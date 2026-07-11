import { useMemo, useState } from "react";
import { FolderOpen, Cloud, HardDrive } from "lucide-react";
import { Explorer } from "../explorer/Explorer";
import { S3Explorer } from "../s3/S3Explorer";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createLocalProvider } from "../../providers/local-provider";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useSettingsStore } from "../../stores/settings-store";
import type { Transport } from "../../lib/explorer-transport";

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
 * A bordered explorer pane (header + content) — used for the single view and
 * for each side of dual-pane. In dual-pane it shows an accent border when it's
 * the focused pane; a mousedown anywhere in it makes it focused.
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
        "flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border transition-colors duration-[var(--duration-fast)]",
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
  const isSftp = !!sftpSessionId;
  const Icon = isSftp ? FolderOpen : Cloud;

  const sftpProvider = useMemo(
    () => (sftpSessionId ? createSftpProvider(sftpSessionId, transport) : null),
    [sftpSessionId, transport],
  );

  // Left pane = local filesystem (WinSCP-style), scoped per tab so each keeps
  // its own cwd. Only created when dual-pane is on.
  const remoteId = sftpSessionId ?? s3SessionId ?? "";
  const localProvider = useMemo(
    () => (dualPane ? createLocalProvider(`local:${remoteId}`) : null),
    [dualPane, remoteId],
  );

  // Which pane has focus. Only the focused pane is "active" (its document-level
  // listeners fire), so the two panes don't fight over keyboard shortcuts.
  const [focused, setFocused] = useState<"local" | "remote">("remote");
  const remoteActive = isActive && (!dualPane || focused === "remote");

  const remotePane = (
    <ExplorerPane
      icon={Icon}
      label={label}
      transport={sftpSessionId ? transport : s3SessionId ? "s3" : undefined}
      highlighted={dualPane && focused === "remote"}
      onActivate={() => setFocused("remote")}
    >
      {sftpSessionId && sftpProvider && <Explorer provider={sftpProvider} isActive={remoteActive} />}
      {s3SessionId && <S3Explorer sessionId={s3SessionId} isActive={remoteActive} />}
    </ExplorerPane>
  );

  return (
    <div className="flex flex-col h-full p-2">
      {dualPane && localProvider ? (
        <div className="flex flex-1 min-h-0 gap-2">
          <ExplorerPane
            icon={HardDrive}
            label="Local"
            transport="local"
            highlighted={focused === "local"}
            onActivate={() => setFocused("local")}
          >
            <Explorer provider={localProvider} isActive={isActive && focused === "local"} />
          </ExplorerPane>
          {remotePane}
        </div>
      ) : (
        remotePane
      )}
    </div>
  );
}
