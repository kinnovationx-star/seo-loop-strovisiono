/** Cloudflare Queue worker: Anthropic for text/analysis, GPT Image stays in app. */
import { normalizeUbersuggestSerp } from "../../lib/serp-provider";
import { createHttpWordPressAdapter, createSeoMetaProvider, detectSeoPlugin } from "../../lib/wordpress-adapter.mjs";
import { insertMinimalInternalLink, targetAlreadyLinked, validatePlacement } from "../../lib/internal-link-execution.mjs";
import { UbersuggestMcpClient } from "./ubersuggest-mcp";
interface Env {
  SEO_LOOP_ORIGIN: string;
  SEO_LOOP_WORKER_TOKEN: string;
  SEO_LOOP_SITES_BYPASS_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  UBERSUGGEST_MCP_TOKEN?: string;
  CLAUDE_MODEL?: string;
  CLOUD_DISPATCH_TOKEN: string;
  SEO_JOBS: Queue;
  SEO_APP?: Fetcher;
  DB: D1Database;
  BACKUPS: R2Bucket;
  FILES?: R2Bucket;
}
type Job = { id: string; client_id?: string; type: string; payload?: any; context?: any };
const BACKUP_TABLES = ["app_settings", "clients", "connections", "external_oauth_states", "jobs", "logs", "oauth_states", "snapshots", "source_files", "sources", "worker_tokens", "client_autopilot_settings", "global_autopilot_settings", "autopilot_runs", "autopilot_actions", "autopilot_measurements", "autopilot_audit_log"] as const;
const compact = (v: unknown, n = 120000) => JSON.stringify(v ?? null).slice(0, n);
const trim = (v: unknown, n = 1000) => String(v ?? "").trim().slice(0, n);
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

function headers(env: Env) {
  return {
    Authorization: `Bearer ${env.SEO_LOOP_WORKER_TOKEN}`,
    // Internal-only service credential for the Queue/cron runner.  This
    // avoids coupling production execution to the legacy Mac worker record.
    "X-SEO-Loop-Dispatch": env.CLOUD_DISPATCH_TOKEN,
    "Content-Type": "application/json",
    ...(env.SEO_LOOP_SITES_BYPASS_TOKEN ? { "OAI-Sites-Authorization": `Bearer ${env.SEO_LOOP_SITES_BYPASS_TOKEN}` } : {}),
  };
}
async function app(env: Env, path: string, method = "GET", body?: unknown): Promise<any> {
  const request = new Request(`${env.SEO_LOOP_ORIGIN.replace(/\/$/, "")}/api/${path}`, { method, headers: headers(env), body: body === undefined ? undefined : JSON.stringify(body) });
  const r = env.SEO_APP ? await env.SEO_APP.fetch(request) : await fetch(request);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `SEO Loop API ${r.status}`);
  return data;
}
async function progress(env: Env, job: Job, percent: number, stage: string, detail: string) {
  await app(env, "worker/progress", "POST", { jobId: job.id, percent, stage, detail }).catch(() => undefined);
}
function parseJson(value: string) {
  const body = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || value;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Claude APIがJSONを返しませんでした。");
  return JSON.parse(body.slice(a, b + 1));
}
const ROLE_PROMPTS: Record<string, { version: string; system: string }> = {
  WRITER: { version: "writer-v2", system: "あなたはSEO記事制作担当です。監査・採点・事実の自己承認は担当しません。確認済み入力だけを使い、根拠のない主張を創作しません。" },
  FACT_CHECKER: { version: "fact-checker-v2", system: "あなたは独立した事実検証担当です。Writerの主張を信用せず、与えられたEvidenceだけで検証状態を判定します。" },
  QUALITY_AUDITOR: { version: "quality-auditor-v2", system: "あなたは独立した品質監査担当です。Writerの自己評価を使用せず、指定された評価基準で採点します。" },
  SERP_ANALYST: { version: "serp-analyst-v2", system: "あなたはSERP・検索意図分析担当です。実取得済みSERPとページ根拠だけを使い、未取得値を推測しません。" },
  AUTOPILOT_STRATEGIST: { version: "autopilot-strategist-v2", system: "あなたはSEO施策選定担当です。記事本文を制作せず、測定済みデータと安全条件だけで施策を選びます。" },
  TITLE_OPTIMIZER: { version: "title-optimizer-v1", system: "あなたはSEO TitleとMeta Descriptionだけを最適化する担当です。記事本文、見出し、画像、内部リンク、CTAは変更も提案もしません。根拠のない最上級表現・数値・誤認表現を使いません。" },
  INTERNAL_LINK_PLACEMENT_ANALYZER: { version: "internal-link-placement-v1", system: "あなたは内部リンクの配置分析担当です。確認済みTarget URLを生成・推測・書換えせず、入力にあるURLだけを使う前提で、本文の最小差分の配置だけを判断します。本文全体を書き直さず、不自然なSEOアンカー、誤認アンカー、隠しリンクを作りません。URLフィールドは絶対に出力しません。" },
  GENERAL: { version: "general-v1", system: "与えられた入力だけを根拠に、指定されたJSON形式で回答してください。" },
};
type ClaudeOptions = { timeoutMs?: number; transientRetries?: number; attachments?: any[] };
function retryableAnthropicStatus(status: number) { return status === 429 || status === 524 || status >= 500; }
function claudeBudget(role: string, ubersuggest: boolean, options: ClaudeOptions) {
  // Queue delivery is the final retry boundary. A single AI request must not
  // leave the UI in an ambiguous "analyzing" state for many minutes.
  const writer = role === "WRITER";
  return {
    timeoutMs: options.timeoutMs ?? (ubersuggest ? 7 * 60 * 1000 : writer ? 3 * 60 * 1000 : 75 * 1000),
    transientRetries: options.transientRetries ?? (ubersuggest || writer ? 0 : 1),
  };
}
async function claude(env: Env, prompt: string, maxTokens = 10000, ubersuggest = false, apiKey?: string, ubersuggestToken?: string, role = "GENERAL", options: ClaudeOptions = {}): Promise<any> {
  const key = env.ANTHROPIC_API_KEY || apiKey;
  if (!key) throw new Error("Anthropic APIキーが未設定です。連携設定で接続してください。");
  const rolePrompt = ROLE_PROMPTS[role] || ROLE_PROMPTS.GENERAL;
  const body: any = { model: env.CLAUDE_MODEL || "claude-sonnet-4-6", max_tokens: maxTokens, temperature: 0.25, system: `${rolePrompt.system}\nprompt_version:${rolePrompt.version}`, messages: [{ role: "user", content: "" }] };
  if (ubersuggest) {
    const token = ubersuggestToken || env.UBERSUGGEST_MCP_TOKEN;
    if (!token) throw new Error("Ubersuggestを「接続」して認証してください。");
    body.mcp_servers = [{ type: "url", name: "ubersuggest", url: "https://ubersuggest-mcp.neilpatelapi.com/mcp", authorization_token: token }];
  }
  const { timeoutMs, transientRetries } = claudeBudget(role, ubersuggest, options);
  for (let transportAttempt = 0; transportAttempt <= transientRetries; transportAttempt++) {
    let shouldRetry = false;
    // A controller is created for each attempt. A timed-out request must not
    // poison the bounded retry that follows it.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // The provider occasionally returns an otherwise complete answer with a
      // malformed JSON character. Retry once with an explicit compact-JSON
      // instruction instead of leaving a user-visible failed analysis.
      for (let jsonAttempt = 0; jsonAttempt < 2; jsonAttempt++) {
        const instruction = `${prompt}\n出力はJSONだけにしてください。${jsonAttempt ? " 前回の形式が不正でした。説明文・Markdownを含めず、有効なJSONを短く返してください。" : ""}`;
        body.messages[0].content = options.attachments?.length
          ? [...options.attachments, { type: "text", text: instruction }]
          : instruction;
        const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...(ubersuggest ? { "anthropic-beta": "mcp-client-2025-04-04" } : {}) }, body: JSON.stringify(body), signal: controller.signal });
        const data: any = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (retryableAnthropicStatus(r.status) && transportAttempt < transientRetries) { shouldRetry = true; break; }
          throw new Error(data.error?.message || `Anthropic API ${r.status}`);
        }
        try {
          return parseJson((data.content || []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n"));
        } catch (error) {
          if (jsonAttempt === 1 || ubersuggest) throw error;
        }
      }
      if (!shouldRetry) throw new Error("Claude APIが有効なJSONを返しませんでした。");
    } catch (error: any) {
      if (controller.signal.aborted) {
        if (transportAttempt < transientRetries) shouldRetry = true;
        else throw new Error(`Claude APIが${Math.round(timeoutMs / 1000)}秒以内に応答しなかったため停止しました。再実行してください。`);
      } else throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (shouldRetry) await wait(1000 * (transportAttempt + 1));
  }
  throw new Error("Claude APIの一時エラーが解消しなかったため停止しました。再実行してください。");
}
function blocks(html: string) {
  const value = String(html || "");
  return { paragraphBlocks: (value.match(/<!-- wp:paragraph(?:\s|--)/g) || []).length, headingBlocks: (value.match(/<!-- wp:heading(?:\s|--)/g) || []).length, listBlocks: (value.match(/<!-- wp:list(?:\s|--)/g) || []).length, imageBlocks: 0, validImages: 0, invalidImages: 0, imagesOk: false, structureOk: /<!-- wp:paragraph/.test(value) && /<!-- wp:heading/.test(value) };
}
function articlePrompt(job: Job, prior?: any, revisionInstruction?: any) {
  const p = job.payload || {}, c = job.context || {}, target = Number(p.targetCharacters || 10000);
  return `カテゴリー・検索意図と完全に整合するWordPress Gutenberg原稿を作成。固定文字数を品質基準にせず、検索意図・SERP合意を満たす必要十分な深さにする。結論を先に置き、H1→H2→H3、短い段落、FAQ、実在内部リンクを使う。根拠のない数値・日付・料金・実績、存在しない事例・URLは禁止。不明は不明とする。返却JSONは {"title":"","slug":"","meta_description":"","excerpt":"","html":"","category_id":0,"category_name":"","image_brief":[],"fact_check_notes":[],"internal_links":[]}。Keyword:${p.keyword}。Intent:${p.intent}。Content Brief:${compact(c.contentBrief)}。SERP:${compact(c.serpInsight || {})}。Differentiation:${compact(c.differentiation || [])}。Confirmed Primary Sources:${compact(c.sources || [])}。Cannibalization:${compact(c.cannibalization || {})}。Internal Link Candidates:${compact(c.internalLinks || [])}。YMYL/E-E-A-T requirements:${compact(c.safetyRequirements || {})}。Existing articles:${compact(c.wordpressPosts || [], 30000)}。${prior ? `元Article Version:${compact(prior, 90000)}。構造化Revision Instruction:${compact(revisionInstruction || {})}` : ""}`;
}
async function contentIntelligence(env: Env, job: Job) {
  const c = job.context || {}, draft = c.articleDraft || {};
  // Missing external evidence is represented explicitly as EVIDENCE_PROVIDER_NOT_AVAILABLE.
  await progress(env, job, 15, "claims", "検証が必要な主張を抽出しています");
  const out = await claude(env, `記事の事実主張を、与えられた原稿・確認済み一次情報・既存URLだけで検証可能な形へ整理してください。AIの記憶でVERIFIEDにしない。外部根拠が必要で既存URLにも確認済み根拠がなければ evidence_provider_not_available とし、UNSUPPORTED または PRIMARY_SOURCE_REQUIREDにする。JSONのみ: {"claims":[{"paragraphIndex":0,"sentence":"","claimText":"","claimType":"numeric|statistic|price|law|date|specification|feature|comparison|effect|medical|health|finance|insurance|real_estate|tax|public_program|company|product|achievement|case_study|general_fact","riskLevel":"LOW|MEDIUM|HIGH|CRITICAL","requiresVerification":true,"verificationStatus":"UNCHECKED|VERIFIED|PARTIALLY_VERIFIED|UNSUPPORTED|CONFLICTING|PRIMARY_SOURCE_REQUIRED|HUMAN_REVIEW_REQUIRED|NOT_APPLICABLE","verificationReason":"","sources":[]}],"ymyl":{"risk":"NONE|LOW|MEDIUM|HIGH","reason":"","requiredReviews":[]},"eeat":{"experience":0,"expertise":0,"authoritativeness":0,"trust":0,"missingEvidence":[]},"internalLinks":[],"quality":{"searchIntent":0,"informationQuality":0,"originalValue":0,"eeat":0,"structureUx":0,"seo":0,"conversion":0,"safetyFactCheck":0}}。原稿:${compact(draft, 42000)}。確認済み一次情報:${compact(c.sources || [], 12000)}。既存URL候補:${compact(c.internalLinks || [], 10000)}。Topic/Keyword/Brief:${compact(c.contentBrief, 8000)}`, 5500, false, c.anthropicApiKey, undefined, "FACT_CHECKER", { timeoutMs: 90 * 1000, transientRetries: 1 });
  return out || {};
}
const safePublishHtml = (value: unknown) => String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/\s(?:href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, "");
const applyApprovedInternalLinks = (html: string, links: any[]) => `${html}${(links || []).filter((link:any) => /^https:\/\//i.test(String(link.target_url || ""))).slice(0, 10).map((link:any) => `\n<!-- wp:paragraph -->\n<p><a href="${String(link.target_url).replace(/"/g,"%22")}">${String(link.anchor_text || "関連情報").replace(/</g,"&lt;")}</a></p>\n<!-- /wp:paragraph -->`).join("")}`;
async function wordpressPublish(env: Env, job: Job) {
  const payload:any = job.payload || {}, context:any = job.context || {}, wp:any = context.wordpress;
  if (!wp?.siteUrl || !wp?.username || !wp?.applicationPassword) throw new Error("WordPress connection is unavailable.");
  const base = String(wp.siteUrl).replace(/\/$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error("WordPress URL must use HTTPS.");
  const adapter = createHttpWordPressAdapter({ siteUrl: base, username: wp.username, applicationPassword: wp.applicationPassword });
  const operation = String(payload.operation || "");
  if (job.type === "wordpress_rollback") {
    const snapshot:any = context.rollbackSnapshot; if (!snapshot) throw new Error("Rollback snapshot not found.");
    const before:any = await adapter.fetchPost(snapshot.wordpress_post_id);
    const post:any = await adapter.update(snapshot.wordpress_post_id,{title:snapshot.wp_title,content:safePublishHtml(snapshot.wp_content),excerpt:snapshot.wp_excerpt,status:snapshot.wp_status,categories:JSON.parse(snapshot.categories_json||"[]"),tags:JSON.parse(snapshot.tags_json||"[]"),featured_media:snapshot.featured_media_id||undefined});
    return { operation:"ROLLBACK", post, responseStatus:200, before, seoMetaStatus:"SEO_META_WRITE_NOT_AVAILABLE" };
  }
  const draft:any = context.articleDraft || {};
  const update = operation === "UPDATE_EXISTING";
  let before:any = null;
  if (update) before=await adapter.fetchPost(String(payload.targetPostId));
  const body:any = { title:String(draft.title||"").slice(0,500), content:applyApprovedInternalLinks(safePublishHtml(draft.html), context.approvedInternalLinks), excerpt:String(draft.excerpt||""), status:operation === "DRAFT" ? "draft" : "publish", categories:Number(draft.category_id||0)>0?[Number(draft.category_id)]:undefined, tags:(Array.isArray(draft.tag_ids)?draft.tag_ids:[]).filter((tag:any)=>Number.isInteger(Number(tag))).slice(0,5), featured_media:draft.featuredMediaId || draft.featured_media_id || undefined };
  if (!update) body.slug=String(draft.slug||"").replace(/[^a-z0-9-]/gi,"-").replace(/^-+|-+$/g,"").slice(0,180) || undefined;
  const post:any=update?await adapter.update(String(payload.targetPostId),body):await adapter.create(body);
  const namespaces:any=await fetch(`${base}/wp-json`).then(async r=>r.ok?await r.json():{}).catch(()=>({})); const seoPlugin=detectSeoPlugin(Object.keys(namespaces?.namespaces||{})); const seoMeta=createSeoMetaProvider(seoPlugin);
  return { operation, post, before, responseStatus:200, seoPlugin, seoMetaStatus:seoMeta.syncStatus, seoMetaAdapter:seoMeta.provider, partialFailure:seoPlugin === "NONE" ? null : seoMeta.syncStatus, canonicalStatus:seoMeta.canonicalStatus, schemaStatus:seoMeta.schemaStatus };
}
async function wordpressSeoPluginSync(env: Env, job: Job) {
  const payload:any=job.payload||{}, wp:any=job.context?.wordpress;
  // Native SEO is already committed by the API before this optional job runs.
  // This job deliberately writes only a supported plugin meta payload.
  if (!wp?.siteUrl || !wp?.username || !wp?.applicationPassword) return { nativeSeoStatus:"SUCCESS", detectedPlugin:"UNKNOWN", pluginSyncStatus:"SEO_PLUGIN_SYNC_NOT_AVAILABLE", pluginSyncErrorCode:"WORDPRESS_CONNECTION_NOT_AVAILABLE" };
  try {
    const adapter=createHttpWordPressAdapter({siteUrl:String(wp.siteUrl).replace(/\/$/,""),username:wp.username,applicationPassword:wp.applicationPassword});
    const detectedPlugin=await adapter.detectSeoPlugin();
    if(detectedPlugin==="NONE") return {nativeSeoStatus:"SUCCESS",detectedPlugin,pluginSyncStatus:"NOT_APPLICABLE",pluginSyncErrorCode:null};
    if(detectedPlugin==="UNKNOWN") return {nativeSeoStatus:"SUCCESS",detectedPlugin,pluginSyncStatus:"SEO_PLUGIN_SYNC_NOT_AVAILABLE",pluginSyncErrorCode:"SEO_PLUGIN_SYNC_NOT_AVAILABLE"};
    const synced=await adapter.syncSeoPlugin(String(payload.wordpressPostId||""),{plugin:detectedPlugin,seoTitle:String(payload.seoTitle||""),metaDescription:String(payload.metaDescription||"")});
    return {nativeSeoStatus:"SUCCESS",detectedPlugin,pluginSyncStatus:synced.pluginSyncStatus,pluginSyncErrorCode:synced.pluginSyncErrorCode||null};
  } catch(error:any) {
    const status=Number(error?.status||0), code=status===401?"WORDPRESS_401":status===403?"WORDPRESS_403":status===404?"SEO_PLUGIN_SYNC_NOT_AVAILABLE":"SEO_PLUGIN_SYNC_NOT_AVAILABLE";
    return {nativeSeoStatus:"SUCCESS",detectedPlugin:"UNKNOWN",pluginSyncStatus:"SEO_PLUGIN_SYNC_NOT_AVAILABLE",pluginSyncErrorCode:code};
  }
}
async function article(env: Env, job: Job) {
  await progress(env, job, 15, "writing", "Claude APIが記事構成と本文を作成しています");
  const prior = job.context?.revisionSource || null, instruction = job.context?.revisionInstruction || null;
  const draft = await claude(env, articlePrompt(job, prior, instruction), 16000, false, job.context?.anthropicApiKey, undefined, "WRITER");
  const p = job.payload || {}, primaryMissing = p.primaryInfoStatus === "missing";
  return { article: draft, promptVersion: ROLE_PROMPTS.WRITER.version, revisionOfVersionId:p.revisionOfVersionId||null, characterCount: String(draft.html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, "").length, targetCharacters: Number(p.targetCharacters || 10000), gutenbergBlocks: blocks(draft.html), status: primaryMissing ? "draft_only_missing_primary_info" : "awaiting_independent_review", publishAllowed: !primaryMissing, qualityException: false, unresolvedIssues: [] };
}
async function titleOptimization(env: Env, job: Job) {
  const c:any=job.context||{}, p:any=job.payload||{};
  await progress(env,job,20,"title_optimization","SEO TitleとMeta Descriptionを独立分析しています");
  const out=await claude(env,`本文を変更せずSEO TitleとMeta Descriptionだけを提案してください。JSONのみ: {"proposed_seo_title":"","proposed_meta_description":"","target_queries":[],"reason":"","evidence":[],"confidence":"HIGH|MEDIUM|LOW","risk":"LOW|MEDIUM|HIGH","misleading":false,"intentMismatch":false,"contentMismatch":false,"unsupportedNumericalClaim":false,"unsupportedSuperlative":false}。Current SEO:${compact(c.currentSeo||{},4000)}。Keyword:${compact(c.keyword||{},2000)}。GSC:${compact(c.gsc||{},8000)}。SERP Titles:${compact(c.serpTitles||[],4000)}。Article Summary:${compact(c.articleSummary||{},16000)}`,3000,false,c.anthropicApiKey,undefined,"TITLE_OPTIMIZER",{timeoutMs:60*1000,transientRetries:1});
  return {...(out||{}),prompt_version:ROLE_PROMPTS.TITLE_OPTIMIZER.version,body_unchanged:true,actionId:p.actionId};
}
async function internalLinkPlacement(env: Env, job: Job) {
  const c:any=job.context||{}, p:any=job.payload||{};
  const out=await claude(env,`確認済みURLへの内部リンクを、指定本文に最小差分で配置する案だけを作成してください。URLは出力せず生成も変更もしない。JSONのみ: {"anchor_text":"","placement_type":"inline|paragraph_end","placement_reference":"本文に存在する置換対象の短い文字列","reason":"","confidence":"HIGH|MEDIUM|LOW","safety_notes":""}。Source:${compact(c.sourceArticle||{},24000)}。Source topic/cluster/intent:${compact(c.sourceContext||{},2000)}。Target:${compact(c.targetArticle||{},8000)}。Target topic/cluster:${compact(c.targetContext||{},2000)}。Confirmed target URL (出力禁止):${String(p.confirmedTargetUrl||"")}`,2200,false,c.anthropicApiKey,undefined,"INTERNAL_LINK_PLACEMENT_ANALYZER",{timeoutMs:60*1000,transientRetries:1});
  return {...(out||{}),prompt_version:ROLE_PROMPTS.INTERNAL_LINK_PLACEMENT_ANALYZER.version,actionId:p.actionId};
}
async function internalLinkUpdate(env: Env, job: Job) {
  const p:any=job.payload||{}, c:any=job.context||{}, wp:any=c.wordpress;
  if(!wp?.siteUrl||!wp?.username||!wp?.applicationPassword)throw new Error("WordPress connection is unavailable.");
  const adapter=createHttpWordPressAdapter({siteUrl:String(wp.siteUrl).replace(/\/$/,""),username:wp.username,applicationPassword:wp.applicationPassword});
  const source=await adapter.fetchPost(String(p.sourceWpPostId||""));
  if(targetAlreadyLinked(source.content?.raw||source.content?.rendered||"",String(p.targetUrl||"")))return {operation:"UPDATE_EXISTING",executionStatus:"ALREADY_LINKED",post:source,before:source};
  const placement=validatePlacement(p.placement||{});
  if(!placement.ok||placement.safetyStatus!=="SAFE")return {operation:"UPDATE_EXISTING",executionStatus:"HUMAN_REVIEW_REQUIRED",before:source};
  const content=String(source.content?.raw||source.content?.rendered||"");
  const changed=insertMinimalInternalLink(content,String(p.targetUrl||""),p.placement);
  // Recheck both controls in the worker immediately before the irreversible
  // snapshot/update pair; an earlier manual/API check is not sufficient.
  await app(env,"worker/internal-link-execution-permit","POST",{actionId:p.actionId,executionId:p.executionId});
  // Persisting this immutable snapshot is a hard prerequisite: a failed
  // internal app call means no WordPress update is attempted.
  const snapshot=await app(env,"worker/internal-link-snapshot","POST",{actionId:p.actionId,executionId:p.executionId,sourceArticleId:p.sourceArticleId,sourceArticleVersionId:p.sourceArticleVersionId,sourceWpPostId:String(p.sourceWpPostId||""),before:source});
  const post=await adapter.update(String(p.sourceWpPostId||""),{content:changed.html});
  return {operation:"UPDATE_EXISTING",executionStatus:"EXECUTED",post,before:source,snapshotId:snapshot.snapshotId,updatedContent:changed.html,link:changed.link};
}
async function ubersuggest(env: Env, job: Job) {
  await progress(env, job, 20, "ubersuggest", "Claude APIがクラウドMCP経由でUbersuggest実データを取得しています");
  const domain = job.payload?.domain || job.context?.client?.site;
  // MCP tool calls are mediated by the Anthropic edge.  Asking for every
  // Ubersuggest report at once can exceed its response window, so each sync
  // starts with the operational data needed by this dashboard.  Broader
  // research is intentionally represented as an empty list until a future
  // focused request asks for it.
  const report = await claude(env, `Ubersuggest MCPだけを使い、${domain}に完全一致する登録プロジェクトから、Dashboard、Site Audit、SEO Opportunities上位10件、Rank Tracking上位20件、主要キーワード上位20件だけを取得。1つのレポートで済む範囲だけを使い、競合・Topic Research・被リンクの追加探索はしない。別ドメインを混ぜず、未取得値はnullまたは空配列。JSON {"domain":"","retrieved_at":"","dashboard":{},"keywords":[],"rank_tracking":[],"site_audit":{"health_score":null,"errors":null,"warnings":null,"crawled_pages":null,"summary":null,"top_issues":[]},"seo_opportunities":[],"competitors":[],"competitor_research":[],"topic_research":[],"backlinks":[],"notes":[]}`, 5000, true, job.context?.anthropicApiKey, job.context?.ubersuggestAccessToken);
  const seeds = (Array.isArray(report?.keywords) ? report.keywords : []).map((item: any) => String(item?.keyword || item?.name || "").trim()).filter(Boolean).slice(0, 3);
  report.keyword_suggestions = [];
  report.keyword_suggestions_status = "DATA_NOT_AVAILABLE";
  if (seeds.length && job.context?.ubersuggestAccessToken) {
    try {
      const client = new UbersuggestMcpClient(String(job.context.ubersuggestAccessToken));
      report.keyword_suggestions = await Promise.all(seeds.map((keyword: string) => client.callKeywordSuggestions(keyword)));
      report.keyword_suggestions_status = "AVAILABLE";
    } catch (error: any) { report.keyword_suggestions_error = trim(error?.message || error, 240); }
  }
  return report;
}
// Keep the SERP retrieval boundary independent from all model analysis.
function aioContext(job: Job) { return aioContextData(job); }
async function serp(env: Env, job: Job) {
  const p = job.payload || {};
  await progress(env, job, 20, "serp", "Ubersuggest MCPから実SERP上位10件を取得しています");
  // Important: this path is deliberately direct. Claude is not called for
  // retrieval or normalization, so no model-generated URL/rank/title can ever
  // enter the SERP history tables.
  let call: any, lastError: unknown;
  // Transport faults get one bounded retry here; a Queue message itself has a
  // separate three-attempt limit. Tool data is not retried after persistence.
  for (let attempt = 1; attempt <= 2; attempt++) try {
    const client = new UbersuggestMcpClient(String(job.context?.ubersuggestAccessToken || ""));
    call = await client.callSerp(String(p.keyword || ""), { language: typeof p.language === "string" ? p.language : undefined, locId: Number.isFinite(Number(p.locId)) ? Number(p.locId) : undefined, limit: 10 });
    break;
  } catch (error) { lastError = error; if (attempt === 2) throw error; }
  if (!call) throw lastError || new Error("SERP取得を開始できませんでした。");
  const normalized = normalizeUbersuggestSerp(call.rawToolResult, call.requestedAt);
  await progress(env, job, 80, "serp", `Ubersuggest MCPの${call.toolName}結果を正規化しました`);
  return {
    provider: "ubersuggest",
    toolName: call.toolName,
    requestedAt: call.requestedAt,
    rawToolResult: call.rawToolResult,
    normalizedResult: normalized,
    location: String(p.location || ""), language: String(p.language || ""), device: p.device === "mobile" ? "mobile" : "desktop",
  };
}
function safeCompetitorUrl(value: unknown) {
  let url: URL;
  try { url = new URL(String(value || "")); } catch { return null; }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) return null;
  // SERP results must never turn the fetcher into a request proxy for private
  // network addresses. DNS validation is performed by Cloudflare's fetch
  // platform; these literal-address checks reject the common unsafe forms.
  if (/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(url.hostname)) return null;
  return url;
}
function htmlText(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--([\s\S]*?)-->/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}
function pageEvidence(html: string, url: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  const headings = [...html.matchAll(/<h([2-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => htmlText(m[2]).slice(0, 240)).filter(Boolean).slice(0, 30);
  const text = htmlText(html).slice(0, 18000);
  return { url, title: htmlText(title).slice(0, 300), h1: htmlText(h1).slice(0, 300), headings, text, tableCount: (html.match(/<table\b/gi) || []).length, hasAuthor: /author|著者|監修|執筆/i.test(html), hasDate: /(?:published|updated|公開日|更新日|20\d{2}[年\/-])/i.test(html) };
}
async function fetchCompetitorPage(urlValue: unknown) {
  const url = safeCompetitorUrl(urlValue);
  if (!url) return { url: String(urlValue || ""), fetchStatus: "blocked", evidence: null };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      response = await fetch(url.toString(), { headers: { Accept: "text/html,application/xhtml+xml" }, signal: controller.signal, redirect: "follow" });
      if (response.ok || attempt === 2 || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
    }
    if (!response) return { url: url.toString(), fetchStatus: "unavailable", evidence: null };
    if (!response.ok) return { url: url.toString(), fetchStatus: `http_${response.status}`, evidence: null };
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")) return { url: url.toString(), fetchStatus: "not_html", evidence: null };
    const html = (await response.text()).slice(0, 750_000);
    return { url: response.url || url.toString(), fetchStatus: "fetched", evidence: pageEvidence(html, response.url || url.toString()) };
  } catch {
    return { url: url.toString(), fetchStatus: "unavailable", evidence: null };
  } finally { clearTimeout(timer); }
}
const intentValue = (value: unknown) => {
  const normalized = String(value || "").toLowerCase();
  return ["informational", "commercial", "transactional", "navigational", "local"].includes(normalized) ? normalized : "DATA_NOT_AVAILABLE";
};
const differentiationValue = (value: unknown, hasConfirmedPrimary: boolean) => !hasConfirmedPrimary
  ? ["NO_CONFIRMED_DIFFERENTIATION"]
  : (Array.isArray(value) ? value.map((item) => String(item).slice(0, 1000)).filter(Boolean).slice(0, 30) : ["NO_CONFIRMED_DIFFERENTIATION"]);
async function competitorAnalysis(env: Env, job: Job) {
  const results = Array.isArray(job.context?.serpResults) ? job.context.serpResults.slice(0, 10) : [];
  if (!results.length) throw new Error("分析対象のSERP結果がありません。");
  await progress(env, job, 15, "competitor_fetch", "上位ページを安全に取得しています");
  const pages = await Promise.all(results.map(async (result: any) => ({ serpResultId: result.id, rank: result.rank, ...await fetchCompetitorPage(result.url) })));
  await progress(env, job, 55, "competitor_analysis", "取得できたページだけを根拠に競合分析しています");
  const evidence = pages.filter((page) => page.evidence).map((page) => ({ serpResultId: page.serpResultId, rank: page.rank, ...page.evidence }));
  const confirmedPrimary = Array.isArray(job.context?.confirmedPrimary) ? job.context.confirmedPrimary : [];
  const out = await claude(env, `日本語SEO編集者として、以下の実SERPと実取得ページの抽出内容だけを根拠に分析してください。取得できなかったページの内容を推測しないでください。不明な項目は DATA_NOT_AVAILABLE。競合の文章を複製せず、事実と提案を区別します。searchIntentは informational/commercial/transactional/navigational/local のいずれかだけを使う。confirmedPrimaryが空なら differentiationOpportunities は必ず ["NO_CONFIRMED_DIFFERENTIATION"]。JSONのみで {"pages":[{"serpResultId":"","pageType":"","searchIntent":"","coveredTopics":[],"uniqueTopics":[],"questions":[],"comparisonDetected":false,"examplesDetected":false,"originalDataDetected":false,"sourceQuality":"","authorInfo":"","freshnessInfo":"","ctaType":"","notes":[]}],"insight":{"searchIntent":"informational","explicitNeed":"","latentNeed":"","anxiety":"","comparisonAxes":[],"desiredOutcome":"","likelyFunnelStage":"","serpConsensus":{"commonTopics":[],"commonQuestions":[],"commonFormats":[],"comparisonAxes":[],"requiredTopics":[],"competitorWeaknesses":[]},"missingTopics":[],"weakCompetitorTopics":[],"differentiationOpportunities":[],"recommendedContentType":"","recommendedDepth":""},"cannibalization":{"risk":"NONE|LOW|MEDIUM|HIGH|DATA_NOT_AVAILABLE","score":0,"reason":"","signals":{"keywordOverlap":"","intentOverlap":"","topicCluster":"","gscQuery":"","articleMapping":"","contentSimilarity":""}},"decision":{"action":"NEW_ARTICLE|UPDATE_EXISTING|MERGE|CHANGE_ANGLE|DO_NOT_CREATE|HUMAN_REVIEW","targetArticleId":null,"reason":"","confidence":0}}。Keyword:${String(job.payload?.keyword || "")}。SERP:${compact(results.map((x:any) => ({ id:x.id, rank:x.rank, url:x.url, title:x.title, resultType:x.result_type })), 12000)}。取得済み根拠:${compact(evidence, 36000)}。確認済み一次情報:${compact(confirmedPrimary, 9000)}。カニバリ判定の実データ:${compact(job.context?.cannibalization || {}, 18000)}`, 4500, false, job.context?.anthropicApiKey, undefined, "SERP_ANALYST", { timeoutMs: 90 * 1000, transientRetries: 1 });
  const analysis = out || {}, insight = analysis.insight || {};
  insight.searchIntent = intentValue(insight.searchIntent);
  insight.differentiationOpportunities = differentiationValue(insight.differentiationOpportunities, confirmedPrimary.length > 0);
  const risk = String(analysis.cannibalization?.risk || "").toUpperCase();
  if (!["NONE", "LOW", "MEDIUM", "HIGH", "DATA_NOT_AVAILABLE"].includes(risk)) analysis.cannibalization = { ...(analysis.cannibalization || {}), risk: "DATA_NOT_AVAILABLE" };
  if (String(analysis.cannibalization?.risk).toUpperCase() === "HIGH" && String(analysis.decision?.action).toUpperCase() === "NEW_ARTICLE") analysis.decision = { ...(analysis.decision || {}), action: "HUMAN_REVIEW", reason: "HIGHのカニバリゼーションリスクがあるため人間確認が必要です。" };
  return { pages, analysis };
}
function aioContextData(job: Job) {
  const context = job.context || {};
  const snapshots = Array.isArray(context.snapshots) ? context.snapshots : [];
  const uber = snapshots.find((item: any) => item.connector === "ubersuggest")?.data || {};
  const take = (items: unknown, limit: number) =>
    Array.isArray(items) ? items.slice(0, limit) : [];
  return {
    client: context.client || {},
    // AIO analysis needs evidence summaries, not the full text of every
    // snapshot or WordPress page. Keeping this bounded avoids Anthropic 524
    // timeouts and prevents unrelated customer content entering the prompt.
    primary_information: take(context.sources, 3).map((item: any) => ({
      title: String(item?.title || "").slice(0, 200),
      note: String(item?.note || "").slice(0, 2000),
      approved: Boolean(item?.approved),
      canonical: Boolean(item?.is_canonical),
    })),
    ubersuggest: {
      dashboard: uber.dashboard || {},
      keywords: take(uber.keywords, 20),
      rank_tracking: take(uber.rank_tracking, 20),
      seo_opportunities: take(uber.seo_opportunities, 10),
      site_audit: {
        health_score: uber.site_audit?.health_score ?? null,
        errors: uber.site_audit?.errors ?? null,
        warnings: uber.site_audit?.warnings ?? null,
        crawled_pages: uber.site_audit?.crawled_pages ?? null,
      },
    },
  };
}
function keywordStrategyContext(job: Job) {
  const context: any = job.context || {};
  const take = (items: unknown, limit: number) => Array.isArray(items) ? items.slice(0, limit) : [];
  const articleSummary = take(context.wordpressPosts, 30).map((post: any) => ({
    id: post?.id ?? null,
    title: String(post?.title || "").slice(0, 300),
    url: String(post?.url || "").slice(0, 1000),
    slug: String(post?.slug || "").slice(0, 300),
    categories: take(post?.categories, 10),
    excerpt: String(post?.excerpt || "").slice(0, 240),
  }));
  // Keyword selection needs SEO metrics and an inventory of existing pages;
  // full WordPress bodies and raw snapshots make the model request slow and
  // are not needed to decide a content plan.
  return {
    client: { name: String(context.client?.name || "").slice(0, 300), site: String(context.client?.site || "").slice(0, 1000), niche: String(context.client?.niche || "").slice(0, 500) },
    primary_information: take(context.sources, 3).filter((item: any) => item?.approved && item?.is_canonical && !item?.archived).map((item: any) => ({ title: String(item?.title || "").slice(0, 300), note: String(item?.note || "").slice(0, 3000) })),
    ubersuggest: aioContextData(job).ubersuggest,
    wordpress: {
      categories: take(context.wordpressCategories, 30).map((category: any) => ({ id: category?.id ?? null, name: String(category?.name || "").slice(0, 300), count: Number(category?.count || 0) })),
      published_articles: articleSummary,
    },
  };
}
function keywordStrategyFallback(job: Job) {
  const context: any = keywordStrategyContext(job);
  const primary = Array.isArray(context.primary_information) ? context.primary_information : [];
  const primaryText = primary.map((item: any) => `${item.title} ${item.note}`).join(" ").toLowerCase();
  const runs = primaryText.match(/[a-z0-9]{2,}|[\u3040-\u30ff\u3400-\u9fff]{3,}/gi) || [];
  const terms = new Set<string>();
  for (const run of runs) for (let index = 0; index <= run.length - 3; index++) terms.add(run.slice(index, Math.min(run.length, index + 8)));
  const uber: any = context.ubersuggest || {};
  const categories = Array.isArray(context.wordpress?.categories) ? [...context.wordpress.categories].sort((a: any, b: any) => Number(a.count || 0) - Number(b.count || 0)) : [];
  const raw = [...(Array.isArray(uber.keywords) ? uber.keywords : []), ...(Array.isArray(uber.rank_tracking) ? uber.rank_tracking : []), ...(Array.isArray(uber.seo_opportunities) ? uber.seo_opportunities : [])].sort((left: any, right: any) => {
    const score = (item: any) => Math.min(40, Number(item?.volume ?? item?.search_volume ?? 0) / 100) + Math.max(0, 30 - Number(item?.position ?? item?.current_position ?? item?.rank ?? 100)) + Math.max(0, 30 - Number(item?.difficulty ?? item?.keyword_difficulty ?? 30));
    return score(right) - score(left);
  });
  const seen = new Set<string>();
  const recommended_keywords = raw.flatMap((item: any, index: number) => {
    const keyword = String(item?.keyword || item?.name || item?.query || "").trim();
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key) || seen.size >= 20 || (primary.length > 0 && ![...terms].some(term => key.includes(term) || term.includes(key)))) return [];
    seen.add(key);
    const category = categories[index % Math.max(1, categories.length)] || {};
    const facts = [item?.position ?? item?.current_position ?? item?.rank, item?.volume ?? item?.search_volume].filter(value => value !== undefined && value !== null);
    return [{ keyword, intent: String(item?.intent || item?.search_intent || "unknown"), target_article_type: "解説記事", rationale: facts.length ? `Ubersuggest実測値（${facts.join(" / ")}）を基に選定` : "Ubersuggestの取得済みキーワードを基に選定", cluster: String(item?.cluster || category?.name || "未分類"), category_id: category?.id ?? null, category_name: String(category?.name || ""), category_reason: category?.name ? "既存カテゴリの掲載数を考慮" : "カテゴリは未取得", internal_link_targets: [] }];
  });
  return { recommended_keywords, monthly_schedule: [], schedule_start: new Date().toISOString().slice(0, 7), strategy_source: "UBERSUGGEST_FALLBACK", notice: primary.length ? "確認済み一次情報との整合性、およびUbersuggestの順位・検索量・難易度を基に優先順位を付けました。" : "一次情報未登録のため、Ubersuggestの順位・検索量・難易度だけで優先順位を付けました。" };
}
function primaryInfoContext(job: Job) {
  const context: any = job.context || {};
  // File bytes were previously serialized as base64 into the model prompt.
  // Claude cannot reliably interpret arbitrary binary/base64 here, and that
  // transfer can dominate the request. Keep an auditable file inventory and
  // use the submitted conversation plus saved primary records as evidence.
  return {
    client: {
      name: String(context.client?.name || "").slice(0, 300),
      site: String(context.client?.site || "").slice(0, 1000),
      niche: String(context.client?.niche || "").slice(0, 500),
    },
    confirmed_primary: (Array.isArray(context.sources) ? context.sources : [])
      .filter((item: any) => item?.approved && item?.is_canonical && !item?.archived)
      .slice(0, 10)
      .map((item: any) => ({
        title: String(item?.title || "").slice(0, 500),
        note: String(item?.note || "").slice(0, 5000),
        url: item?.url ? String(item.url).slice(0, 1000) : null,
        rights: item?.rights || null,
      })),
    uploaded_files: (Array.isArray(context.sourceFiles) ? context.sourceFiles : [])
      .slice(0, 5)
      .map((item: any) => ({
        id: String(item?.id || ""),
        name: String(item?.name || "").slice(0, 240),
        content_type: String(item?.contentType || ""),
        size: Number(item?.size || 0),
        rights_confirmed: Boolean(item?.rightsConfirmed),
      })),
    primaryInterviewHistory: (Array.isArray(context.primaryInterviewHistory)
      ? context.primaryInterviewHistory
      : [])
      .slice(-20)
      .map((item: any) => ({
        questionKey: String(item?.questionKey || "").slice(0, 40),
        askedQuestion: String(item?.askedQuestion || "").slice(0, 600),
        message: String(item?.message || "").slice(0, 2500),
      })),
  };
}
const PRIMARY_INTERVIEW_STEPS = [
  // Start from the reality of the company, not from its selling points.  This
  // order makes the interview useful for SEO articles, case studies, hiring,
  // and owned-media stories alike.
  { key: "company", label: "会社の実態", question: "まず、御社はどのような会社ですか？ 会社の成り立ち、拠点・対応地域、人数や体制などを、分かる範囲で教えてください。" },
  { key: "business", label: "事業内容", question: "次に、現在どのような事業をしていますか？ 主なサービス・商品、誰に提供しているか、普段どのような仕事をしているかを教えてください。" },
  { key: "content_goal", label: "記事の目的", question: "今回つくりたい記事では、何を達成したいですか？ たとえばSEOで問い合わせを増やしたい、採用につなげたい、実績を伝えたい、会社の考え方を知ってもらいたい、など目的を教えてください。" },
  { key: "service", label: "提供サービス", question: "その中でも、特に記事で伝えたいサービス・商品はどれですか？ 内容、料金や提供条件、利用の流れなど、公開できる範囲で教えてください。" },
  { key: "customer", label: "対象のお客様", question: "いちばん力になりたいお客様は、どんな会社・担当者ですか？ 業種、規模、状況を教えてください。" },
  { key: "problem", label: "解決する課題", question: "そのお客様が相談前に困っていることを、実際の言葉で教えてください。" },
  { key: "difference", label: "選ばれる理由", question: "他社と比べて選ばれる理由や、御社らしい進め方は何ですか？" },
  { key: "process", label: "支援の進め方", question: "相談から成果確認まで、通常どのような流れ・体制・期間で進めますか？" },
  { key: "proof", label: "公開できる実績", question: "記事で公開してよい事例・成果・お客様の声はありますか？ 数字は期間や条件も一緒に教えてください。" },
  { key: "evidence", label: "根拠・公開可否", question: "上の内容を裏付けるURL・資料・確認担当者と、記事で公開してよい範囲を教えてください。" },
] as const;
function primaryInterviewAnswers(job: Job, context: any) {
  const previous = (context.confirmed_primary || []).map((item: any) => String(item.note || "")).join("\n");
  const current = job.payload?.answers && typeof job.payload.answers === "object" ? job.payload.answers : {};
  const values: Record<string, string> = {};
  for (const step of PRIMARY_INTERVIEW_STEPS) {
    const marker = new RegExp(`【${step.label}】\\s*([\\s\\S]*?)(?=\\n【|$)`, "i");
    const found = previous.match(marker)?.[1]?.trim();
    if (found) values[step.key] = found.slice(0, 2500);
  }
  // Preserve the actual conversation, not only the AI-written canonical
  // summary. Older summaries do not always retain the step markers above.
  for (const answer of Array.isArray(context.primaryInterviewHistory) ? context.primaryInterviewHistory : []) {
    const key = String(answer?.questionKey || "");
    const message = String(answer?.message || "").trim();
    if (PRIMARY_INTERVIEW_STEPS.some((step) => step.key === key) && message)
      values[key] = message.slice(0, 2500);
  }
  const askedKey = String(current.questionKey || "");
  const message = String(current.message || "").trim();
  if (PRIMARY_INTERVIEW_STEPS.some((step) => step.key === askedKey) && message) values[askedKey] = message.slice(0, 2500);
  return values;
}
function primaryInfoUpdates(job: Job, context: any) {
  const current = job.payload?.answers && typeof job.payload.answers === "object" ? job.payload.answers : {};
  const updates = (Array.isArray(context.primaryInterviewHistory) ? context.primaryInterviewHistory : [])
    .filter((answer: any) => String(answer?.questionKey || "") === "update")
    .map((answer: any) => String(answer?.message || "").trim())
    .filter(Boolean);
  if (String(current.questionKey || "") === "update" && String(current.message || "").trim())
    updates.push(String(current.message).trim());
  return updates.slice(-5).map((message: string) => message.slice(0, 2500));
}
function primaryInfoFallback(job: Job) {
  const context: any = primaryInfoContext(job), answers = primaryInterviewAnswers(job, context);
  const updates = primaryInfoUpdates(job, context);
  const importedPdf = job.payload?.mode === "pdf_import";
  if (importedPdf) {
    return {
      quality_score: 80,
      quality_summary: "PDFの回答を記事用の一次情報として文章化しました。内容を確認して、必要なら編集してください。",
      quality_breakdown: PRIMARY_INTERVIEW_STEPS.map((step) => ({ label: step.label, score: 10 })),
      client_facing_summary: "アップロードされたPDFをもとに、記事に使う一次情報を整理しています。",
      article_ready_text: "アップロードされたPDFをもとに、記事に使う一次情報を整理しています。",
      interview_progress: { completed: PRIMARY_INTERVIEW_STEPS.map((step) => step.key), total: PRIMARY_INTERVIEW_STEPS.length },
      next_question_key: null,
      follow_up_questions: [],
      unverified_claims: [],
      ready_for_use: false,
      provider_status: "PDF_PRIMARY_INFORMATION_IMPORT",
    };
  }
  const completed = PRIMARY_INTERVIEW_STEPS.filter((step) => Boolean(answers[step.key]));
  const next = PRIMARY_INTERVIEW_STEPS.find((step) => !answers[step.key]);
  const score = Math.min(85, 50 + completed.length * 5);
  const record = PRIMARY_INTERVIEW_STEPS.filter((step) => answers[step.key])
    .map((step) => `【${step.label}】\n${answers[step.key]}`)
    .join("\n\n");
  const company = String(context.client?.name || "この会社");
  const updateRecord = updates.length
    ? `【今回の更新】\n${updates.join("\n\n")}`
    : "";
  const summary = record || updateRecord
    ? `${company}の一次情報ヒアリング（確認中）\n\n${[record, updateRecord].filter(Boolean).join("\n\n")}\n\n※未確認の数値・実績・表現は、確認が終わるまで記事で断定しません。`
    : "一次情報の回答がまだありません。";
  return {
    quality_score: score,
    quality_summary: `必要な一次情報は${PRIMARY_INTERVIEW_STEPS.length}項目中${completed.length}項目です。次の質問に答えると、記事で使える正式文章へ近づきます。`,
    quality_breakdown: PRIMARY_INTERVIEW_STEPS.map((step) => ({ label: step.label, score: answers[step.key] ? 10 : 0 })),
    client_facing_summary: summary,
    article_ready_text: summary,
    interview_progress: { completed: completed.map((step) => step.key), total: PRIMARY_INTERVIEW_STEPS.length },
    next_question_key: next?.key || null,
    follow_up_questions: next ? [next.question] : ["公開してよい表現・数値・実績を確認したうえで、最下部の確定操作へ進んでください。"],
    unverified_claims: [],
    ready_for_use: false,
    provider_status: "FALLBACK_GUIDED_INTERVIEW",
  };
}
function toBase64(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let output = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    output += String.fromCharCode(...bytes.subarray(start, Math.min(start + 0x8000, bytes.length)));
  return btoa(output);
}
async function primaryPdfAttachments(env: Env, job: Job) {
  const requestedId = String(job.payload?.sourceFileId || "");
  const files = (Array.isArray(job.context?.sourceFiles) ? job.context.sourceFiles : [])
    .filter((file: any) => !requestedId || String(file?.id || "") === requestedId)
    .filter((file: any) => String(file?.contentType || "") === "application/pdf")
    .slice(0, 1);
  if (job.payload?.mode === "pdf_import" && !files.length)
    throw new Error("読み取るPDFが見つかりません。もう一度PDFを追加してください。");
  const attachments: any[] = [];
  const processedFileIds: string[] = [];
  for (const file of files) {
    if (!env.FILES || !file?.objectKey) throw new Error("PDFの保存先に接続できません。もう一度PDFを追加してください。");
    if (Number(file.size || 0) > 8 * 1024 * 1024)
      throw new Error("PDFは8MB以内にしてください。画像を減らしてPDFを書き出し直してください。");
    const object = await env.FILES.get(String(file.objectKey));
    if (!object) throw new Error("PDFが見つかりません。もう一度PDFを追加してください。");
    attachments.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: toBase64(await object.arrayBuffer()),
      },
      title: String(file.name || "一次情報.pdf").slice(0, 240),
    });
    processedFileIds.push(String(file.id));
  }
  return { attachments, processedFileIds };
}
async function primaryInfoAssistant(env: Env, job: Job, instruction: string, context: unknown) {
  const guided = primaryInfoFallback(job);
  try {
    const documents = await primaryPdfAttachments(env, job);
    const out = await claude(
      env,
      `${instruction} 添付PDFがある場合は、PDFに書かれた「項目」と「クライアントの内容」を最優先の根拠として使います。PDFの記載を単に転載せず、内容を落とさず自然な日本語の一次情報へ文章化してください。PDFにない数値・実績・お客様の声は創作せず、未確認はunverified_claimsへ分けてください。これは固定アンケートではありません。最初に会社の実態、次に事業内容、次に今回の記事の目的を確認してから、回答内容に応じてサービス・顧客・課題・実績を奥へ深掘りします。クライアントの業種、これまでの回答、既存一次情報を読み、回答済みのことを聞き直さず、次の質問を1問だけ作ってください。質問は、専門用語や曖昧な営業表現を避けた自然で丁寧な日本語にし、何を答えればよいかが分かる補足を含めてください。「他社と比べて」などの比較質問は、会社・事業・記事目的を確認した後にだけ行います。事例なら対象・期間・施策・前後変化・公開可否、人物記事なら本人の経験・発言確認・肩書き、慎重な業種なら条件・根拠・確認者を優先します。更新回答なら何が変わったかと有効時点を確認してください。quality_breakdownは項目ごとの配列、next_question_keyは company/business/content_goal/service/customer/problem/difference/process/proof/evidence/update のいずれか、follow_up_questionsは不足がある限り最も重要な1問だけを返してください。80点未満では不足項目を埋める質問を優先し、80点以上でも公開可否が未確認ならready_for_useをfalseにしてください。ジョブ情報:${compact({ payload: job.payload, context }, 24000)}`,
      3000,
      false,
      job.context?.anthropicApiKey,
      undefined,
      "GENERAL",
      { timeoutMs: 25 * 1000, transientRetries: 0, attachments: documents.attachments },
    );
    // The model writes the natural-language summary, while the application
    // owns the interview state machine. This prevents a valid answer from
    // being followed by the first question again when model output varies.
    const modelQuestion = Array.isArray(out?.follow_up_questions)
      ? out.follow_up_questions.map((item: any) => typeof item === "string" ? item.trim() : String(item?.question || item?.text || "").trim()).find(Boolean)
      : "";
    return {
      ...out,
      quality_score: guided.quality_score,
      quality_breakdown: guided.quality_breakdown,
      interview_progress: guided.interview_progress,
      next_question_key: guided.next_question_key,
      // Claude sees the actual client transcript and supplies the tailored
      // wording. The application-owned fallback remains available if it fails.
      follow_up_questions: modelQuestion ? [modelQuestion.slice(0, 600)] : guided.follow_up_questions,
      ready_for_use: false,
      processed_file_ids: documents.processedFileIds,
    };
  } catch {
    return guided;
  }
}
async function resilientKeywordStrategy(env: Env, job: Job, instruction: string, context: unknown) {
  const model = claude(env, `${instruction} ジョブ情報:${compact({ payload: job.payload, context }, 8000)}`, 2000, false, job.context?.anthropicApiKey, undefined, "GENERAL", { timeoutMs: 45 * 1000, transientRetries: 1 }).catch(() => null);
  const result = await Promise.race([model, wait(20 * 1000).then(() => null)]);
  return result || keywordStrategyFallback(job);
}
function normalizeAio(out: any, job: Job) {
  const value = out?.llmo_aio_analysis || out || {};
  const source = aioContext(job);
  const uber: any = source.ubersuggest || {};
  const status = value.llmo_aio_status || value.serp_aio_observation || {};
  const strategies = value.llmo_strategy || {};
  const actions = Object.entries(strategies).flatMap(([category, group]: any) =>
    (Array.isArray(group?.actions) ? group.actions : []).map((item: any) => ({
      category,
      priority: group?.priority || item?.priority || "medium",
      action: item?.title || item?.action || item?.detail || "改善内容を確認",
      detail: item?.detail || "",
      impact: item?.impact || "—",
      effort: item?.effort || "—",
    })),
  );
  const planActions = Object.entries(value.action_plan || {}).flatMap(([, group]: any) =>
    (Array.isArray(group?.tasks) ? group.tasks : []).map((item: any) => ({
      category: group?.theme || "改善計画",
      priority: group?.priority || "high",
      action: item?.task || "改善内容を確認",
      detail: [item?.detail, item?.deadline].filter(Boolean).join(" / "),
      impact: item?.impact || "—",
      effort: item?.effort || "—",
    })),
  );
  const quickWins = (Array.isArray(value.quick_wins) ? value.quick_wins : []).map((item: any) => ({
    category: "短期改善",
    priority: "high",
    action: item?.action || "短期改善を確認",
    detail: item?.deadline_days ? `${item.deadline_days}日以内を目安` : "",
    impact: item?.impact || "—",
    effort: item?.effort || "—",
  }));
  const keywords = [...(Array.isArray(uber.keywords) ? uber.keywords : []), ...(Array.isArray(uber.rank_tracking) ? uber.rank_tracking : [])]
    .map((item: any) => ({ keyword: item?.keyword || item?.name || item?.query, position: item?.position ?? item?.current_position ?? item?.rank, volume: item?.volume ?? item?.search_volume }))
    .filter((item: any) => item.keyword)
    .filter((item: any, index: number, all: any[]) => all.findIndex((candidate: any) => candidate.keyword === item.keyword) === index)
    .slice(0, 20);
  const allActions = [...quickWins, ...actions, ...planActions];
  const fallbackActions = [
    { category: "技術SEO", priority: "高", action: `監査エラー${uber.site_audit?.errors ?? "未取得"}件を重要ページから修正`, detail: "タイトル・重複メタ・薄いコンテンツを優先", impact: "high", effort: "medium" },
    { category: "一次情報", priority: "最優先", action: "支援実績・事例・検証数値を一次情報として公開", detail: "AIO引用の根拠となる独自データを整備", impact: "critical", effort: "medium" },
    { category: "FAQ・構造化データ", priority: "高", action: "主要ページへFAQとFAQPageスキーマを追加", detail: "質問形式と回答根拠を明確化", impact: "high", effort: "low" },
  ];
  const prioritizedActions = allActions.length ? allActions : fallbackActions;
  const contentActions = allActions.filter((item: any) => /faq|visual|original|コンテンツ|情報|図解/i.test(item.category));
  const opportunities = Array.isArray(value.keyword_llmo_opportunity) ? value.keyword_llmo_opportunity : [];
  const primary = strategies.primary_information || {};
  return {
    executive_summary: value.executive_summary || `Ubersuggest実データでは、オーガニックキーワード${uber.dashboard?.organic_keywords ?? "未取得"}件、推定流入${uber.dashboard?.organic_traffic ?? "未取得"}、サイトヘルス${uber.site_audit?.health_score ?? "未取得"}です。AIOの出現・引用は実SERPでは未観測として扱います。`,
    current_status: status.note || "実SERPのAIO出現・引用は未観測です。",
    aio_detected_queries: status.aio_observed || status.aio_detected ? 1 : 0,
    citations: status.aio_citation_observed || status.site_cited_in_aio ? 1 : 0,
    competitors: Array.isArray(value.competitors) ? value.competitors : [],
    queries: keywords.map((item: any) => ({
      query: item.keyword,
      status: item.position ? `通常検索順位: ${item.position}位（AIO出現は未観測）` : "通常順位は未取得（AIO出現は未観測）",
      note: item.volume ? `検索ボリューム: ${item.volume}` : "Ubersuggestの追跡対象キーワード",
      recommended_format: "一次情報・FAQ・比較表を含む解説",
      search_intent: "要確認",
      priority: item.position && Number(item.position) <= 30 ? "高" : "中",
      evidence_needed: "独自の実績・事例・検証データ",
      next_action: "検索意図を確認し、既存ページの根拠とFAQを強化",
    })),
    gaps: [...(Array.isArray(value.current_issues) ? value.current_issues : []), ...(Array.isArray(value.aio_citation_risk_factors) ? value.aio_citation_risk_factors : [])].map((item: any) => `${item.issue || item.factor || "課題"}${item.count ? `（${item.count}件）` : ""} / 影響: ${item.impact || item.severity || "要確認"}`),
    priority_actions: prioritizedActions.slice(0, 12),
    content_recommendations: (opportunities.length ? opportunities.map((item: any) => ({ topic: item.keyword, format: Array.isArray(item.content_format) ? item.content_format.join(" / ") : "解説記事", why_now: `${item.opportunity_type || "候補"} / AIO可能性: ${item.aio_potential || "要確認"}`, evidence_to_add: item.llmo_strategy || "独自データ・事例・FAQを追加" })) : contentActions.length ? contentActions.map((item: any) => ({ topic: item.action, format: item.category, why_now: `影響: ${item.impact} / 工数: ${item.effort}`, evidence_to_add: item.detail || "独自データ・事例・FAQを追加" })) : keywords.slice(0, 5).map((item: any) => ({ topic: item.keyword, format: "一次情報・FAQを含む解説記事", why_now: item.volume ? `検索ボリューム: ${item.volume}` : "Ubersuggest追跡キーワード", evidence_to_add: "実績・事例・検証データ・比較表" }))).slice(0, 8),
    entity_evidence: primary?.actions?.map((item: any) => item.detail || item.title).filter(Boolean) || (value.llmo_content_guidelines?.ideal_content_structure_for_aio?.elements || []).map((item: any) => item.detail || item.element).filter(Boolean),
    citation_readiness: [
      { area: "一次情報", status: primary?.status === "missing" || value.llmo_aio_readiness?.scoring_breakdown?.primary_information?.status === "missing" ? "不足" : "要確認", improvement: primary?.actions?.[0]?.title || value.llmo_aio_readiness?.scoring_breakdown?.primary_information?.note || "実績・事例を一次情報として公開" },
      { area: "FAQ・構造化データ", status: strategies.faq ? "改善候補あり" : "要確認", improvement: strategies.faq?.actions?.[0]?.title || "FAQとFAQPageを整備" },
      { area: "著者性・権威性", status: strategies.authoritativeness ? "改善候補あり" : "要確認", improvement: strategies.authoritativeness?.actions?.[0]?.title || "著者情報とPersonスキーマを整備" },
    ],
    evidence_gaps: primary?.status === "missing" || value.llmo_aio_readiness?.scoring_breakdown?.primary_information?.status === "missing" ? ["独自の実績、事例、検証データなどの一次情報"] : [],
    disclaimer: "AIOの実際の出現・引用はSERP観測データが未取得のため未観測です。通常順位・監査・キーワードはUbersuggestの同期結果をもとに表示しています。",
  };
}
async function analysis(env: Env, job: Job) {
  const instructions: Record<string, string> = {
    keyword_strategy: "Ubersuggest実データとWordPressカテゴリー・公開済み記事から、カテゴリ均等化とテーマ整合を守るSEOキーワード年間計画をJSONで作る。recommended_keywordsにはkeyword,intent,target_article_type,rationale,cluster,category_id,category_name,category_reason,internal_link_targetsを含める。",
    monthly_report: "SEO運用の月次PDCAを実測データだけでクライアント向けJSONとして作成。比較データがなければ明記する。",
    aio_observe: "LLMO/AIO分析をJSONで作成。実SERPのAIO出現・引用は未観測と明記し、一次情報・FAQ・独自図解・著者性にもとづく施策を示す。",
    content_audit: "WordPress公開記事をSEO監査し、更新性、検索意図、重複、根拠不明、内部リンクをJSONで返す。確認できない事実は要確認にする。",
    primary_info_assist: "一次情報インタビューの会話として、既存の確認済み一次情報と今回の回答を統合し、記事に使えるクライアント向け正式文をJSONで作成。回答にない数値・実績・お客様の声を創作しない。根拠不足や未確認の主張はunverified_claimsへ分離し、次に聞くべき質問だけをfollow_up_questionsへ最大3件、具体的かつ答えやすく返す。既存確認済み情報を失わず、quality_score,quality_summary,quality_breakdown,client_facing_summary,article_ready_text,follow_up_questions,unverified_claims,ready_for_useを含める。",
    article_mapping_analyze: "既存WordPress記事を、提示されたTopic / Cluster / Keyword候補だけへ分類する。記事のtitle,slug,URL,category,excerpt,contentを読み、各記事ごとにarticle_id,article_title,article_url,suggested_topic_id,suggested_cluster_id,suggested_keyword_id,suggested_keyword_text,confidence(0〜1),reasoningを返す。IDが提示されていないTopic/Cluster/Keywordを確定候補にしない。適切な既存Keywordがない場合はsuggested_keyword_idを空、suggested_keyword_textへ新規候補として明示する。推測は低confidenceにする。JSONは {\"candidates\":[]}。",
  };
  if (!instructions[job.type]) throw new Error(`未対応ジョブ: ${job.type}`);
  await progress(env, job, 20, "analyzing", "Claude APIがクラウド上で分析しています");
  const isAio = job.type === "aio_observe";
  const isKeywordStrategy = job.type === "keyword_strategy";
  const isPrimaryInfo = job.type === "primary_info_assist";
  const context = isAio ? aioContext(job) : isKeywordStrategy ? keywordStrategyContext(job) : isPrimaryInfo ? primaryInfoContext(job) : job.context;
  if (isKeywordStrategy) return resilientKeywordStrategy(env, job, instructions[job.type], context);
  if (isPrimaryInfo) return primaryInfoAssistant(env, job, instructions[job.type], context);
  const budget = isPrimaryInfo
    ? { input: 24000, output: 3000, timeoutMs: 60 * 1000 }
    : isAio
      ? { input: 30000, output: 4500, timeoutMs: 60 * 1000 }
      : job.type === "article_mapping_analyze"
        ? { input: 45000, output: 5000, timeoutMs: 90 * 1000 }
        : job.type === "content_audit"
          ? { input: 35000, output: 4500, timeoutMs: 75 * 1000 }
          : { input: 24000, output: 3500, timeoutMs: 60 * 1000 };
  const out = await claude(
    env,
    `${instructions[job.type]} ジョブ情報:${compact({ payload: job.payload, context }, budget.input)}`,
    budget.output,
    false,
    job.context?.anthropicApiKey,
    undefined,
    "GENERAL",
    { timeoutMs: budget.timeoutMs, transientRetries: 1 },
  );
  if (isAio) return normalizeAio(out, job);
  if (job.type === "primary_info_assist") { out.quality_score = Number(out.quality_score || 80); out.ready_for_use = out.quality_score >= 80; }
  return out;
}
async function execute(env: Env, expectedId?: string) {
  const pollPath = expectedId
    ? `worker/poll?jobId=${encodeURIComponent(expectedId)}`
    : "worker/poll";
  const job: Job | null = (await app(env, pollPath)).job;
  if (!job) return;
  if (expectedId && job.id !== expectedId) throw new Error("キューと取得ジョブが一致しません。");
  try {
    const result = job.type === "article_generate" ? await article(env, job) : job.type === "content_intelligence_review" ? await contentIntelligence(env, job) : job.type === "title_optimize" ? await titleOptimization(env,job) : job.type === "internal_link_analyze" ? await internalLinkPlacement(env,job) : job.type === "internal_link_update" ? await internalLinkUpdate(env,job) : job.type === "wordpress_seo_plugin_sync" ? await wordpressSeoPluginSync(env,job) : ["wordpress_publish","wordpress_rollback"].includes(job.type) ? await wordpressPublish(env, job) : job.type === "autopilot_execute" ? (await app(env, "worker/autopilot-execute", "POST", { actionId: job.payload?.actionId, clientId: job.client_id })).result : job.type === "ubersuggest_sync" ? await ubersuggest(env, job) : job.type === "serp_analyze" ? await serp(env, job) : job.type === "serp_competitor_analyze" ? await competitorAnalysis(env, job) : job.type === "sync_google" ? (await app(env, "worker/google-sync", "POST", { jobId: job.id, connector: job.payload?.connector })).result : await analysis(env, job);
    await app(env, "worker/result", "POST", { jobId: job.id, ok: true, result });
  } catch (e: any) {
    await app(env, "worker/result", "POST", { jobId: job.id, ok: false, error: trim(e?.message || e) }); throw e;
  }
}
async function healthcheck(env: Env) {
  try {
    const result = await app(env, "worker/healthcheck", "POST", {});
    console.log(JSON.stringify({ event: "connection_healthcheck", ...result }));
  } catch (error: any) {
    // A temporary provider check must not prevent normal queued work from
    // running. The failure is still retained in Worker observability logs.
    console.log(JSON.stringify({ event: "connection_healthcheck_failed", error: trim(error?.message || error) }));
  }
}
async function backup(env: Env) {
  const date = new Date().toISOString().slice(0, 10);
  const key = `d1/${date}/seo-loop-dashboard.json`;
  try {
    if (await env.BACKUPS.head(key)) return;
    const entries = await Promise.all(
      BACKUP_TABLES.map(async (table) => {
        const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
        return [table, rows.results] as const;
      }),
    );
    const snapshot = JSON.stringify({
      schema: "seo-loop-d1-backup/v1",
      created_at: new Date().toISOString(),
      tables: Object.fromEntries(entries),
    });
    await env.BACKUPS.put(key, snapshot, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { kind: "d1-recovery-snapshot", date },
    });
    console.log(JSON.stringify({ event: "d1_backup_complete", key, bytes: snapshot.length }));
  } catch (error: any) {
    // A backup failure must not stop the queue or the connection-health check.
    console.log(JSON.stringify({ event: "d1_backup_failed", error: trim(error?.message || error) }));
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/enqueue") { if (request.headers.get("X-SEO-Loop-Dispatch") !== env.CLOUD_DISPATCH_TOKEN) return new Response("unauthorized", { status: 401 }); const body: any = await request.json(); if (!body?.jobId) return new Response("jobId is required", { status: 400 }); const jobId = String(body.jobId); await env.SEO_JOBS.send({ jobId }); if (body.runNow) { try { await execute(env, jobId); } catch (error: any) { return Response.json({ error: trim(error?.message || error) }, { status: 502 }); } }
      // Queue is the only asynchronous executor. Starting another detached
      // invocation here races the consumer: one call sets the job to running
      // while the other can no longer lease it, leaving a stale spinner.
      return Response.json({ ok: true }); }
    if (request.method === "POST" && path === "/images") {
      if (request.headers.get("X-SEO-Loop-Dispatch") !== env.CLOUD_DISPATCH_TOKEN) return new Response("unauthorized", { status: 401 });
      if (!env.OPENAI_API_KEY) return Response.json({ error: "OPENAI_API_KEYが未設定です。" }, { status: 422 });
      const body: any = await request.json();
      const generated = await fetch("https://api.openai.com/v1/images/generations", { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-image-2", prompt: String(body.prompt || ""), size: body.size || "1024x1024", quality: body.quality || "medium", output_format: "png" }) });
      const data = await generated.json().catch(() => ({}));
      return Response.json(data, { status: generated.status });
    }
    if (request.method === "POST" && path === "/oauth/google/config") {
      if (request.headers.get("X-SEO-Loop-Dispatch") !== env.CLOUD_DISPATCH_TOKEN) return new Response("unauthorized", { status: 401 });
      if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return Response.json({ error: "Google OAuthのCloudflare secretが未設定です。" }, { status: 422 });
      const body: any = await request.json().catch(() => ({}));
      return Response.json({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: String(body.redirectUri || ""), source: "cloud_runner" });
    }
    return new Response("SEO Loop cloud runner");
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env) { for (const message of batch.messages) { try { await execute(env, message.body.jobId); message.ack(); } catch { message.retry({ delaySeconds: 60 }); } } },
  async scheduled(_: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([healthcheck(env), backup(env), execute(env)]));
    ctx.waitUntil(app(env, "worker/autopilot-weekly", "POST", {}).catch(() => undefined));
  },
};
