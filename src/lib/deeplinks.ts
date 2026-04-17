export type ConfigureDestinationLinkOptions = {
  /** Full origin of the PulseVault server, e.g. `https://example.com` or `http://192.168.1.10:3030`. */
  server: string;
  /** Opaque token forwarded to the server's `authorize` hook. Omit for unauthenticated servers. */
  token?: string;
  /** Human-readable name shown in the Pulse app's destination list. Defaults to the server hostname. */
  name?: string;
};

export type UploadLinkOptions = {
  /** Full origin of the PulseVault server. */
  server: string;
  /** Opaque token forwarded to the server's `authorize` hook. Omit for unauthenticated servers. */
  token?: string;
  /**
   * Server-side video UUID. Used as both the app's local draft key and the
   * `videoid` in `Upload-Metadata`, so the app skips `POST /reserve`.
   * Generate with `crypto.randomUUID()`.
   */
  videoid: string;
};

/**
 * Build a `pulsecam://` deep link that adds this server as a saved upload
 * destination in the Pulse app. No server request is made when the link is
 * opened — the app stores the config locally.
 */
export function buildConfigureDestinationLink(
  opts: ConfigureDestinationLinkOptions,
): string {
  const params = new URLSearchParams({ mode: "configure_destination", server: opts.server });
  if (opts.token) params.set("token", opts.token);
  if (opts.name) params.set("name", opts.name);
  return `pulsecam://?${params.toString()}`;
}

/**
 * Build a `pulsecam://` deep link that opens the Pulse app directly on the
 * upload screen for a specific draft, pointed at this server.
 */
export function buildUploadLink(opts: UploadLinkOptions): string {
  const params = new URLSearchParams({ mode: "upload", videoid: opts.videoid, server: opts.server });
  if (opts.token) params.set("token", opts.token);
  return `pulsecam://?${params.toString()}`;
}
