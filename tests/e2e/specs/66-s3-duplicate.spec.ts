// S3 connection duplicate — the mirror of 09-host-duplicate for the S3 half of
// the credential lifecycle.
//
// The bug this guards: duplication used to happen entirely in the frontend,
// which cannot read the source's secret out of the keychain, so the copy was
// written with empty "" access keys. It looked healthy on the dashboard and
// then failed every listing with `serde xml: missing field "Name"` — an error
// that says nothing about credentials. Only a real MinIO round-trip on the
// COPY proves the keys came across, which is why this lives in E2E and not in
// the unit tests.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickS3Save,
    duplicateS3Connection,
    fillS3Form,
    findS3Card,
    getS3Id,
    openNewS3Dialog,
    s3CardCount,
} from "../helpers/s3.js";
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

/** Save one MinIO connection under `label` and wait for its card. */
async function saveConnection(label: string): Promise<void> {
    await openNewS3Dialog();
    await fillS3Form({
        label,
        provider: "minio",
        accessKey: MINIO_ACCESS_KEY,
        secretKey: MINIO_SECRET_KEY,
        region: "us-east-1",
        bucket: MINIO_BUCKET,
        endpoint: MINIO_ENDPOINT,
    });
    await clickS3Save();
    await findS3Card(label);
}

describe("S3 connection duplicate", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates a copy with '(copy)' suffix and a new id", async () => {
        await saveConnection("minio-original");
        const originalId = await getS3Id("minio-original");

        const outcome = await duplicateS3Connection("minio-original");

        await findS3Card("minio-original (copy)");
        expect(await s3CardCount()).to.equal(2);
        expect(outcome.id).to.not.equal(originalId);
        expect(await getS3Id("minio-original (copy)")).to.equal(outcome.id);
    });

    it("the copy inherits the access keys and can list the bucket", async () => {
        await saveConnection("minio-pw-original");

        // A keychain failure is reported rather than thrown, so assert it stayed
        // clean — otherwise the listing below would fail for a reason that looks
        // unrelated to credentials.
        const outcome = await duplicateS3Connection("minio-pw-original");
        expect(outcome.credential_error).to.equal(null);

        // Open the COPY's explorer. With empty "" keys the request is rejected
        // and the seeded objects never render.
        const copyId = await getS3Id("minio-pw-original (copy)");
        const explorerBtn = await $(`[data-testid='s3-card-${copyId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();

        await waitForExplorer();
        await waitForEntry("hello.txt");
        await waitForEntry("data.json");
    });
});
