import type { DuplicateOutcome } from "../types";
import { toast } from "../stores/toast-store";

// Duplicating a saved S3 connection is offered from two places (the hosts
// dashboard and the S3 page). Both must report the same two failure modes
// identically, so the call lives here rather than being copied into each.

/**
 * Duplicate a saved S3 connection through the backend command, reporting both
 * ways it can go wrong: the command itself failing (source gone from the list,
 * DB error) and the row being created without its access keys.
 *
 * The caller reloads its own connection list afterwards — the dashboard and the
 * S3 page hold that list differently.
 */
export async function duplicateS3Connection(conn: {
  id: string;
  label: string;
}): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    // The backend copies the DB row AND the keychain credential under a new id.
    // A frontend-only duplicate wrote empty "" creds (it can't read the source
    // secret), so the copy connected unauthenticated and every list failed with
    // `serde xml: missing field "Name"`.
    const outcome = await invoke<DuplicateOutcome>("s3_duplicate_connection", {
      id: conn.id,
    });
    // The copy exists but its access keys didn't come across — say so now,
    // rather than leaving the user to hit an opaque auth failure on first use.
    if (outcome.credential_error) {
      toast.error(
        `Duplicated "${conn.label}", but its access keys didn't copy — re-enter them on the copy.`,
      );
    }
  } catch {
    // Swallowing this left the user clicking Duplicate with nothing happening.
    toast.error(`Couldn't duplicate "${conn.label}".`);
  }
}
