import type { ExplorerEntry } from "../types/explorer";

/**
 * Terminal disposition of a cross-pane transfer, as far as a MOVE cares. A move
 * deletes its source only on `completed`; `failed` drops the pending deletion
 * (never lose data); `pending` leaves it in place to await a later event.
 */
export type MoveOutcome = "completed" | "failed" | "pending";

/**
 * Classify a raw transfer `status` from a `*:transfer` event payload.
 *
 * The Rust unit variants (`Completed`, `Cancelled`, …) serialize as bare
 * strings, but `Failed(String)` serializes as an OBJECT — `{ "Failed": "…" }` —
 * not the string `"Failed"`. Treating any non-null object as a terminal failure
 * is what stops a failed transfer from being mistaken for still-pending (which
 * would strand the source) or, worse, for completed (which would delete it).
 */
export function classifyMoveOutcome(status: unknown): MoveOutcome {
  if (status === "Completed") return "completed";
  if (status === "Cancelled") return "failed";
  if (typeof status === "object" && status !== null) return "failed";
  return "pending";
}

/**
 * Map queued transfer ids to the sources a MOVE should delete once each lands.
 *
 * `enqueue` preserves order, so `ids[i]` is the transfer for `entries[i]`. If
 * the backend returns a different count we can't pair them safely, so we return
 * `null`: the caller records no pending deletions and the move degrades to a
 * copy — never a wrong delete.
 */
export function planMoveSources<T>(ids: string[], entries: T[]): Map<string, T> | null {
  if (ids.length !== entries.length) return null;
  const plan = new Map<string, T>();
  ids.forEach((id, i) => plan.set(id, entries[i]));
  return plan;
}

/** The value a coordinator tracks per pending move: which pane owns the source. */
export interface PendingMove {
  role: "local" | "remote";
  entry: ExplorerEntry;
}

/**
 * Reconcile the focused pane id after a session swap (e.g. the sudo toggle),
 * which changes `remoteId` and, with it, both pane ids. Keep the current focus
 * if it still names a live pane; otherwise fall back to the remote pane. Without
 * this, a `focusedId` seeded from the pre-swap id would match neither pane and
 * the dual-pane highlight/keyboard target would be lost.
 */
export function reconcileFocusedId(current: string, localKey: string, remoteId: string): string {
  return current === localKey || current === remoteId ? current : remoteId;
}
