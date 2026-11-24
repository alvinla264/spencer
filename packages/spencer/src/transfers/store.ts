import type { DatabaseSync } from "node:sqlite";
import type { Transfer, TransferDirection, TransferInitiator } from "../contracts.ts";

/** A persisted transfer row (superset of the API `Transfer`). */
export interface TransferRow {
  tid: string;
  /** Local-only upload retry key; absent for all other transfer origins. */
  uploadId: string | null;
  ch: string;
  direction: TransferDirection;
  peer: string;
  name: string;
  size: number;
  sha256: string;
  state: Transfer["state"];
  attempt: number;
  /** croc code (secret). Cleared once the transfer is terminal. */
  code: string | null;
  via: "link" | "croc" | null;
  initiatedBy: TransferInitiator;
  reason: string | null;
  error: string | null;
  /** out: staged copy; in: quarantined file once completed. */
  path: string | null;
  /** Whether the peer has been told about this transfer (decides file_cancel on expiry/cancel). */
  peerKnows: boolean;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  tid TEXT PRIMARY KEY,
  upload_id TEXT,
  ch TEXT NOT NULL,
  direction TEXT NOT NULL,
  peer TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  code TEXT,
  via TEXT,
  initiated_by TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  path TEXT,
  peer_knows INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_ch_created ON transfers(ch, created_at);
CREATE INDEX IF NOT EXISTS transfers_state ON transfers(state);
`;

const COLS: Record<keyof TransferRow, string> = {
  tid: "tid",
  uploadId: "upload_id",
  ch: "ch",
  direction: "direction",
  peer: "peer",
  name: "name",
  size: "size",
  sha256: "sha256",
  state: "state",
  attempt: "attempt",
  code: "code",
  via: "via",
  initiatedBy: "initiated_by",
  reason: "reason",
  error: "error",
  path: "path",
  peerKnows: "peer_knows",
  nextAttemptAt: "next_attempt_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  expiresAt: "expires_at",
};

type SqlValue = string | number | null;

function toSql(k: keyof TransferRow, v: unknown): SqlValue {
  if (k === "peerKnows") return v ? 1 : 0;
  if (v === undefined) return null;
  return v as SqlValue;
}

function fromSql(r: Record<string, unknown>): TransferRow {
  return {
    tid: r.tid as string,
    uploadId: (r.upload_id as string | null) ?? null,
    ch: r.ch as string,
    direction: r.direction as TransferDirection,
    peer: r.peer as string,
    name: r.name as string,
    size: Number(r.size),
    sha256: r.sha256 as string,
    state: r.state as Transfer["state"],
    attempt: Number(r.attempt),
    code: (r.code as string | null) ?? null,
    via: (r.via as TransferRow["via"]) ?? null,
    initiatedBy: r.initiated_by as TransferInitiator,
    reason: (r.reason as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    path: (r.path as string | null) ?? null,
    peerKnows: Number(r.peer_knows) === 1,
    nextAttemptAt: r.next_attempt_at == null ? null : Number(r.next_attempt_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    expiresAt: Number(r.expires_at),
  };
}

export const NON_TERMINAL_SQL = "('awaiting_approval','offered','accepted','sending','receiving')";

export class TransferStore {
  db: DatabaseSync;
  private seq = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
    const columns = db.prepare("PRAGMA table_info(transfers)").all();
    if (!columns.some((column) => column.name === "via")) db.exec("ALTER TABLE transfers ADD COLUMN via TEXT");
    if (!columns.some((column) => column.name === "upload_id")) db.exec("ALTER TABLE transfers ADD COLUMN upload_id TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS transfers_upload_id ON transfers(upload_id) WHERE upload_id IS NOT NULL");
  }

  /**
   * Runs fn atomically. Uses SAVEPOINTs, so it works both standalone (acts as BEGIN…COMMIT) and when the
   * caller (e.g. the inbox router) already has a transaction open.
   */
  tx<T>(fn: () => T): T {
    const name = `xfer_${++this.seq}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw e;
    }
  }

  get(tid: string): TransferRow | undefined {
    const r = this.db.prepare("SELECT * FROM transfers WHERE tid = ?").get(tid) as Record<string, unknown> | undefined;
    return r ? fromSql(r) : undefined;
  }

  byUploadId(uploadId: string): TransferRow | undefined {
    const r = this.db.prepare("SELECT * FROM transfers WHERE upload_id = ?").get(uploadId) as Record<string, unknown> | undefined;
    return r ? fromSql(r) : undefined;
  }

  list(ch?: string): TransferRow[] {
    const rows = (
      ch === undefined
        ? this.db.prepare("SELECT * FROM transfers ORDER BY created_at DESC, tid").all()
        : this.db.prepare("SELECT * FROM transfers WHERE ch = ? ORDER BY created_at DESC, tid").all(ch)
    ) as Record<string, unknown>[];
    return rows.map(fromSql);
  }

  nonTerminal(): TransferRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM transfers WHERE state IN ${NON_TERMINAL_SQL} ORDER BY created_at`)
      .all() as Record<string, unknown>[];
    return rows.map(fromSql);
  }

  insert(row: TransferRow): void {
    const keys = Object.keys(COLS) as (keyof TransferRow)[];
    const sql = `INSERT INTO transfers (${keys.map((k) => COLS[k]).join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
    this.db.prepare(sql).run(...keys.map((k) => toSql(k, row[k])));
  }

  update(tid: string, patch: Partial<TransferRow>): void {
    const keys = (Object.keys(patch) as (keyof TransferRow)[]).filter((k) => k !== "tid");
    if (keys.length === 0) return;
    const sql = `UPDATE transfers SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")} WHERE tid = ?`;
    this.db.prepare(sql).run(...keys.map((k) => toSql(k, patch[k])), tid);
  }
}
