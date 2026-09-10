import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { measureAutopilot } from "../lib/seo-autopilot.mjs";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("TITLE measurement uses the existing before/7d/28d model and reports outcomes without inventing data", () => {
  assert.equal(measureAutopilot({}, {}).status, "INSUFFICIENT_DATA");
  assert.equal(measureAutopilot({ clicks: 10, sessions: 2 }, { clicks: 14, sessions: 3 }).status, "IMPROVED");
  assert.equal(measureAutopilot({ clicks: 10, sessions: 2 }, { clicks: 7, sessions: 1 }).status, "DECLINED");
});

test("TITLE execution stores one mapped before snapshot and cron measures the same article/query at 7d and 28d", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  for (const value of [
    "const titleMetricSummary",
    "wordpress_article_mappings",
    "m.status IN ('APPROVED','MODIFIED')",
    "gsc_search_performance WHERE client_id=? AND date>=? AND page=? GROUP BY query",
    "target_queries_json",
    "targetQueries:queryMetrics",
    "ga4_page_performance WHERE client_id=? AND date>=? AND landing_page=?",
    "action.action_type===\"TITLE_OPTIMIZATION\"?await titleMetricSummary",
    "window_days,metrics_json,result_status,measured_at",
    "ON CONFLICT(action_id,window_days) DO UPDATE SET metrics_json=excluded.metrics_json",
    "measurement:\"SCHEDULED_7D_28D\"",
  ]) assert.ok(api.includes(value), `missing ${value}`);
});

test("TITLE measurement is returned only from the owner-scoped Autopilot payload and rendered with explicit unavailable states", async () => {
  const [api, ui] = await Promise.all([source("app/api/[[...path]]/route.ts"), source("app/seo-loop-app.tsx")]);
  assert.match(api, /ownedClient\(clientId, owner\)/);
  assert.match(api, /titleMeasurements:parsedMeasurements\.filter/);
  for (const value of ["TITLE Measurement", "Target Queryの観測値", "Before", "PENDING", "DATA_NOT_AVAILABLE", "titleMetricValue", "windowDays === 0", "[0, 7, 28]"]) assert.ok(ui.includes(value), `missing ${value}`);
});
