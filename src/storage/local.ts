import { ArtiMount, type ArtiPod } from "@mieweb/artipod";
import { FileStore } from "@tus/file-store";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createPulseVaultPod } from "../pod/pulsevaultPod.js";
import type {
  PulseVaultResolution,
  PulseVaultStorage,
  ReserveUploadParams,
} from "./types.js";

export type LocalStorageOptions = {
  /** Directory where per-video mounts are stored. Resolved against CWD if relative. */
  workspaceDir: string;
  /** Stable ArtiPod id. Must be unique across plugins in the same process. */
  podId: string;
};

/** Local-adapter-returned storage also exposes its pod for consumers that want it. */
export type LocalStorage = PulseVaultStorage & {
  readonly pod: ArtiPod;
  readonly workspaceRoot: string;
};

const videoidDirSchema = z.uuid();

export function createLocalStorage(opts: LocalStorageOptions): LocalStorage {
  const workspaceRoot = path.resolve(opts.workspaceDir);
  const pod = createPulseVaultPod(workspaceRoot, opts.podId);
  const datastore = new FileStore({ directory: workspaceRoot });
  // Serialize concurrent `reserveUpload` calls that share a videoid so we
  // don't race two `ArtiMount` registrations against the same pod. TUS's
  // default locker only guards *existing* upload ids, so the window between
  // id minting and `addMount` is otherwise unprotected.
  const reservations = new Map<string, Promise<void>>();

  const initialize = async (): Promise<void> => {
    await fs.mkdir(workspaceRoot, { recursive: true });
    await pod.initialize();

    // Rehydrate persisted mounts from disk.
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const parsed = videoidDirSchema.safeParse(entry.name);
      if (!parsed.success || pod.getMount(parsed.data)) {
        continue;
      }
      const mount = new ArtiMount(
        parsed.data,
        path.join(workspaceRoot, parsed.data),
      );
      await mount.initialize();
      pod.addMount(mount);
    }
  };

  const reserveUpload = async ({
    videoid,
    ext,
  }: ReserveUploadParams): Promise<string> => {
    // Collision guard: if a finalized video already exists for this videoid,
    // refuse the new upload rather than letting @tus/file-store silently
    // rewrite the bytes (it would reset the metadata sidecar to offset 0 and
    // overwrite the file chunk-by-chunk on subsequent PATCHes).
    // Translates to HTTP 409 via @tus/server's error path.
    const existing = await resolve(videoid);
    if (existing) {
      throw Object.assign(
        new Error(`videoid ${videoid} already has a completed upload`),
        { statusCode: 409, status_code: 409 },
      );
    }

    const mountRoot = path.join(workspaceRoot, videoid);
    await fs.mkdir(path.join(mountRoot, "video"), { recursive: true });

    if (!pod.getMount(videoid)) {
      let inflight = reservations.get(videoid);
      if (!inflight) {
        inflight = (async () => {
          if (pod.getMount(videoid)) {
            return;
          }
          // Writable by default; rehydration in `initialize` uses the same
          // default so both code paths produce equivalent mounts.
          const mount = new ArtiMount(videoid, mountRoot);
          await mount.initialize();
          pod.addMount(mount);
        })();
        reservations.set(videoid, inflight);
        inflight.finally(() => {
          if (reservations.get(videoid) === inflight) {
            reservations.delete(videoid);
          }
        });
      }
      await inflight;
    }

    return `${videoid}/video/${videoid}${ext}`;
  };

  const resolve = async (
    videoid: string,
  ): Promise<PulseVaultResolution | null> => {
    const mount = pod.getMount(videoid);
    if (!mount) {
      return null;
    }
    const mountRoot = mount.getRootPath();
    const videoDir = path.join(mountRoot, "video");
    const entries = await fs.readdir(videoDir).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return [] as string[];
      }
      throw err;
    });
    // `@tus/file-store` writes its metadata sidecar at `<id>.json` next to the
    // file itself, so a naive `startsWith("${videoid}.")` match can return the
    // JSON sidecar (leaking upload metadata). Require the full filename to be
    // exactly `${videoid}<ext>` and reject the `.json` configstore artifact.
    const match = entries.find((name) => {
      const ext = path.extname(name).toLowerCase();
      return ext !== ".json" && ext !== "" && name === `${videoid}${ext}`;
    });
    if (!match) {
      return null;
    }
    return { kind: "stream", root: mountRoot, filename: `video/${match}` };
  };

  return {
    datastore,
    pod,
    workspaceRoot,
    initialize,
    reserveUpload,
    resolve,
  };
}
