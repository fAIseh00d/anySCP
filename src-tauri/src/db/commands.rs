use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use super::{ConnectionHistoryEntry, DbError, HostDb, HostGroup, RecentConnection, SavedHost};

/// Persist (insert or update) a host entry.
///
/// ProxyJump cycles, self-references, and dangling tunnel-host targets are
/// rejected atomically with the write inside [`HostDb::save_host_validated`].
#[tauri::command]
#[instrument(skip(state), fields(id = %host.id))]
pub async fn save_host(host: SavedHost, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_host_validated(&host))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all saved hosts, ordered by label.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_hosts(state: State<'_, Arc<HostDb>>) -> Result<Vec<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_hosts())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a saved host by its UUID string, including its keychain
/// secret. The DB delete is authoritative (its error propagates); the keychain
/// purge is best-effort — a missing entry (key-file/agent auth) is fine, and a
/// real failure is logged rather than orphaning the secret silently.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_host(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    let del_id = id.clone();
    task::spawn_blocking(move || db.delete_host(&del_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))??;

    // Honor the "delete_host and its credential are removed together" contract
    // (see vault/mod.rs) — the dashboard delete used to drop only the DB row,
    // orphaning the keychain secret for password/passphrase hosts.
    if let Ok(Err(e)) = task::spawn_blocking(move || crate::vault::delete_credential(&id)).await {
        tracing::warn!(error = %e, "delete_host: keychain purge failed (secret orphaned)");
    }
    Ok(())
}

/// Duplicate a saved host: persist the caller-built copy row AND copy its
/// keychain secret under the new id. The credential copy is why this is a
/// backend command — the frontend can't read the source secret out of the
/// keychain, so a frontend-only duplicate (just `save_host`) left password- and
/// passphrase-auth copies with no credential, so they failed to authenticate.
/// `host` is the copy (fresh id + label, reset stats); `source_id` is the
/// original whose secret to clone.
#[tauri::command]
#[instrument(skip(state), fields(id = %host.id, source = %source_id))]
pub async fn duplicate_host(
    host: SavedHost,
    source_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let new_id = host.id.clone();
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_host_validated(&host))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))??;

    // Copy the secret under the new id — best-effort. A source with no stored
    // secret (key-file auth without a passphrase, or agent auth) yields a
    // credential-less copy, which is correct, not an error.
    let copied = task::spawn_blocking(move || match crate::vault::get_credential(&source_id) {
        Ok(cred) => crate::vault::save_credential(&new_id, &cred),
        Err(crate::vault::VaultError::NotFound(_)) => Ok(()),
        Err(e) => Err(e),
    })
    .await;
    if let Ok(Err(e)) = copied {
        // The row is saved but the secret didn't copy — surface why; the user
        // re-enters the credential rather than the duplicate silently failing.
        tracing::warn!(error = %e, "duplicate_host: credential copy failed (copy has no stored secret)");
    }
    Ok(())
}

/// Persist a manual host ordering produced by drag-and-drop on the dashboard.
///
/// `ordered_ids` is the full list of host ids in their new display order; each
/// host's `sort_order` is set to its position. Rolls back and returns
/// `DbError::NotFound` if any id is unknown (e.g. a host deleted concurrently).
#[tauri::command]
#[instrument(skip(state), fields(count = ordered_ids.len()))]
pub async fn reorder_hosts(
    ordered_ids: Vec<String>,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.reorder_hosts(&ordered_ids))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Look up a single host by its UUID string.  Returns `None` when not found.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn get_host(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<Option<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.get_host(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Create a new host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn create_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.create_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Update an existing host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn update_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.update_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Persist a manual group ordering produced by drag-and-drop on the dashboard.
///
/// `ordered_ids` is the full list of group ids in their new display order; each
/// group's `sort_order` is set to its position. Rolls back and returns
/// `DbError::NotFound` if any id is unknown (e.g. a group deleted concurrently).
#[tauri::command]
#[instrument(skip(state), fields(count = ordered_ids.len()))]
pub async fn reorder_groups(
    ordered_ids: Vec<String>,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.reorder_groups(&ordered_ids))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all host groups, ordered by sort_order then name.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_groups(state: State<'_, Arc<HostDb>>) -> Result<Vec<HostGroup>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_groups())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a host group.  Member hosts are orphaned (their
/// `group_id` is set to NULL) rather than deleted.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_group(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Delete a host group AND all hosts inside it.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group_with_hosts(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    let host_ids = task::spawn_blocking(move || db.delete_group_with_hosts(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))??;

    // Purge each deleted host's keychain secret — the DB cascade only removed
    // the rows. Same best-effort loop as factory_reset: a missing entry is fine,
    // and one bad key shouldn't abort the rest.
    if !host_ids.is_empty() {
        task::spawn_blocking(move || {
            for host_id in &host_ids {
                if let Err(e) = crate::vault::delete_credential(host_id) {
                    tracing::warn!(host_id = %host_id, error = %e, "delete_group_with_hosts: keychain purge failed (secret orphaned)");
                }
            }
        })
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;
    }
    Ok(())
}

/// Record a successful connection for the given host id.  Also prunes the
/// history table to keep at most 50 rows.
#[tauri::command]
#[instrument(skip(state), fields(host_id = %host_id))]
pub async fn record_connection(
    host_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.record_connection(&host_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return the most-recent distinct connection per host, ordered newest-first.
/// `limit` caps the number of rows returned.
#[tauri::command]
#[instrument(skip(state), fields(limit = %limit))]
pub async fn list_recent_connections(
    limit: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<RecentConnection>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_recent_connections(limit))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Connection History (full audit log) ──────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn list_connection_history(
    host_id: Option<String>,
    limit: u32,
    offset: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<ConnectionHistoryEntry>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_connection_history(host_id.as_deref(), limit, offset))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_connection_history_entry(
    id: i64,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_connection_history_entry(id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── App Settings ─────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn save_setting(
    key: String,
    value: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_setting(&key, &value))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn load_all_settings(
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<(String, String)>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.load_all_settings())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Factory reset ─────────────────────────────────────────────────────────────

/// Permanently wipe ALL local data — saved hosts, groups, connection history,
/// snippets, port-forward rules, S3 connections, and app settings — plus their
/// stored credentials in the OS keychain. Returns anySCP to first-launch state.
///
/// This is irreversible; the frontend gates it behind a typed confirmation and
/// relaunches the app afterwards.
#[tauri::command]
#[instrument(skip(state))]
pub async fn factory_reset(state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || {
        let keys = db.factory_reset()?;
        // Purge secrets from the keychain. Best-effort: a missing entry is fine,
        // and one bad key shouldn't abort the rest — the rows are already gone.
        for host_id in &keys.host_ids {
            if let Err(e) = crate::vault::delete_credential(host_id) {
                tracing::warn!(host_id = %host_id, error = %e, "factory reset: keychain purge failed");
            }
        }
        for s3_id in &keys.s3_ids {
            let key = format!("s3:{s3_id}");
            if let Err(e) = crate::vault::delete_credential(&key) {
                tracing::warn!(key = %key, error = %e, "factory reset: keychain purge failed");
            }
        }
        Ok::<(), DbError>(())
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}
