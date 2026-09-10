import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("keyword strategy keeps model input bounded and excludes WordPress bodies", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const context = worker.slice(worker.indexOf("function keywordStrategyContext"), worker.indexOf("function normalizeAio"));
  assert.match(context, /published_articles: articleSummary/);
  assert.match(context, /excerpt: String\(post\?\.excerpt \|\| ""\)\.slice\(0, 240\)/);
  assert.doesNotMatch(context, /post\?\.content/);
  assert.match(worker, /function keywordStrategyFallback/);
  assert.match(worker, /primary_information/);
  assert.match(worker, /primary\.length > 0 && !\[\.\.\.terms\]\.some/);
  assert.match(worker, /volume.*search_volume/);
  assert.match(worker, /strategy_source: "UBERSUGGEST_FALLBACK"/);
  assert.match(worker, /Promise\.race\(\[model, wait\(20 \* 1000\)\.then\(\(\) => null\)\]\)/);
});

test("Anthropic transient 524 handling is finite and each retry receives a new timeout controller", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(worker, /function retryableAnthropicStatus\(status: number\).*status === 524/s);
  assert.match(worker, /for \(let transportAttempt = 0; transportAttempt <= transientRetries; transportAttempt\+\+\)/);
  assert.match(worker, /const controller = new AbortController\(\)/);
  assert.match(worker, /if \(retryableAnthropicStatus\(r\.status\) && transportAttempt < transientRetries\)/);
  assert.match(worker, /timeoutMs: 45 \* 1000, transientRetries: 1/);
});

test("keyword strategy retry dispatches immediately while retaining the durable queue fallback", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  const retry = api.slice(api.indexOf("if (retryJobRoute)"), api.indexOf("const automationRoute"));
  assert.match(retry, /await dispatchCloudJob\(nextId, false, new URL\(request\.url\)\.origin\)\.catch\(\(\) => undefined\)/);
  assert.match(api, /body: JSON\.stringify\(\{ jobId, runNow \}\)/);
});
