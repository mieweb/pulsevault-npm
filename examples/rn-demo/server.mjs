import path from "node:path";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import QRCode from "qrcode";
import pulseVault, {
  createLocalStorage,
  buildConfigureDestinationLink,
  buildUploadLink,
} from "@mieweb/pulsevault";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, "public/index.html"), "utf8");
const dataDir = path.join(__dirname, "data");

const app = Fastify({
  logger: true,
  bodyLimit: 16 * 1024 * 1024, // max single PATCH chunk (RN app sends 1 MB chunks)
});

// Swagger MUST be registered before any route (including the plugin's) so
// their schemas are picked up for the generated OpenAPI spec.
await app.register(fastifySwagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "PulseVault RN Demo",
      description:
        "Reference server pairing the React Native demo app with `@mieweb/pulsevault`.",
      version: "0.0.1",
    },
    tags: [
      { name: "demo", description: "RN demo server endpoints" },
      {
        name: "pulsevault",
        description: "Routes contributed by the `@mieweb/pulsevault` plugin",
      },
    ],
  },
});

await app.register(fastifySwaggerUI, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
});

// Serve pairing page before the plugin so it isn't swallowed by /:videoid
app.get(
  "/",
  {
    schema: {
      tags: ["demo"],
      summary: "Pairing page (HTML)",
      description:
        "Returns the static pairing UI that renders the configure-destination and upload QR codes.",
      response: {
        200: {
          description: "HTML pairing page.",
          type: "string",
        },
      },
    },
  },
  (_req, reply) => reply.type("text/html").send(html),
);

// Reserve a videoid for an upload. The server owns ID generation so it can
// later attach auth tokens, quotas, or other server-side state here.
app.post(
  "/reserve",
  {
    schema: {
      tags: ["demo"],
      summary: "Reserve a new videoid",
      description:
        "Generates a fresh UUID for the client to use as the `videoid` metadata entry on its TUS upload.",
      response: {
        200: {
          description: "A newly minted videoid.",
          type: "object",
          properties: {
            videoid: { type: "string", format: "uuid" },
          },
          required: ["videoid"],
        },
      },
    },
  },
  async (_req, reply) => {
    const videoid = randomUUID();
    return reply.send({ videoid });
  },
);

// List all uploaded videos under dataDir. The TUS file-store layout is
// data/<videoid>/video/<videoid>.<ext>(+ .json sidecar with metadata).
const videoSummarySchema = {
  type: "object",
  properties: {
    videoid: { type: "string", format: "uuid" },
    filename: { type: "string" },
    size: { type: "integer", minimum: 0 },
    creation_date: { type: "string", format: "date-time" },
  },
  required: ["videoid", "filename", "size", "creation_date"],
};

app.get(
  "/videos",
  {
    schema: {
      tags: ["demo"],
      summary: "List previously uploaded videos",
      description:
        "Enumerates completed uploads on disk by scanning the local data directory.",
      response: {
        200: {
          description: "Videos sorted by creation time, newest first.",
          type: "array",
          items: videoSummarySchema,
        },
      },
    },
  },
  async (_req, reply) => {
    let entries;
    try {
      entries = await readdir(dataDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return reply.send([]);
      throw err;
    }

    const videos = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const videoid = e.name;
          const videoDir = path.join(dataDir, videoid, "video");
          let files;
          try {
            files = await readdir(videoDir);
          } catch {
            return null;
          }
          const mp4 = files.find(
            (f) => f.endsWith(".mp4") && !f.endsWith(".mp4.json"),
          );
          if (!mp4) return null;

          const mp4Path = path.join(videoDir, mp4);
          const jsonPath = `${mp4Path}.json`;
          const [mp4Stat, meta] = await Promise.all([
            stat(mp4Path).catch(() => null),
            readFile(jsonPath, "utf8")
              .then(JSON.parse)
              .catch(() => null),
          ]);
          if (!mp4Stat || mp4Stat.size === 0) return null;

          return {
            videoid,
            filename: meta?.metadata?.filename ?? mp4,
            size: mp4Stat.size,
            creation_date:
              meta?.creation_date ?? mp4Stat.birthtime.toISOString(),
          };
        }),
    );

    return reply.send(
      videos
        .filter(Boolean)
        .sort((a, b) => b.creation_date.localeCompare(a.creation_date)),
    );
  },
);

// Return pre-built deep links for the pairing page.
// draftId and videoid are generated here so the server is the single source of truth.
app.get(
  "/deeplinks",
  {
    schema: {
      tags: ["demo"],
      summary: "Deep links + QR codes for RN pairing",
      description:
        "Builds a configure-destination link and a videoid-scoped upload link, then encodes both as data-URL PNG QR codes.",
      response: {
        200: {
          description: "Deep links and their QR-code renderings.",
          type: "object",
          properties: {
            configureDestination: { type: "string", format: "uri" },
            upload: { type: "string", format: "uri" },
            videoid: { type: "string", format: "uuid" },
            qrConfigure: {
              type: "string",
              description:
                "data:image/png;base64 QR for `configureDestination`.",
            },
            qrUpload: {
              type: "string",
              description: "data:image/png;base64 QR for `upload`.",
            },
          },
          required: [
            "configureDestination",
            "upload",
            "videoid",
            "qrConfigure",
            "qrUpload",
          ],
        },
      },
    },
  },
  async (req, reply) => {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const server = `${proto}://${host}`;
    const videoid = randomUUID();

    const configureDestination = buildConfigureDestinationLink({
      server,
      name: "Demo Server",
    });
    const upload = buildUploadLink({ server, videoid });

    const qrOpts = {
      width: 224,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    };
    const [qrConfigure, qrUpload] = await Promise.all([
      QRCode.toDataURL(configureDestination, qrOpts),
      QRCode.toDataURL(upload, qrOpts),
    ]);

    return reply.send({
      configureDestination,
      upload,
      videoid,
      qrConfigure,
      qrUpload,
    });
  },
);

// Mount plugin at root prefix so TUS is at POST /upload and video GET is at /:videoid
await app.register(pulseVault, {
  prefix: "",
  storage: createLocalStorage({
    workspaceDir: dataDir,
    podId: "rn-demo",
  }),
  maxUploadSize: 5 * 1024 * 1024 * 1024, // 5 GiB
  allowedExtensions: [".mp4"],
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
console.log(`\nRN demo server running.`);
console.log(`Pairing page: http://localhost:${port}/`);
console.log(`Swagger UI:   http://localhost:${port}/docs`);
console.log(
  `From your phone (same WiFi): open http://<your-laptop-ip>:${port}/ in the browser`,
);
