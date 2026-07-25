// A long, silent-but-alive command must NOT be mistaken for a dead link.
//
// The counterpart to the silent-hang spec (94): timeouts have to fire on a hung
// link without firing on a healthy one that simply has nothing to say. A
// running `sleep 60` produces no output for a minute — exactly the shape of a
// hang from the outside — yet the connection is fine. If any timeout were ever
// (wrongly) applied to open-ended command output, this is where it would show
// up as a spurious "Connection lost" overlay.
//
// No proxy here: the link is genuinely healthy the whole time.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    typeIntoTerminal,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("long silent command is not a disconnect", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("keeps the session alive through a 60 s silent command", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "quiet-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("quiet-target");

        await openHostEdit("quiet-target");
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Start a command that emits nothing for a minute.
        await typeIntoTerminal(sessionId, "sleep 60\n");

        // Wait past every operation budget (DATA_TIMEOUT 20 s, with margin) but
        // short of the ~50 s keepalive death — the window where a wrongly-placed
        // timeout on output would fire. Poll for the overlay throughout; its
        // absence at the end is the assertion.
        const overlay = await browser.$("[aria-label='Connection lost']");
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            if (await overlay.isExisting()) {
                throw new Error(
                    "'Connection lost' overlay appeared during a healthy `sleep 60` — " +
                        "a timeout is being applied to command output",
                );
            }
            await browser.pause(2_000);
        }

        // Still connected: prove it by running a command and seeing its output.
        await typeIntoTerminal(sessionId, "\x03"); // Ctrl-C to end the sleep early
        await typeIntoTerminal(sessionId, "echo still_alive\n");
        await waitForTerminalText(sessionId, "still_alive", { timeoutMs: 10_000 });
    });
});
