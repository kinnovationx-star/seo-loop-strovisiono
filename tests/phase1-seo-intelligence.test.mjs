import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Phase 1は履歴型GSC・GA4テーブルと重複防止キーを持つ", async () => {
  const migration = await source("drizzle/0005_seo_intelligence_foundation.sql");
  assert.match(migration, /gsc_search_performance/);
  assert.match(migration, /client_id, date, query, page/);
  assert.match(migration, /ga4_page_performance/);
  assert.match(migration, /client_id, date, landing_page, source, medium/);
});

test("Phase 1 APIはクライアント境界を確認してSEOデータを操作する", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  assert.match(api, /clients\\\/\(\[\^\/\]\+\)\\\/seo-map/);
  assert.match(api, /clients\\\/\(\[\^\/\]\+\)\\\/seo-performance/);
  assert.match(api, /ownedClient\(clientId, owner\)/);
  assert.match(api, /WHERE id=\? AND client_id=\?/);
  assert.match(api, /syncGscHistory/);
  assert.match(api, /syncGa4History/);
});

test("Phase 1画面は追加・編集・無効化・同期・期間切替を提供する", async () => {
  const ui = await source("app/seo-loop-app.tsx");
  for (const expected of ["SEOトピック", "Topicを追加", "Keywordを追加", "GSCを同期", "GA4を同期", "直近7日", "直近28日", "直近3か月", "無効化", "Content Briefを追加"]) assert.match(ui, new RegExp(expected));
});
