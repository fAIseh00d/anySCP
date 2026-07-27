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

  const transferCopy = useCallback(
    (fromRole: "local" | "remote", entries: ExplorerEntry[]) => {
      if (entries.length === 0) return;
      const { local, remote } = runtimes.current;
      if (!local || !remote) return;
      if (fromRole === "local") {
        // local → remote: upload into the remote pane's current dir.
        remote.uploadInto?.(entries.map((e) => e.id));
      } else {
        // remote → local: download into the local pane's current dir.
        remote.downloadTo?.(entries, local.getCurrentPath());
      }
    },
    [],
  );

  const localCrossPane = useMemo<CrossPaneTarget | undefined>(
    () =>
      crossPaneEnabled
        ? { siblingLabel: label, copyTo: (entries) => transferCopy("local", entries) }
        : undefined,
    [crossPaneEnabled, label, transferCopy],
  );
  const remoteCrossPane = useMemo<CrossPaneTarget | undefined>(
    () =>
      crossPaneEnabled
        ? { siblingLabel: "Local", copyTo: (entries) => transferCopy("remote", entries) }
        : undefined,
    [crossPaneEnabled, transferCopy],
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
        const unsub = await listen<Record<string, string>>(channel, (event) => {
          const p = event.payload;
          if (
            p[idField] === sftpSessionId &&
            p.direction === "Download" &&
            p.status === "Completed"
          ) {
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
