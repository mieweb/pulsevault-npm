import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import pulseVaultRoutes, {
  type PulseVaultAuthorize,
  type PulseVaultAuthorizeContext,
  type PulseVaultAuthorizePhase,
} from "./routes/pulsevault.js";
import type { PulseVaultOnUploadComplete } from "./lib/pulsevaultTus.js";
import type { PulseVaultStorage } from "./storage/types.js";

/**
 * Subset of `@fastify/send`'s cache-related options forwarded to the GET
 * route. All upload filenames are content-addressable (keyed by the upload
 * UUID), so `immutable: true` is safe whenever you also set a non-zero
 * `maxAge`.
 */
export type PulseVaultCacheOptions = {
  /** Enable the `Cache-Control` response header. Defaults to `true`. */
  cacheControl?: boolean;
  /**
   * `max-age` for the `Cache-Control` header. Accepts a number of
   * milliseconds or an `ms`-style string such as `"1y"`. Defaults to `0`.
   */
  maxAge?: string | number;
  /**
   * Add the `immutable` directive to `Cache-Control`. Requires `maxAge > 0`
   * to take effect. Defaults to `false`.
   */
  immutable?: boolean;
};

export type PulseVaultPluginOptions = {
  /** Storage adapter. Use `createLocalStorage(...)` for filesystem-backed deployments. */
  storage: PulseVaultStorage;
  /**
   * URL prefix where the plugin's routes are mounted, e.g. `"/pulsevault"`.
   * Must be set explicitly: because this plugin is wrapped with
   * `fastify-plugin` (so its decorator escapes encapsulation), Fastify's own
   * `register(..., { prefix })` is a no-op and must be routed through this
   * option instead. Use `""` to mount at the root.
   */
  prefix: string;
  /**
   * Max TUS upload size in bytes. Required — consumers must choose an
   * explicit cap for their deployment. Use `Infinity` for no cap.
   */
  maxUploadSize: number;
  /**
   * Fastify instance decorator name under which the storage adapter is
   * exposed. Defaults to `"pulseVault"`. Override when registering this
   * plugin more than once in the same process so the decorators don't
   * collide.
   *
   * For typed access to the default decorator, add a single side-effect
   * import somewhere in your app: `import "@mieweb/pulsevault/augment"`.
   * Consumers using a custom name must skip that import and write their own
   * `declare module "fastify"` augmentation — see `./augment.ts` for the
   * template.
   */
  decoratorName?: string;
  /**
   * File extensions allowed in the upload `filename` metadata. Must include
   * the leading dot; matched case-insensitively. Defaults to `[".mp4"]`.
   */
  allowedExtensions?: readonly string[];
  /**
   * Cache-control options forwarded to `@fastify/send` for the GET route.
   * When omitted, `@fastify/send`'s defaults apply (`Cache-Control: public,
   * max-age=0`).
   */
  cache?: PulseVaultCacheOptions;
  /**
   * Optional authorization hook. Runs before the TUS create/PATCH lifecycle
   * and before `resolve` on GET. Throw to reject the request; a thrown
   * `statusCode`/`status_code` number on the error is honored (default 403).
   *
   * The hook is called with the `FastifyRequest`, so consumers can look up
   * sessions, API keys, JWTs, etc. using whatever auth system they have
   * registered higher up in the Fastify tree.
   *
   * When omitted, the plugin performs no authorization. For production
   * deployments you almost certainly want to set this — register your auth
   * plugin on the parent scope and let the hook verify ownership of the
   * `videoid` before any bytes are written.
   */
  authorize?: PulseVaultAuthorize;
  /**
   * Optional post-upload hook. Fires once TUS writes the final byte, before
   * the success response is sent to the client. Use this to flip consumer
   * state (DB row, queue job, audit log). Throwing turns the upload into a
   * 500 response, so the client knows bytes landed but completion failed.
   */
  onUploadComplete?: PulseVaultOnUploadComplete;
};

const DEFAULT_DECORATOR_NAME = "pulseVault";
const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [".mp4"];

const storageSchema = z.custom<PulseVaultStorage>(
  (val) => {
    if (!val || typeof val !== "object") {
      return false;
    }
    const s = val as Partial<PulseVaultStorage>;
    return (
      typeof s.reserveUpload === "function" &&
      typeof s.resolve === "function" &&
      !!s.datastore
    );
  },
  { message: "storage must implement PulseVaultStorage" },
);

const cacheOptionsSchema = z
  .object({
    cacheControl: z.boolean().optional(),
    maxAge: z.union([z.string().min(1), z.number().min(0)]).optional(),
    immutable: z.boolean().optional(),
  })
  .strict();

// Validate hooks at runtime without enforcing a specific call signature —
// zod v4's `z.function()` produces a wrapped function we don't want. A simple
// typeof check is enough; the TS types do the real enforcement for consumers.
const authorizeSchema = z.custom<PulseVaultAuthorize>(
  (v) => typeof v === "function",
  { message: "`authorize` must be a function" },
);
const onUploadCompleteSchema = z.custom<PulseVaultOnUploadComplete>(
  (v) => typeof v === "function",
  { message: "`onUploadComplete` must be a function" },
);

const optionsSchema = z.object({
  storage: storageSchema,
  prefix: z
    .string()
    .refine((v) => v === "" || (v.startsWith("/") && !v.endsWith("/")), {
      message:
        "`prefix` must be '' or start with '/' with no trailing slash (e.g. '/pulsevault')",
    }),
  maxUploadSize: z.number().refine((v) => v > 0, {
    message:
      "`maxUploadSize` must be a positive number (use Infinity for no cap)",
  }),
  decoratorName: z.string().min(1).optional(),
  allowedExtensions: z
    .array(
      z.string().regex(/^\.[^.\s/\\]+$/, {
        message:
          "each extension must start with '.' and contain no nested dots, slashes, or whitespace (e.g. '.mp4')",
      }),
    )
    .min(1)
    .optional(),
  cache: cacheOptionsSchema.optional(),
  authorize: authorizeSchema.optional(),
  onUploadComplete: onUploadCompleteSchema.optional(),
});

const app: FastifyPluginAsync<PulseVaultPluginOptions> = async (
  fastify,
  rawOpts,
) => {
  const opts = optionsSchema.parse(rawOpts);

  // Register the shutdown hook *before* awaiting initialize() so any partial
  // state the adapter allocates mid-init still gets cleaned up if Fastify
  // later tears the plugin down.
  fastify.addHook("onClose", async () => {
    await opts.storage.shutdown?.();
  });
  await opts.storage.initialize?.();

  const decoratorName = opts.decoratorName ?? DEFAULT_DECORATOR_NAME;
  const allowedExtensions = (
    opts.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS
  ).map((e) => e.toLowerCase());

  fastify.decorate(decoratorName, opts.storage);

  await fastify.register(pulseVaultRoutes, {
    prefix: opts.prefix,
    storage: opts.storage,
    maxUploadSize: opts.maxUploadSize,
    allowedExtensions,
    cache: opts.cache,
    authorize: opts.authorize,
    onUploadComplete: opts.onUploadComplete,
  });
};

export default fp(app, {
  name: "pulsevault",
  fastify: "5.x",
});

export { createLocalStorage } from "./storage/local.js";
export type { LocalStorage, LocalStorageOptions } from "./storage/local.js";
export type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
} from "./storage/types.js";
export type {
  PulseVaultAuthorize,
  PulseVaultAuthorizeContext,
  PulseVaultAuthorizePhase,
} from "./routes/pulsevault.js";
export type { PulseVaultOnUploadComplete } from "./lib/pulsevaultTus.js";
export {
  buildConfigureDestinationLink,
  buildUploadLink,
} from "./lib/deeplinks.js";
export type {
  ConfigureDestinationLinkOptions,
  UploadLinkOptions,
} from "./lib/deeplinks.js";
