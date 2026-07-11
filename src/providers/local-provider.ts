import { invoke } from "@tauri-apps/api/core";
import type { SftpEntry } from "../types/sftp";
import type { ProviderCapabilities, FileSystemProvider } from "../types/explorer";
import { toExplorerEntry } from "./sftp-provider";

// Local paths are native to the OS: `/` on Unix, `\` on Windows. `local_*`
// commands return native paths, so path-joining must match. Detect once.
const SEP =
  typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent) ? "\\" : "/";

// v1: browse + create/delete/rename only. Transfers are cross-pane (driven by
// the remote provider), so canUpload/canDownload are off here; permissions,
// editor, move/copy, and presign are future work.
const LOCAL_CAPABILITIES: ProviderCapabilities = {
  canRename: true,
  canCreateFile: true,
  canCreateFolder: true,
  canDelete: true,
  canUpload: false,
  canDownload: false,
  canDragDropUpload: false,
  canInternalDragMove: false,
  canCopyPaste: false,
  canEditInEditor: false,
  canGetInfo: true,
  hasPermissions: false,
  hasStorageClass: false,
  canPresignUrl: false,
};

/**
 * Provider for the local filesystem pane. `paneKey` is only a state key (local
 * commands are stateless); it lets each dual-pane tab keep its own cwd.
 */
export function createLocalProvider(paneKey: string): FileSystemProvider {
  return {
    type: "local",
    sessionId: paneKey,
    capabilities: LOCAL_CAPABILITIES,

    joinPath(parent, child) {
      if (!parent) return child;
      return parent.endsWith(SEP) ? `${parent}${child}` : `${parent}${SEP}${child}`;
    },
    parentPath(path) {
      const trimmed = path.length > 1 && path.endsWith(SEP) ? path.slice(0, -1) : path;
      const idx = trimmed.lastIndexOf(SEP);
      if (idx < 0) return trimmed;
      // Keep the leading separator so `/a` → `/`, not "".
      return idx === 0 ? SEP : trimmed.substring(0, idx);
    },
    rootLabel() {
      return SEP;
    },
    breadcrumbs(path) {
      const parts = path.split(SEP).filter(Boolean);
      return [
        { label: SEP, path: SEP },
        ...parts.map((seg, i) => ({ label: seg, path: SEP + parts.slice(0, i + 1).join(SEP) })),
      ];
    },

    async listDir(path) {
      const entries = await invoke<SftpEntry[]>("local_list_dir", { path });
      return entries.map(toExplorerEntry);
    },
    homeDir() {
      return invoke<string>("local_home_dir");
    },
    mkdir(path) {
      return invoke("local_mkdir", { path });
    },
    createFile(path) {
      return invoke("local_create_file", { path });
    },
    delete(entry) {
      return invoke("local_delete", { path: entry.id, isDir: entry.entryType === "Directory" });
    },
    rename(entry, newPath) {
      return invoke("local_rename", { oldPath: entry.id, newPath });
    },
  };
}
