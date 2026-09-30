import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("article workflow runtime tables are included in a safe deployment migration", async () => {
  const sql = await readFile(
    path.join(root, "drizzle", "0019_article_workflow_and_missing_runtime_tables.sql"),
    "utf8",
  );
  for (const table of [
    "article_creation_inputs",
    "reference_sources",
    "article_series",
    "article_series_items",
    "article_schedules",
    "article_schedule_history",
    "article_generation_settings",
    "generation_settings_snapshots",
    "monthly_content_plans",
    "monthly_content_plan_items",
    "title_optimization_proposals",
    "title_optimization_history_v2",
    "internal_link_execution_history",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /category_id INTEGER/);
  assert.match(sql, /idx_monthly_content_plan_once/);
});
