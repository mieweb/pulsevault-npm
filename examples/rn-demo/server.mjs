import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Fastify from "fastify";
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

const qrcodeJs = readFileSync(
  path.join(__dirname, "public/qrcode.min.js"),
  "utf8",
);

// Serve pairing page before the plugin so it isn't swallowed by /:videoid
app.get("/", (_req, reply) => reply.type("text/html").send(html));
app.get("/qrcode.min.js", (_req, reply) =>
  reply.type("application/javascript").send(qrcodeJs),
);

// Reserve a videoid for an upload. The server owns ID generation so it can
// later attach auth tokens, quotas, or other server-side state here.
app.post("/reserve", async (_req, reply) => {
  const videoid = randomUUID();
  return reply.send({ videoid });
});

// Return pre-built deep links for the pairing page.
// draftId and videoid are generated here so the server is the single source of truth.
app.get("/deeplinks", async (req, reply) => {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const server = `${proto}://${host}`;
  const videoid = randomUUID();

  const configureDestination = buildConfigureDestinationLink({ server, name: "Demo Server" });
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
});

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

const port = Number(process.env.PORT ?? 3030);
const host = process.env.HOST ?? "0.0.0.0";

await app.listen({ port, host });
console.log(`\nRN demo server running.`);
console.log(`Pairing page: http://localhost:${port}/`);
console.log(
  `From your phone (same WiFi): open http://<your-laptop-ip>:${port}/ in the browser`,
);
