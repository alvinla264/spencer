import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { http, relayAt, startNode, tempDir, waitFor } from "./helpers.ts";

function wsOpen(url: string, headers: Record<string, string> = {}): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode });
      ws.terminate();
    });
    ws.once("error", () => resolve({ status: -1 }));
  });
}

test("http api: guards, state, owner + channel messages, invites, events ws", async () => {
  const t = tempDir();
  const relay = await relayAt(t.dir);
  const web = join(t.dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), '<html><head><meta name="spencer-token" content="__SPENCER_TOKEN__"></head></html>');
  writeFileSync(join(web, "app.js"), "console.log(1)");
  writeFileSync(join(t.dir, "secret.txt"), "nope");
  mkdirSync(join(t.dir, "a"));
  mkdirSync(join(t.dir, "b"));
  const A = await startNode(join(t.dir, "a"), relay.url, "Alice", { webRoot: web });
  const B = await startNode(join(t.dir, "b"), relay.url, "Bob");
  const sockets: WebSocket[] = [];
  try {
    const port = A.daemon.port;
    const token = A.daemon.token;
    const H = { "X-Spencer-Token": token };

    // --- guards
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `evil.example:${port}` })).status, 403);
    assert.equal((await http(port, "GET", "/", { host: "evil.example" })).status, 403);
    assert.equal((await http(port, "GET", "/api/state")).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: { "X-Spencer-Token": "0".repeat(64) } })).status, 401);
    assert.equal((await http(port, "GET", "/api/state", { headers: H, host: `localhost:${port}` })).status, 200);

    // --- static + token injection + headers + traversal
    const idx = await http(port, "GET", "/");
    assert.equal(idx.status, 200);
    assert.ok(idx.text.includes(`content="${token}"`));
    assert.match(String(idx.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(idx.headers["content-security-policy"]), new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${port} ws://localhost:${port}`));
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    assert.equal(idx.headers["referrer-policy"], "no-referrer");
    assert.equal(idx.headers["access-control-allow-origin"], undefined);
    assert.equal((await http(port, "GET", "/app.js")).status, 200);
    assert.notEqual((await http(port, "GET", "/../secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/%2e%2e/secret.txt")).status, 200);
    assert.notEqual((await http(port, "GET", "/..%2fsecret.txt")).status, 200);

    // --- state shape
    const st = (await http(port, "GET", "/api/state", { headers: H })).json();
    assert.deepEqual(Object.keys(st.me).sort(), ["fingerprint", "id", "name"]);
    assert.equal(st.me.name, "Alice");
    assert.equal(st.relay.url, relay.url);
    assert.equal(typeof st.relay.connected, "boolean");
    assert.deepEqual(st.channels, []);
    assert.deepEqual(st.transfers, []);
    assert.deepEqual(st.mcp, []);
    assert.equal(st.policy.maxHops, 40);
    assert.equal(st.policy.maxAgentTurns, 20);

    // --- events ws: origin / token / host checks
    const base = `ws://127.0.0.1:${port}/api/events`;
    assert.equal((await wsOpen(`${base}?token=bad`)).status, 401);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Origin: `http://localhost:${port + 1}` })).status, 403);
    assert.equal((await wsOpen(`${base}?token=${token}`, { Host: "evil.example" })).status, 403);
    const ok1 = await wsOpen(`${base}?token=${token}`, { Origin: `http://127.0.0.1:${port}` });
    assert.ok(ok1.ws);
    sockets.push(ok1.ws!);
    const ok2 = await wsOpen(`${base}?token=${token}`); // non-browser client: no Origin
    assert.ok(ok2.ws);
    sockets.push(ok2.ws!);
    const events: any[] = [];
    ok1.ws!.on("message", (d) => events.push(JSON.parse(d.toString())));

    // --- owner message
    const om = await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "hello spencer" } });
    assert.equal(om.status, 200);
    assert.equal(om.json().submissionId, "sub-1");
    assert.deepEqual(A.agent().ownerSends, ["hello spencer"]);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "" } })).status, 400);
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: "{not json" })).status, 400);
    const tr = (await http(port, "GET", "/api/owner/messages?limit=10", { headers: H })).json();
    assert.equal(tr.items[0].text, "hello spencer");

    // --- invites over HTTP
    const inv = await http(port, "POST", "/api/invites", { headers: H, body: { kind: "direct", name: "Bob" } });
    assert.equal(inv.status, 200);
    const { link, channel } = inv.json();
    assert.equal(channel.name, "Bob");
    assert.equal((await http(port, "POST", "/api/invites", { headers: H, body: { kind: "weird", name: "x" } })).status, 400);
    const acc = await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link } });
    assert.equal(acc.status, 200);
    assert.equal(acc.json().channel.id, channel.id);
    assert.equal(
      (await http(B.daemon.port, "POST", "/api/invites/accept", { headers: { "X-Spencer-Token": B.daemon.token }, body: { link: "nope" } })).status,
      400,
    );
    const ch = channel.id;
    await waitFor(() => A.daemon.core.getChannel(ch)!.members.length === 2, "joined");

    // --- channel message
    const pm = await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "hi from http" } });
    assert.equal(pm.status, 200);
    const id = pm.json().id;
    const row = A.daemon.db.prepare("SELECT ch, type FROM outbox WHERE id = ?").get(id) as { ch: string; type: string };
    assert.deepEqual({ ...row }, { ch, type: "chat" });
    await waitFor(() => B.agent().peerChats.some((c) => c.id === id && c.body.text === "hi from http"), "B got http message");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "sent"), "ws message event");
    assert.ok(events.some((e) => e.type === "message" && e.message.id === id && e.message.status === "pending"));
    assert.ok(events.some((e) => e.type === "channel" && e.channel.id === ch));
    assert.equal((await http(port, "POST", `/api/channels/${ch}/messages`, { headers: H, body: { text: "x".repeat(16_001) } })).status, 400);
    assert.equal((await http(port, "POST", `/api/channels/AAAAAAAAAAAAAAAAAAAAAA/messages`, { headers: H, body: { text: "x" } })).status, 404);

    // incoming on A shows up in the list, unread resets on read
    const back = B.daemon.sendHuman(ch, "back at you");
    await waitFor(() => events.some((e) => e.type === "message" && e.message.id === back.id), "incoming event");
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 1);
    const list = (await http(port, "GET", `/api/channels/${ch}/messages?limit=10`, { headers: H })).json();
    assert.ok(list.items.some((m: any) => m.type === "hello" && !m.mine && m.fromName === "Bob"));
    assert.deepEqual(
      list.items.filter((m: any) => m.type === "chat").map((m: any) => [m.text, m.mine, m.status]),
      [
        ["hi from http", true, "sent"],
        ["back at you", false, "received"],
      ],
    );
    assert.equal(A.daemon.core.getChannel(ch)!.unread, 0);
    const older = (await http(port, "GET", `/api/channels/${ch}/messages?before=${back.id}`, { headers: H })).json();
    assert.deepEqual(
      older.items.filter((m: any) => m.type === "chat").map((m: any) => m.id),
      [id],
    );
    assert.ok(older.items.every((m: any) => m.id !== back.id));

    // --- patch channel
    const pt = await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { name: "Bobby", autoReply: false, allowedMcpTools: ["mcp__fs__read"] } });
    assert.equal(pt.status, 200);
    assert.equal(pt.json().name, "Bobby");
    assert.equal(pt.json().autoReply, false);
    assert.deepEqual(pt.json().allowedMcpTools, ["mcp__fs__read"]);
    assert.ok(A.agent().changed.includes(ch));
    assert.equal((await http(port, "PATCH", `/api/channels/${ch}`, { headers: H, body: { autoReply: "yes" } })).status, 400);

    // --- transfers + mcp (stubs)
    assert.deepEqual((await http(port, "GET", "/api/transfers", { headers: H })).json(), { items: [] });
    const tq = await http(port, "POST", "/api/transfers", { headers: H, body: { ch, path: "/tmp/x" } });
    assert.equal(tq.status, 200);
    assert.equal(A.transfers().requests[0].req.initiatedBy, "owner");
    const uploadUrl = `/api/transfers/upload?ch=${encodeURIComponent(ch)}&name=${encodeURIComponent("notes <draft>.txt")}&uploadId=upload-key-00000001`;
    assert.equal((await http(port, "POST", `/api/transfers/upload?ch=${encodeURIComponent(ch)}&name=x`, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/octet-stream" } })).status, 400);
    assert.equal((await http(port, "POST", uploadUrl, { body: Buffer.from("untrusted bytes"), headers: { "Content-Type": "application/octet-stream" } })).status, 401);
    const uploaded = await http(port, "POST", uploadUrl, { body: Buffer.from("synthetic upload"), headers: { ...H, "Content-Type": "application/octet-stream" } });
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json().name, "notes <draft>.txt");
    assert.equal(A.transfers().requests[1].req.initiatedBy, "owner");
    assert.equal(A.transfers().requests[1].req.path, "notes <draft>.txt");
    assert.equal(A.transfers().uploads[0].uploadId, "upload-key-00000001");
    assert.equal(A.transfers().uploads[0].data.toString(), "synthetic upload");
    assert.equal((await http(port, "POST", uploadUrl, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/json" } })).status, 415);
    assert.equal((await http(port, "POST", `/api/transfers/upload?ch=unknown&name=x`, { body: Buffer.from("x"), headers: { ...H, "Content-Type": "application/octet-stream" } })).status, 400);
    assert.equal((await http(port, "POST", "/api/transfers/abc/approve", { headers: H })).status, 404);
    assert.deepEqual((await http(port, "GET", "/api/mcp", { headers: H })).json(), { servers: [] });
    assert.equal((await http(port, "GET", "/api/nope", { headers: H })).status, 404);

    // --- body limit
    assert.equal((await http(port, "POST", "/api/owner/messages", { headers: H, body: { text: "x".repeat(1024 * 1024 + 10) } })).status, 413);

    // --- leave
    assert.equal((await http(port, "DELETE", `/api/channels/${ch}`, { headers: H })).status, 200);
    assert.equal((await http(port, "GET", "/api/state", { headers: H })).json().channels.length, 0);
    assert.ok(events.some((e) => e.type === "channel_removed" && e.ch === ch));
  } finally {
    for (const s of sockets) s.terminate();
    await A.daemon.stop();
    await B.daemon.stop();
    await relay.close();
    t.cleanup();
  }
});

test("http api: placeholder page when the web UI is not installed", async () => {
  const t = tempDir();
  const A = await startNode(t.dir, "ws://127.0.0.1:1/ws", "Solo");
  try {
    const r = await http(A.daemon.port, "GET", "/");
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(A.daemon.token));
    assert.ok(r.text.includes("Spencer is running"));
  } finally {
    await A.daemon.stop();
    t.cleanup();
  }
});
