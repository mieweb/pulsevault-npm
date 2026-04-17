import type { DataStore } from "@tus/server";

/**
 * How the GET route should serve a resolved video. Stream means `@fastify/send`
 * reads directly from a local path; Redirect issues an HTTP 3xx to a URL the
 * adapter produced (e.g. a pre-signed object storage URL).
 */
export type PulseVaultResolution =
  | {
      kind: "stream";
      /** Root directory `@fastify/send` should jail to. */
      root: string;
      /** Filename relative to `root`. */
      filename: string;
    }
  | {
      kind: "redirect";
      url: string;
      /** Defaults to 302. */
      statusCode?: number;
    };

export type ReserveUploadParams = {
  /** UUID from `Upload-Metadata.videoid`. */
  videoid: string;
  /** Raw filename from `Upload-Metadata.filename`. */
  filename: string;
  /** Lowercase extension including the leading dot, validated upstream. */
  ext: string;
};

/**
 * Storage backend contract. Keep the surface small: one write hook, one read
 * hook, plus optional one-time init. Adapters own their own configuration.
 */
export interface PulseVaultStorage {
  /** TUS datastore used for resumable uploads. */
  readonly datastore: DataStore;

  /** One-time setup. Called once during plugin boot. */
  initialize?(): Promise<void>;

  /**
   * One-time teardown. Called from Fastify's `onClose` hook so adapters can
   * flush state, close connections, etc. The local adapter has nothing to
   * release, so it omits this method.
   */
  shutdown?(): Promise<void>;

  /**
   * Called by TUS's `namingFunction` after core validation. Returns the file
   * id (the string the datastore will use as its key/path). Adapters may also
   * perform per-upload bookkeeping here (e.g. creating local mount dirs).
   */
  reserveUpload(params: ReserveUploadParams): Promise<string>;

  /**
   * Called by the GET route. Returns how to serve the video, or `null` if
   * the videoid is unknown.
   */
  resolve(videoid: string): Promise<PulseVaultResolution | null>;
}
