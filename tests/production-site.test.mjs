import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const compact = (value) => value.replace(/\s+/g, "");
// The cloud deployment repository intentionally contains only the Worker
// application. Legacy Mac-only helpers live outside this repository and must
// not make cloud CI fail just because they are absent from the checkout.
const hasLegacyMacRuntime = existsSync(path.join(root, "..", "production-worker.mjs"));
test("本番ビルドにSEO Loop UIとAPIルートを含む", async () => {
  const manifest = await readFile(
    path.join(root, "dist", "server", "index.js"),
    "utf8",
  );
  assert.ok(manifest.length > 1000);
  const source = await readFile(
    path.join(root, "app", "seo-loop-app.tsx"),
    "utf8",
  );
  for (const label of [
    "ダッシュボード",
    "LLMO / AIO",
    "記事投稿",
    "連携設定",
    "一次情報",
    "実行ログ",
  ])
    assert.match(source, new RegExp(label));
});
test("永続化・秘密情報暗号化・品質通知を実装する", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const server = await readFile(path.join(root, "lib", "server.ts"), "utf8");
  assert.match(api, /worker\/poll/);
  assert.match(compact(api), /status:\"draft\"/);
  assert.match(server, /AES-GCM/);
  assert.doesNotMatch(api, /localStorage/);
});
test("WordPressへ公開禁止のテスト下書きを安全に入稿できる", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "この設定で自動化されること",
    "記事の公開時刻ではありません",
    "テスト下書きを入稿",
    "WordPressで確認する",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /wordpress\\\/test-draft/);
  assert.match(api, /公開禁止・動作確認/);
  assert.match(compact(api), /status:"draft"/);
  assert.doesNotMatch(api, /status:\s*["']publish["']/);
});
test("手入力の記事作成欄を廃止しAI計画から約1万字の記事をPDCA生成する", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  assert.doesNotMatch(ui, /function ArticleForm/);
  assert.doesNotMatch(ui, /対象キーワード[\s\S]{0,500}記事ブリーフ/);
  for (const label of [
    "AI計画から記事公開後までの自動PDCA",
    "約10,000字",
    "手入力は不要です",
    "自動記事制作の対象",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /planKey/);
  assert.match(api, /monthly_report/);
  assert.match(worker, /targetCharacters/);
  assert.match(worker, /minimumCharacters/);
  assert.match(worker, /lengthOk/);
});
test("WordPress記事をGutenbergブロックと実在画像で構造化する", { skip: !hasLegacyMacRuntime }, async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  assert.match(api, /wordpressMediaInventory/);
  assert.match(api, /wp-json\/wp\/v2\/media/);
  assert.match(worker, /wp:paragraph/);
  assert.match(worker, /wp:heading/);
  assert.match(worker, /wp:image/);
  assert.match(worker, /gutenbergCheck/);
  assert.match(worker, /draft_only_missing_images/);
  assert.match(worker, /提供されていない画像URLや画像IDは作らない/);
});
test("一次情報をクライアント向け文章へ整え、URL一致のUbersuggestと詳しいAIO分析を使う", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  const primarySchema = await readFile(path.join(root, "..", "schemas", "primary-info.schema.json"), "utf8");
  const aioSchema = await readFile(path.join(root, "..", "schemas", "aio-analysis.schema.json"), "utf8");
  assert.match(primarySchema, /client_facing_summary/);
  assert.match(worker, /registered Ubersuggest projects/);
  assert.match(worker, /exactly matches/);
  assert.match(worker, /aio-analysis\.schema\.json/);
  assert.match(aioSchema, /priority_actions/);
  assert.match(ui, /Ubersuggest実データからのSEO改善点/);
  assert.match(ui, /keywords\.map/);
  assert.match(ui, /AI検索における現状と分析/);
  assert.match(ui, /JobProgress/);
});
test("Ubersuggestの主要ビューを圧縮してダッシュボードへ展開する", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  const schema = await readFile(path.join(root, "..", "schemas", "ubersuggest-snapshot.schema.json"), "utf8");
  for (const label of ["Ubersuggest 統合サマリー", "サイト監査", "SEOチャンス", "ランク追跡", "競合分析・競合リサーチ", "トピックリサーチ"])
    assert.match(ui, new RegExp(label));
  for (const field of ["dashboard", "rank_tracking", "seo_opportunities", "competitor_research", "topic_research"])
    assert.match(schema, new RegExp(field));
  assert.match(worker, /Dashboard metrics, Site Audit/);
  assert.match(worker, /Topic Research/);
});
test("AIO分析は必要な一次情報とSEO要約だけを渡し、入力過多でタイムアウトしない", async () => {
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(runner, /function aioContext/);
  assert.match(runner, /snapshots\.find\(\(item: any\) => item\.connector === "ubersuggest"\)/);
  assert.match(runner, /function keywordStrategyContext/);
  assert.match(runner, /isAio \? aioContext\(job\) : isKeywordStrategy \? keywordStrategyContext\(job\) : isPrimaryInfo \? primaryInfoContext\(job\) : job\.context/);
  assert.match(runner, /if \(isKeywordStrategy\) return resilientKeywordStrategy/);
  assert.match(runner, /function resilientKeywordStrategy/);
  assert.match(runner, /function normalizeAio/);
  assert.match(runner, /通常検索順位/);
});
test("AIO画面はAIが返した構造化アクションを安全な表示文字列へ変換する", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  assert.match(ui, /snapshot\.priority_actions[\s\S]{0,320}map\(\s*\(item: unknown, index: number\)/);
  assert.match(ui, /displayValue\(item, "改善内容を確認してください。"\)/);
});
test("連携障害はクラウド側で定期検知し、画面には最終認証確認を表示する", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  assert.match(api, /CONNECTION_HEALTH_INTERVAL_MS/);
  assert.match(api, /route === "worker\/healthcheck"/);
  assert.match(api, /checkConnectionHealth/);
  assert.match(runner, /connection_healthcheck/);
  assert.match(runner, /Promise\.all\(\[healthcheck\(env\), backup\(env\), execute\(env\)\]\)/);
  assert.match(ui, /最終認証確認/);
  assert.match(ui, /既に保存された分析データは保持されています/);
});
test("AIのJSON形式エラーは短い有効JSONを求めて一度だけ自動再試行する", async () => {
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(runner, /for \(let jsonAttempt = 0; jsonAttempt < 2; jsonAttempt\+\+\)/);
  assert.match(runner, /前回の形式が不正でした/);
  assert.match(runner, /if \(jsonAttempt === 1 \|\| ubersuggest\) throw error/);
});
test("下書きはスラッグ・抜粋を分け、必要なGPT Image 2画像だけをメタデータ付きで登録する", { skip: !hasLegacyMacRuntime }, async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const schema = await readFile(path.join(root, "..", "schemas", "article.schema.json"), "utf8");
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  assert.match(schema, /"excerpt"/);
  assert.match(schema, /"benefit"/);
  assert.match(api, /generateRequiredArticleImages/);
  assert.match(api, /articleImageBriefs/);
  assert.match(api, /featuredImageBrief/);
  assert.match(api, /アイキャッチ画像兼、記事冒頭の画像/);
  assert.match(api, /model: "gpt-image-2"/);
  assert.match(api, /articleImageBriefs\(article\)/);
  assert.match(schema, /"minItems": 1/);
  assert.match(worker, /アイキャッチ用/);
  assert.match(api, /featured_media: result\.featuredMediaId/);
  assert.match(api, /alt_text:/);
  assert.match(api, /caption:/);
  assert.match(api, /description:/);
  assert.match(api, /slug: result\.article\.slug/);
  assert.match(api, /excerpt: result\.article\.excerpt/);
  assert.doesNotMatch(api, /excerpt: result\.article\.meta_description/);
  assert.match(api, /quality exception is never an automatic-publication exception/i);
  assert.match(compact(api), /constwordpressPostStatus="draft"/);
  assert.match(api, /status: wordpressPostStatus/);
});
test("AI計画から本番記事を即日入稿する専用タブを提供する", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "即日入稿",
    "本番記事の即日入稿",
    "本番記事を今すぐ制作・入稿",
    "約10,000字・画像付きで制作",
    "テスト記事ではありません",
    "WordPressの本番用下書きを確認する",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(ui, /productionArticle: true/);
  assert.match(ui, /immediate: true/);
  assert.match(api, /このAI計画の記事はすでに制作済み/);
  assert.match(api, /planKey/);
});
test("即日入稿は実処理の進捗をパーセント表示する", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(
    path.join(root, "..", "production-worker.mjs"),
    "utf8",
  );
  assert.match(ui, /article-progress/);
  assert.match(ui, /progressPercent/);
  assert.match(worker, /worker\/progress/);
  assert.match(worker, /約10,000字の本文とGutenbergブロックを作成しています/);
  assert.match(worker, /"--output-schema"/);
  assert.match(worker, /"--ephemeral"/);
  assert.match(worker, /articleEvidence/);
  assert.match(api, /route === "worker\/progress"/);
  assert.match(api, /45 \* 60 \* 1000/);
});
test("クラウド連携の状態とGoogle設定を利用者へ明示する", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "クラウド実行",
    "Cloudflare Queueで自動実行",
    "同期を受付済み",
    "Google認証情報が一致していません",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /anthropicConfigured/);
  assert.match(api, /GOOGLE_OAUTH_CLIENT_ID/);
  assert.match(compact(api), /workers:workers\.results/);
});
test("ワーカートークンを全クライアントで共有し再発行時は旧トークンを無効化する", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /DELETE FROM worker_tokens WHERE client_id IN/);
  assert.match(api, /c\.owner_id=\?/);
  assert.match(api, /job\.client_id/);
  assert.match(api, /以前のワーカートークンは無効化/);
});
test("Cloudflare QueueはローカルMac登録なしでもWorker secretでジョブを取得できる", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const server = await readFile(path.join(root, "lib", "server.ts"), "utf8");
  assert.match(api, /cloudflare-job-runner/);
  assert.match(api, /token === runtime\(\)\.SEO_LOOP_WORKER_TOKEN/);
  assert.match(api, /internalDispatch === runtime\(\)\.CLOUD_DISPATCH_TOKEN/);
  assert.match(api, /SELECT id FROM clients ORDER BY created_at LIMIT 1/);
  assert.match(server, /SEO_LOOP_WORKER_TOKEN\?: string/);
  assert.match(server, /SEO_LOOP_ORIGIN\?: string/);
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(runner, /X-SEO-Loop-Dispatch/);
});
test("新規ジョブはCloudflare Queueへ即時送信し、障害時も定期実行へ残す", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /async function dispatchCloudJob/);
  assert.match(api, /runtime\(\)\.CLOUD_RUNNER_PUBLIC_URL \|\| runtime\(\)\.CLOUD_RUNNER_URL/);
  assert.match(api, /body: JSON\.stringify\(\{ jobId, runNow \}\)/);
  assert.match(api, /X-SEO-Loop-Dispatch/);
  assert.match(api, /new URL\(request\.url\)\.origin/);
  assert.match(api, /定期実行で再試行します/);
});
test("待機中のUbersuggest同期は重複作成せず同じQueueジョブを再送する", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /body\.type === "ubersuggest_sync"/);
  assert.match(api, /待機中のUbersuggest同期をCloudflare Queueへ再送/);
  assert.match(api, /replayed: true/);
});
test("Queue即時実行は対象ジョブだけを取得して別ジョブを巻き込まない", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(api, /searchParams\.get\("jobId"\)/);
  assert.match(api, /j\.id=\?/);
  assert.match(runner, /worker\/poll\?jobId=/);
  assert.match(runner, /async queue\(batch: MessageBatch/);
  assert.match(runner, /await execute\(env, message\.body\.jobId\)/);
  assert.doesNotMatch(runner, /ctx\.waitUntil\(execute\(env, jobId\)\)/);
  assert.match(runner, /if \(body\.runNow\)/);
});
test("解消済みエラーを上部へ残さずクライアントを安全に削除できる", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(ui, /latestByType/);
  assert.match(ui, /クライアントを削除/);
  assert.match(compact(ui), /index\+1/);
  assert.match(ui, /Cloudflare Queue/);
  assert.match(api, /export async function DELETE/);
  assert.match(api, /確認欄へ/);
  assert.match(api, /UPDATE worker_tokens SET client_id/);
});
test("MCP再認証を自動検知し初心者向け復旧手順と全APIガイドを表示する", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "MCP・Mac かんたん再接続",
    "codex mcp login Ubersuggest",
    "新しいクライアントの場合",
    "全連携の詳しい設定方法",
    "Google CloudのOAuth設定",
    "Application Password",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /reauth_required/);
  assert.match(api, /mcpUrl/);
  assert.match(api, /token\.\*expired/);
});
test("Ubersuggest OAuthの期限切れトークンを同期前に自動更新する", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /async function ubersuggestAccessToken/);
  assert.match(api, /grant_type: "refresh_token"/);
  assert.match(api, /Ubersuggest OAuthアクセストークンを自動更新/);
  assert.match(api, /await ubersuggestAccessToken\(job\.client_id\)/);
});
test("Google OAuth情報をWorker秘密値として使い、コールバック情報を安全に保持する", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const server = await readFile(path.join(root, "lib", "server.ts"), "utf8");
  const migration = await readFile(
    path.join(root, "drizzle", "0001_google_owner_settings.sql"),
    "utf8",
  );
  for (const label of [
    "Google認証が完了しました",
    "Google認証情報が一致していません",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(compact(api), /awaitrequireOwner\(request\)/);
  assert.match(api, /GOOGLE_OAUTH_CLIENT_SECRET/);
  assert.doesNotMatch(compact(api), /google:\{[^}]*clientSecret/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS app_settings/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_owner_key/,
  );
});
test("Google OAuthコールバック失敗を安全な案内へ戻し認証コードを画面に残さない", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /return await googleCallback\(request\)/);
  assert.match(api, /invalid_client/);
  assert.match(api, /Google OAuth token exchange failed/);
  assert.match(api, /DELETE FROM oauth_states/);
  assert.match(ui, /Google認証情報が一致していません/);
  assert.match(ui, /history\.replaceState/);
});
test("Google認証後に取得先一覧を表示し実API確認後だけ接続済みにする", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const value of [
    "accountSummaries",
    "webmasters/v3/sites",
    "drive/v3/about",
    "youtube/v3/channels",
    "googleSelectRoute",
    "status='connected'",
  ])
    assert.match(api, new RegExp(value));
  for (const label of [
    "取得先を選ぶ",
    "Googleの取得先を選択",
    "GA4プロパティ",
    "Search Consoleサイト",
    "選択して接続確認",
  ])
    assert.match(ui, new RegExp(label));
});
test("専用OG画像を含みスターター表示を残さない", async () => {
  const layout = await readFile(path.join(root, "app", "layout.tsx"), "utf8");
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(layout, /codex-preview/);
  await readFile(path.join(root, "public", "og.png"));
});
test("一次情報を対話回答と資料からClaude APIで整理する", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(
    path.join(root, "..", "production-worker.mjs"),
    "utf8",
  );
  const migration = await readFile(
    path.join(root, "drizzle", "0002_primary_info_files.sql"),
    "utf8",
  );
  for (const label of [
    "AIに答えるだけで、記事に使える情報が完成します",
    "AIからの質問",
    "内容を確認・編集する（必要な場合のみ）",
    "記事用にまとめる",
    "送る",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /source-files/);
  assert.match(api, /FILES!\.put/);
  assert.match(api, /primary_info_assist/);
  assert.match(worker, /extractOfficeText/);
  assert.match(worker, /aiSiteBackground/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS source_files/);
});
test("Claude APIの認証エラーを検知して前回内容を再実行できる", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(
    path.join(root, "..", "production-worker.mjs"),
    "utf8",
  );
  for (const label of [
    "AIへの接続を確認してください",
    "もう一度試す",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(compact(api), /job\.type==="primary_info_assist"/);
  assert.match(api, /reauth_required/);
  assert.match(worker, /authentication\|401/);
});
test("一次情報整理ではサイト確認と構造化を分離しCodex互換スキーマを使用する", { skip: !hasLegacyMacRuntime }, async () => {
  const worker = await readFile(
    path.join(root, "..", "production-worker.mjs"),
    "utf8",
  );
  const schema = await readFile(
    path.join(root, "..", "schemas", "primary-info.schema.json"),
    "utf8",
  );
  assert.match(worker, /aiSiteBackground/);
  assert.match(worker, /fetch\(site/);
  assert.match(worker, /質問調整専用・一次情報ではない/);
  assert.match(worker, /Codexが指定された構造化結果を返せませんでした/);
  assert.doesNotMatch(schema, /\"\$schema\"/);
});
test("Macワーカーから最新の失敗一次情報ジョブを重複なしで再投入できる", async () => {
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  assert.match(api, /worker\/retry-latest-primary/);
  assert.match(api, /alreadyQueued/);
  assert.match(api, /失敗した一次情報整理を前回回答で再実行/);
});
test("一次情報を会話で登録しAI整理済みデータも編集できる", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "AIからの質問",
    "あなたの回答",
    "送る",
    "編集する",
    "変更を保存",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /export async function PATCH/);
  assert.match(api, /UPDATE sources SET/);
  assert.match(api, /正式な一次情報へ手入力を追加/);
});
test("一次情報不足の理由を表示し所有者確認後だけ確定できる", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  for (const label of [
    "記事用にまとめる",
    "内容を確認・編集する（必要な場合のみ）",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /primary-info-status/);
  assert.match(api, /confirmFacts/);
  assert.match(api, /confirmRights/);
  assert.match(api, /canonical_status='ready'/);
  assert.match(api, /rights='approved',approved=1/);
  assert.doesNotMatch(
    api,
    /SELECT COUNT\(\*\) AS count FROM sources WHERE client_id=\? AND is_canonical=1 AND archived=0 AND approved=1/,
  );
  assert.match(api, /primary_info_status='sufficient'/);
  assert.match(ui, /interviewComplete/);
});
test("一次情報の各不足項目を元文章と追加項目へ紐づける", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  for (const label of [
    "内容を確認・編集する（必要な場合のみ）",
    "確認",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(ui, /locateClaim/);
  assert.match(ui, /HighlightedExcerpt/);
  assert.match(ui, /ClaimInlineEditor/);
  assert.match(ui, /claimInputQuality/);
  assert.match(ui, /リアルタイム入力チェック/);
  assert.match(ui, /入力項目はそろっています/);
  assert.match(ui, /あと.*項目を補足してください/);
  assert.match(ui, /事実の正しさと資料の内容/);
});
test("Ubersuggestから記事群を選定しWordPressを定期監査する", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const worker = await readFile(
    path.join(root, "..", "production-worker.mjs"),
    "utf8",
  );
  for (const label of [
    "AI計画を作成して自動制作開始",
    "AIが選定中",
    "この処理をやり直す",
    "未同期の場合は、同期・AI選定・今月の記事予約まで続けて実行",
    "既存記事の自動点検・リライト",
    "週の記事下書き数",
    "12か月の記事制作スケジュール",
    "月ごとの重点テーマ・対象キーワード・記事内容",
    "AI選定結果から自動更新",
    "被リンク獲得候補（自動設置ではありません）",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /content-automation/);
  assert.match(api, /keyword_strategy/);
  assert.match(api, /content_audit/);
  assert.match(api, /wordpressInventory/);
  assert.match(api, /AbortSignal\.timeout\(10000\)/);
  assert.match(api, /利用者が停止して再実行しました/);
  assert.match(api, /wordpress_draft_only/);
  assert.match(worker, /Know・Do・Buy・Go/);
  assert.match(worker, /monthlySchedule/);
  assert.match(worker, /Ubersuggest実データ/);
  assert.match(worker, /publishedInventory/);
  assert.match(worker, /存在しないURLは作らない/);
  assert.match(worker, /公開記事を直接変更せず/);
});
test("正式な一次情報1件だけを更新し記事生成へ渡す", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const api = await readFile(
    path.join(root, "app", "api", "[[...path]]", "route.ts"),
    "utf8",
  );
  const schema = await readFile(path.join(root, "db", "schema.ts"), "utf8");
  const migration = await readFile(
    path.join(root, "drizzle", "0003_canonical_primary_source.sql"),
    "utf8",
  );
  for (const label of [
    "AIに答えるだけで、記事に使える情報が完成します",
    "AIからの質問",
    "記事用にまとめる",
    "内容を確認・編集する（必要な場合のみ）",
  ])
    assert.match(ui, new RegExp(label));
  assert.match(api, /is_canonical=1 AND archived=0/);
  assert.match(api, /job\.type === "article_generate"/);
  assert.match(api, /Codexが正式な一次情報を更新/);
  assert.match(api, /canonical_status='superseded'/);
  assert.match(schema, /idx_sources_one_canonical/);
  assert.match(migration, /ALTER TABLE sources ADD COLUMN is_canonical/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_one_canonical/,
  );
});
test("AI処理はCodexに統一し、構造化出力スキーマを厳格に保つ", { skip: !hasLegacyMacRuntime }, async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  const worker = await readFile(path.join(root, "..", "production-worker.mjs"), "utf8");
  const installer = await readFile(
    path.join(root, "..", "scripts", "install-production-worker.sh"),
    "utf8",
  );
  assert.match(worker, /codexBin/);
  assert.match(worker, /"exec"/);
  assert.doesNotMatch(worker, /claude|anthropic/i);
  assert.doesNotMatch(installer, /CLAUDE_BIN|command -v claude/i);
  assert.match(ui, /hasCompletedAfter/);
  assert.match(ui, /displayHistoricalAiLabel/);
  const schemaDirectory = path.join(root, "..", "schemas");
  const entries = await (await import("node:fs/promises")).readdir(schemaDirectory);
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "object") assert.equal(value.additionalProperties, false);
    for (const child of Object.values(value)) inspect(child);
  };
  for (const file of entries.filter((name) => name.endsWith(".json")))
    inspect(JSON.parse(await readFile(path.join(schemaDirectory, file), "utf8")));
});

test("テンプレートは既存クライアントのドメインを含まず、クライアントごとの設定を要求する", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "full.ts"), "utf8");
  const config = await readFile(path.join(root, "cloud-runner", "dashboard-wrangler.example.jsonc"), "utf8");
  assert.doesNotMatch(worker, /app0805\.org/);
  assert.match(config, /YOUR_CLIENT\.example/);
  assert.match(config, /REPLACE_WITH_CLIENT_D1_DATABASE_ID/);
});

test("D1の復旧用スナップショットを非公開R2へ日次保存する", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const config = await readFile(path.join(root, "cloud-runner", "dashboard-wrangler.example.jsonc"), "utf8");
  assert.match(worker, /const BACKUP_TABLES/);
  assert.match(worker, /env\.BACKUPS\.head\(key\)/);
  assert.match(worker, /env\.BACKUPS\.put\(key, snapshot/);
  assert.match(worker, /d1_backup_complete/);
  assert.match(worker, /Promise\.all\(\[healthcheck\(env\), backup\(env\), execute\(env\)\]\)/);
  assert.match(config, /"binding": "BACKUPS"/);
  assert.match(config, /"bucket_name": "YOUR_CLIENT-seo-backups"/);
});

test("SERP事実データはClaudeを経由せず、直接MCPのraw tool resultだけを保存する", async () => {
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  const client = await readFile(path.join(root, "cloud-runner", "src", "ubersuggest-mcp.ts"), "utf8");
  const provider = await readFile(path.join(root, "lib", "serp-provider.ts"), "utf8");
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  const server = await readFile(path.join(root, "lib", "server.ts"), "utf8");
  assert.match(client, /"initialize"/);
  assert.match(client, /"tools\/list"/);
  assert.match(client, /"tools\/call"/);
  assert.match(client, /MCP-Session-Id/);
  assert.match(client, /MCP_AUTH_FAILED/);
  assert.match(client, /MCP_RATE_LIMITED/);
  assert.match(client, /MCP_SERP_TOOL_UNAVAILABLE/);
  assert.match(client, /access\[_-\]?token|Authorization/);
  assert.match(runner, /new UbersuggestMcpClient/);
  const serpBody = runner.slice(runner.indexOf("async function serp"), runner.indexOf("function aioContext"));
  assert.doesNotMatch(serpBody, /claude\(/);
  assert.match(provider, /rawMcpStructuredValue/);
  assert.match(provider, /serpEntries/);
  assert.match(api, /raw_tool_result/);
  assert.match(api, /safeMcpAudit/);
  assert.match(server, /idx_serp_snapshot_job/);
});
