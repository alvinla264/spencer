import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDraftFile, uploadDraftBatch } from "../public/draft-batch.js";
import { discardEmptyChannelDraftState, getChannelDraftState } from "../public/draft-state.js";

const draft = (name, file = { name }) => ({ file, status: "draft" });

test("channel state survives navigation while text or a send is pending", () => {
  const states = new Map();
  const original = getChannelDraftState(states, "channel-a");
  original.messageText = "unsent text";
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(getChannelDraftState(states, "channel-a"), original);

  original.messageText = "message with attachment";
  original.sending = true;
  original.drafts.push(draft("file.txt"));
  original.drafts.length = 0; // Upload completed; the message request is still pending.
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(getChannelDraftState(states, "channel-a"), original);
  assert.equal(original.sending, true);

  original.sending = false;
  original.messageText = ""; // Message send succeeded.
  discardEmptyChannelDraftState(states, "channel-a", original);
  assert.equal(states.has("channel-a"), false);
});

test("distinct same-metadata files are not silently collapsed", () => {
  const firstFile = { name: "report.txt", size: 12, lastModified: 1 };
  const otherFile = { name: "report.txt", size: 12, lastModified: 1 };
  const drafts = [draft("report.txt", firstFile)];
  assert.equal(hasDraftFile(drafts, firstFile), true);
  assert.equal(hasDraftFile(drafts, otherFile), false);
});

function controls(drafts, upload) {
  return {
    isPresent: (item) => drafts.includes(item),
    upload,
    onSuccess: (item) => { item.status = "sent"; },
    onFailure: (item) => { item.status = "failed"; },
  };
}

test("a Send snapshots its files; removing queued drafts skips them and later drops wait", async () => {
  const active = draft("active.txt");
  const removed = draft("removed.txt");
  const drafts = [active, removed];
  const calls = [];
  let release;
  const pending = uploadDraftBatch(drafts, controls(drafts, async (item) => {
    calls.push(item.file.name);
    if (item === active) await new Promise((resolve) => { release = resolve; });
    return {};
  }));

  drafts.splice(drafts.indexOf(removed), 1);
  const later = draft("later.txt");
  drafts.push(later);
  release();

  assert.equal(await pending, true);
  assert.deepEqual(calls, ["active.txt"]);
  assert.equal(later.status, "draft");
});

test("a second view cannot upload files already reserved by an in-flight Send", async () => {
  const first = draft("first.txt");
  const second = draft("second.txt");
  const drafts = [first, second];
  const calls = [];
  let release;
  const upload = async (item) => {
    calls.push(item.file.name);
    if (item === first) await new Promise((resolve) => { release = resolve; });
    return {};
  };

  const initialSend = uploadDraftBatch(drafts, controls(drafts, upload));
  assert.equal(first.status, "uploading");
  assert.equal(second.status, "queued");
  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), true);
  assert.deepEqual(calls, ["first.txt"]);
  release();
  assert.equal(await initialSend, true);
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
});

test("partial failure retries only unsuccessful files, not successful transfers", async () => {
  const first = draft("first.txt");
  const second = draft("second.txt");
  const third = draft("third.txt");
  const drafts = [first, second, third];
  const calls = [];
  let failSecond = true;
  const upload = async (item) => {
    calls.push(item.file.name);
    if (item === second && failSecond) throw new Error("synthetic failure");
    return {};
  };

  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), false);
  assert.deepEqual(calls, ["first.txt", "second.txt"]);
  assert.deepEqual(drafts.map((item) => item.status), ["sent", "failed", "draft"]);
  failSecond = false;
  assert.equal(await uploadDraftBatch(drafts, controls(drafts, upload)), true);
  assert.deepEqual(calls, ["first.txt", "second.txt", "second.txt", "third.txt"]);
});
