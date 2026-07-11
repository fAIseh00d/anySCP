import type { EditorConfig } from "../stores/settings-store";

// ─── Unified explorer types ──────────────────────────────────────────────────

/** Normalized file entry that both SFTP and S3 entries convert into. */
export interface ExplorerEntry {
  /** Display name */
  name: string;
  /** Unique identifier (SFTP: absolute path, S3: object key) */
  id: string;
  entryType: "File" | "Directory";
  size: number;
  /** Unix timestamp in seconds */
  modified: number | null;
  /** SFTP-only: e.g. "drwxr-xr-x" */
  permissionsDisplay: string | null;
  /** SFTP-only: raw Unix mode (lower 12 bits incl. setuid/setgid/sticky), or
   *  `null` when the transport has no Unix permissions (e.g. S3). Used to
   *  preserve special bits the rwx display string can't represent. */
  permissions: number | null;
  /** SFTP-only */
  isSymlink: boolean;
  /** S3-only: e.g. "STANDARD", "GLACIER" */
  storageClass: string | null;
}

/** Result of a recursive chmod — mirrors the Rust `ChmodSummary`. */
export interface ChmodResult {
  /** Number of entries whose permissions were successfully updated. */
  applied: number;
  /** Per-entry failure messages collected during the walk (empty = success). */
  errors: string[];
}

/** Outcome of an OS drag-out — mirrors the Rust `DragOutResult`. */
export interface DragOutResult {
  /** True if the native drag ended in a drop (vs. cancelled). */
  dropped: boolean;
  /** Number of top-level items that were dragged. */
  count: number;
}

/** Clipboard for copy/cut/paste within a session. */
export interface ExplorerClipboard {
  entries: ExplorerEntry[];
  operation: "copy" | "cut";
  sourceSessionId: string;
}

/** Controls which UI elements and actions are available. */
export interface ProviderCapabilities {
  canRename: boolean;
  canCreateFile: boolean;
  canCreateFolder: boolean;
  canDelete: boolean;
  canUpload: boolean;
  canDownload: boolean;
  canDragDropUpload: boolean;
  canInternalDragMove: boolean;
  canCopyPaste: boolean;
  canEditInEditor: boolean;
  canGetInfo: boolean;
  hasPermissions: boolean;
  hasStorageClass: boolean;
  canPresignUrl: boolean;
}

/**
 * Operations adapter — the single seam between the shared explorer UI and a
 * concrete backend (SFTP/SCP or S3). One provider-driven container renders every
 * backend; each provider maps the abstract operations below to its own commands
 * (e.g. `delete` → `sftp_delete` / `s3_delete_object`). Operations that a backend
 * can't do are left unimplemented and gated by the matching capability, so the
 * UI hides them.
 */
export interface FileSystemProvider {
  readonly type: "sftp" | "scp" | "s3";
  readonly sessionId: string;
  readonly capabilities: ProviderCapabilities;

  // ─── Path helpers (pure, sync) ───────────────────────────────────────────
  /** Join a parent path with a child name. */
  joinPath(parent: string, child: string): string;
  /** Get the parent of a path. */
  parentPath(path: string): string;
  /** Display label for the root (SFTP: "/", S3: bucket name, local: "/" or drive). */
  rootLabel(): string;

  // ─── Operations (async; map to backend commands) ─────────────────────────
  /** List a directory, normalized to `ExplorerEntry` rows. */
  listDir(path: string): Promise<ExplorerEntry[]>;
  /** The starting directory (SFTP/local home; S3 root prefix ""). */
  homeDir(): Promise<string>;
  /** Create a directory at the given full path. */
  mkdir(path: string): Promise<void>;
  /** Create an empty file at the given full path. */
  createFile(path: string): Promise<void>;
  /** Delete an entry (folder or file — the provider handles the distinction). */
  delete(entry: ExplorerEntry): Promise<void>;

  // ─── Optional operations (gated by the matching capability) ──────────────
  /** Rename/move within the same dir. Requires `canRename`. */
  rename?(entry: ExplorerEntry, newPath: string): Promise<void>;
  /** Change permissions. Requires `hasPermissions`; returns a recursive summary. */
  chmod?(entry: ExplorerEntry, mode: number, recursive: boolean): Promise<ChmodResult | undefined>;
  /** Open in an external editor. Requires `canEditInEditor`. */
  editInEditor?(entry: ExplorerEntry, editor: EditorConfig | null): Promise<void>;
  /** Move entries into a target dir (in-backend). Requires `canInternalDragMove`. */
  move?(sourceIds: string[], targetDir: string): Promise<void>;
  /** Copy entries into a target dir (in-backend). Requires `canCopyPaste`. */
  copy?(sourceIds: string[], targetDir: string): Promise<void>;
  /** Presign a shareable URL. Requires `canPresignUrl` (S3). */
  presignUrl?(entry: ExplorerEntry): Promise<string>;
  /** Stage the selection and start a native OS drag-out. SFTP/SCP only. */
  dragOut?(entryIds: string[]): Promise<DragOutResult>;

  // ─── Transfers (the dual-pane coordinator decides direction/refresh; the
  //     provider just knows its own command). Gated by canUpload/canDownload. ─
  /** Download one entry to an exact local path (save-as). */
  downloadAs?(entry: ExplorerEntry, localPath: string): Promise<void>;
  /** Download several entries into a local directory (through the queue). */
  enqueueDownload?(entryIds: string[], localDir: string): Promise<void>;
  /** Upload local paths into a target dir on this backend (through the queue). */
  enqueueUpload?(localPaths: string[], targetDir: string): Promise<void>;
}
