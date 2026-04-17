import { Server } from "@tus/server";
import type { FastifyRequest } from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { z } from "zod";
import type { PulseVaultStorage } from "../storage/types.js";

/**
 * Context the plugin stashes on each incoming Fastify request for the lifetime
 * of a TUS call. Shared with the tus hooks via `AsyncLocalStorage` because
 * `@tus/server` v2 hooks receive a web `Request`, not the FastifyRequest.
 */
export type PulseVaultTusContext = {
  request: FastifyRequest;
  videoid?: string;
};

export const pulseVaultTusContext = new AsyncLocalStorage<PulseVaultTusContext>();

export type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { videoid: string; size: number; uploadId: string },
) => void | Promise<void>;

export type PulsevaultTusOptions = {
  storage: PulseVaultStorage;
  /** Absolute URL path where TUS is mounted, e.g. `/pulsevault/upload`. */
  tusPath: string;
  /** Max total upload size in bytes. Use `Infinity` for no cap. */
  maxSize: number;
  /**
   * File extensions allowed in the upload `filename` metadata. Must be
   * pre-normalized to lowercase and include the leading dot.
   */
  allowedExtensions: readonly string[];
  /**
   * Fired once the final byte of an upload has been written. Use this to flip
   * consumer state (DB row, queue job, audit log). The plugin itself does
   * nothing here — it's an escape hatch for the parent server.
   */
  onUploadComplete?: PulseVaultOnUploadComplete;
};

const videoidMetaSchema = z.uuid();

/**
 * Shape `@tus/server` recognizes for sending an error response. We tag both
 * `statusCode` and `status_code` so throws originating from either Fastify
 * conventions (camelCase) or the tus convention (snake_case) surface with the
 * right HTTP status.
 */
export function tusError(status: number, body: string): Error {
  return Object.assign(new Error(body), {
    statusCode: status,
    status_code: status,
    body,
  });
}

/** Parse the first path segment of a tus upload id as the videoid. */
function videoidFromUploadId(id: string): string | undefined {
  const first = id.split("/", 1)[0];
  return first && videoidMetaSchema.safeParse(first).success ? first : undefined;
}

export function createPulsevaultTusServer(options: PulsevaultTusOptions) {
  const { storage, tusPath, maxSize, allowedExtensions, onUploadComplete } =
    options;

  return new Server({
    path: tusPath,
    datastore: storage.datastore,
    maxSize,
    namingFunction: async (_req, metadata) => {
      const videoid = metadata?.videoid ?? "";
      const filename = (metadata?.filename ?? "").trim();

      const idCheck = videoidMetaSchema.safeParse(videoid);
      if (!idCheck.success) {
        throw tusError(
          400,
          "Upload-Metadata must include a valid `videoid` (UUID).\n",
        );
      }

      const ext = path.extname(filename).toLowerCase();
      if (!ext || !allowedExtensions.includes(ext)) {
        throw tusError(
          400,
          `Upload-Metadata \`filename\` must end with one of: ${allowedExtensions.join(
            ", ",
          )}\n`,
        );
      }

      return storage.reserveUpload({ videoid, filename, ext });
    },
    generateUrl(_req, { proto, host, path: tusBasePath, id }) {
      const encoded = Buffer.from(id, "utf8").toString("base64url");
      return `${proto}://${host}${tusBasePath}/${encoded}`;
    },
    getFileIdFromRequest(_req, lastPath) {
      if (!lastPath) {
        return;
      }
      return Buffer.from(lastPath, "base64url").toString("utf8");
    },
    onUploadFinish: async (_req, upload) => {
      // The plugin bridges tus → consumer here. Videoid is parsed from the
      // upload id (which the local adapter shapes as `${videoid}/video/…`);
      // other adapters that embed videoid at position 0 get this for free.
      if (!onUploadComplete) {
        return {};
      }
      const store = pulseVaultTusContext.getStore();
      if (!store) {
        // Should not happen — the Fastify layer always establishes a store
        // before calling into tus. Bail quietly rather than crash.
        return {};
      }
      const videoid = videoidFromUploadId(upload.id);
      if (!videoid) {
        return {};
      }
      try {
        await onUploadComplete(store.request, {
          videoid,
          size: upload.size ?? 0,
          uploadId: upload.id,
        });
      } catch (err) {
        // Propagate as a tus error so the client sees a non-2xx and can
        // distinguish "bytes stored but completion hook failed" from success.
        const message =
          err instanceof Error ? err.message : "onUploadComplete failed";
        throw tusError(500, `${message}\n`);
      }
      return {};
    },
  });
}
