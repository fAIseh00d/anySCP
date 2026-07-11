import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import { usePaneState } from "../../hooks/use-pane-state";
import type { ExplorerEntry, ChmodResult, FileSystemProvider } from "../../types/explorer";
import { ExplorerToolbar } from "./ExplorerToolbar";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { ExplorerDropZone } from "./ExplorerDropZone";
import { DropOverwriteDialog } from "../sftp/DropOverwriteDialog";
import { conflictingNames } from "../../lib/drop-conflicts";
import { editorLaunchErrorMessage } from "../../lib/editor-errors";
import { toast } from "../../stores/toast-store";
import type { EditorConfig } from "../../stores/settings-store";

interface ExplorerProps {
  /** The backend adapter — one container drives SFTP/SCP and S3 through it. */
  provider: FileSystemProvider;
  /** Whether this explorer's tab is active/visible. Explorer tabs stay mounted
   *  (issue #17), so document-level listeners are gated to the active one. */
  isActive?: boolean;
}

/**
 * The single file-explorer container. All backend calls go through `provider`;
 * per-pane browsing state comes from `usePaneState`. Backend-specific bits are
 * gated by capabilities or provider type (sudo → SFTP; presign → S3).
 */
export function Explorer({ provider, isActive = true }: ExplorerProps) {
  const sessionId = provider.sessionId;
  const caps = provider.capabilities;
  const isSftpLike = provider.type === "sftp" || provider.type === "scp";
  const pane = usePaneState(provider);

  const currentPathRef = useRef(pane.currentPath);
  currentPathRef.current = pane.currentPath;

  // ─── Navigation ────────────────────────────────────────────────────────────

  const loadDirectory = useCallback(
    async (path: string) => {
      pane.setLoading(true);
      try {
        pane.setEntries(path, await provider.listDir(path));
      } catch (err) {
        pane.setError(errorMessage(err, "Failed to list directory"));
      }
    },
    // pane's setters are recreated each render but the effects/handlers that
    // matter gate on sessionId; see eslint-disable notes below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  );

  // ─── Drag-and-drop (OS → App) ─────────────────────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const isProcessingDrop = useRef(false);
  const isDraggingOut = useRef(false);

  const uploadDropped = useCallback(
    async (localPaths: string[], remoteDir: string) => {
      try {
        await provider.enqueueUpload?.(localPaths, remoteDir);
      } catch (err) {
        toast.error(`Upload failed: ${errorMessage(err)}`);
      }
    },
    [provider],
  );

  const confirmOverwrite = useCallback(() => {
    const pd = pendingDrop;
    setPendingDrop(null);
    isProcessingDrop.current = false;
    if (pd) void uploadDropped(pd.localPaths, pd.remoteDir);
  }, [pendingDrop, uploadDropped]);

  const cancelOverwrite = useCallback(() => {
    setPendingDrop(null);
    isProcessingDrop.current = false;
  }, []);

  // Resolve the upload destination for an OS drop: hit-test the window position
  // against the listing so a drop on a folder row uploads INTO that folder.
  const resolveDropDir = useCallback(
    (position?: { x: number; y: number }): string => {
      const base = currentPathRef.current;
      if (!position) return base;
      const scale = isWindowsWebview() ? window.devicePixelRatio || 1 : 1;
      const el = document.elementFromPoint(position.x / scale, position.y / scale);
      const row = el?.closest("[data-entry-row]") as HTMLElement | null;
      if (row && row.dataset.entryType === "Directory") {
        const name = row.dataset.entryName;
        const target = pane.entries.find((e) => e.name === name && e.entryType === "Directory");
        if (target) return target.id;
      }
      return base;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.entries],
  );

  useEffect(() => {
    if (!isActive || !caps.canDragDropUpload || !provider.enqueueUpload) return;

    let aborted = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        type DragDropTarget = { onDragDropEvent: (cb: (e: DragDropEventPayload) => void) => Promise<() => void> };
        let appWindow: DragDropTarget | null = null;
        try {
          const mod = await import("@tauri-apps/api/webviewWindow");
          appWindow = mod.getCurrentWebviewWindow() as unknown as DragDropTarget;
        } catch {
          try {
            const mod2 = await import("@tauri-apps/api/webview");
            if ("getCurrentWebview" in mod2 && typeof mod2.getCurrentWebview === "function") {
              appWindow = (mod2.getCurrentWebview as () => DragDropTarget)();
            }
          } catch { /* Drag-drop API unavailable */ }
        }
        if (!appWindow || aborted) return;

        const unsub = await appWindow.onDragDropEvent((event: DragDropEventPayload) => {
          if (isDraggingOut.current) return;
          const type = event.payload?.type;
          if (type === "enter" || type === "over") {
            setIsDragOver(true);
            setDropTargetDir(resolveDropDir(event.payload?.position));
          } else if (type === "drop") {
            setIsDragOver(false);
            setDropTargetDir(null);
            const paths: string[] = event.payload?.paths ?? [];
            if (paths.some((p) => p.includes(DRAGOUT_STAGING_SEGMENT))) return;
            if (isProcessingDrop.current || paths.length === 0) return;
            isProcessingDrop.current = true;
            const remoteDir = resolveDropDir(event.payload?.position);

            void (async () => {
              let conflicts: string[] = [];
              try {
                const existing = await provider.listDir(remoteDir);
                conflicts = conflictingNames(paths, new Set(existing.map((e) => e.name)));
              } catch { /* skip the pre-check; proceed to upload */ }

              if (conflicts.length > 0) {
                setPendingDrop({ localPaths: paths, remoteDir, conflicts });
                return;
              }
              await uploadDropped(paths, remoteDir);
              setTimeout(() => { isProcessingDrop.current = false; }, 500);
            })();
          } else {
            setIsDragOver(false);
            setDropTargetDir(null);
          }
        });

        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Tauri API not available */ }
    })();

    return () => { aborted = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isActive, resolveDropDir, uploadDropped]);

  // ─── Auto-refresh on upload completion ────────────────────────────────────

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    const sessionField = `${provider.type}_session_id`;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;
        const unsub = await listen<Record<string, string>>(`${provider.type}:transfer`, (event) => {
          const p = event.payload;
          if (p[sessionField] === sessionId && p.direction === "Upload" && p.status === "Completed") {
            setTimeout(() => {
              const path = currentPathRef.current;
              if (path !== undefined) void loadDirectory(path);
            }, 300);
          }
        });
        if (aborted) { unsub(); } else { unlisten = unsub; }
      } catch { /* Not in Tauri context */ }
    })();
    return () => { aborted = true; unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider.type]);

  // ─── Sudo toggle (SFTP only) ──────────────────────────────────────────────

  const sudoMode = useSftpStore((s) => s.sessions.get(sessionId)?.sudoMode ?? false);
  const sshSessionId = useSftpStore((s) => s.sessions.get(sessionId)?.sshSessionId ?? "");
  const isRoot = useSftpStore((s) => s.sessions.get(sessionId)?.username === "root");
  const swapSession = useSftpStore((s) => s.swapSession);
  const replaceTabId = useTabStore((s) => s.replaceTabId);
  const [togglingSudo, setTogglingSudo] = useState(false);

  const handleToggleSudo = useCallback(async () => {
    if (provider.type !== "sftp" || togglingSudo) return;
    const newSudoMode = !sudoMode;
    setTogglingSudo(true);
    try {
      const newSftpSessionId = await invoke<string>("sftp_open", { sessionId: sshSessionId, useSudo: newSudoMode });
      try { await invoke("sftp_close", { sftpSessionId: sessionId }); } catch { /* ignore */ }
      swapSession(sessionId, newSftpSessionId, newSudoMode);
      replaceTabId(sessionId, newSftpSessionId);
    } catch (err) {
      pane.setError(errorMessage(err, `Failed to ${newSudoMode ? "enable" : "disable"} sudo mode`));
    } finally {
      setTogglingSudo(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.type, togglingSudo, sudoMode, sessionId, sshSessionId, swapSession, replaceTabId]);

  // ─── Mount: resolve the starting directory ─────────────────────────────────

  useEffect(() => {
    (async () => {
      // SFTP "/" means "unresolved" → walk the start-dir → home → root chain.
      // S3's "" is the real root and is loaded directly.
      if (isSftpLike) {
        const state = useSftpStore.getState().sessions.get(sessionId);
        const preserved = state?.currentPath;
        if (preserved && preserved !== "/") { await loadDirectory(preserved); return; }

        const tryList = async (path: string): Promise<boolean> => {
          try { pane.setEntries(path, await provider.listDir(path)); return true; } catch { return false; }
        };
        let homeDir: string | null = null;
        const resolveHome = async (): Promise<string> => {
          if (homeDir === null) { try { homeDir = await provider.homeDir(); } catch { homeDir = ""; } }
          return homeDir;
        };

        const startDir = (state?.startDirectory ?? "").trim();
        if (startDir) {
          let target: string | null = startDir;
          if (startDir === "~" || startDir.startsWith("~/")) {
            const home = await resolveHome();
            target = !home ? null : startDir === "~" ? home : `${home.replace(/\/+$/, "")}/${startDir.slice(2)}`;
          }
          if (target && (await tryList(target))) return;
        }
        const home = await resolveHome();
        if (home && (await tryList(home))) return;
        await loadDirectory("/");
      } else {
        const preserved = currentPathRef.current;
        await loadDirectory(preserved || (await safeHome(provider)));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, provider.type]);

  // ─── Download ──────────────────────────────────────────────────────────────

  const handleDownload = useCallback(async (entry: ExplorerEntry) => {
    try {
      if (entry.entryType === "Directory") {
        if (!provider.enqueueDownload) return; // e.g. S3 has no batch/dir download
        const { open } = await import("@tauri-apps/plugin-dialog");
        const localDir = (await open({ directory: true, title: `Download "${entry.name}" to…` })) as string | null;
        if (!localDir) return;
        await provider.enqueueDownload([entry.id], localDir);
      } else {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const savePath = await save({ defaultPath: entry.name, title: `Save "${entry.name}" as…` });
        if (!savePath) return;
        await provider.downloadAs?.(entry, savePath);
      }
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [provider]);

  const handleDownloadMany = useCallback(async (entries: ExplorerEntry[]) => {
    if (entries.length === 0 || !provider.enqueueDownload) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const localDir = (await open({ directory: true, title: `Download ${entries.length} items to…` })) as string | null;
      if (!localDir) return;
      await provider.enqueueDownload(entries.map((e) => e.id), localDir);
    } catch (err) {
      console.error("Download failed:", err);
    }
  }, [provider]);

  // ─── Drag-out (Explorer → OS) ───────────────────────────────────────────────

  const handleDragOut = useCallback((entries: ExplorerEntry[]) => {
    if (isDraggingOut.current || !provider.dragOut) return;
    isDraggingOut.current = true;
    void (async () => {
      let prepToast: string | null = null;
      const prepTimer = setTimeout(() => { prepToast = toast.info("Preparing download…"); }, 400);
      try {
        const { dropped, count } = await provider.dragOut!(entries.map((e) => e.id));
        if (dropped && count > 0) toast.success(`Downloaded ${count} ${count === 1 ? "item" : "items"}`);
      } catch (err) {
        toast.error(`Download failed: ${errorMessage(err)}`);
      } finally {
        clearTimeout(prepTimer);
        if (prepToast) toast.dismiss(prepToast);
        isDraggingOut.current = false;
      }
    })();
  }, [provider]);

  // ─── Upload (dialog) ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({ multiple: true, title: "Upload file" });
      if (!selection) return;
      const localPaths = Array.isArray(selection) ? selection : [selection];
      if (localPaths.length === 0) return;
      await provider.enqueueUpload?.(localPaths, currentPathRef.current);
    } catch { /* Upload errors surface in the transfer overlay */ }
  }, [provider]);

  // ─── New folder/file (inline) ─────────────────────────────────────────────

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [creatingFile, setCreatingFile] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    const folderHandler = () => setCreatingFolder(true);
    const fileHandler = () => setCreatingFile(true);
    document.addEventListener("explorer:new-folder", folderHandler);
    document.addEventListener("explorer:new-file", fileHandler);
    return () => {
      document.removeEventListener("explorer:new-folder", folderHandler);
      document.removeEventListener("explorer:new-file", fileHandler);
    };
  }, [isActive]);

  const handleCreateFile = useCallback(async (name: string) => {
    setCreatingFile(false);
    if (!name.trim()) return;
    try {
      await provider.createFile(provider.joinPath(currentPathRef.current, name.trim()));
      await loadDirectory(currentPathRef.current);
    } catch { /* Error shown via refresh */ }
  }, [provider, loadDirectory]);

  const handleCreateFolder = useCallback(async (name: string) => {
    setCreatingFolder(false);
    if (!name.trim()) return;
    try {
      await provider.mkdir(provider.joinPath(currentPathRef.current, name.trim()));
      await loadDirectory(currentPathRef.current);
    } catch { /* Error shown via refresh */ }
  }, [provider, loadDirectory]);

  // ─── Delete / Rename / Permissions / Editor ────────────────────────────────

  const handleDelete = useCallback(async (entriesToDelete: ExplorerEntry[]) => {
    try {
      for (const entry of entriesToDelete) await provider.delete(entry);
    } catch { /* Partial deletes may occur */ }
    void loadDirectory(currentPathRef.current);
  }, [provider, loadDirectory]);

  const handleRename = useCallback(async (entry: ExplorerEntry, newName: string) => {
    const parent = provider.parentPath(entry.id);
    try {
      await provider.rename?.(entry, provider.joinPath(parent, newName));
      void loadDirectory(currentPathRef.current);
    } catch (err) {
      console.error("Rename failed:", err);
    }
  }, [provider, loadDirectory]);

  const handleApplyPermissions = useCallback(async (entry: ExplorerEntry, mode: number, recursive: boolean) => {
    const result = await provider.chmod?.(entry, mode, recursive);
    try { await loadDirectory(currentPathRef.current); } catch (err) { console.error("Refresh after chmod failed:", err); }
    return result as ChmodResult | undefined;
  }, [provider, loadDirectory]);

  const handleEditInEditor = useCallback((entry: ExplorerEntry, editor?: EditorConfig) => {
    void (async () => {
      try {
        await provider.editInEditor?.(entry, editor ?? null);
      } catch (err) {
        toast.error(editorLaunchErrorMessage(err));
      }
    })();
  }, [provider]);

  const handlePresignUrl = useCallback(async (entry: ExplorerEntry) => {
    try {
      const url = await provider.presignUrl?.(entry);
      if (url) await navigator.clipboard.writeText(url);
    } catch { /* best-effort */ }
  }, [provider]);

  // ─── Paste / Move / Copy ─────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);

  const handlePaste = useCallback(async () => {
    const clip = pane.clipboard;
    if (!clip || clip.sourceSessionId !== sessionId) return;
    const sourceIds = clip.entries.map((e) => e.id);
    const targetDir = currentPathRef.current;
    setBusy(true);
    try {
      if (clip.operation === "cut") {
        await provider.move?.(sourceIds, targetDir);
        pane.setClipboard(null);
      } else {
        await provider.copy?.(sourceIds, targetDir);
      }
      await loadDirectory(targetDir);
    } catch (err) {
      pane.setError(err instanceof Error ? err.message : "Paste failed");
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, sessionId, pane.clipboard, loadDirectory]);

  const handleMoveEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      await provider.move?.(sourceIds, targetDir);
      await loadDirectory(currentPathRef.current);
    } catch (err) {
      pane.setError(err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, loadDirectory]);

  const handleCopyEntries = useCallback(async (sourceIds: string[], targetDir: string) => {
    setBusy(true);
    try {
      await provider.copy?.(sourceIds, targetDir);
      await loadDirectory(currentPathRef.current);
    } catch (err) {
      pane.setError(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, loadDirectory]);

  // ─── Render ────────────────────────────────────────────────────────────────

  const segments = provider.breadcrumbs(pane.currentPath);

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      <ExplorerToolbar
        provider={provider}
        currentPath={pane.currentPath}
        segments={segments}
        loading={pane.loading}
        onNavigate={(path) => void loadDirectory(path)}
        onRefresh={() => void loadDirectory(pane.currentPath)}
        onNewFile={() => setCreatingFile(true)}
        onNewFolder={() => setCreatingFolder(true)}
        onUpload={() => void handleUpload()}
        busy={busy}
        sudoMode={sudoMode}
        sudoBusy={togglingSudo}
        onToggleSudo={provider.type === "sftp" && !isRoot ? () => void handleToggleSudo() : undefined}
      />

      {pane.error && (
        <div
          data-testid="explorer-error"
          className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error"
        >
          <AlertCircle size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <p className="text-[length:var(--text-sm)]">{pane.error}</p>
        </div>
      )}

      <ExplorerFileTable
        provider={provider}
        entries={pane.entries}
        sortBy={pane.sortBy}
        sortAsc={pane.sortAsc}
        onSortChange={(sortBy, sortAsc) => pane.setSort(sortBy, sortAsc)}
        clipboard={pane.clipboard}
        onSetClipboard={(c) => pane.setClipboard(c)}
        onNavigate={(path) => void loadDirectory(path)}
        onDownload={(entry) => void handleDownload(entry)}
        onDownloadMany={provider.enqueueDownload ? (entries) => void handleDownloadMany(entries) : undefined}
        onDelete={handleDelete}
        onRename={caps.canRename ? handleRename : undefined}
        onEditInEditor={caps.canEditInEditor ? handleEditInEditor : undefined}
        onApplyPermissions={caps.hasPermissions ? handleApplyPermissions : undefined}
        onPresignUrl={caps.canPresignUrl ? (entry) => void handlePresignUrl(entry) : undefined}
        creatingFile={creatingFile}
        onCreateFile={(name) => void handleCreateFile(name)}
        onCancelCreateFile={() => setCreatingFile(false)}
        creatingFolder={creatingFolder}
        onCreateFolder={(name) => void handleCreateFolder(name)}
        onCancelCreateFolder={() => setCreatingFolder(false)}
        onPaste={caps.canCopyPaste ? () => void handlePaste() : undefined}
        onMoveEntries={caps.canInternalDragMove ? handleMoveEntries : undefined}
        onCopyEntries={caps.canCopyPaste ? handleCopyEntries : undefined}
        onDragOut={provider.dragOut ? handleDragOut : undefined}
        currentPath={pane.currentPath}
        loading={pane.loading}
        busy={busy}
      />

      {isDragOver && (
        <ExplorerDropZone
          path={dropTargetDir ?? pane.currentPath}
          intoFolder={!!dropTargetDir && dropTargetDir !== pane.currentPath}
        />
      )}

      {pendingDrop && (
        <DropOverwriteDialog
          conflicts={pendingDrop.conflicts}
          targetDir={pendingDrop.remoteDir}
          onConfirm={confirmOverwrite}
          onCancel={cancelOverwrite}
        />
      )}
    </div>
  );
}

interface PendingDrop {
  localPaths: string[];
  remoteDir: string;
  conflicts: string[];
}

/** Best-effort home dir (empty string on failure = list the provider root). */
async function safeHome(provider: FileSystemProvider): Promise<string> {
  try { return await provider.homeDir(); } catch { return ""; }
}

function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message);
  return typeof err === "string" ? err : fallback;
}

/** Path segment of our drag-out staging dir (temp_dir/anyscp-dragout/<uuid>). */
const DRAGOUT_STAGING_SEGMENT = "anyscp-dragout";

function isWindowsWebview(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

interface DragDropEventPayload {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths: string[];
    position?: { x: number; y: number };
  };
}
