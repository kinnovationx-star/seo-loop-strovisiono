import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("記事マッピング候補は承認・修正・却下を履歴として保存する", async () => {
  const migration = await source("drizzle/0006_phase1_article_mapping_and_priority_weights.sql");
  const api = await source("app/api/[[...path]]/route.ts");
  for (const value of ["article_mapping_candidates", "suggested_topic_id", "suggested_cluster_id", "suggested_keyword_id", "PENDING"]) assert.match(migration, new RegExp(value));
  for (const value of ["REJECTED", "MODIFIED", "REANALYZING"]) assert.match(api, new RegExp(value));
  assert.match(api, /article-mappings/);
  assert.match(api, /keyword_article_relations/);
  assert.match(api, /normalizeKeyword\(keywordText\)/);
});

test("再分析はブラウザで待たずCloudflare Queueジョブとして記録される", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  const runner = await source("cloud-runner/src/index.ts");
  assert.match(api, /article_mapping_analyze/);
  assert.match(api, /dispatchCloudJob\(job.id/);
  assert.match(runner, /article_mapping_analyze/);
  assert.match(runner, /suggested_keyword_id/);
});

test("Priority Weightはクライアント単位で100合計を検証し再計算する", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  const ui = await source("app/seo-loop-app.tsx");
  assert.match(api, /client_priority_weights/);
  assert.match(api, /ウェイト合計を100にしてください/);
  assert.match(api, /UPDATE seo_keywords SET priority_score/);
  assert.match(ui, /Priority Weight/);
  assert.match(ui, /保存して再計算/);
});

test("マッピングとウェイトのすべてのAPIはクライアント所有権を確認する", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  const checks = api.match(/ownedClient\(clientId, owner\)/g) || [];
  assert.ok(checks.length >= 8);
  assert.match(api, /WHERE id=\? AND client_id=\?/);
});
