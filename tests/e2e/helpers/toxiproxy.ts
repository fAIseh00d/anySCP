// Control a Toxiproxy sidecar over its HTTP API to simulate a *silent* network
// drop — packets vanish with no RST, the TCP connection stays open, and only a
// timeout can notice. This is the case operation-timeouts / keepalive exist for
// and the one a clean `exit`/close can't reproduce.
//
// Unprivileged by design: Toxiproxy is a plain sidecar, so the same test runs
// locally and on GitHub Actions (which doesn't grant NET_ADMIN for iptables/tc).
//
// Node 20 in the runner image provides global `fetch`; no client library needed.

const API = process.env.TOXIPROXY_API ?? "http://toxiproxy:8474";
const PROXY_HOST = process.env.TOXIPROXY_HOST ?? "toxiproxy";
const UPSTREAM = process.env.TOXIPROXY_UPSTREAM ?? "sshd-pass:2222";

/** A live proxy: where the app connects, plus teardown. */
export interface HangProxy {
  /** Hostname the app should connect to (the Toxiproxy container). */
  host: string;
  /** Port the proxy listens on (forwards to the upstream sshd). */
  port: number;
  /** Freeze all data while holding the socket open — the silent hang. */
  hang: () => Promise<void>;
  /** Resume forwarding (rarely needed; the app has usually given up by then). */
  heal: () => Promise<void>;
  /** Remove the proxy entirely. Safe to call more than once. */
  destroy: () => Promise<void>;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // 404 on DELETE is fine — the thing is already gone.
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`toxiproxy ${method} ${path} → ${res.status} ${await res.text()}`);
  }
  return res;
}

/**
 * Create a proxy in front of the upstream sshd. The app connects to the
 * returned host:port; nothing is frozen until `hang()` is called.
 *
 * `listenPort` must be unique per proxy within the Toxiproxy container. Callers
 * pick it (the specs use a per-file constant) so parallel specs don't collide.
 */
export async function createHangProxy(
  name: string,
  listenPort: number,
): Promise<HangProxy> {
  // Idempotent: a leftover from a crashed run would otherwise 409.
  await api("DELETE", `/proxies/${name}`);
  await api("POST", "/proxies", {
    name,
    listen: `0.0.0.0:${listenPort}`,
    upstream: UPSTREAM,
    enabled: true,
  });

  return {
    host: PROXY_HOST,
    port: listenPort,
    async hang() {
      // `timeout` with timeout=0: stop all data, do NOT close the connection —
      // it stays ESTABLISHED and unresponsive. Applied downstream (server →
      // client) so the app's in-flight request never receives its reply, which
      // is what an SSH request/response hang looks like from the client side.
      await api("POST", `/proxies/${name}/toxics`, {
        name: "freeze",
        type: "timeout",
        stream: "downstream",
        attributes: { timeout: 0 },
      });
    },
    async heal() {
      await api("DELETE", `/proxies/${name}/toxics/freeze`);
    },
    async destroy() {
      await api("DELETE", `/proxies/${name}`);
    },
  };
}
