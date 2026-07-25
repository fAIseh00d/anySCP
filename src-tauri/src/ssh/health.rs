//! Connection-health signalling — the single place a connection is declared dead.
//!
//! Detection is necessarily spread across layers, because each layer notices a
//! different failure first:
//!   * an **in-flight request** (channel open, directory listing, a transfer's
//!     next chunk) notices when it exceeds [`OP_TIMEOUT`],
//!   * the **keepalive** is the only thing that notices an *idle* connection dying.
//!
//! But the *verdict* is centralised here: every detector calls
//! [`mark_disconnected`], so the `ssh:status` event and the log line happen
//! exactly once and identically no matter who noticed first. That also makes the
//! call idempotent — several detectors firing at once (a transfer failing while
//! keepalive expires) emit a single event instead of spamming the frontend.
//!
//! ## Why a transfer does not detect death on its own
//!
//! It is tempting to assume a running transfer hits a dead socket immediately.
//! It does not. When the link drops *silently* (VPN yanked, laptop suspended)
//! there is no RST and no FIN — the next read simply never completes and the
//! next write disappears into the send buffer. Without [`OP_TIMEOUT`] a transfer
//! blocks indefinitely and produces no error to classify, which is exactly the
//! "app freezes and nothing happens" symptom. The timeout is what converts that
//! silence into a `Result` the layers above can act on.

use dashmap::DashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::warn;

use crate::types::{ConnectionStatus, SshStatusPayload};

/// How long an in-flight **request/response round-trip** may go unanswered
/// before we call the link hung.
///
/// This bounds round-trips only — an SFTP request awaiting its reply, an SCP
/// ack, a channel open. It must **never** be applied to an open-ended wait for
/// command *output*: `find` over a large tree or a long build are legitimately
/// silent for minutes, and treating that silence as death is the same mistake
/// as the echo/output heuristic we rejected for hang detection.
///
/// Use it for **control** round-trips, whose payloads are small enough that the
/// wait is pure latency: a stat, a directory listing, a channel open, an SCP
/// ack. Bulk data blocks get [`DATA_TIMEOUT`] instead.
///
/// Ordering invariant (fastest to slowest, so the most specific detector wins):
///
/// ```text
///   spinner delay (500-800 ms)  <  OP_TIMEOUT (10 s)
///                               <  DATA_TIMEOUT (20 s)
///                               <  keepalive death (~50 s)
/// ```
///
/// **Keepalive death is `(keepalive_max + 2) × interval`, not
/// `keepalive_max × interval`.** russh checks `alive_timeouts > keepalive_max`
/// *before* incrementing the counter, so with the defaults (10 s × max 3) the
/// session is torn down on the **fifth** unanswered probe, at ~50 s — not the
/// ~30 s an obvious reading of the constants suggests. Re-derive from russh's
/// client loop before quoting a number here; this was wrong once.
///
/// A host that overrides `keep_alive_interval` downwards can invert the right
/// half; nothing breaks if it does — keepalive simply declares the session dead
/// before an individual request gives up, and [`mark_disconnected`] is
/// idempotent either way. The ordering is about which detector reports *first*,
/// not about correctness.
///
/// Note that keepalive is the *worst case*, not the usual one: when the network
/// goes away in a way the OS notices (an interface torn down, a route dropped, a
/// peer that sends RST), the socket errors and the channel closes long before
/// any of these budgets expire.
pub const OP_TIMEOUT: Duration = Duration::from_secs(10);

/// How long one **bulk data block** of a transfer may stall before we call the
/// link hung.
///
/// Same rule as [`OP_TIMEOUT`], with room for the payload. It needs its own
/// value because a data block is not a small request: SFTP moves up to 255 KiB
/// per read/write, so a time limit doubles as a *minimum throughput*
/// requirement. At `OP_TIMEOUT` that floor would be ~25 KiB/s — fast enough that
/// a congested or heavily shared link could dip below it and have a perfectly
/// healthy transfer aborted as a disconnect. At 20 s the floor is ~13 KiB/s,
/// which no usable link sustains falling under, and detection still lands well
/// inside the keepalive window.
///
/// Applied per underlying request, never per accumulated chunk — otherwise the
/// effective budget would drift with whatever buffer size the caller picked.
pub const DATA_TIMEOUT: Duration = Duration::from_secs(20);

/// Sessions already declared dead. Keyed by SSH session id; entries are cleared
/// by [`mark_alive`] when a session (re)connects or is torn down, so this stays
/// bounded by the number of live sessions.
fn declared_dead() -> &'static DashMap<String, ()> {
    static DEAD: OnceLock<DashMap<String, ()>> = OnceLock::new();
    DEAD.get_or_init(DashMap::new)
}

/// Declare `session_id`'s connection dead and notify the frontend.
///
/// Idempotent: the first caller wins and later ones are ignored until
/// [`mark_alive`] resets it. `reason` is logged (not sent to the UI) so the
/// cause — keepalive, a failed transfer, a timeout — is visible in the log.
pub fn mark_disconnected(session_id: &str, reason: &str, app_handle: &AppHandle) {
    if declared_dead().insert(session_id.to_string(), ()).is_some() {
        return; // another detector already declared this session dead
    }

    warn!(session_id = %session_id, reason = %reason, "SSH connection lost");

    let _ = app_handle.emit(
        "ssh:status",
        &SshStatusPayload {
            session_id: session_id.to_string(),
            status: ConnectionStatus::Disconnected,
        },
    );
}

/// Clear the dead flag for `session_id`.
///
/// Called when a session connects, reconnects (same id, new transport), or is
/// torn down — so a session that dies again later is reported again.
pub fn mark_alive(session_id: &str) {
    declared_dead().remove(session_id);
}
