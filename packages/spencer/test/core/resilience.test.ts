/** Connection resilience: stale sockets (suspend, NAT), reconnects, and the outbox after a reconnect. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { FAST, relayAt, startNode, tcpProxy, tempDir, waitFor, sleep, type TestNode } from "./helpers.ts";

async function pairVia(t: { dir: string }, relayUrl: string, tuningA: object, tuningB?: object): Promise<{ A: TestNode; B: TestNode; ch: string }> {
  const da = join(t.dir, "a");
  const db = join(t.dir, "b");
  mkdirSync(da);
  mkdirSync(db);
  const A = await startNode(da, relayUrl, "Alice", { tuning: tuningA as never });
  const B = await startNode(db, relayUrl, "Bob", tuningB ? { tuning: tuningB as never } : {});
  const { link, channel } = await A.daemon.createInvite("direct", "Bob");
  await B.daemon.acceptInvite(link);
  await waitFor(() => A.daemon.core.getChannel(channel.id)?.members.length === 2, "joined");
  return { A, B, ch: channel.id };
}

test("outbox: after a reconnect, messages that failed on the dead connection go out right away (no stale backoff)", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const proxy = await tcpProxy(relay.port);
  // A long outbox backoff, a short request timeout, and no pings or wake checks: only the fix can make this fast.
  const tuning = {
    ...FAST,
    relay: { ...FAST.relay, requestTimeoutMs: 300, pingIntervalMs: 600_000, wakeCheckMs: 0 },
    outboxMinBackoffMs: 30_000,
    outboxMaxBackoffMs: 30_000,
  };
  const { A, B, ch } = await pairVia(t, proxy.url, tuning);
  try {
    // Drain the setup hello before freezing; otherwise it can take the 30s backoff ahead of this test's chat.
    await waitFor(
      () => (A.daemon.db.prepare("SELECT count(*) AS n FROM outbox WHERE ch = ? AND state = 'pending'").get(ch) as { n: number }).n === 0,
      "setup messages delivered",
    );
    proxy.freeze();
    const m = A.daemon.sendHuman(ch, "sent into a dead socket");
    await waitFor(
      () => (A.daemon.db.prepare("SELECT attempts FROM outbox WHERE id = ?").get(m.id) as { attempts: number }).attempts > 0,
      "the send timed out",
    );
    // The dead socket is noticed (here: it closes) and A reconnects through a working path.
    proxy.killAll();
    await waitFor(() => B.agent().peerChats.some((c) => c.id === m.id), "delivered soon after the reconnect", 5000);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await proxy.close();
    await relay.close();
    t.cleanup();
  }
});

test("relay client: a wall-clock jump (laptop resume) probes the connection, and a stale socket is replaced fast", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const proxy = await tcpProxy(relay.port);
  let skew = 0;
  const tuning = {
    ...FAST,
    relay: { ...FAST.relay, pingIntervalMs: 600_000, wakeCheckMs: 50, probeTimeoutMs: 300, now: () => Date.now() + skew },
  };
  // Both laptops sleep (both sockets go through the proxy): B's send also lands in a dead socket first.
  const { A, B, ch } = await pairVia(t, proxy.url, tuning, tuning);
  try {
    const events: boolean[] = [];
    A.daemon.events.subscribe((e) => {
      if (e.type === "relay") events.push(e.connected);
    });
    proxy.freeze();
    // B writes while A's socket is dead.
    const m = B.daemon.sendHuman(ch, "while you were asleep");
    await sleep(200);
    assert.equal(A.daemon.pool.isConnected(proxy.url), true, "a frozen socket still looks connected");
    // The laptop wakes up: the wall clock jumped an hour, monotonic timers did not.
    skew += 3_600_000;
    await waitFor(() => events.includes(false), "stale connection dropped", 3000);
    await waitFor(() => A.daemon.pool.isConnected(proxy.url), "reconnected", 3000);
    await waitFor(() => A.agent().peerChats.some((c) => c.id === m.id), "caught up on the missed message", 3000);
  } finally {
    await A.daemon.stop();
    await B.daemon.stop();
    await proxy.close();
    await relay.close();
    t.cleanup();
  }
});
