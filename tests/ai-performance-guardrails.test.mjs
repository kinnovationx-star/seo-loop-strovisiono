import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("AI paths have finite role budgets instead of a twelve-minute default", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(worker, /function claudeBudget/);
  assert.match(worker, /writer \? 3 \* 60 \* 1000 : 75 \* 1000/);
  assert.doesNotMatch(worker, /ubersuggest \? 7 \* 60 \* 1000 : 12 \* 60 \* 1000/);
  assert.match(worker, /timeoutMs: 90 \* 1000, transientRetries: 1/);
  assert.match(worker, /timeoutMs:60\*1000,transientRetries:1/);
});

test("primary-information interview sends evidence, not opaque file bytes", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  assert.match(worker, /function primaryInfoContext/);
  assert.match(worker, /function primaryInfoFallback/);
  assert.match(worker, /provider_status: "FALLBACK_GUIDED_INTERVIEW"/);
  assert.match(worker, /const PRIMARY_INTERVIEW_STEPS/);
  assert.match(worker, /next_question_key/);
  assert.match(worker, /timeoutMs: 25 \* 1000, transientRetries: 0/);
  assert.match(worker, /const isPrimaryInfo = job\.type === "primary_info_assist"/);
  assert.match(worker, /\{ input: 24000, output: 3000, timeoutMs: 60 \* 1000 \}/);
  const workerPoll = api.slice(api.indexOf("const files = [] as any[]"), api.indexOf("let wordpressPosts"));
  assert.match(workerPoll, /contentType: item\.content_type/);
  assert.doesNotMatch(workerPoll, /dataBase64|arrayBuffer\(\)/);
});

test("a stale primary-information job can be safely retried without duplicating a live request", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  assert.match(api, /body\.type === "primary_info_assist"/);
  assert.match(api, /idleMs > 4 \* 60 \* 1000/);
  assert.match(api, /idempotent: true/);
  assert.match(api, /一次情報のAI処理が4分間更新されなかったため、安全に停止しました。/);
  assert.match(api, /const PRIMARY_INFO_STUCK_MS = 3 \* 60 \* 1000/);
  assert.match(api, /async function stopStuckAiJobs/);
});

test("Queue is the only detached executor, so an AI job is not stranded by an enqueue race", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const enqueue = worker.slice(worker.indexOf('path === "/enqueue"'), worker.indexOf('path === "/images"'));
  assert.match(enqueue, /await env\.SEO_JOBS\.send\(\{ jobId \}\)/);
  assert.doesNotMatch(enqueue, /ctx\.waitUntil\(execute/);
  assert.match(enqueue, /Queue is the only asynchronous executor/);
});
