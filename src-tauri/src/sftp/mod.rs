pub mod commands;
pub mod transfer_manager;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::ssh::health::{DATA_TIMEOUT, OP_TIMEOUT};

/// russh-sftp applies its own timeout to every request it sends. We demote it
/// to a **backstop** and let our own [`OP_TIMEOUT`] be the authoritative one, so
/// that a stalled request fails with a typed `Elapsed` we can classify.
///
/// The reason we cannot simply use the library's timer: on the `File`
/// byte-stream path (`AsyncRead`/`AsyncWrite`, which is how transfers move data)
/// russh-sftp flattens its typed error into `io::Error::new(Other, e.to_string())`,
/// so a timeout arrives indistinguishable from a disk error. Recognising it
/// would mean string-matching the library's `Display` output — brittle, and it
/// would break silently on a version bump.
///
/// Kept above `OP_TIMEOUT` (asserted below) so it only ever fires for a request
/// we forgot to wrap, and kept under the keepalive death window so it still
/// resolves rather than hanging until the session is torn down.
const RUSSH_REQUEST_BACKSTOP_SECS: u64 = 30;

const _: () = assert!(
    RUSSH_REQUEST_BACKSTOP_SECS > DATA_TIMEOUT.as_secs(),
    "the russh-sftp backstop must outlast every timeout we apply ourselves, or \
     the library's untyped timeout wins the race and the failure can no longer \
     be classified"
);

// ─── Error ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    #[error("SFTP session not found: {0}")]
    SessionNotFound(String),
    #[error("SSH session not found: {0}")]
    SshSessionNotFound(String),
    #[error("SFTP protocol error: {0}")]
    ProtocolError(String),
    #[error("Remote I/O error: {0}")]
    RemoteIoError(String),
    #[error("Local I/O error: {0}")]
    LocalIoError(String),
    #[error("Transfer cancelled")]
    TransferCancelled,
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[allow(dead_code)]
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[allow(dead_code)]
    #[error("Path not found: {0}")]
    NotFound(String),
    #[error("Channel error: {0}")]
    ChannelError(String),
}

impl SftpError {
    /// True when this failure means the SSH link itself is gone, rather than a
    /// per-file problem (permission, missing path, local disk). Only these
    /// should declare the connection dead — mirrors the frontend's
    /// CONNECTION_LOST_KINDS so both sides classify identically.
    pub fn is_connection_lost(&self) -> bool {
        matches!(
            self,
            SftpError::ChannelError(_)
                | SftpError::ProtocolError(_)
                | SftpError::SshSessionNotFound(_)
                | SftpError::SessionNotFound(_)
        )
    }
}

/// Build the error for an exchange that ran out of `budget`.
///
/// Takes the budget as an argument rather than reading a constant, because two
/// different ones are in play ([`OP_TIMEOUT`] and [`DATA_TIMEOUT`]) and a
/// message that names the wrong one is worse than a message with no number:
/// it sends whoever reads the log looking for a bug at the wrong layer.
pub(crate) fn timed_out(budget: std::time::Duration) -> SftpError {
    SftpError::ChannelError(format!(
        "no response from the server for {}s",
        budget.as_secs()
    ))
}

/// An SFTP exchange that ran out of time means the link is hung, not that the
/// file was a problem — so it must classify as connection-lost.
///
/// This impl is the whole reason our own `tokio::time::timeout` wraps SFTP calls
/// rather than leaning on russh-sftp's internal timer: `Elapsed` is a *type* we
/// can map, whereas the library erases its own timeout into an untyped
/// `io::Error` on the `File` byte-stream path (see [`RUSSH_REQUEST_BACKSTOP_SECS`]).
///
/// `Elapsed` carries no duration, so this cannot name the budget. Prefer
/// [`timed_out`] wherever the budget is known.
impl From<tokio::time::error::Elapsed> for SftpError {
    fn from(_: tokio::time::error::Elapsed) -> Self {
        SftpError::ChannelError("the server stopped responding".to_string())
    }
}

/// Classify a russh-sftp error by *kind* instead of flattening it to a string.
///
/// The distinction that matters: a `Status` packet is the server answering
/// "no" about one path (permission, missing file, full disk) and says nothing
/// about the link, whereas a timeout / closed session / transport I/O error
/// means the link itself is gone. Only the latter may declare a disconnect.
impl From<russh_sftp::client::error::Error> for SftpError {
    fn from(err: russh_sftp::client::error::Error) -> Self {
        use russh_sftp::client::error::Error as E;
        use russh_sftp::protocol::StatusCode;

        match err {
            // A status packet is normally the server answering about one path,
            // which says nothing about the link. The two exceptions are the
            // client-generated pseudo-codes, which mean exactly the opposite.
            E::Status(status) => {
                let msg = if status.error_message.is_empty() {
                    status.status_code.to_string()
                } else {
                    status.error_message.clone()
                };
                match status.status_code {
                    StatusCode::PermissionDenied => SftpError::PermissionDenied(msg),
                    StatusCode::NoSuchFile => SftpError::NotFound(msg),
                    StatusCode::NoConnection | StatusCode::ConnectionLost => {
                        SftpError::ChannelError(msg)
                    }
                    _ => SftpError::RemoteIoError(msg),
                }
            }
            // The link is gone or unusable.
            E::Timeout => SftpError::ChannelError("the server stopped responding".to_string()),
            E::IO(msg) => SftpError::ChannelError(msg),
            E::UnexpectedBehavior(msg) => SftpError::ChannelError(msg),
            // Protocol-level confusion: the stream is no longer trustworthy.
            E::UnexpectedPacket => SftpError::ProtocolError("unexpected SFTP packet".to_string()),
            E::Limited(msg) => SftpError::ProtocolError(msg),
        }
    }
}

/// Bound one SFTP request/response round-trip by [`OP_TIMEOUT`] and classify the
/// outcome.
///
/// Every call into `russh_sftp` goes through here, so there is exactly one
/// timeout rule and one classification rule for the whole protocol. Reads as
/// `request(sftp.read_dir(&path)).await?`.
///
/// Only correct for **round-trips**. Do not use it to await command output or
/// anything else that may be legitimately silent — see [`OP_TIMEOUT`].
///
/// Cancel safety: NOT cancel-safe, and neither is russh-sftp underneath. If the
/// timeout fires (or a caller drops this future), russh-sftp keeps the pending
/// request in its response map because only its own error paths remove it. That
/// leaks one map entry per abandoned request, bounded by the requests in flight
/// when a link dies — and the session it belongs to is torn down immediately
/// afterwards, taking the map with it.
pub(crate) async fn request<T>(
    fut: impl std::future::Future<Output = Result<T, russh_sftp::client::error::Error>>,
) -> Result<T, SftpError> {
    match tokio::time::timeout(OP_TIMEOUT, fut).await {
        Err(_) => Err(timed_out(OP_TIMEOUT)),
        Ok(result) => result.map_err(SftpError::from),
    }
}

/// Bound one read or write on an SFTP file's byte stream by [`DATA_TIMEOUT`].
///
/// A `File`'s `AsyncRead`/`AsyncWrite` impls issue real SFTP requests underneath,
/// but russh-sftp flattens their typed errors into an untyped `io::Error`, so
/// [`request`] cannot classify them. Here the *timeout* carries the meaning
/// instead of the error kind: a stalled block is a hung link, anything else is
/// an ordinary remote I/O failure.
///
/// Pass only the **remote** endpoint. A transfer moves bytes between a local
/// file and a remote one, and a slow local disk must never be reported as a lost
/// connection.
///
/// One call must map to one SFTP request. `File::poll_read`/`poll_write` each
/// issue exactly one, so a bare `read`/`write` is fine — but `write_all` loops
/// internally, which is why [`remote_write_all`] exists.
///
/// Cancel safety: NOT cancel-safe — an aborted write may have been partially
/// applied. Every caller treats a failed block as a failed transfer, and the
/// `.part`/region bookkeeping decides what is safe to resume.
pub(crate) async fn remote_io<T>(
    fut: impl std::future::Future<Output = std::io::Result<T>>,
) -> Result<T, SftpError> {
    match tokio::time::timeout(DATA_TIMEOUT, fut).await {
        Err(_) => Err(timed_out(DATA_TIMEOUT)),
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(SftpError::RemoteIoError(e.to_string())),
    }
}

/// Write all of `buf` to a remote file, bounding **each** underlying SFTP
/// request separately.
///
/// `AsyncWriteExt::write_all` loops until the buffer is drained, so wrapping it
/// in a single timeout would spread one budget across however many requests the
/// caller's buffer size happens to produce — the effective per-request bound
/// would silently change if `CHUNK_SIZE` ever did. Looping here keeps
/// [`DATA_TIMEOUT`] meaning exactly what it says: one block, one reply.
pub(crate) async fn remote_write_all<W>(remote: &mut W, buf: &[u8]) -> Result<(), SftpError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    let mut rest = buf;
    while !rest.is_empty() {
        let n = remote_io(remote.write(rest)).await?;
        if n == 0 {
            return Err(SftpError::ChannelError(
                "the server accepted no bytes".to_string(),
            ));
        }
        rest = &rest[n..];
    }
    Ok(())
}

/// Serialize as `{ kind, message }` — same convention as SshError / DbError.
impl Serialize for SftpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("SftpError", 2)?;
        let kind = match self {
            SftpError::SessionNotFound(_) => "session_not_found",
            SftpError::SshSessionNotFound(_) => "ssh_session_not_found",
            SftpError::ProtocolError(_) => "protocol_error",
            SftpError::RemoteIoError(_) => "remote_io_error",
            SftpError::LocalIoError(_) => "local_io_error",
            SftpError::TransferCancelled => "transfer_cancelled",
            SftpError::InvalidPath(_) => "invalid_path",
            SftpError::PermissionDenied(_) => "permission_denied",
            SftpError::NotFound(_) => "not_found",
            SftpError::ChannelError(_) => "channel_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub entry_type: SftpEntryType,
    pub size: u64,
    /// Raw Unix permission bits (lower 12 bits of the mode word).
    pub permissions: u32,
    /// Human-readable rwxrwxrwx string.
    pub permissions_display: String,
    /// Unix mtime as seconds since epoch, or `None` when the server omits it.
    pub modified: Option<u64>,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SftpEntryType {
    File,
    Directory,
    Symlink,
    Other,
}

/// Outcome of a recursive chmod: how many entries were successfully updated and
/// any per-entry failures (collected rather than aborting the whole operation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChmodSummary {
    pub applied: u32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub file_name: String,
    pub direction: TransferDirection,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub status: TransferStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferDirection {
    Download,
    Upload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TransferStatus {
    Queued,
    InProgress,
    Completed,
    Failed(String),
    Cancelled,
}

/// Event payload emitted to the frontend on the `sftp:transfer` channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferEvent {
    pub transfer_id: String,
    pub sftp_session_id: String,
    /// Display name — file name for single-file transfers, directory name for dirs.
    pub name: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    /// Populated only when status is `Failed`.
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    /// Unix timestamp in milliseconds.
    pub created_at: u64,
}

/// Serialisable snapshot returned by `sftp_list_transfers`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferInfo {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub name: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub created_at: u64,
}

// ─── Manager ─────────────────────────────────────────────────────────────────

pub struct SftpSessionWrapper {
    pub sftp: Arc<Mutex<russh_sftp::client::SftpSession>>,
    #[allow(dead_code)]
    pub ssh_session_id: String,
}

pub struct SftpManager {
    sessions: DashMap<String, SftpSessionWrapper>,
    active_transfers: DashMap<String, CancellationToken>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            active_transfers: DashMap::new(),
        }
    }

    pub fn insert_session(&self, id: String, wrapper: SftpSessionWrapper) {
        self.sessions.insert(id, wrapper);
    }

    pub fn get_session(
        &self,
        id: &str,
    ) -> Result<dashmap::mapref::one::Ref<'_, String, SftpSessionWrapper>, SftpError> {
        self.sessions
            .get(id)
            .ok_or_else(|| SftpError::SessionNotFound(id.to_string()))
    }

    pub fn remove_session(&self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn insert_transfer(&self, id: String, token: CancellationToken) {
        self.active_transfers.insert(id, token);
    }

    pub fn cancel_transfer(&self, id: &str) -> Result<(), SftpError> {
        let entry = self
            .active_transfers
            .get(id)
            .ok_or_else(|| SftpError::SessionNotFound(format!("transfer not found: {id}")))?;
        entry.value().cancel();
        Ok(())
    }

    pub fn remove_transfer(&self, id: &str) {
        self.active_transfers.remove(id);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Validate a server-supplied directory-entry name before joining it onto a
/// local path. The SFTP server controls these strings (READDIR/`SSH_FXP_NAME`),
/// and `russh-sftp` only filters literal `.`/`..` — so without this guard a
/// hostile server could return `..`, `/etc/cron.d/evil`, or `a/b` and escape the
/// local staging directory via `Path::join` (an absolute arg replaces the base;
/// `..` is resolved by the OS at create time). We require the name to be exactly
/// one normal path component: no separators, no `.`/`..`, no NUL, not absolute,
/// not empty. Returns the name on success.
pub(crate) fn validate_remote_name(name: &str) -> Result<&str, SftpError> {
    use std::path::{Component, Path};

    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(SftpError::InvalidPath(format!(
            "server returned an unsafe entry name: {name:?}"
        )));
    }

    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        // Exactly one component, and it must be a plain file/dir name (not `..`,
        // `.`, a root, or a Windows drive prefix).
        (Some(Component::Normal(c)), None) if c == std::ffi::OsStr::new(name) => Ok(name),
        _ => Err(SftpError::InvalidPath(format!(
            "server returned an unsafe entry name: {name:?}"
        ))),
    }
}

/// Convert a raw Unix mode word into a 9-character `rwxrwxrwx` string.
/// Only the lower 9 permission bits are examined.
pub fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Error classification ────────────────────────────────────────────────
    //
    // These pin the rule the disconnect trip depends on: a failure about *one
    // path* must never declare the link dead, and a failure of the *link* must
    // always do so. Getting this backwards is silent — either the app freezes
    // through a real disconnect, or a missing file pops a reconnect banner.

    use russh_sftp::client::error::Error as RusshSftpError;
    use russh_sftp::protocol::{Status, StatusCode};

    fn status(code: StatusCode) -> RusshSftpError {
        RusshSftpError::Status(Status {
            id: 1,
            status_code: code,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }

    /// An `Elapsed`, which has no public constructor.
    async fn elapsed() -> tokio::time::error::Elapsed {
        tokio::time::timeout(std::time::Duration::ZERO, std::future::pending::<()>())
            .await
            .unwrap_err()
    }

    #[test]
    fn library_timeout_is_a_lost_connection() {
        let err = SftpError::from(RusshSftpError::Timeout);
        assert!(matches!(err, SftpError::ChannelError(_)));
        assert!(err.is_connection_lost());
    }

    #[tokio::test]
    async fn our_timeout_is_a_lost_connection() {
        let err = SftpError::from(elapsed().await);
        assert!(err.is_connection_lost());
    }

    #[test]
    fn closed_session_is_a_lost_connection() {
        let err = SftpError::from(RusshSftpError::UnexpectedBehavior("session closed".into()));
        assert!(err.is_connection_lost());
    }

    #[test]
    fn client_side_connection_status_codes_are_a_lost_connection() {
        for code in [StatusCode::NoConnection, StatusCode::ConnectionLost] {
            let err = SftpError::from(status(code));
            assert!(err.is_connection_lost(), "{code:?} should be a dead link");
        }
    }

    #[test]
    fn per_path_status_codes_are_not_a_lost_connection() {
        let denied = SftpError::from(status(StatusCode::PermissionDenied));
        assert!(matches!(denied, SftpError::PermissionDenied(_)));
        assert!(!denied.is_connection_lost());

        let missing = SftpError::from(status(StatusCode::NoSuchFile));
        assert!(matches!(missing, SftpError::NotFound(_)));
        assert!(!missing.is_connection_lost());

        // A generic server-side failure is still about the path, not the link.
        let failure = SftpError::from(status(StatusCode::Failure));
        assert!(!failure.is_connection_lost());
    }

    #[test]
    fn status_without_a_message_still_describes_itself() {
        let err = SftpError::from(status(StatusCode::PermissionDenied));
        assert!(
            err.to_string().contains("Permission denied"),
            "empty error_message should fall back to the status code, got {err}"
        );
    }

    // ── Byte-stream timeouts ────────────────────────────────────────────────

    /// A remote endpoint that accepts nothing and never completes — what a
    /// silently dropped link looks like from the transfer's point of view.
    struct StalledStream;

    impl tokio::io::AsyncWrite for StalledStream {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Pending
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Pending
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_remote_write_reports_a_lost_connection() {
        let err = remote_write_all(&mut StalledStream, b"payload")
            .await
            .unwrap_err();
        assert!(
            err.is_connection_lost(),
            "a write that never completes must declare the link dead, got {err}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_remote_write_gives_up_after_the_data_timeout() {
        let started = tokio::time::Instant::now();
        let _ = remote_write_all(&mut StalledStream, b"payload").await;
        assert_eq!(started.elapsed(), crate::ssh::health::DATA_TIMEOUT);
    }

    /// The message must name the budget that actually ran out. It once always
    /// said "10s" because the `From<Elapsed>` impl read `OP_TIMEOUT`, while the
    /// byte-stream path elapses at `DATA_TIMEOUT` — so a real 20 s stall was
    /// reported as a 10 s one, pointing debugging at the wrong layer.
    #[tokio::test(start_paused = true)]
    async fn the_reported_budget_is_the_one_that_elapsed() {
        let err = remote_write_all(&mut StalledStream, b"payload")
            .await
            .unwrap_err();
        let expected = crate::ssh::health::DATA_TIMEOUT.as_secs();
        assert!(
            err.to_string().contains(&format!("{expected}s")),
            "byte-stream stall must report {expected}s, got: {err}"
        );
    }

    #[test]
    fn each_budget_reports_itself() {
        use crate::ssh::health::{DATA_TIMEOUT, OP_TIMEOUT};
        assert!(timed_out(OP_TIMEOUT).to_string().contains("10s"));
        assert!(timed_out(DATA_TIMEOUT).to_string().contains("20s"));
    }

    #[test]
    fn timeouts_are_ordered_so_the_most_specific_detector_wins() {
        use crate::ssh::health::{DATA_TIMEOUT, OP_TIMEOUT};
        assert!(
            OP_TIMEOUT <= DATA_TIMEOUT,
            "a small control round-trip must not outlast a bulk data block"
        );
        assert!(
            DATA_TIMEOUT.as_secs() < RUSSH_REQUEST_BACKSTOP_SECS,
            "russh-sftp's untyped timer must never fire before ours, or the \
             failure can no longer be classified"
        );
    }

    #[test]
    fn format_permissions_rwxr_xr_x() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
    }

    #[test]
    fn format_permissions_rw_r_r() {
        assert_eq!(format_permissions(0o644), "rw-r--r--");
    }

    #[test]
    fn format_permissions_all_zero() {
        assert_eq!(format_permissions(0), "---------");
    }

    #[test]
    fn validate_remote_name_accepts_plain_names() {
        for name in [
            "file.txt",
            "My Folder",
            "résumé.pdf",
            ".hidden",
            "a.b.c",
            "...",
        ] {
            assert!(validate_remote_name(name).is_ok(), "should accept {name:?}");
        }
    }

    #[test]
    fn validate_remote_name_rejects_traversal_and_separators() {
        // The hostile inputs a malicious SFTP server could return.
        for name in [
            "",
            ".",
            "..",
            "/",
            "/etc/passwd",
            "../../secret",
            "a/b",
            "a\\b", // Windows separator
            "C:\\evil",
            "with\0nul",
        ] {
            assert!(
                validate_remote_name(name).is_err(),
                "should reject {name:?}"
            );
        }
    }
}
