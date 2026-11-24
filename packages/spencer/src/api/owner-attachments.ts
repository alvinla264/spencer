import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OwnerAttachment } from "../contracts.ts";

export const OWNER_ATTACHMENT_MAX_FILES = 10;
export const OWNER_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
export const OWNER_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const OWNER_ATTACHMENT_MAX_STORED_BYTES = 500 * 1024 * 1024;
const OWNER_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredAttachment extends OwnerAttachment {
  path: string;
  sha256: string;
  uploadId: string;
  createdAt: number;
}

/** Private, local-only storage for owner conversation attachments (never a channel transfer). */
export class OwnerAttachmentStore {
  private readonly db: DatabaseSync;
  private readonly dir: string;
  private pendingBytes = 0;

  constructor(db: DatabaseSync, dataDir: string) {
    this.db = db;
    this.dir = join(dataDir, "owner-attachments");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_send_idempotency (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        submission_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owner_attachments (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async initialize(): Promise<void> {
    await this.cleanupExpired();
    const rows = this.db.prepare("SELECT path FROM owner_attachments").all() as { path: string }[];
    const known = new Set(rows.map((row) => row.path));
    for (const entry of await readdir(this.dir)) {
      const path = join(this.dir, entry);
      if (entry.includes(".tmp-") || !known.has(path)) await rm(path, { force: true });
    }
  }

  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now() - OWNER_ATTACHMENT_TTL_MS;
    const expired = this.db.prepare("SELECT id, path FROM owner_attachments WHERE created_at < ?").all(cutoff) as { id: string; path: string }[];
    for (const item of expired) {
      await rm(item.path, { force: true });
      this.db.prepare("DELETE FROM owner_attachments WHERE id = ?").run(item.id);
    }
  }

  findOwnerSend(requestId: string, fingerprint: string): string | undefined {
    const row = this.db.prepare("SELECT fingerprint, submission_id FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
      | { fingerprint: string; submission_id: string }
      | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new Error("request ID was already used for different owner content");
    return row.submission_id;
  }

  recordOwnerSend(requestId: string, fingerprint: string, submissionId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO owner_send_idempotency (request_id, fingerprint, submission_id) VALUES (?, ?, ?)")
      .run(requestId, fingerprint, submissionId);
    const row = this.db.prepare("SELECT fingerprint, submission_id FROM owner_send_idempotency WHERE request_id = ?").get(requestId) as
      | { fingerprint: string; submission_id: string }
      | undefined;
    if (!row || row.fingerprint !== fingerprint || row.submission_id !== submissionId) {
      throw new Error("request ID was already used for different owner content");
    }
  }

  async upload(name: string, uploadId: string, bytes: AsyncIterable<Uint8Array>): Promise<StoredAttachment> {
    await this.cleanupExpired();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of bytes) {
      size += chunk.byteLength;
      if (size > OWNER_ATTACHMENT_MAX_FILE_BYTES) throw new Error("file exceeds the 25 MiB upload limit");
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks, size);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const existing = this.db.prepare("SELECT * FROM owner_attachments WHERE upload_id = ?").get(uploadId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.name !== name || existing.sha256 !== sha256 || Number(existing.size) !== size) throw new Error("upload id was already used for different content");
      return this.fromRow(existing);
    }

    const stored = Number((this.db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM owner_attachments").get() as { total: number }).total);
    if (stored + this.pendingBytes + size > OWNER_ATTACHMENT_MAX_STORED_BYTES) throw new Error("private attachment storage is full; remove older attachments first");
    this.pendingBytes += size;
    const id = randomUUID();
    const path = join(this.dir, id);
    const temp = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
      const createdAt = Date.now();
      try {
        this.db.prepare("INSERT INTO owner_attachments (id, upload_id, name, size, sha256, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, uploadId, name, size, sha256, path, createdAt);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      return { id, uploadId, name, size, sha256, path, createdAt };
    } finally {
      this.pendingBytes -= size;
      await rm(temp, { force: true });
    }
  }

  get(ids: string[]): StoredAttachment[] {
    const found = ids.map((id) => {
      const row = this.db.prepare("SELECT * FROM owner_attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? this.fromRow(row) : undefined;
    });
    if (found.some((item) => !item)) throw new Error("one or more attachments are unavailable; keep the drafts and retry");
    const items = found as StoredAttachment[];
    if (items.length > OWNER_ATTACHMENT_MAX_FILES || items.reduce((n, item) => n + item.size, 0) > OWNER_ATTACHMENT_MAX_BYTES) {
      throw new Error("the composer allows up to 10 files and 50 MiB at a time");
    }
    return items;
  }

  private fromRow(row: Record<string, unknown>): StoredAttachment {
    return {
      id: String(row.id), uploadId: String(row.upload_id), name: String(row.name), size: Number(row.size),
      sha256: String(row.sha256), path: String(row.path), createdAt: Number(row.created_at),
    };
  }
}
