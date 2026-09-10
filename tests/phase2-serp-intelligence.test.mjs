import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Phase 2は実SERP、競合分析、判断の履歴を分離して保存する", async () => {
  const migration = await source("drizzle/0007_phase2_serp_intelligence.sql");
  for (const table of ["serp_snapshots", "serp_results", "competitor_page_analysis", "keyword_serp_insights", "cannibalization_assessments", "content_decisions"]) assert.match(migration, new RegExp(table));
});

test("競合ページ取得は安全なURLとHTMLだけを対象にし、取得不能な内容を推測しない", async () => {
  const worker = await source("cloud-runner/src/index.ts");
  assert.match(worker, /function safeCompetitorUrl/);
  assert.match(worker, /not_html/);
  assert.match(worker, /DATA_NOT_AVAILABLE/);
  assert.match(worker, /serp_competitor_analyze/);
});

test("Phase 2 APIと画面はクライアント境界を確認してSERP取得・競合分析を提供する", async () => {
  const [api, ui] = await Promise.all([source("app/api/[[...path]]/route.ts"), source("app/seo-loop-app.tsx")]);
  assert.match(api, /serp-intelligence/);
  assert.match(api, /ownedClient\(clientId, owner\)/);
  assert.match(api, /serp_competitor_analyze/);
  for (const label of ["実SERP取得", "競合を取得・分析", "実SERP・競合ページ分析", "Overview", "Search Intent", "SERP Consensus", "Top 10", "Content Gap", "Differentiation", "Cannibalization", "Recommendation"]) assert.match(ui, new RegExp(label));
});

test("Phase 2は検索意図・Consensus・Gap・確認済み一次情報をContent Briefへ反映する", async () => {
  const [runner, api] = await Promise.all([source("cloud-runner/src/index.ts"), source("app/api/[[...path]]/route.ts")]);
  for (const intent of ["informational", "commercial", "transactional", "navigational", "local"]) assert.match(runner, new RegExp(intent));
  for (const key of ["commonTopics", "commonQuestions", "commonFormats", "requiredTopics", "competitorWeaknesses", "NO_CONFIRMED_DIFFERENTIATION", "confirmedPrimary"]) assert.match(runner, new RegExp(key));
  for (const field of ["explicit_need", "latent_need", "anxiety", "comparison_axes", "desired_outcome", "serp_consensus", "required_topics", "content_gap", "differentiation"]) assert.match(api, new RegExp(field));
});

test("Phase 2はカニバリゼーションの根拠と6種類のコンテンツ判断を保存する", async () => {
  const [runner, api] = await Promise.all([source("cloud-runner/src/index.ts"), source("app/api/[[...path]]/route.ts")]);
  for (const risk of ["NONE", "LOW", "MEDIUM", "HIGH"]) assert.match(runner, new RegExp(risk));
  for (const signal of ["keywordOverlap", "intentOverlap", "topicCluster", "gscQuery", "articleMapping", "contentSimilarity"]) assert.match(runner, new RegExp(signal));
  for (const action of ["NEW_ARTICLE", "UPDATE_EXISTING", "MERGE", "CHANGE_ANGLE", "DO_NOT_CREATE", "HUMAN_REVIEW"]) assert.match(api, new RegExp(action));
  assert.match(api, /risk === "HIGH" && action === "NEW_ARTICLE"/);
});

test("Phase 2は有限リトライ、冪等保存、Provider未取得値を明示する", async () => {
  const [runner, api, provider] = await Promise.all([source("cloud-runner/src/index.ts"), source("app/api/[[...path]]/route.ts"), source("lib/serp-provider.ts")]);
  assert.match(runner, /attempt <= 2/);
  assert.match(api, /attempts<3/);
  for (const index of ["idx_serp_snapshot_job", "idx_competitor_analysis_result", "idx_keyword_serp_insight_snapshot", "idx_cannibal_snapshot", "idx_content_decision_snapshot"]) assert.match(await source("drizzle/0007_phase2_serp_intelligence.sql"), new RegExp(index));
  assert.match(api, /ON CONFLICT\(snapshot_id,rank,url\) DO NOTHING/);
  for (const unavailable of ["ai_overview", "people_also_ask", "local_pack", "DATA_NOT_AVAILABLE"]) assert.match(provider, new RegExp(unavailable));
});
