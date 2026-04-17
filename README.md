# @mieweb/pulsevault

Fastify plugin for resumable video uploads via the [TUS protocol](https://tus.io/), with local filesystem storage and deep link helpers for the [Pulse](https://github.com/mieweb/pulse) mobile app.

## Requirements

- Fastify `^5.x`
- Node.js `>=18`

## Installation

```sh
npm install @mieweb/pulsevault
```

## Quick start

```ts
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import pulseVault, { createLocalStorage } from "@mieweb/pulsevault";

const app = Fastify();

await app.register(pulseVault, {
  prefix: "",
  storage: createLocalStorage({ workspaceDir: "./data", podId: "my-server" }),
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
});

// Your server owns videoid creation — attach auth, DB records, quotas here.
app.post("/reserve", async (_req, reply) => {
  return reply.send({ videoid: randomUUID() });
});

await app.listen({ port: 3030 });
```

## Routes

The plugin mounts three routes under `prefix`:

| Method  | Path          | Description                              |
| ------- | ------------- | ---------------------------------------- |
| `POST`  | `/upload`     | Create a TUS upload session              |
| `PATCH` | `/upload/:id` | Upload chunks                            |
| `GET`   | `/:videoid`   | Stream or redirect to the uploaded video |

> `POST /reserve` is **not** part of the plugin. Your server implements it so you control auth, ownership, and any business logic tied to video creation.

## Plugin options

```ts
type PulseVaultPluginOptions = {
  storage: PulseVaultStorage;
  prefix: string;
  maxUploadSize: number;
  decoratorName?: string; // default: "pulseVault"
  allowedExtensions?: string[]; // default: [".mp4"]
  cache?: PulseVaultCacheOptions;
  authorize?: PulseVaultAuthorize;
  onUploadComplete?: PulseVaultOnUploadComplete;
};
```

### `storage`

A `PulseVaultStorage` adapter. Use the built-in `createLocalStorage` for filesystem-backed deployments or implement the interface for custom backends.

### `prefix`

URL prefix for all plugin routes. Use `""` to mount at the root or `"/pulsevault"` to namespace. Must start with `/` (no trailing slash) or be `""`.

> Because the plugin uses `fastify-plugin` to escape encapsulation, Fastify's native `register(..., { prefix })` is a no-op — always pass `prefix` through this option.

### `maxUploadSize`

Maximum upload size in bytes. Use `Infinity` for no cap.

### `decoratorName`

Name of the Fastify decorator that exposes the storage adapter on the instance. Defaults to `"pulseVault"`. Override when registering the plugin more than once in the same process.

For TypeScript access to the default decorator, add a side-effect import once in your app:

```ts
import "@mieweb/pulsevault/augment";
```

### `allowedExtensions`

File extensions accepted in `Upload-Metadata.filename`. Must include the leading dot. Defaults to `[".mp4"]`.

### `cache`

Cache-control options for the `GET /:videoid` route, forwarded to `@fastify/send`:

```ts
type PulseVaultCacheOptions = {
  cacheControl?: boolean; // default: true
  maxAge?: string | number; // ms or ms-style string e.g. "1y". default: 0
  immutable?: boolean; // requires maxAge > 0. default: false
};
```

Upload filenames are keyed by UUID, so `immutable: true` is safe when `maxAge` is non-zero.

### `authorize`

Optional async hook called before TUS create/patch and before GET resolve. Throw to reject — a `statusCode` or `status_code` number on the thrown error is used as the HTTP status (default `403`).

```ts
type PulseVaultAuthorize = (
  request: FastifyRequest,
  ctx: { phase: "create" | "patch" | "resolve"; videoid: string },
) => void | Promise<void>;
```

```ts
await app.register(pulseVault, {
  // ...
  authorize: async (request, { phase, videoid }) => {
    const token = request.headers.authorization?.replace("Bearer ", "");
    if (!isValid(token, videoid)) {
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    }
  },
});
```

### `onUploadComplete`

Optional async hook fired once the final byte is written, before the success response is sent. Use it to update a database row, enqueue a job, or write an audit log. Throwing returns a `500` to the client.

```ts
type PulseVaultOnUploadComplete = (
  request: FastifyRequest,
  ctx: { videoid: string; size: number; uploadId: string },
) => void | Promise<void>;
```

## Local storage

```ts
import { createLocalStorage } from "@mieweb/pulsevault";

const storage = createLocalStorage({
  workspaceDir: "./data", // directory for uploads; created if absent
  podId: "my-server", // unique id across plugin instances in the same process
});
```

The returned adapter also exposes `storage.pod` and `storage.workspaceRoot` for consumers that need direct access to the underlying ArtiPod.

## Custom storage adapter

Implement `PulseVaultStorage` to back uploads with any system (S3, GCS, database, etc.):

```ts
import type {
  PulseVaultStorage,
  PulseVaultResolution,
} from "@mieweb/pulsevault";

const storage: PulseVaultStorage = {
  datastore, // @tus/server DataStore instance
  async initialize() {
    /* optional setup */
  },
  async shutdown() {
    /* optional teardown */
  },
  async reserveUpload({ videoid, filename, ext }) {
    // Called by the TUS naming function. Return the file id for the datastore.
    await db.createVideo({ videoid, filename });
    return `${videoid}${ext}`;
  },
  async resolve(videoid): Promise<PulseVaultResolution | null> {
    const video = await db.findVideo(videoid);
    if (!video) return null;
    // Stream from local disk:
    return { kind: "stream", root: "/uploads", filename: video.filename };
    // Or redirect to a CDN / presigned URL:
    // return { kind: "redirect", url: video.signedUrl, statusCode: 302 };
  },
};
```

## Deep link helpers

Use these to generate `pulsecam://` deep links for pairing the Pulse mobile app with your server. Typically encoded as QR codes on a pairing page.

```ts
import {
  buildConfigureDestinationLink,
  buildUploadLink,
} from "@mieweb/pulsevault";
import { randomUUID } from "node:crypto";

// Adds this server as a saved destination in the Pulse app.
const configureLink = buildConfigureDestinationLink({
  server: "https://example.com",
  name: "My Server", // optional — shown in the app's destination list
  token: "secret", // optional — forwarded to your authorize hook
});

// Opens the app directly on the upload screen for a specific video.
const uploadLink = buildUploadLink({
  server: "https://example.com",
  videoid: randomUUID(), // generate server-side; skip POST /reserve on the app
  token: "secret", // optional
});
```

## Accessing storage outside the plugin routes

The storage adapter is exposed as a Fastify decorator, so you can use it in your own routes:

```ts
import "@mieweb/pulsevault/augment"; // once, for TypeScript types

app.get("/admin/video/:id", async (req, reply) => {
  const resolved = await app.pulseVault.resolve(req.params.id);
  if (!resolved) return reply.code(404).send();
  // custom logic...
});
```

## License

ISC
