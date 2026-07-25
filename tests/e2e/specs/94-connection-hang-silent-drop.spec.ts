// Silent link drop → the explorer surfaces the disconnect via a timeout.
//
// This covers the case operation-timeouts exist for and that no other spec
// reaches: the connection HANGS rather than closing. A clean disconnect (shell
// `exit`, container stop) sends FIN/RST and is noticed instantly; a VPN/route
// drop just makes packets vanish, and only a request timeout can detect it.
//
// The app connects through a Toxiproxy sidecar. Mid-session we freeze the proxy
// (data stops, TCP stays open), then issue a directory listing. That listing is
// a bounded round-trip (OP_TIMEOUT), so it fails as a connection-lost error and
// the "Connection lost" overlay appears — instead of the app hanging until the
// keepalive tears the session down tens of seconds later.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { refreshExplorer, waitForExplorer } from "../helpers/sftp-ops.js";
import { createHangProxy, HangProxy } from "../helpers/toxiproxy.js";

const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

// Unique per spec file so parallel runs don't collide on the Toxiproxy listener.
const PROXY_NAME = "ssh-hang-94";
const PROXY_PORT = 23_094;

describe("silent connection hang", () => {
    let proxy: HangProxy;

    beforeEach(async () => {
        proxy = await createHangProxy(PROXY_NAME, PROXY_PORT);
        await resetApp();
        await waitForDashboard();
    });

    afterEach(async () => {
        // Always tear the proxy down, even if the test failed mid-way, so a
        // frozen listener can't leak into the next spec.
        if (proxy) await proxy.destroy();
    });

    it("shows the reconnect overlay when the link goes silent mid-session", async () => {
        // Connect the explorer THROUGH the proxy (which forwards to sshd-pass).
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "hang-target",
            host: proxy.host,
            port: proxy.port,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("hang-target");

        const hostId = await getHostId("hang-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        // The overlay must NOT be up yet — the link is healthy.
        if (await browser.$("[aria-label='Connection lost']").isExisting()) {
            throw new Error("overlay appeared before the link was frozen");
        }

        // Freeze the link: packets stop, the socket stays open. Nothing errors
        // on its own from here — only an in-flight request can notice.
        await proxy.hang();

        // Trigger a bounded round-trip (a directory listing). This is what
        // times out and declares the connection lost.
        await refreshExplorer();

        // The overlay should appear well inside the keepalive window. OP_TIMEOUT
        // is 10 s; give generous headroom for CI scheduling. If this ever waits
        // the full ~50 s keepalive instead, the operation timeout regressed.
        const overlay = await browser.$("[aria-label='Connection lost']");
        await overlay.waitForExist({
            timeout: 25_000,
            timeoutMsg:
                "no 'Connection lost' overlay within 25 s of a silent hang — " +
                "the operation timeout did not fire",
        });
    });
});
