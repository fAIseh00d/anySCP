// The S3 duplicate path, which both the hosts dashboard and the S3 page route
// through. This is the half of the credential-lifecycle fix with no E2E cover,
// and the bug it replaced was silent: a frontend-only duplicate wrote empty ""
// access keys (it can't read the source secret), so the copy looked healthy in
// the list and then failed every listing with `serde xml: missing field
// "Name"`. Both of those — the command actually used, and the warning when the
// keys don't come across — are asserted here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { duplicateS3Connection } from "../duplicate";
import { useToastStore } from "../../stores/toast-store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const conn = { id: "c1", label: "minio-prod" };

const toastMessages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("duplicateS3Connection", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("duplicates through the backend command so the access keys are copied", async () => {
    invoke.mockResolvedValue({ id: "c2", credential_error: null });

    await duplicateS3Connection(conn);

    expect(invoke).toHaveBeenCalledWith("s3_duplicate_connection", { id: "c1" });
    // `s3_save_connection` is the frontend-only bypass that wrote "" creds.
    expect(invoke).not.toHaveBeenCalledWith("s3_save_connection", expect.anything());
    expect(toastMessages()).toEqual([]);
  });

  it("warns when the copy was created but its access keys didn't come across", async () => {
    invoke.mockResolvedValue({
      id: "c2",
      credential_error: "Keychain error: user denied access",
    });

    await duplicateS3Connection(conn);

    // Said now, rather than leaving the user to hit an opaque auth failure on
    // the copy's first listing.
    expect(toastMessages()).toEqual([
      'Duplicated "minio-prod", but its access keys didn\'t copy — re-enter them on the copy.',
    ]);
  });

  it("reports a failed duplicate instead of leaving the click silent", async () => {
    invoke.mockRejectedValue(new Error("source gone"));

    await duplicateS3Connection(conn);

    expect(toastMessages()).toEqual(['Couldn\'t duplicate "minio-prod".']);
  });

  it("never rejects, so neither call site needs its own catch", async () => {
    invoke.mockRejectedValue(new Error("db locked"));

    // Both callers `await` this inside handlers invoked as `void handle(...)`;
    // a rejection here would surface as an unhandled promise rejection.
    await expect(duplicateS3Connection(conn)).resolves.toBeUndefined();
  });
});
