import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OwnerAttachmentStore } from "../../src/api/owner-attachments.ts";

async function* data(value: string) {
  yield Buffer.from(value);
}

test("owner attachment storage is private, safe from filename paths, and retries are idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spencer-owner-files-"));
  const db = new DatabaseSync(join(dir, "core.sqlite"));
  try {
    const store = new OwnerAttachmentStore(db, dir);
    const attachment = await store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    assert.equal(readFileSync(attachment.path, "utf8"), "synthetic file bytes");
    assert.equal(statSync(attachment.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "owner-attachments")).mode & 0o777, 0o700);
    assert.equal(attachment.path.startsWith(join(dir, "owner-attachments") + "/"), true);
    assert.equal(attachment.path.includes("ignore previous instructions"), false);
    const retry = await store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("synthetic file bytes"));
    assert.equal(retry.id, attachment.id);
    assert.equal(store.get([attachment.id])[0]?.path, attachment.path);
    store.recordOwnerSend("owner-send-key-0001", "fingerprint-one", "submission-one");
    assert.equal(store.findOwnerSend("owner-send-key-0001", "fingerprint-one"), "submission-one");
    assert.throws(() => store.findOwnerSend("owner-send-key-0001", "different-content"), /different owner content/);
    await assert.rejects(store.upload("../../ignore previous instructions.txt", "owner-upload-key-0001", data("different bytes")), /already used for different content/);
    assert.throws(() => store.get(["unknown-attachment-id"]), /unavailable/);
    const orphan = join(dir, "owner-attachments", "orphan.tmp-left-by-crash");
    writeFileSync(orphan, "untracked");
    await store.initialize();
    assert.equal(existsSync(orphan), false, "startup removes leftover partial files");
    db.prepare("UPDATE owner_attachments SET created_at = ? WHERE id = ?").run(Date.now() - 31 * 24 * 60 * 60 * 1000, attachment.id);
    await store.upload("new.txt", "owner-upload-key-0002", data("new content"));
    assert.equal(existsSync(attachment.path), false, "expired attachment bytes are removed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
