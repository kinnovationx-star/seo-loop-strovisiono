import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("Google履歴同期は90日分を日別の外部API呼び出しに分割しない", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  const gsc = api.slice(api.indexOf("async function syncGscHistory"), api.indexOf("async function syncGa4History"));
  const ga4 = api.slice(api.indexOf("async function syncGa4History"), api.indexOf("async function wordpressInventory"));
  assert.match(gsc, /dimensions: \["date", "query", "page"\]/);
  assert.match(gsc, /startDate: start, endDate: end/);
  assert.doesNotMatch(gsc, /for \(const day of dayList/);
  assert.match(ga4, /dateRanges: \[\{ startDate: start, endDate: end \}\]/);
  assert.match(ga4, /rawDate.*slice\(0, 4\)/);
  assert.doesNotMatch(ga4, /for \(const day of dayList/);
});

test("Google同期は日付粒度のD1 upsertを維持する", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  assert.match(api, /ON CONFLICT\(client_id,date,query,page\) DO UPDATE/);
  assert.match(api, /ON CONFLICT\(client_id,date,landing_page,source,medium\) DO UPDATE/);
});
