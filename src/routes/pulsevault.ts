import type {
  FastifyPluginAsync,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import send from "@fastify/send";
import type { PulseVaultCacheOptions } from "../app.js";
import {
  createPulsevaultTusServer,
  pulseVaultTusContext,
  type PulseVaultOnUploadComplete,
} from "../lib/pulsevaultTus.js";
import { pulseVaultError, replyWithZodError } from "../lib/zodReply.js";
import type { PulseVaultStorage } from "../storage/types.js";
import { z } from "zod";

// Internal augmentation — mirrored in the opt-in `./augment.ts` re-export so
// consumers can `import "@mieweb/pulsevault/augment"` and get the
// same typing. Kept here as well so the plugin itself typechecks regardless
// of whether the consumer ever imports the augment module.
declare module "fastify" {
  interface FastifyRequest {
    pulseVault?: { videoid: string };
  }
}

export type PulseVaultAuthorizePhase = "create" | "patch" | "resolve";

export type PulseVaultAuthorizeContext = {
  phase: PulseVaultAuthorizePhase;
  videoid: string;
};

export type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: PulseVaultAuthorizeContext,
) => void | Promise<void>;

export type PulseVaultRoutesOptions = {
  storage: PulseVaultStorage;
  maxUploadSize: number;
  allowedExtensions: readonly string[];
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  onUploadComplete?: PulseVaultOnUploadComplete;
} & FastifyPluginOptions;

const videoidParamsSchema = z.object({
  videoid: z.uuid(),
});

const videoidSchema = z.uuid();

/**
 * Pull `videoid` out of a raw `Upload-Metadata` header. Format is a
 * comma-separated list of `<key> <base64-value>` pairs (tus v1 creation
 * extension). We only care about `videoid`; everything else is left to the
 * tus server proper.
 */
function parseVideoidFromMetadata(header: string): string | undefined {
  for (const pair of header.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(" ");
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep);
    if (key !== "videoid") continue;
    const value = trimmed.slice(sep + 1).trim();
    if (!value) return undefined;
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return videoidSchema.safeParse(decoded).success ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Decode the last URL segment of a tus PATCH/HEAD/DELETE (base64url-encoded
 * id) and extract the first path component, which the plugin always shapes as
 * the videoid (see `pulseVaultTus.ts`).
 */
function videoidFromTusUrl(url: string): string | undefined {
  const match = url.match(/\/upload\/([^/?#]+)/);
  if (!match?.[1]) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const first = decoded.split("/", 1)[0];
  return first && videoidSchema.safeParse(first).success ? first : undefined;
}

function extractAuthzStatus(err: unknown): number {
  const e = err as { statusCode?: unknown; status_code?: unknown };
  if (typeof e?.statusCode === "number") return e.statusCode;
  if (typeof e?.status_code === "number") return e.status_code;
  return 403;
}

function extractAuthzMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Forbidden";
}

const pulseVaultRoutes: FastifyPluginAsync<PulseVaultRoutesOptions> = async (
  fastify,
  opts,
) => {
  const { storage, maxUploadSize, allowedExtensions, cache, authorize, onUploadComplete } = opts;
  // `fastify.prefix` is `""` when the plugin is mounted at the root.
  const tusPath = `${fastify.prefix}/upload`;

  const tusServer = createPulsevaultTusServer({
    storage,
    tusPath,
    maxSize: maxUploadSize,
    allowedExtensions,
    onUploadComplete,
  });

  fastify.addContentTypeParser(
    "application/offset+octet-stream",
    (_request, _payload, done) => {
      done(null);
    },
  );

  /**
   * Run the consumer's `authorize` hook (if any) for a TUS request. Returns
   * `true` iff the request may proceed; on rejection, this function already
   * wrote the response.
   */
  const runAuthorize = async (
    request: FastifyRequest,
    reply: FastifyReply,
    phase: "create" | "patch",
  ): Promise<{ ok: true; videoid: string | undefined } | { ok: false }> => {
    let videoid: string | undefined;
    if (phase === "create") {
      const meta = request.headers["upload-metadata"];
      if (typeof meta === "string") {
        videoid = parseVideoidFromMetadata(meta);
      }
    } else {
      videoid = videoidFromTusUrl(request.url);
    }

    if (videoid) {
      request.pulseVault = { videoid };
    }

    if (!authorize) {
      return { ok: true, videoid };
    }

    // If we can't extract a videoid, let tus produce its own 4xx for malformed
    // input rather than synthesize a fake authorize failure.
    if (!videoid) {
      return { ok: true, videoid };
    }

    try {
      await authorize(request, { phase, videoid });
      return { ok: true, videoid };
    } catch (err) {
      const statusCode = extractAuthzStatus(err);
      const message = extractAuthzMessage(err);
      request.log.info(
        { err, videoid, phase, statusCode },
        "pulsevault authorize rejected",
      );
      await reply.code(statusCode).send(pulseVaultError(message));
      return { ok: false };
    }
  };

  const tusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const phase: "create" | "patch" =
      request.method === "POST" ? "create" : "patch";

    const authz = await runAuthorize(request, reply, phase);
    if (!authz.ok) return;

    // Once hijacked, Fastify will not write to this reply on our behalf, so we
    // must translate any unexpected throw from `@tus/server` into a response
    // ourselves — otherwise the socket stays open until the client times out.
    reply.hijack();
    try {
      await pulseVaultTusContext.run(
        { request, videoid: authz.videoid },
        () => tusServer.handle(request.raw, reply.raw),
      );
    } catch (err) {
      request.log.error({ err }, "pulsevault tus handler failed");
      if (reply.raw.headersSent || reply.raw.writableEnded) {
        reply.raw.destroy();
        return;
      }
      reply.raw.statusCode = 500;
      reply.raw.setHeader("content-type", "text/plain; charset=utf-8");
      reply.raw.end("Internal Server Error");
    }
  };

  fastify.all("/upload", tusHandler);
  fastify.all("/upload/*", tusHandler);

  fastify.get("/:videoid", async (request, reply) => {
    const parsed = videoidParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return replyWithZodError(reply, parsed.error);
    }

    const videoid = parsed.data.videoid;
    request.pulseVault = { videoid };

    // Run authorize *before* resolve so consumers can reject without the
    // response leaking "this videoid exists but you don't own it" vs. "no such
    // videoid".
    if (authorize) {
      try {
        await authorize(request, { phase: "resolve", videoid });
      } catch (err) {
        const statusCode = extractAuthzStatus(err);
        const message = extractAuthzMessage(err);
        request.log.info(
          { err, videoid, phase: "resolve", statusCode },
          "pulsevault authorize rejected",
        );
        return reply.code(statusCode).send(pulseVaultError(message));
      }
    }

    const resolved = await storage.resolve(videoid);
    if (!resolved) {
      return reply.code(404).send(pulseVaultError("Video not found"));
    }

    if (resolved.kind === "redirect") {
      return reply.redirect(resolved.url, resolved.statusCode ?? 302);
    }

    const result = await send(request.raw, resolved.filename, {
      root: resolved.root,
      ...cache,
    });

    if (result.type === "error") {
      return reply
        .code(result.statusCode)
        .send(pulseVaultError(result.metadata.error.message));
    }

    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }
    return reply.code(result.statusCode).send(result.stream);
  });
};

export default pulseVaultRoutes;
