import { ArtiPod } from "@mieweb/artipod";

/** `workspaceDir` must be an absolute path; callers are responsible for resolving. */
export function createPulseVaultPod(
  workspaceDir: string,
  podId: string,
): ArtiPod {
  return new ArtiPod({
    id: podId,
    workspaceDir,
    useMainMount: false,
  });
}
