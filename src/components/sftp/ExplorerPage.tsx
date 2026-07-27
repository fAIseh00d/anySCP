import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Cloud, HardDrive } from "lucide-react";
import { Explorer } from "../explorer/Explorer";
import { S3Explorer } from "../s3/S3Explorer";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createLocalProvider } from "../../providers/local-provider";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useSettingsStore } from "../../stores/settings-store";
import { WorkspaceArea } from "../workspace/WorkspaceArea";
import type { Transport } from "../../lib/explorer-transport";
import type { LayoutNode, PaneContent } from "../../types";
import type {
  ExplorerEntry,
  PaneRuntime,
  CrossPaneTarget,
} from "../../types/explorer";

interface ExplorerPageProps {
  /** SFTP/SCP transport session id (both live in the sftp store). */
  sftpSessionId?: string;
  /** Defaults to "sftp"; "scp" when the host fell back to SCP. */
  transport?: Transport;
  s3SessionId?: string;
  /** Whether this tab is the active/visible one. Explorer tabs stay mounted
   *  (issue #17), so document-level listeners must only fire for the active one. */
  isActive?: boolean;
}

/**
 * A bordered explorer pane (header + content) — the explorer's equivalent of
 * TerminalPane, rendered by WorkspaceArea for each leaf. Fills via `h-full`
 * (not flex-1) so it works inside a split child, which is a plain block. In
 * dual-pane it shows an accent border when focused; a mousedown focuses it.
 */
function ExplorerPane({
  icon: Icon,
  label,
  transport,
  highlighted,
  onActivate,
  children,
}: {
  icon: React.ElementType;
  label: string;
  transport?: string;
  highlighted: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseDownCapture={onActivate}
      className={[
        "flex flex-col h-full min-h-0 rounded-lg overflow-hidden border transition-colors duration-[var(--duration-fast)]",
        highlighted ? "border-accent/50" : "border-border/60",
      ].join(" ")}
    >
      {/* Pane header — matching terminal pane style */}
      <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
        <Icon size={14} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
        <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={label}>
          {label}
        </span>
      </div>
      <div className="flex-1 min-h-0 bg-bg-base" data-explorer-transport={transport}>
        {children}
      </div>
    </div>
  );
}

export function ExplorerPage({ sftpSessionId, transport = "sftp", s3SessionId, isActive = true }: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => sftpSessionId ? s.sessions.get(sftpSessionId) : null);
  const s3Session = useS3Store((s) => s3SessionId ? s.sessions.get(s3SessionId) : null);
  const dualPane = useSettingsStore((s) => s.explorerDualPane);

  const baseLabel = sftpSession?.label ?? s3Session?.label ?? "Explorer";
  // Surface SCP fallback subtly so the user understands why server-side
  // metadata (timestamps, etc.) may look slightly different.
  const label = sftpSessionId && transport === "scp" ? `${baseLabel} · SCP` : baseLabel;

  const sftpProvider = useMemo(
    () => (sftpSessionId ? createSftpProvider(sftpSessionId, transport) : null),
    [sftpSessionId, transport],
  );

  // Left pane = local filesystem (WinSCP-style), scoped per tab so each keeps
  // its own cwd. Only created when dual-pane is on.
  const remoteId = sftpSessionId ?? s3SessionId ?? "";
  const localKey = `local:${remoteId}`;
  const localProvider = useMemo(
    () => (dualPane ? createLocalProvider(localKey) : null),
    [dualPane, localKey],
  );

  // Divider position + which pane is focused. Only the focused pane is "active"
  // (its document-level listeners fire), so the two don't fight over shortcuts.
  const [ratio, setRatio] = useState(0.5);
  const [focusedId, setFocusedId] = useState(remoteId);

  // ─── Cross-pane transfer coordinator ──────────────────────────────────────
  // Both Explorers register a runtime here; a "Copy to <sibling>" action reads
  // the target pane's cwd and drives the SFTP provider (which owns both
  // upload and download). Only meaningful for the local↔SFTP/SCP dual-pane —
  // the S3 pane uses a separate component and doesn't participate.
  const crossPaneEnabled = dualPane && !!sftpProvider;
  const runtimes = useRef<{ local: PaneRuntime | null; remote: PaneRuntime | null }>({
    local: null,
    remote: null,
  });
  const registerLocalRuntime = useCallback((rt: PaneRuntime | null) => {
    runtimes.current.local = rt;
  }, []);
  const registerRemoteRuntime = useCallback((rt: PaneRuntime | null) => {
    runtimes.current.remote = rt;
  }, []);

  // Pending source deletions for in-flight cross-pane MOVES, keyed by the queued
  // transfer id. When that id's transfer reports Completed, the mapped source is
  // deleted; on Failed/Cancelled it's dropped undeleted. This is what makes a
  // move safe — the source only goes away once its transfer has actually landed.
  const pendingMoves = useRef(new Map<string, { role: "local" | "remote"; entry: ExplorerEntry }>());

  // Core cross-pane transfer (local↔remote), shared by copy and move. `onEnqueued`
  // (move only) receives the queued transfer ids so the source can be deleted once
  // each completes. Copy passes nothing, so no source is ever removed.
  const transfer = useCallback(
    (
      fromRole: "local" | "remote",
      entries: ExplorerEntry[],
      onEnqueued?: (ids: string[]) => void,
      // Destination dir override (a folder/".." the drop landed on); omitted =
      // the destination pane's cwd.
      targetDir?: string,
    ) => {
      if (entries.length === 0) return;
      const { local, remote } = runtimes.current;
      if (!local || !remote) return;
      if (fromRole === "local") {
        // local → remote: upload into the remote pane's target dir (the remote
        // pane's uploadInto runs its own overwrite guard).
        remote.uploadInto?.(entries.map((e) => e.id), onEnqueued, targetDir);
      } else {
        // remote → local: let the local pane guard against clobbering its own
        // files (same overwrite dialog as an upload), then download into it.
        const run = (localDir: string) => remote.downloadTo?.(entries, localDir, onEnqueued);
        if (local.receiveDownload) local.receiveDownload(entries, run, targetDir);
        else run(targetDir ?? local.getCurrentPath());
      }
    },
    [],
  );

  const transferCopy = useCallback(
    (fromRole: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) =>
      transfer(fromRole, entries, undefined, targetDir),
    [transfer],
  );

  const transferMove = useCallback(
    (fromRole: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) => {
      transfer(fromRole, entries, (ids) => {
        // ids[i] ↔ entries[i] (enqueue preserves order). If the backend returned
        // a different count we can't map ids→sources safely, so we skip the
        // auto-delete entirely: the move degrades to a copy, never a wrong delete.
        if (ids.length !== entries.length) {
          console.warn("cross-pane move: transfer id/entry count mismatch — leaving sources in place");
          return;
        }
        ids.forEach((id, i) => pendingMoves.current.set(id, { role: fromRole, entry: entries[i] }));
      }, targetDir);
    },
    [transfer],
  );

  // Shared cross-pane clipboard: the single most-recent clipboard action across
  // both panes (copy OR cut), tagged with its source role. `syncClipboard` writes
  // it on every copy/cut; each pane's `pasteFromSibling` reads it and, when the
  // action came from the OTHER pane, drives a copy (copy) or a move (cut). Tracking
  // cuts here — not just copies — is what stops a stale per-pane clipboard from
  // hijacking a paste after a cut in the sibling.
  const crossClipboard = useRef<
    { role: "local" | "remote"; operation: "copy" | "cut"; entries: ExplorerEntry[] } | null
  >(null);
  const hasSiblingClipboard = useCallback(
    (paneRole: "local" | "remote") => {
      const clip = crossClipboard.current;
      return !!clip && clip.role !== paneRole;
    },
    [],
  );
  const pasteFromSibling = useCallback(
    (paneRole: "local" | "remote") => {
      const clip = crossClipboard.current;
      if (!clip || clip.role === paneRole) return false;
      if (clip.operation === "cut") {
        transferMove(clip.role, clip.entries);
        crossClipboard.current = null; // a cut moves once, then it's spent
        // Clear the source pane's own clipboard too, so a later same-pane paste
        // there doesn't try to move the now-relocated files.
        runtimes.current[clip.role]?.clearClipboard?.();
      } else {
        transferCopy(clip.role, clip.entries);
      }
      return true;
    },
    [transferCopy, transferMove],
  );

  const localCrossPane = useMemo<CrossPaneTarget | undefined>(
    () =>
      crossPaneEnabled
        ? {
            siblingLabel: label,
            copyTo: (entries, targetDir) => transferCopy("local", entries, targetDir),
            moveTo: (entries, targetDir) => transferMove("local", entries, targetDir),
            syncClipboard: (clip) => {
              crossClipboard.current = clip
                ? { role: "local", operation: clip.operation, entries: clip.entries }
                : null;
            },
            pasteFromSibling: () => pasteFromSibling("local"),
            hasSiblingClipboard: () => hasSiblingClipboard("local"),
          }
        : undefined,
    [crossPaneEnabled, label, transferCopy, transferMove, pasteFromSibling, hasSiblingClipboard],
  );
  const remoteCrossPane = useMemo<CrossPaneTarget | undefined>(
    () =>
      crossPaneEnabled
        ? {
            siblingLabel: "Local",
            copyTo: (entries, targetDir) => transferCopy("remote", entries, targetDir),
            moveTo: (entries, targetDir) => transferMove("remote", entries, targetDir),
            syncClipboard: (clip) => {
              crossClipboard.current = clip
                ? { role: "remote", operation: clip.operation, entries: clip.entries }
                : null;
            },
            pasteFromSibling: () => pasteFromSibling("remote"),
            hasSiblingClipboard: () => hasSiblingClipboard("remote"),
          }
        : undefined,
    [crossPaneEnabled, transferCopy, transferMove, pasteFromSibling, hasSiblingClipboard],
  );

  // The remote pane self-refreshes on upload completion; downloads land in the
  // local pane, whose provider emits no transfer events — so refresh it here
  // when a download for this session finishes. The channel + id field track the
  // transport, since an SCP-fallback remote emits `scp:transfer`/`scp_session_id`.
  useEffect(() => {
    if (!crossPaneEnabled || !sftpSessionId) return;
    const channel = `${transport}:transfer`;
    const idField = `${transport}_session_id`;
    let aborted = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;
        const unsub = await listen<{
          transfer_id?: string;
          direction?: string;
          // Unit variants serialize as strings ("Completed", "Cancelled", …);
          // the `Failed(String)` variant serializes as an object `{Failed: "…"}`.
          status?: string | Record<string, unknown>;
          [k: string]: unknown;
        }>(channel, (event) => {
          const p = event.payload;
          if (p[idField] !== sftpSessionId) return;

          const status = p.status;
          const completed = status === "Completed";
          // Terminal failure = "Cancelled" or the object form of `Failed(String)`.
          const failed = status === "Cancelled" || (typeof status === "object" && status !== null);

          // Cross-pane MOVE: once a tracked transfer lands, delete its source;
          // if it failed or was cancelled, drop it undeleted (never lose data).
          const id = typeof p.transfer_id === "string" ? p.transfer_id : undefined;
          if (id && pendingMoves.current.has(id)) {
            if (completed) {
              const { role, entry } = pendingMoves.current.get(id)!;
              pendingMoves.current.delete(id);
              setTimeout(() => runtimes.current[role]?.remove?.([entry]), 300);
            } else if (failed) {
              pendingMoves.current.delete(id);
            }
          }

          // Downloads land in the local pane, which emits no transfer events of
          // its own — refresh it here when one for this session finishes.
          if (p.direction === "Download" && completed) {
            setTimeout(() => runtimes.current.local?.refresh(), 300);
          }
        });
        if (aborted) unsub();
        else unlisten = unsub;
      } catch {
        /* Not in a Tauri context */
      }
    })();
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [crossPaneEnabled, sftpSessionId, transport]);

  const remoteContent: PaneContent = sftpSessionId
    ? { kind: "sftp", sessionId: sftpSessionId, transport }
    : { kind: "s3", sessionId: s3SessionId ?? "" };

  // Dual-pane is just a horizontal split of [local, remote]; single is one pane.
  const layout: LayoutNode = dualPane
    ? {
        type: "split",
        direction: "horizontal",
        ratio,
        children: [
          { type: "pane", content: { kind: "local", sessionId: localKey } },
          { type: "pane", content: remoteContent },
        ],
      }
    : { type: "pane", content: remoteContent };

  const renderPane = (content: PaneContent) => {
    const paneActive = isActive && (!dualPane || content.sessionId === focusedId);
    const highlighted = dualPane && content.sessionId === focusedId;
    const onActivate = () => setFocusedId(content.sessionId);

    if (content.kind === "local") {
      return (
        <ExplorerPane icon={HardDrive} label="Local" transport="local" highlighted={highlighted} onActivate={onActivate}>
          {localProvider && (
            <Explorer
              provider={localProvider}
              isActive={paneActive}
              tabActive={isActive}
              registerRuntime={registerLocalRuntime}
              crossPane={localCrossPane}
              dense={dualPane}
            />
          )}
        </ExplorerPane>
      );
    }
    if (content.kind === "s3") {
      return (
        <ExplorerPane icon={Cloud} label={label} transport="s3" highlighted={highlighted} onActivate={onActivate}>
          <S3Explorer sessionId={content.sessionId} isActive={paneActive} />
        </ExplorerPane>
      );
    }
    if (content.kind === "sftp") {
      return (
        <ExplorerPane icon={FolderOpen} label={label} transport={content.transport} highlighted={highlighted} onActivate={onActivate}>
          {sftpProvider && (
            <Explorer
              provider={sftpProvider}
              isActive={paneActive}
              tabActive={isActive}
              registerRuntime={registerRemoteRuntime}
              crossPane={remoteCrossPane}
              dense={dualPane}
            />
          )}
        </ExplorerPane>
      );
    }
    return null; // terminal panes never occur in an explorer tab
  };

  return (
    <div className="flex flex-col h-full p-2">
      <WorkspaceArea
        node={layout}
        tabId={remoteId}
        zoomed={false}
        setRatio={(_tabId, _path, r) => setRatio(r)}
        renderPane={renderPane}
      />
    </div>
  );
}
