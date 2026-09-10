import { connectorFields, verify, wordpressBase, wordpressXmlRpcDraft } from "../../../lib/integrations";
import {
  decrypt,
  encrypt,
  ensureSchema,
  id,
  json,
  log,
  now,
  ownedClient,
  ownerId,
  runtime,
  sha256,
} from "../../../lib/server";
import { defaultPriorityWeights, normalizeKeyword, priorityBreakdown, scoreKeyword, topicCoverage } from "../../../lib/seo-intelligence";
import { evaluateWeeklyAutopilot, freshnessStatus, measureAutopilot } from "../../../lib/seo-autopilot.mjs";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const bootstrapCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();
const parse = (value: unknown, fallback: any = null) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};
// MCP responses are retained for auditability, but credentials must never be
// persisted even if a provider unexpectedly echoes one in a tool payload.
const safeMcpAudit = (value: any): any => {
  if (Array.isArray(value)) return value.map(safeMcpAudit);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password/i.test(key) ? "[REDACTED]" : safeMcpAudit(item)]));
};
async function recordPrimaryInfoVersion(clientId: string, sourceId: string, articleReadyText: string, interview: unknown, changeSummary: string) {
  const db = runtime().DB;
  const latest = await db.prepare("SELECT COALESCE(MAX(version_no),0) version_no FROM primary_info_versions WHERE client_id=? AND source_id=?").bind(clientId, sourceId).first<any>();
  await db.prepare("INSERT INTO primary_info_versions (id,client_id,source_id,version_no,article_ready_text,interview_json,change_summary,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(), clientId, sourceId, Number(latest?.version_no || 0) + 1, articleReadyText.slice(0, 10000), JSON.stringify(interview || []).slice(0, 20000), changeSummary.slice(0, 2000), now()).run();
}
const bytesToB64 = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
};
async function input(request: Request) {
  return request.clone().json().catch(() => ({})) as Promise<any>;
}
async function requireOwner(request: Request) {
  const owner = ownerId(request);
  if (!owner)
    throw new Response(JSON.stringify({ error: "ログインが必要です。" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  return owner;
}
const articleStatusTransitions: Record<string, string[]> = {
  GENERATING: ["REVIEWING"],
  REVIEWING: [
    "AUTO_PUBLISH_READY",
    "BELOW_AUTO_PUBLISH_THRESHOLD",
    "HUMAN_REVIEW_REQUIRED",
    "DRAFT",
  ],
  HUMAN_REVIEW_REQUIRED: ["DRAFT", "REVIEWING"],
  AUTO_PUBLISH_READY: ["DRAFT", "PUBLISHED_AUTOMATICALLY"],
  BELOW_AUTO_PUBLISH_THRESHOLD: ["DRAFT"],
  DRAFT: ["REVIEWING"],
};
const completeContentBrief = (brief: any) => Boolean(
  brief && typeof brief === "object" && ["informational","commercial","transactional","navigational","local"].includes(String(brief.search_intent || "")) &&
  String(brief.desired_outcome || "").trim() && String(brief.serp_consensus || "[]") !== "[]" &&
  String(brief.content_gap || "").trim() && String(brief.ymyl_risk || "").trim(),
);

/**
 * The only Phase 3 path that changes an article version's workflow status.
 * It deliberately verifies ownership again, validates the transition, and
 * records one event per retry-safe transition event.
 */
async function transitionArticleStatus({
  clientId,
  owner,
  articleVersionId,
  toStatus,
  reason,
  changedBy = "system",
  transitionEvent,
}: {
  clientId: string;
  owner: string;
  articleVersionId: string;
  toStatus: string;
  reason: string;
  changedBy?: string;
  transitionEvent: string;
}) {
  if (!(await ownedClient(clientId, owner))) throw new Error("クライアントが見つかりません。");
  const db = runtime().DB;
  const version = await db
    .prepare("SELECT id,article_id,status FROM article_versions WHERE id=? AND client_id=?")
    .bind(articleVersionId, clientId)
    .first<any>();
  if (!version) throw new Error("記事バージョンが見つかりません。");
  const fromStatus = String(version.status);
  if (fromStatus === toStatus) return { ok: true, idempotent: true, status: toStatus };
  const allowed = toStatus === "FAILED" || toStatus === "PUBLISHED_MANUALLY" || (articleStatusTransitions[fromStatus] || []).includes(toStatus);
  if (!allowed) throw new Error(`状態遷移が不正です: ${fromStatus} → ${toStatus}`);
  const stamp = now();
  await db.batch([
    db.prepare("UPDATE article_versions SET status=?,updated_at=? WHERE id=? AND client_id=? AND status=?")
      .bind(toStatus, stamp, articleVersionId, clientId, fromStatus),
    db.prepare("INSERT INTO article_status_history (id,client_id,article_id,article_version_id,from_status,to_status,reason,changed_by,transition_event,changed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_version_id,from_status,to_status,transition_event) DO NOTHING")
      .bind(id(), clientId, version.article_id, articleVersionId, fromStatus, toStatus, reason.slice(0, 4000), changedBy, transitionEvent, stamp),
  ]);
  return { ok: true, idempotent: false, status: toStatus };
}
async function publishEligibility(clientId: string, articleVersionId: string) {
  const db = runtime().DB;
  const [version, quality, ymyl, review, claims, links, cannibal, connection, settings] = await Promise.all([
    db.prepare("SELECT * FROM article_versions WHERE id=? AND client_id=?").bind(articleVersionId, clientId).first<any>(),
    db.prepare("SELECT * FROM article_quality_reviews WHERE client_id=? AND article_version_id=?").bind(clientId, articleVersionId).first<any>(),
    db.prepare("SELECT * FROM article_ymyl_assessments WHERE client_id=? AND article_version_id=?").bind(clientId, articleVersionId).first<any>(),
    db.prepare("SELECT status FROM human_review_queue WHERE client_id=? AND article_version_id=?").bind(clientId, articleVersionId).first<any>(),
    db.prepare("SELECT verification_status,risk_level FROM content_claims WHERE client_id=? AND article_version_id=?").bind(clientId, articleVersionId).all<any>(),
    db.prepare("SELECT status,validation_reason FROM internal_link_candidates WHERE client_id=? AND article_version_id=?").bind(clientId, articleVersionId).all<any>(),
    db.prepare("SELECT risk FROM cannibalization_assessments WHERE client_id=? ORDER BY created_at DESC LIMIT 1").bind(clientId).first<any>(),
    db.prepare("SELECT id,status FROM connections WHERE client_id=? AND connector='wordpress'").bind(clientId).first<any>(),
    db.prepare("SELECT * FROM client_publish_settings WHERE client_id=?").bind(clientId).first<any>(),
  ]);
  const unsupported = claims.results.filter((claim:any) => ["UNSUPPORTED", "PRIMARY_SOURCE_REQUIRED"].includes(claim.verification_status) && ["HIGH", "CRITICAL"].includes(claim.risk_level));
  const conflicting = claims.results.filter((claim:any) => claim.verification_status === "CONFLICTING");
  const criticalLinkError = links.results.some((link:any) => /critical|unsafe|invalid/i.test(String(link.validation_reason || "")) && link.status !== "APPROVED");
  const blockers = [
    ...(version?.status !== "AUTO_PUBLISH_READY" ? ["ARTICLE_STATUS_NOT_AUTO_PUBLISH_READY"] : []),
    ...(Number(quality?.total_score || 0) < 95 ? ["QUALITY_SCORE_BELOW_95"] : []),
    ...(ymyl?.risk === "HIGH" ? ["YMYL_HIGH"] : []),
    ...(unsupported.length ? ["UNSUPPORTED_CLAIM"] : []),
    ...(conflicting.length ? ["CONFLICTING_EVIDENCE"] : []),
    ...(review && review.status !== "APPROVED" ? ["HUMAN_REVIEW_REQUIRED"] : []),
    ...(cannibal?.risk === "HIGH" ? ["CANNIBALIZATION_HIGH"] : []),
    ...(criticalLinkError ? ["INTERNAL_LINK_CRITICAL_ERROR"] : []),
    ...(connection?.status !== "connected" ? ["WORDPRESS_CONNECTION_UNAVAILABLE"] : []),
    ...(!Number(settings?.auto_publish_enabled || 0) ? ["AUTO_PUBLISH_OFF"] : []),
  ];
  return { version, quality, ymyl, review, unsupportedClaims: unsupported.length, conflictingClaims: conflicting.length, internalLinkCriticalError: criticalLinkError, connection, settings: settings || { auto_publish_enabled: 0, auto_create_category: 0, tag_limit: 5 }, eligible: blockers.length === 0, blockers };
}
const UBERSUGGEST_STUCK_MS = 7 * 60 * 1000;
const PRIMARY_INFO_STUCK_MS = 3 * 60 * 1000;
const OTHER_AI_STUCK_MS = 6 * 60 * 1000;
const CONNECTION_HEALTH_INTERVAL_MS = 20 * 60 * 60 * 1000;
async function stopStuckUbersuggestJobs(owner: string) {
  const cutoff = new Date(Date.now() - UBERSUGGEST_STUCK_MS).toISOString();
  const stamp = now();
  await runtime().DB.prepare(
    "UPDATE jobs SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE type='ubersuggest_sync' AND status='running' AND updated_at<? AND client_id IN (SELECT id FROM clients WHERE owner_id=?)",
  )
    .bind("Ubersuggest同期が7分間進まなかったため停止しました。再同期してください。", stamp, cutoff, owner)
    .run();
}
async function stopStuckAiJobs(owner: string) {
  const db = runtime().DB, stamp = now();
  await db.prepare(
    "UPDATE jobs SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE type='primary_info_assist' AND status='running' AND updated_at<? AND client_id IN (SELECT id FROM clients WHERE owner_id=?)",
  ).bind("一次情報のAI処理が3分間更新されなかったため停止しました。再実行してください。", stamp, new Date(Date.now() - PRIMARY_INFO_STUCK_MS).toISOString(), owner).run();
  await db.prepare(
    "UPDATE jobs SET status='failed',error=?,lease_until=NULL,updated_at=? WHERE type IN ('content_intelligence_review','title_optimize','internal_link_analyze','serp_competitor_analyze','monthly_report','aio_observe','content_audit','article_mapping_analyze') AND status='running' AND updated_at<? AND client_id IN (SELECT id FROM clients WHERE owner_id=?)",
  ).bind("AI処理が6分間更新されなかったため停止しました。再実行してください。", stamp, new Date(Date.now() - OTHER_AI_STUCK_MS).toISOString(), owner).run();
}
async function dispatchCloudJob(jobId: string, runNow = false, origin = "") {
  const runnerUrl = String(
    // The vinext request URL can be an internal asset-host URL.  Always use
    // the explicitly configured Cloudflare Worker endpoint for job execution.
    runtime().CLOUD_RUNNER_PUBLIC_URL || runtime().CLOUD_RUNNER_URL || runtime().SEO_LOOP_ORIGIN || origin || "",
  ).replace(/\/$/, "");
  const token = String(runtime().CLOUD_DISPATCH_TOKEN || "");
  // Run immediately through the authenticated runner when possible.  The
  // Queue remains the durable retry path, but content operations must not be
  // blocked when Cloudflare delays queue-consumer delivery.
  if (runnerUrl && token) {
    const runnerRequest = new Request(`${runnerUrl}/enqueue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SEO-Loop-Dispatch": token,
      },
      body: JSON.stringify({ jobId, runNow }),
    });
    const appBinding = runtime().SEO_APP;
    const response = appBinding
      ? await appBinding.fetch(runnerRequest)
      : await fetch(runnerRequest);
    if (response.ok) return true;
    const job = await runtime()
      .DB.prepare("SELECT client_id FROM jobs WHERE id=?")
      .bind(jobId)
      .first<{ client_id: string }>();
    if (job?.client_id)
      await log(job.client_id, "Cloudflare即時実行へ接続できずQueueへフォールバック", "warn", {
        status: response.status,
      });
  }
  const queue = runtime().SEO_JOBS;
  if (queue) {
    await queue.send({ jobId });
    return true;
  }
  if (!runnerUrl || !token) return false;
  throw new Error("Cloudflareジョブ実行先へ接続できませんでした。");
}
async function worker(request: Request) {
  const token = (request.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  const internalDispatch = request.headers.get("X-SEO-Loop-Dispatch") || "";
  if (
    runtime().CLOUD_DISPATCH_TOKEN &&
    internalDispatch === runtime().CLOUD_DISPATCH_TOKEN
  ) {
    const client = await runtime()
      .DB.prepare("SELECT id FROM clients ORDER BY created_at LIMIT 1")
      .first<{ id: string }>();
    return client
      ? { id: "cloudflare-job-runner", client_id: client.id, cloud: true }
      : null;
  }
  if (!token) return null;
  // The Cloudflare Queue/cron worker is the production job runner.  It uses
  // the Worker secret directly and must not depend on the retired local-Mac
  // registration record.  Keep the database-token path for backward
  // compatibility with any existing local worker, but prefer neither one
  // over the other at the API boundary.
  if (
    runtime().SEO_LOOP_WORKER_TOKEN &&
    token === runtime().SEO_LOOP_WORKER_TOKEN
  ) {
    const client = await runtime()
      .DB.prepare("SELECT id FROM clients ORDER BY created_at LIMIT 1")
      .first<{ id: string }>();
    return client
      ? { id: "cloudflare-job-runner", client_id: client.id, cloud: true }
      : null;
  }
  const hash = await sha256(token);
  return runtime()
    .DB.prepare("SELECT * FROM worker_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<Record<string, any>>();
}
async function googleCredentials(owner: string, request: Request) {
  const env = runtime();
  const redirectUri =
    env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${new URL(request.url).origin}/api/google/callback`;
  const runnerUrl = String(env.CLOUD_RUNNER_URL || "").replace(/\/$/, "");
  const runnerToken = String(env.CLOUD_DISPATCH_TOKEN || "");
  if (runnerUrl && runnerToken) {
    const remote = await fetch(`${runnerUrl}/oauth/google/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SEO-Loop-Dispatch": runnerToken },
      body: JSON.stringify({ redirectUri }),
    });
    const config = await remote.json().catch(() => null) as any;
    if (remote.ok && config?.clientId && config?.clientSecret) return config;
  }
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET)
    return {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri,
      source: "server",
    };
  const saved = await env.DB.prepare(
    "SELECT secret_cipher,public_config FROM app_settings WHERE owner_id=? AND setting_key='google_oauth'",
  )
    .bind(owner)
    .first<any>();
  if (!saved?.secret_cipher) return null;
  const secret = await decrypt<any>(saved.secret_cipher);
  const publicConfig = parse(saved.public_config, {});
  return {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    redirectUri: publicConfig.redirectUri || redirectUri,
    source: "encrypted_settings",
  };
}
const ubersuggestIssuer = "https://ubersuggest-mcp.neilpatelapi.com";
const ubersuggestMcpUrl = `${ubersuggestIssuer}/mcp`;
const b64urlDigest = async (value: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let raw = ""; for (const byte of digest) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function ubersuggestStart(request: Request, clientId: string, owner: string) {
  const redirectUri = `${new URL(request.url).origin}/api/ubersuggest/callback`;
  const registration: any = await fetch(`${ubersuggestIssuer}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "SEO Loop", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) }).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
  if (!registration.ok || !registration.data?.client_id) return json({ error: "Ubersuggest MCPクライアントの登録に失敗しました。" }, 502);
  const state = crypto.randomUUID() + crypto.randomUUID();
  const verifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await runtime().DB.prepare("INSERT INTO external_oauth_states (state,client_id,owner_id,provider,secret_cipher,expires_at) VALUES (?,?,?,?,?,?)")
    .bind(state, clientId, owner, "ubersuggest", await encrypt({ verifier, clientId: registration.data.client_id, redirectUri }), new Date(Date.now() + 10 * 60 * 1000).toISOString()).run();
  const params = new URLSearchParams({ response_type: "code", client_id: registration.data.client_id, redirect_uri: redirectUri, scope: "profile domain keywords serp backlinks site_audit content projects utility", state, code_challenge: await b64urlDigest(verifier), code_challenge_method: "S256" });
  return json({ ok: true, authorizationUrl: `${ubersuggestIssuer}/authorize?${params}` });
}
async function ubersuggestCallback(request: Request) {
  const url = new URL(request.url); const state = url.searchParams.get("state") || "";
  const finish = (result: string) => Response.redirect(`${url.origin}/?ubersuggest=${encodeURIComponent(result)}`, 302);
  const pending = await runtime().DB.prepare("SELECT * FROM external_oauth_states WHERE state=? AND provider='ubersuggest' AND expires_at>?").bind(state, now()).first<any>();
  if (!pending) return finish("session_expired");
  await runtime().DB.prepare("DELETE FROM external_oauth_states WHERE state=?").bind(state).run();
  if (url.searchParams.get("error")) return finish("denied");
  try {
    const stateData = await decrypt<any>(pending.secret_cipher);
    const response = await fetch(`${ubersuggestIssuer}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: stateData.redirectUri, client_id: stateData.clientId, code_verifier: stateData.verifier }) });
    const token: any = await response.json().catch(() => ({}));
    if (!response.ok || !token.access_token) return finish("token_exchange_failed");
    const saved = { clientId: stateData.clientId, accessToken: token.access_token, refreshToken: token.refresh_token || "", expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000 };
    await runtime().DB.prepare("INSERT INTO connections (id,client_id,connector,status,public_config,secret_cipher,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,secret_cipher=excluded.secret_cipher,checked_at=excluded.checked_at,updated_at=excluded.updated_at")
      .bind(id(), pending.client_id, "ubersuggest", "connected", JSON.stringify({ mode: "cloud_oauth", mcpUrl: ubersuggestMcpUrl }), await encrypt(saved), now(), now()).run();
    await log(pending.client_id, "Ubersuggest MCP OAuth認証が完了"); return finish("authorized");
  } catch { return finish("failed"); }
}
async function ubersuggestAccessToken(clientId: string) {
  const row = await runtime().DB.prepare(
    "SELECT secret_cipher FROM connections WHERE client_id=? AND connector='ubersuggest' AND secret_cipher IS NOT NULL",
  ).bind(clientId).first<any>();
  if (!row?.secret_cipher)
    throw new Error("Ubersuggestを「接続」して認証してください。");
  const saved = await decrypt<any>(row.secret_cipher);
  const accessToken = String(saved.accessToken || "");
  // Keep a small safety margin so a token cannot expire while Anthropic is
  // opening the remote MCP connection.
  if (accessToken && Number(saved.expiresAt || 0) > Date.now() + 2 * 60 * 1000)
    return accessToken;
  if (!saved.refreshToken || !saved.clientId)
    throw new Error("Ubersuggestの再接続が必要です。認証情報を更新してください。");
  const response = await fetch(`${ubersuggestIssuer}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(saved.refreshToken),
      client_id: String(saved.clientId),
    }),
  });
  const token: any = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token)
    throw new Error(token.error_description || "Ubersuggestの再接続が必要です。認証情報を更新してください。");
  const next = {
    ...saved,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || saved.refreshToken,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  await runtime().DB.prepare(
    "UPDATE connections SET secret_cipher=?,status='connected',checked_at=?,updated_at=? WHERE client_id=? AND connector='ubersuggest'",
  ).bind(await encrypt(next), now(), now(), clientId).run();
  await log(clientId, "Ubersuggest OAuthアクセストークンを自動更新");
  return next.accessToken;
}
const googleConnectors = ["ga", "gsc", "drive", "youtube"];
async function googleToken(clientId: string, request: Request, force = false) {
  const env = runtime();
  const row = await env.DB.prepare(
    "SELECT c.secret_cipher,cl.owner_id FROM connections c JOIN clients cl ON cl.id=c.client_id WHERE c.client_id=? AND c.connector IN ('ga','gsc','drive','youtube') AND c.secret_cipher IS NOT NULL LIMIT 1",
  )
    .bind(clientId)
    .first<any>();
  if (!row?.secret_cipher)
    throw new Error("Googleアカウントを先に認証してください。");
  const saved = await decrypt<any>(row.secret_cipher);
  if (
    !force &&
    saved.access_token &&
    (!saved.expires_at || Number(saved.expires_at) > Date.now() + 60000)
  )
    return saved.access_token;
  if (!saved.refresh_token) throw new Error("Googleの再認証が必要です。");
  const credentials = await googleCredentials(row.owner_id, request);
  if (!credentials) throw new Error("Google管理者設定が見つかりません。");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: saved.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok || !payload.access_token)
    throw new Error(payload.error_description || "Googleの再認証が必要です。");
  const next = {
    ...saved,
    ...payload,
    refresh_token: saved.refresh_token,
    expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  const cipher = await encrypt(next);
  await env.DB.prepare(
    "UPDATE connections SET secret_cipher=?,updated_at=? WHERE client_id=? AND connector IN ('ga','gsc','drive','youtube')",
  )
    .bind(cipher, now(), clientId)
    .run();
  return next.access_token;
}
async function checkConnectionHealth(request: Request, owner: string) {
  const db = runtime().DB;
  const clients = await db.prepare("SELECT id FROM clients WHERE owner_id=?").bind(owner).all<{ id: string }>();
  const cutoff = new Date(Date.now() - CONNECTION_HEALTH_INTERVAL_MS).toISOString();
  const summary = { checked: 0, healthy: 0, needsReauth: 0, skipped: 0 };
  for (const client of clients.results) {
    const rows = await db.prepare("SELECT connector,status,checked_at FROM connections WHERE client_id=? AND connector IN ('ubersuggest','ga','gsc','drive','youtube')").bind(client.id).all<any>();
    const uber = rows.results.find((row: any) => row.connector === "ubersuggest");
    if (uber) {
      if (uber.checked_at && uber.checked_at >= cutoff) summary.skipped++;
      else {
        summary.checked++;
        try {
          await ubersuggestAccessToken(client.id);
          await db.prepare("UPDATE connections SET status='connected',checked_at=?,updated_at=? WHERE client_id=? AND connector='ubersuggest'").bind(now(), now(), client.id).run();
          summary.healthy++;
        } catch (error: any) {
          await db.prepare("UPDATE connections SET status='reauth_required',checked_at=?,updated_at=? WHERE client_id=? AND connector='ubersuggest'").bind(now(), now(), client.id).run();
          await log(client.id, "Ubersuggest接続の定期確認に失敗", "warn", { error: String(error?.message || error).slice(0, 300) });
          summary.needsReauth++;
        }
      }
    }
    const google = rows.results.filter((row: any) => googleConnectors.includes(row.connector));
    const lastGoogleCheck = google.map((row: any) => row.checked_at).filter(Boolean).sort().at(-1);
    if (!google.length) continue;
    if (lastGoogleCheck && lastGoogleCheck >= cutoff) { summary.skipped++; continue; }
    summary.checked++;
    try {
      // Refresh an expiring credential without reading customer data or using
      // Search Console / Analytics reporting quota.
      await googleToken(client.id, request);
      await db.prepare("UPDATE connections SET checked_at=?,updated_at=? WHERE client_id=? AND connector IN ('ga','gsc','drive','youtube')").bind(now(), now(), client.id).run();
      summary.healthy++;
    } catch (error: any) {
      await db.prepare("UPDATE connections SET status='reauth_required',checked_at=?,updated_at=? WHERE client_id=? AND connector IN ('ga','gsc','drive','youtube')").bind(now(), now(), client.id).run();
      await log(client.id, "Google接続の定期確認に失敗", "warn", { error: String(error?.message || error).slice(0, 300) });
      summary.needsReauth++;
    }
  }
  return summary;
}
async function googleApi(
  clientId: string,
  request: Request,
  url: string,
  options: RequestInit = {},
) {
  let token = await googleToken(clientId, request);
  let response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    token = await googleToken(clientId, request, true);
    response = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  }
  const payload = (await response.json().catch(() => ({}))) as any;
  if (!response.ok)
    throw new Error(
      payload.error?.message ||
        payload.error_description ||
        `Google API error (${response.status})`,
    );
  return payload;
}
async function googleResources(clientId: string, request: Request) {
  const results = await Promise.allSettled([
    googleApi(
      clientId,
      request,
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
    ),
    googleApi(
      clientId,
      request,
      "https://www.googleapis.com/webmasters/v3/sites",
    ),
    googleApi(
      clientId,
      request,
      "https://www.googleapis.com/drive/v3/about?fields=user,storageQuota",
    ),
    googleApi(
      clientId,
      request,
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=50",
    ),
  ]);
  const value = (index: number) =>
    results[index].status === "fulfilled"
      ? (results[index] as PromiseFulfilledResult<any>).value
      : {};
  const error = (index: number) =>
    results[index].status === "rejected"
      ? String(
          (results[index] as PromiseRejectedResult).reason?.message ||
            (results[index] as PromiseRejectedResult).reason,
        )
      : "";
  const ga4 = (value(0).accountSummaries || [])
    .flatMap((account: any) =>
      (account.propertySummaries || []).map((item: any) => ({
        id: String(item.property || "").replace("properties/", ""),
        name: item.displayName || item.property || "",
        account: account.displayName || account.account || "",
      })),
    )
    .filter((item: any) => item.id);
  const gsc = (value(1).siteEntry || [])
    .map((item: any) => ({
      id: item.siteUrl,
      name: item.siteUrl,
      permission: item.permissionLevel || "",
    }))
    .filter((item: any) => item.id);
  const drive = value(2).user
    ? {
        id: value(2).user.permissionId || value(2).user.emailAddress || "drive",
        name:
          value(2).user.displayName ||
          value(2).user.emailAddress ||
          "Google Drive",
        email: value(2).user.emailAddress || "",
      }
    : null;
  const youtube = (value(3).items || []).map((item: any) => ({
    id: item.id,
    name: item.snippet?.title || item.id,
  }));
  return {
    ga4,
    gsc,
    drive,
    youtube,
    errors: { ga: error(0), gsc: error(1), drive: error(2), youtube: error(3) },
  };
}
const daysAgo = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
async function verifyGoogleResource(
  clientId: string,
  request: Request,
  connector: string,
  resourceId: string,
) {
  if (connector === "ga")
    return googleApi(
      clientId,
      request,
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(resourceId)}:runReport`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
          metrics: [{ name: "activeUsers" }],
          limit: 1,
        }),
      },
    );
  if (connector === "gsc")
    return googleApi(
      clientId,
      request,
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(resourceId)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: daysAgo(8),
          endDate: daysAgo(1),
          dimensions: ["date"],
          rowLimit: 1,
        }),
      },
    );
  if (connector === "drive")
    return googleApi(
      clientId,
      request,
      "https://www.googleapis.com/drive/v3/about?fields=user",
    );
  return googleApi(
    clientId,
    request,
    `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&id=${encodeURIComponent(resourceId)}`,
  );
}

const isoDay = (offset: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const autopilotWeek = () => {
  const date = new Date();
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
};
const metricSummary = async (clientId: string, days: number) => {
  const db = runtime().DB, since = isoDay(-(days - 1));
  const [gsc, ga4] = await Promise.all([
    db.prepare("SELECT COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position,COUNT(*) rows FROM gsc_search_performance WHERE client_id=? AND date>=?").bind(clientId, since).first<any>(),
    db.prepare("SELECT COALESCE(SUM(organic_sessions),0) sessions,COALESCE(SUM(engaged_sessions),0) engagement,COALESCE(SUM(conversions),0) conversions,COALESCE(SUM(revenue),0) revenue,COUNT(*) rows FROM ga4_page_performance WHERE client_id=? AND date>=?").bind(clientId, since).first<any>(),
  ]);
  return { clicks:Number(gsc?.clicks||0), impressions:Number(gsc?.impressions||0), ctr:Number(gsc?.ctr||0), position:Number(gsc?.position||0), sessions:Number(ga4?.sessions||0), engagement:Number(ga4?.engagement||0), conversions:Number(ga4?.conversions||0), revenue:Number(ga4?.revenue||0), gscRows:Number(gsc?.rows||0), ga4Rows:Number(ga4?.rows||0) };
};
// TITLE changes are measured against the mapped article and primary keyword,
// never against an unrelated client-wide aggregate. Missing mappings/data stay
// explicit so a result is not inferred from a different page or query.
const titleMetricSummary = async (clientId: string, action: any, days: number) => {
  const db = runtime().DB, since = isoDay(-(days - 1));
  const [mapping, keyword, proposal] = await Promise.all([
    db.prepare("SELECT COALESCE(NULLIF(w.wordpress_url,''),NULLIF(m.article_url,'')) article_url FROM article_mapping_candidates m LEFT JOIN wordpress_article_mappings w ON w.client_id=m.client_id AND w.article_id=m.article_id WHERE m.client_id=? AND m.article_id=? AND m.status IN ('APPROVED','MODIFIED') ORDER BY w.updated_at DESC,m.updated_at DESC LIMIT 1").bind(clientId, String(action.target_article_id || "")).first<any>(),
    action.target_keyword_id ? db.prepare("SELECT keyword FROM seo_keywords WHERE client_id=? AND id=?").bind(clientId, String(action.target_keyword_id)).first<any>() : Promise.resolve(null),
    db.prepare("SELECT target_queries_json FROM title_optimization_proposals WHERE client_id=? AND action_id=?").bind(clientId,String(action.id)).first<any>(),
  ]);
  const page = String(mapping?.article_url || ""), primaryQuery = String(keyword?.keyword || "");
  const targetQueries = Array.from(new Set([primaryQuery,...(Array.isArray(parse(proposal?.target_queries_json,[]))?parse(proposal?.target_queries_json,[]):[]).map((value:any)=>String(typeof value === "string" ? value : value?.query || value?.keyword || "")).map((value:string)=>value.trim()).filter(Boolean)]));
  if (!page || !targetQueries.length) return { clicks:0, impressions:0, ctr:0, position:0, sessions:0, engagement:0, conversions:0, revenue:0, gscRows:0, ga4Rows:0, page:page || null, query:primaryQuery || null, targetQueries:targetQueries.map((query)=>({query,dataStatus:"DATA_NOT_AVAILABLE"})), dataStatus:"DATA_NOT_AVAILABLE" };
  const [gsc, ga4] = await Promise.all([
    db.prepare("SELECT query,COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position,COUNT(*) rows FROM gsc_search_performance WHERE client_id=? AND date>=? AND page=? GROUP BY query").bind(clientId,since,page).all<any>(),
    db.prepare("SELECT COALESCE(SUM(organic_sessions),0) sessions,COALESCE(SUM(engaged_sessions),0) engagement,COALESCE(SUM(conversions),0) conversions,COALESCE(SUM(revenue),0) revenue,COUNT(*) rows FROM ga4_page_performance WHERE client_id=? AND date>=? AND landing_page=?").bind(clientId,since,page).first<any>(),
  ]);
  const gscByQuery=new Map((gsc.results||[]).map((row:any)=>[String(row.query).toLowerCase(),row]));
  const queryMetrics=targetQueries.map((query)=>{const row:any=gscByQuery.get(query.toLowerCase());return row?{query,clicks:Number(row.clicks||0),impressions:Number(row.impressions||0),ctr:Number(row.ctr||0),position:Number(row.position||0),gscRows:Number(row.rows||0),dataStatus:"AVAILABLE"}:{query,clicks:null,impressions:null,ctr:null,position:null,gscRows:0,dataStatus:"DATA_NOT_AVAILABLE"};});
  const available=queryMetrics.filter((row:any)=>row.dataStatus==="AVAILABLE"),gscRows=available.reduce((sum:number,row:any)=>sum+Number(row.gscRows||0),0),impressions=available.reduce((sum:number,row:any)=>sum+Number(row.impressions||0),0),clicks=available.reduce((sum:number,row:any)=>sum+Number(row.clicks||0),0),ga4Rows=Number(ga4?.rows||0);
  return { clicks, impressions, ctr:impressions?clicks/impressions:0, position:available.length?available.reduce((sum:number,row:any)=>sum+Number(row.position||0),0)/available.length:0, sessions:Number(ga4?.sessions||0), engagement:Number(ga4?.engagement||0), conversions:Number(ga4?.conversions||0), revenue:Number(ga4?.revenue||0), gscRows, ga4Rows, page, query:primaryQuery || null, targetQueries:queryMetrics, dataStatus:gscRows||ga4Rows ? "AVAILABLE" : "DATA_NOT_AVAILABLE" };
};
// INTERNAL_LINK uses the same Action/window measurement rows as Autopilot.
// Both mapped pages are retained inside one immutable observation so the
// existing action+window idempotency contract remains intact.
const internalLinkMetricSummary = async (clientId:string, action:any, days:number) => {
  const db=runtime().DB, since=isoDay(-(days-1)), execution=await db.prepare("SELECT * FROM internal_link_execution_history WHERE client_id=? AND action_id=?").bind(clientId,String(action.id)).first<any>();
  if(!execution)return {source:{dataStatus:"DATA_NOT_AVAILABLE"},target:{dataStatus:"DATA_NOT_AVAILABLE"},dataStatus:"DATA_NOT_AVAILABLE"};
  const pageMetric=async(articleId:string)=>{const mapping=await db.prepare("SELECT COALESCE(NULLIF(w.wordpress_url,''),NULLIF(m.article_url,'')) page FROM article_mapping_candidates m LEFT JOIN wordpress_article_mappings w ON w.client_id=m.client_id AND w.article_id=m.article_id WHERE m.client_id=? AND m.article_id=? AND m.status IN ('APPROVED','MODIFIED') ORDER BY w.updated_at DESC,m.updated_at DESC LIMIT 1").bind(clientId,articleId).first<any>(),page=String(mapping?.page||"");if(!page)return {page:null,dataStatus:"DATA_NOT_AVAILABLE"};const [gsc,ga4]=await Promise.all([db.prepare("SELECT COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE NULL END ctr,AVG(position) position,COUNT(*) rows FROM gsc_search_performance WHERE client_id=? AND date>=? AND page=?").bind(clientId,since,page).first<any>(),db.prepare("SELECT COALESCE(SUM(organic_sessions),0) sessions,COALESCE(SUM(engaged_sessions),0) engagement,COALESCE(SUM(conversions),0) conversions,COUNT(*) rows FROM ga4_page_performance WHERE client_id=? AND date>=? AND landing_page=?").bind(clientId,since,page).first<any>()]);const gscRows=Number(gsc?.rows||0),ga4Rows=Number(ga4?.rows||0);return {page,clicks:gscRows?Number(gsc.clicks):null,impressions:gscRows?Number(gsc.impressions):null,ctr:gscRows?Number(gsc.ctr||0):null,position:gscRows?Number(gsc.position||0):null,sessions:ga4Rows?Number(ga4.sessions):null,engagement:ga4Rows?Number(ga4.engagement):null,conversions:ga4Rows?Number(ga4.conversions):null,gscRows,ga4Rows,dataStatus:gscRows||ga4Rows?"AVAILABLE":"DATA_NOT_AVAILABLE"};};
  const [source,target]=await Promise.all([pageMetric(execution.source_article_id),pageMetric(execution.target_article_id)]);return {source,target,dataStatus:source.dataStatus==="AVAILABLE"||target.dataStatus==="AVAILABLE"?"AVAILABLE":"DATA_NOT_AVAILABLE"};
};
async function autopilotInput(clientId: string) {
  const db = runtime().DB;
  const [settings,global,latestGsc,latestGa,latestSerp,latestUber,keyword,insight,cannibal,mapping,source,metrics28,linkRows,learning] = await Promise.all([
    db.prepare("SELECT * FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>(),
    db.prepare("SELECT * FROM global_autopilot_settings WHERE id='global'").first<any>(),
    db.prepare("SELECT MAX(date) value FROM gsc_search_performance WHERE client_id=?").bind(clientId).first<any>(),
    db.prepare("SELECT MAX(date) value FROM ga4_page_performance WHERE client_id=?").bind(clientId).first<any>(),
    db.prepare("SELECT MAX(checked_at) value FROM serp_snapshots WHERE client_id=? AND status IN ('SUCCESS','COMPLETED')").bind(clientId).first<any>(),
    db.prepare("SELECT MAX(retrieved_at) value FROM snapshots WHERE client_id=? AND connector='ubersuggest'").bind(clientId).first<any>(),
    db.prepare("SELECT * FROM seo_keywords WHERE client_id=? AND status<>'archived' ORDER BY priority_score DESC LIMIT 1").bind(clientId).first<any>(),
    db.prepare("SELECT i.* FROM keyword_serp_insights i WHERE i.client_id=? ORDER BY analyzed_at DESC LIMIT 1").bind(clientId).first<any>(),
    db.prepare("SELECT * FROM cannibalization_assessments WHERE client_id=? ORDER BY created_at DESC LIMIT 1").bind(clientId).first<any>(),
    db.prepare("SELECT * FROM article_mapping_candidates WHERE client_id=? AND status IN ('APPROVED','MODIFIED') ORDER BY updated_at DESC LIMIT 1").bind(clientId).first<any>(),
    db.prepare("SELECT id FROM sources WHERE client_id=? AND approved=1 AND is_canonical=1 AND archived=0 LIMIT 1").bind(clientId).first<any>(),
    metricSummary(clientId,28),
    db.prepare("SELECT source_article_id,target_article_id,status FROM internal_link_candidates WHERE client_id=? AND status='APPROVED'").bind(clientId).all<any>(),
    db.prepare("SELECT a.action_type,COUNT(*) samples,AVG(CASE WHEN m.result_status='IMPROVED' THEN 1 ELSE 0 END) successRate FROM autopilot_measurements m JOIN autopilot_actions a ON a.id=m.action_id AND a.client_id=m.client_id WHERE m.client_id=? AND m.window_days IN (7,28) GROUP BY a.action_type").bind(clientId).all<any>(),
  ]);
  const prior = await (async()=>{const gsc=await db.prepare("SELECT COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND date>=? AND date<?").bind(clientId,isoDay(-56),isoDay(-28)).first<any>();return gsc||{};})();
  const keywordGsc=keyword?await db.prepare("SELECT COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND lower(query)=lower(?) AND date>=?").bind(clientId,keyword.keyword,isoDay(-27)).first<any>():null;
  const freshness = { gsc:freshnessStatus(latestGsc?.value ? `${latestGsc.value}T23:59:59Z` : null,48), ga4:freshnessStatus(latestGa?.value ? `${latestGa.value}T23:59:59Z` : null,48), serp:freshnessStatus(latestSerp?.value,8*24), ubersuggest:freshnessStatus(latestUber?.value,8*24) };
  const links=linkRows.results||[], articleId=mapping?.article_id || null, incoming=links.filter((x:any)=>x.target_article_id===articleId).length,outgoing=links.filter((x:any)=>x.source_article_id===articleId).length;
  const quality=articleId ? await db.prepare("SELECT q.total_score,v.status FROM article_versions v LEFT JOIN article_quality_reviews q ON q.article_version_id=v.id WHERE v.client_id=? AND v.article_id=? ORDER BY v.version_no DESC LIMIT 1").bind(clientId,articleId).first<any>() : null;
  const ymyl=articleId ? await db.prepare("SELECT y.risk FROM article_versions v LEFT JOIN article_ymyl_assessments y ON y.article_version_id=v.id WHERE v.client_id=? AND v.article_id=? ORDER BY v.version_no DESC LIMIT 1").bind(clientId,articleId).first<any>() : null;
  const learningByAction=Object.fromEntries((learning.results||[]).map((row:any)=>[String(row.action_type),{samples:Number(row.samples||0),successRate:Number(row.successRate||0)}]));
  return { settings:settings||{mode:"OFF",new_article_priority_mode:0,paused:0,weekly_action_limit:1,serp_refresh_limit:4,article_generation_limit:1}, global:global||{kill_switch_enabled:0}, freshness, keyword:keyword?{id:keyword.id,keyword:keyword.keyword,priorityScore:keyword.priority_score,position:keyword.current_position,topicId:keyword.topic_id,clusterId:keyword.cluster_id}: {}, gsc:{...metrics28,...(keywordGsc&&Number(keywordGsc.impressions)>0?keywordGsc:{}),positionDelta:Number(metrics28.position||0)-Number(prior.position||0),impressionsGrowth:Number(metrics28.impressions||0)-Number(prior.impressions||0)}, ga4:metrics28, serp:{searchIntent:insight?.search_intent||"DATA_NOT_AVAILABLE",contentGap:parse(insight?.missing_topics,[]).length>0,requiredTopics:parse(insight?.serp_consensus,{}).requiredTopics||[],intentChanged:false,competitorChanged:false}, ubersuggest:{status:freshness.ubersuggest,searchVolume:Number(keyword?.search_volume||0),seoDifficulty:Number(keyword?.keyword_difficulty||0),ranking:Number(keyword?.current_position||0)}, cannibalization:{risk:cannibal?.risk||"DATA_NOT_AVAILABLE",score:Number(cannibal?.score||0)}, article:{id:articleId,qualityScore:Number(quality?.total_score||0),ymylRisk:ymyl?.risk||"LOW",orphan:Boolean(articleId&&incoming+outgoing===0),hubCandidate:incoming+outgoing>=3,relatedArticleCount:links.filter((x:any)=>x.source_article_id===articleId||x.target_article_id===articleId).length,freshness:freshness.serp}, primarySourceReady:Boolean(source?.id), topicCoverage:keyword?.topic_id ? "DATA_NOT_AVAILABLE" : "DATA_NOT_AVAILABLE", newArticlePriorityMode:Boolean(settings?.new_article_priority_mode), learning:{byAction:learningByAction}, beforeMetrics:metrics28 };
}
async function saveAutopilotAudit(clientId:string,eventType:string,detail:unknown,runId:string|null=null,actionId:string|null=null){await runtime().DB.prepare("INSERT INTO autopilot_audit_log (id,client_id,run_id,action_id,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(id(),clientId,runId,actionId,eventType,JSON.stringify(detail),now()).run();}
async function queueAutopilotRefresh(clientId:string,input:any){const db=runtime().DB,stale=Object.entries(input.freshness||{}).filter(([,status])=>status!=="FRESH").map(([source])=>source),types:any[]=[];if(stale.includes("gsc"))types.push({type:"sync_google",payload:{connector:"gsc"}});if(stale.includes("ga4"))types.push({type:"sync_google",payload:{connector:"ga"}});if(stale.includes("ubersuggest"))types.push({type:"ubersuggest_sync",payload:{}});if(stale.includes("serp")&&input.keyword?.id)types.push({type:"serp_analyze",payload:{keywordId:input.keyword.id,keyword:input.keyword.keyword||""}});for(const item of types){const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type=? AND status IN ('queued','running') LIMIT 1").bind(clientId,item.type).first<any>();if(existing)continue;const stamp=now(),job={id:id(),client_id:clientId,type:item.type,status:"queued",payload:JSON.stringify(item.payload),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false).catch(()=>undefined);}return stale;}
async function runAutopilot(clientId:string,triggerType:string,manualRerun=false) {
  const db=runtime().DB, input=await autopilotInput(clientId), weekKey=autopilotWeek();
  if (Number(input.global.kill_switch_enabled)) return { status:"SKIPPED", reason:"GLOBAL_KILL_SWITCH", input };
  if (Number(input.settings.paused)) return { status:"SKIPPED", reason:"AUTOPILOT_PAUSED", input };
  if (triggerType==="CRON" && input.settings.mode==="OFF") return { status:"SKIPPED", reason:"AUTOPILOT_OFF", input };
  const runKey=manualRerun?`MANUAL:${id()}`:"WEEKLY";
  const existing= !manualRerun && await db.prepare("SELECT * FROM autopilot_runs WHERE client_id=? AND week_key=? AND run_key=?").bind(clientId,weekKey,runKey).first<any>();
  if(existing)return {status:"IDEMPOTENT",run:existing,input};
  const staleSources=await queueAutopilotRefresh(clientId,input), decision=evaluateWeeklyAutopilot(input), stamp=now(), runId=id();
  await db.prepare("INSERT INTO autopilot_runs (id,client_id,week_key,run_key,trigger_type,freshness_json,input_snapshot_json,result_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(runId,clientId,weekKey,runKey,triggerType,JSON.stringify(decision.freshness),JSON.stringify(input),JSON.stringify(decision),"COMPLETED",stamp).run();
  const priorAction=await db.prepare("SELECT * FROM autopilot_actions WHERE client_id=? AND week_key=?").bind(clientId,weekKey).first<any>();
  let action=priorAction;
  if(!priorAction){const candidate=decision.recommended, mode=String(input.settings.mode||"OFF"), isInternal=candidate.actionType==="INTERNAL_LINK", requiresHuman=Boolean(candidate.humanReview)||candidate.actionType==="TITLE_OPTIMIZATION", safe=["NEW_ARTICLE","REWRITE","EXPAND"].includes(candidate.actionType)&&!requiresHuman;const status=mode==="OFF"?"SKIPPED":requiresHuman?"HUMAN_REVIEW_REQUIRED":isInternal?"QUEUED":mode==="RECOMMEND_ONLY"?"RECOMMENDED":safe?"QUEUED":"SKIPPED";action={id:id(),client_id:clientId,run_id:runId,week_key:weekKey,action_type:candidate.actionType,target_keyword_id:input.keyword.id||null,target_article_id:input.article.id||null,target_topic_id:input.keyword.topicId||null,target_cluster_id:input.keyword.clusterId||null,reason_json:JSON.stringify({reason:candidate.reason,reasons:decision.reasons}),evidence_json:JSON.stringify(candidate.evidence||{}),expected_impact:decision.expectedImpact,confidence:decision.confidence,risk:candidate.risk,score:candidate.score,status,before_metrics_json:JSON.stringify(input.gsc),after_metrics_json:"{}",execution_result_json:"{}",created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO autopilot_actions (id,client_id,run_id,week_key,action_type,target_keyword_id,target_article_id,target_topic_id,target_cluster_id,reason_json,evidence_json,expected_impact,confidence,risk,score,status,before_metrics_json,after_metrics_json,execution_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(action.id,action.client_id,action.run_id,action.week_key,action.action_type,action.target_keyword_id,action.target_article_id,action.target_topic_id,action.target_cluster_id,action.reason_json,action.evidence_json,action.expected_impact,action.confidence,action.risk,action.score,action.status,action.before_metrics_json,action.after_metrics_json,action.execution_result_json,action.created_at,action.updated_at).run();if(status==="QUEUED"){const job={id:id(),client_id:clientId,type:"autopilot_execute",status:"queued",payload:JSON.stringify({actionId:action.id}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false).catch(()=>undefined);}}
  await db.prepare("INSERT INTO autopilot_measurements (id,client_id,action_id,window_days,metrics_json,result_status,measured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(action_id,window_days) DO NOTHING").bind(id(),clientId,action.id,0,JSON.stringify(input.gsc),"INSUFFICIENT_DATA",stamp).run();
  await db.prepare("INSERT INTO client_autopilot_settings (client_id,last_run_at,updated_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET last_run_at=excluded.last_run_at,updated_at=excluded.updated_at").bind(clientId,stamp,stamp).run();
  await saveAutopilotAudit(clientId,"WEEKLY_DECISION",{triggerType,decision,manualRerun,staleSources},runId,action.id);return {status:"COMPLETED",run:{id:runId,weekKey},action,decision,input,staleSources};
}
const dayList = (start: string, end: string) => {
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && result.length < 90) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
};
async function selectedGoogleResource(clientId: string, connector: "gsc" | "ga") {
  const row = await runtime().DB.prepare("SELECT public_config FROM connections WHERE client_id=? AND connector=? AND status='connected'").bind(clientId, connector).first<any>();
  const resourceId = String(parse(row?.public_config, {}).resourceId || "");
  if (!resourceId) throw new Error(connector === "gsc" ? "Search Consoleのプロパティが選択されていません。" : "GA4プロパティが選択されていません。");
  return resourceId;
}
async function syncGscHistory(clientId: string, request: Request) {
  const db = runtime().DB, resourceId = await selectedGoogleResource(clientId, "gsc");
  const latest = await db.prepare("SELECT MAX(date) AS date FROM gsc_search_performance WHERE client_id=?").bind(clientId).first<any>();
  const start = latest?.date ? (() => { const value = new Date(`${latest.date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() - 3); return value.toISOString().slice(0, 10); })() : isoDay(-90);
  const end = isoDay(-3);
  if (start > end) return { connector: "gsc", start, end, rows: 0, status: "UP_TO_DATE" };
  // Search Console accepts a date range.  Requesting every day separately used
  // more than a Worker invocation's subrequest budget on an initial 90-day sync.
  // Including date in dimensions retains the same date-granular D1 schema.
  const response = await googleApi(clientId, request, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(resourceId)}/searchAnalytics/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: start, endDate: end, dimensions: ["date", "query", "page"], rowLimit: 25000 }),
  });
  const rows = Array.isArray(response.rows) ? response.rows : [];
  let stored = 0;
  for (let index = 0; index < rows.length; index += 50) {
    const statements = rows.slice(index, index + 50).map((row: any) => {
      const date = String(row.keys?.[0] || ""), query = String(row.keys?.[1] || ""), page = String(row.keys?.[2] || "");
      return db.prepare("INSERT INTO gsc_search_performance (id,client_id,date,query,page,clicks,impressions,ctr,position,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,date,query,page) DO UPDATE SET clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr,position=excluded.position").bind(id(), clientId, date, query, page, Number(row.clicks || 0), Number(row.impressions || 0), Number(row.ctr || 0), row.position == null ? null : Number(row.position), now());
    });
    await db.batch(statements); stored += statements.length;
  }
  await log(clientId, "GSC履歴同期が完了", "info", { start, end, rows: stored });
  return { connector: "gsc", start, end, rows: stored, status: stored ? "synced" : "DATA_NOT_AVAILABLE" };
}
async function syncGa4History(clientId: string, request: Request) {
  const db = runtime().DB, resourceId = await selectedGoogleResource(clientId, "ga");
  const latest = await db.prepare("SELECT MAX(date) AS date FROM ga4_page_performance WHERE client_id=?").bind(clientId).first<any>();
  const start = latest?.date ? (() => { const value = new Date(`${latest.date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() - 3); return value.toISOString().slice(0, 10); })() : isoDay(-90);
  const end = isoDay(-1);
  if (start > end) return { connector: "ga", start, end, rows: 0, status: "UP_TO_DATE" };
  // GA4 returns one row per date when date is a dimension, so this keeps the
  // existing D1 grain while reducing a 90-day backfill to one report request.
  const response = await googleApi(clientId, request, `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(resourceId)}:runReport`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dateRanges: [{ startDate: start, endDate: end }], dimensions: [{ name: "date" }, { name: "landingPagePlusQueryString" }, { name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "keyEvents" }, { name: "totalRevenue" }], limit: 10000 }),
  });
  const headers = response.metricHeaders || [];
  const metric = (row: any, name: string) => Number(row.metricValues?.[headers.findIndex((header: any) => header.name === name)]?.value || 0);
  const rows = Array.isArray(response.rows) ? response.rows : [];
  let stored = 0;
  for (let index = 0; index < rows.length; index += 50) {
    const statements = rows.slice(index, index + 50).map((row: any) => {
      const values = row.dimensionValues || [], rawDate = String(values[0]?.value || ""), date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate, page = String(values[1]?.value || "(not set)"), channel = String(values[2]?.value || "(not set)"), sessions = metric(row, "sessions");
      return db.prepare("INSERT INTO ga4_page_performance (id,client_id,date,landing_page,source,medium,sessions,organic_sessions,engaged_sessions,engagement_rate,conversions,revenue,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,date,landing_page,source,medium) DO UPDATE SET sessions=excluded.sessions,organic_sessions=excluded.organic_sessions,engaged_sessions=excluded.engaged_sessions,engagement_rate=excluded.engagement_rate,conversions=excluded.conversions,revenue=excluded.revenue").bind(id(), clientId, date, page, channel, "(not set)", sessions, channel === "Organic Search" ? sessions : 0, metric(row, "engagedSessions"), metric(row, "engagementRate"), metric(row, "keyEvents"), metric(row, "totalRevenue"), now());
    });
    await db.batch(statements); stored += statements.length;
  }
  await log(clientId, "GA4履歴同期が完了", "info", { start, end, rows: stored });
  return { connector: "ga", start, end, rows: stored, status: stored ? "synced" : "DATA_NOT_AVAILABLE" };
}

async function wordpressInventory(clientId: string) {
  const db = runtime().DB;
  const row = await db
    .prepare(
      "SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'",
    )
    .bind(clientId)
    .first<any>();
  if (!row?.secret_cipher) return [];
  const config = parse(row.public_config, {});
  const secret = await decrypt<any>(row.secret_cipher);
  const base = wordpressBase(config.siteUrl);
  if (!base || !config.username || !secret.applicationPassword) return [];
  const authorization = `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}`;
  const posts: any[] = [];
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, 20); page++) {
    const response = await fetch(
      `${base}/wp-json/wp/v2/posts?status=publish&context=edit&per_page=100&page=${page}&_fields=id,date,modified,slug,link,title,excerpt,content,categories,tags`,
      {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      if (page > 1 && response.status === 400) break;
      throw new Error(
        `WordPressの記事取得に失敗しました（${response.status}）`,
      );
    }
    const batch = (await response.json()) as any[];
    totalPages = Math.max(
      1,
      Number(response.headers.get("X-WP-TotalPages") || 1),
    );
    posts.push(
      ...batch.map((post) => ({
        id: post.id,
        date: post.date,
        modified: post.modified,
        slug: post.slug,
        url: post.link,
        title: post.title?.rendered || "",
        excerpt: post.excerpt?.rendered || "",
        content: String(
          post.content?.raw || post.content?.rendered || "",
        ).slice(0, 6000),
        categories: post.categories || [],
        tags: post.tags || [],
      })),
    );
  }
  return posts;
}

async function wordpressMediaInventory(clientId: string) {
  const db = runtime().DB;
  const row = await db
    .prepare(
      "SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'",
    )
    .bind(clientId)
    .first<any>();
  if (!row?.secret_cipher) return [];
  const config = parse(row.public_config, {});
  const secret = await decrypt<any>(row.secret_cipher);
  const base = wordpressBase(config.siteUrl);
  if (!base || !config.username || !secret.applicationPassword) return [];
  const authorization = `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}`;
  const response = await fetch(
    `${base}/wp-json/wp/v2/media?status=inherit&media_type=image&context=edit&per_page=100&orderby=date&order=desc&_fields=id,date,slug,link,title,caption,alt_text,source_url,media_details`,
    {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new Error(`WordPressの画像取得に失敗しました（${response.status}）`);
  const media = (await response.json()) as any[];
  return media.map((item) => ({
    id: item.id,
    date: item.date,
    slug: item.slug,
    title: item.title?.rendered || "",
    caption: item.caption?.rendered || "",
    alt: item.alt_text || "",
    url: item.source_url || "",
    width: item.media_details?.width || null,
    height: item.media_details?.height || null,
  }));
}
async function wordpressCategoriesInventory(clientId: string) {
  const db = runtime().DB;
  const row = await db.prepare("SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'").bind(clientId).first<any>();
  if (!row?.secret_cipher) return [];
  const config = parse(row.public_config, {});
  const secret = await decrypt<any>(row.secret_cipher);
  const base = wordpressBase(config.siteUrl);
  if (!base || !config.username || !secret.applicationPassword) return [];
  const response = await fetch(`${base}/wp-json/wp/v2/categories?context=edit&per_page=100&orderby=count&order=desc&_fields=id,name,slug,count,parent`, { headers: { Authorization: `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`WordPressのカテゴリー取得に失敗しました（${response.status}）`);
  return (await response.json() as any[]).map((item) => ({ id: Number(item.id), name: text(item.name, 100), slug: text(item.slug, 100), count: Number(item.count || 0), parent: Number(item.parent || 0) }));
}

const text = (value: unknown, limit = 500) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
const binary = (base64: string) => {
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};
const imageBlock = (media: any) =>
  `<!-- wp:image {"id":${media.id},"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${media.url}" alt="${media.alt}" class="wp-image-${media.id}"/></figure>\n<!-- /wp:image -->`;
const removeExistingArticleImages = (html: string) =>
  String(html || "")
    .replace(/<!-- wp:image[\s\S]*?<!-- \/wp:image -->\s*/gi, "")
    .replace(/<figure\b[^>]*>[\s\S]*?<img\b[\s\S]*?<\/figure>\s*/gi, "")
    .replace(/<img\b[^>]*>\s*/gi, "");
function insertGeneratedImage(html: string, media: any, placement: string, ordinal: number) {
  const block = imageBlock(media);
  // Deterministic insertion avoids another Codex call just to place an asset.
  if (ordinal === 0) {
    const firstHeading = html.search(/<!-- wp:heading[\s\S]*?<!-- \/wp:heading -->/i);
    if (firstHeading >= 0) return `${html.slice(0, firstHeading)}${block}\n${html.slice(firstHeading)}`;
  }
  if (/faq|よくある質問/i.test(placement)) {
    const faq = html.search(/<!-- wp:heading[^>]*-->[\s\S]*?(?:FAQ|よくある質問)/i);
    if (faq >= 0) return `${html.slice(0, faq)}${block}\n${html.slice(faq)}`;
  }
  return `${html}\n${block}`;
}
function featuredImageBrief(article: any) {
  const title = text(article?.title, 180) || "この記事のテーマ";
  const intent = text(article?.search_intent, 300);
  return {
    prompt: `${title}を正確に表す、SEO記事のアイキャッチ用ビジュアル。記事テーマに直接関係する人物・道具・場面だけを使い、読者が内容を一目で理解できる構図にする。${intent ? ` 検索意図: ${intent}。` : ""}`,
    placement: "アイキャッチ用（記事冒頭）",
    alt: `${title}のアイキャッチ画像`,
    caption: title,
    description: `${title}の記事内容を補足するためにGPT Image 2で生成したアイキャッチ画像。`,
    benefit: "記事のテーマを本文を読む前に把握しやすくする。",
  };
}
function explanatoryImageBrief(article: any) {
  const title = text(article?.title, 180) || "この記事のテーマ";
  const intent = text(article?.search_intent, 300);
  return {
    prompt: `${title}の内容を読者が理解しやすくする、記事本文用の説明イラストまたは概念ビジュアル。工程・比較・判断ポイントのうち記事の中心となる一つを、文字を使わずに分かりやすく表現する。${intent ? ` 検索意図: ${intent}。` : ""}`,
    placement: "最初の主要見出しの直後",
    alt: `${title}の内容を説明する図解イメージ`,
    caption: `${title}の要点を視覚的に補足`,
    description: `${title}の本文理解を助けるためにGPT Image 2で生成した説明画像。`,
    benefit: "記事の要点や手順を視覚的に理解しやすくする。",
  };
}
function articleImageBriefs(article: any) {
  const supplied = Array.isArray(article?.image_brief) ? article.image_brief : [];
  // The first image is always a newly generated featured image.  Existing
  // WordPress media can still be used inside the article, but never replaces
  // the featured visual requested for this article.
  const featured = supplied.find((brief: any) => /アイキャッチ|featured|記事冒頭/i.test(String(brief?.placement || ""))) || supplied[0] || featuredImageBrief(article);
  const explanatory = supplied.find((brief: any) => brief !== featured) || explanatoryImageBrief(article);
  // Image briefs are generated only when they clarify an article section. Six
  // is a safety ceiling, not a per-article target; most articles use 2–4.
  return [featured, explanatory, ...supplied.filter((brief: any) => brief !== featured && brief !== explanatory)].slice(0, 6);
}
async function generateRequiredArticleImages(clientId: string, article: any) {
  const briefs = articleImageBriefs(article);
  const db = runtime().DB;
  const runnerUrl = String(runtime().CLOUD_RUNNER_URL || "").replace(/\/$/, "");
  const runnerToken = String(runtime().CLOUD_DISPATCH_TOKEN || "");
  const rows = await db
    .prepare(
      "SELECT connector,public_config,secret_cipher FROM connections WHERE client_id=? AND connector IN ('wordpress','image') AND status='connected'",
    )
    .bind(clientId)
    .all<any>();
  const wordpress = rows.results.find((row: any) => row.connector === "wordpress");
  const image = rows.results.find((row: any) => row.connector === "image");
  if (!wordpress?.secret_cipher || (!runnerUrl && !image?.secret_cipher))
    return {
      article,
      media: [],
      errors: [
        !wordpress?.secret_cipher && (!runnerUrl && !image?.secret_cipher)
          ? "WordPressとGPT Image 2が未接続です。"
          : !wordpress?.secret_cipher
            ? "WordPressが未接続です。"
            : "GPT Image 2が未接続です。Cloudflare WorkerへOPENAI_API_KEYを登録してください。",
      ],
    };
  const wp = parse(wordpress.public_config, {});
  const wpSecret = await decrypt<any>(wordpress.secret_cipher);
  const imageSecret = image?.secret_cipher ? await decrypt<any>(image.secret_cipher) : {};
  const base = wordpressBase(wp.siteUrl);
  const authorization = `Basic ${btoa(`${wp.username}:${wpSecret.applicationPassword}`)}`;
  if (!base || !wp.username || (!runnerUrl && !imageSecret.apiKey))
    return { article, media: [], errors: ["画像またはWordPressの接続設定が不足しています。"] };
  const media: any[] = [];
  const errors: string[] = [];
  // The client has requested Image 2 assets only.  Remove any legacy or model-
  // selected WordPress media before inserting the generated, article-specific set.
  let html = removeExistingArticleImages(String(article.html || ""));
  for (let index = 0; index < briefs.length; index++) {
    const brief = briefs[index] || {};
    try {
      const imagePrompt = `${text(brief.prompt, 3000)}\n用途: ${index === 0 ? "WordPressのアイキャッチ画像兼、記事冒頭の画像" : `記事本文の「${text(brief.placement, 160)}」を説明する画像`}。記事タイトル: ${text(article.title, 220)}。この記事の文脈だけを表現し、汎用的な会議・ノートPC・人物・無関係な商品画像にはしない。文字、ロゴ、透かし、根拠のない数値・実績表現、既存ブランドの画面や広告クリエイティブは入れない。読者へのベネフィット: ${text(brief.benefit, 400)}`;
      const generated = await fetch(runnerUrl ? `${runnerUrl}/images` : "https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: runnerUrl ? { "X-SEO-Loop-Dispatch": runnerToken, "Content-Type": "application/json" } : { Authorization: `Bearer ${imageSecret.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: imagePrompt,
          size: "1024x1024",
          quality: "low",
          output_format: "png",
          n: 1,
        }),
      });
      const generatedBody = (await generated.json().catch(() => ({}))) as any;
      const encoded = generatedBody.data?.[0]?.b64_json;
      if (!generated.ok || !encoded)
        throw new Error(generatedBody.error?.message || `GPT Image 2 (${generated.status})`);
      const title = text(`${article.title || "記事"} ${index === 0 ? "アイキャッチ画像" : `画像 ${index + 1}`}`, 120);
      const uploaded = await fetch(`${base}/wp-json/wp/v2/media`, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "image/png",
          "Content-Disposition": `attachment; filename="${text(article.slug || "seo-article", 70)}-${index === 0 ? "featured" : index + 1}.png"`,
        },
        body: binary(encoded),
      });
      const uploadedBody = (await uploaded.json().catch(() => ({}))) as any;
      if (!uploaded.ok || !uploadedBody.id)
        throw new Error(uploadedBody.message || `WordPress media upload (${uploaded.status})`);
      const metadata = {
        title,
        slug: `${text(article.slug || "seo-article", 70)}-${index === 0 ? "featured" : `image-${index + 1}`}`,
        alt_text: text(brief.alt, 180) || `${text(article.title, 140) || "記事"}を説明する画像`,
        // Captions are deliberately blank: the explanatory metadata stays in
        // WordPress's media description, not in the reader-facing article.
        caption: "",
        description: text(brief.description, 1000) || `${text(article.title, 180) || "記事"}の内容を補足するImage 2生成画像。`,
      };
      const updated = await fetch(`${base}/wp-json/wp/v2/media/${uploadedBody.id}`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      const updatedBody = (await updated.json().catch(() => uploadedBody)) as any;
      if (!updated.ok) throw new Error(updatedBody.message || `WordPress media metadata (${updated.status})`);
      const item = {
        id: uploadedBody.id,
        url: updatedBody.source_url || uploadedBody.source_url,
        alt: metadata.alt_text,
        caption: metadata.caption,
        description: metadata.description,
        benefit: text(brief.benefit, 400),
      };
      if (!item.url) throw new Error("WordPress画像URLを取得できませんでした。");
      html = insertGeneratedImage(html, item, String(brief.placement || ""), index);
      media.push(item);
    } catch (error: any) {
      errors.push(`画像${index + 1}: ${String(error.message || error).slice(0, 300)}`);
    }
  }
  return { article: { ...article, html }, media, errors };
}

const tokyoClock = () => {
  const value = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return {
    day: value.toISOString().slice(0, 10),
    hour: value.getUTCHours(),
    weekday: value.getUTCDay(),
  };
};
const tokyoDay = (value: string) =>
  new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

async function enqueueScheduledContentJobs(owner: string) {
  const db = runtime().DB;
  // Ubersuggest is a read-only data source. Keep a lightweight, regular
  // refresh independent from content automation so every registered client
  // retains a current dashboard even when article automation is off.
  const uberClients = await db
    .prepare("SELECT id,site FROM clients WHERE owner_id=? AND site IS NOT NULL AND site<>''")
    .bind(owner)
    .all<any>();
  const clock = tokyoClock();
  for (const client of uberClients.results) {
    const recent = await db
      .prepare("SELECT created_at FROM jobs WHERE client_id=? AND type='ubersuggest_sync' ORDER BY created_at DESC LIMIT 1")
      .bind(client.id)
      .first<any>();
    const lastRun = recent?.created_at ? new Date(recent.created_at).getTime() : 0;
    const due = !lastRun || Date.now() - lastRun >= 24 * 60 * 60 * 1000;
    // The worker's first poll after wake runs this check. If today's sync has
    // not happened, queue it immediately; otherwise do nothing. This keeps one
    // read-only refresh per day without depending on the Mac being awake at a
    // specific clock time.
    if (due) {
      const stamp = now();
      await db
        .prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id(), client.id, "ubersuggest_sync", "queued", JSON.stringify({ domain: client.site, scheduled: true }), null, 0, null, null, stamp, stamp)
        .run();
      await log(client.id, "Ubersuggestの日次実データ同期を予約");
    }
  }
  const rows = await db
    .prepare(
      "SELECT c.id,c.primary_info_status,x.public_config FROM clients c JOIN connections x ON x.client_id=c.id AND x.connector='content_automation' AND x.status='connected' WHERE c.owner_id=?",
    )
    .bind(owner)
    .all<any>();
  for (const row of rows.results) {
    const config = parse(row.public_config, {});
    if (!config.enabled) continue;
    const recent = await db
      .prepare(
        "SELECT type,created_at FROM jobs WHERE client_id=? AND type IN ('content_audit','keyword_strategy','monthly_report') ORDER BY created_at DESC LIMIT 30",
      )
      .bind(row.id)
      .all<any>();
    const latest = (type: string) =>
      recent.results.find((job: any) => job.type === type)?.created_at;
    const jobs: any[] = [];
    if (
      clock.hour >= Number(config.auditHour ?? 6) &&
      (!latest("content_audit") ||
        tokyoDay(latest("content_audit")) !== clock.day)
    )
      jobs.push({
        type: "content_audit",
        payload: {
          autoCreate: Boolean(config.autoCreateDrafts),
          maxRewrites: Number(config.maxRewrites || 2),
          primaryInfoStatus: row.primary_info_status,
        },
      });
    const lastStrategy = latest("keyword_strategy");
    const strategyDue =
      !lastStrategy ||
      Date.now() - new Date(lastStrategy).getTime() > 6.5 * 864e5;
    if (
      clock.weekday === Number(config.strategyDay ?? 1) &&
      clock.hour >= Number(config.strategyHour ?? 6) &&
      strategyDue
    )
      jobs.push({
        type: "keyword_strategy",
        payload: {
          autoCreate: Boolean(config.autoCreateDrafts),
          articleCount: Number(config.weeklyArticles || 3),
          defaultCategoryId: Number(config.defaultCategoryId || 0) || null,
          categoryRotation: Array.isArray(config.categoryRotation) ? config.categoryRotation : [],
          scheduleDays: Array.isArray(config.scheduleDays) ? config.scheduleDays : [],
          publishHour: Number(config.publishHour ?? 10),
          targetCharacters: 10000,
          primaryInfoStatus: row.primary_info_status,
        },
      });
    const lastReport = latest("monthly_report");
    if (
      clock.day.endsWith("-01") &&
      clock.hour >= Number(config.auditHour ?? 6) &&
      (!lastReport || tokyoDay(lastReport) !== clock.day)
    )
      jobs.push({
        type: "monthly_report",
        payload: { pdca: true, targetCharacters: 10000 },
      });
    for (const job of jobs) {
      const stamp = now();
      await db
        .prepare(
          "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id(),
          row.id,
          job.type,
          "queued",
          JSON.stringify(job.payload),
          null,
          0,
          null,
          null,
          stamp,
          stamp,
        )
        .run();
    }
  }
}

export async function GET(request: Request, context: Context) {
  try {
    await ensureSchema();
    const parts = (await context.params).path || [];
    const route = parts.join("/");
    if (route === "health") {
      try {
        await runtime().DB.prepare("SELECT 1 AS ok").first();
        return json({ ok: true, service: "SEO Loop Production", database: "ok", time: now() });
      } catch {
        return json({ ok: false, service: "SEO Loop Production", database: "unavailable", time: now() }, 503);
      }
    }
    if (route === "bootstrap") {
      const owner = await requireOwner(request);
      await stopStuckUbersuggestJobs(owner);
      await stopStuckAiJobs(owner);
      const cached = bootstrapCache.get(owner);
      if (cached && cached.expiresAt > Date.now()) return json(cached.payload);
      const env = runtime();
      const savedGoogle = await env.DB.prepare(
        "SELECT id,public_config,updated_at FROM app_settings WHERE owner_id=? AND setting_key='google_oauth'",
      )
        .bind(owner)
        .first<any>();
      const google = {
        configured: Boolean(
          (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) ||
          savedGoogle,
        ),
        redirectUri:
          env.GOOGLE_OAUTH_REDIRECT_URI ||
          parse(savedGoogle?.public_config, {}).redirectUri ||
          `${new URL(request.url).origin}/api/google/callback`,
        source: env.GOOGLE_OAUTH_CLIENT_ID
          ? "server"
          : savedGoogle
            ? "encrypted_settings"
            : null,
        updatedAt: savedGoogle?.updated_at || null,
      };
      const cloud = {
        anthropicConfigured: Boolean(env.ANTHROPIC_API_KEY),
        imageConfigured: Boolean(env.OPENAI_API_KEY),
        fileUploadsEnabled: Boolean(env.FILES),
      };
      const clients = (
        await env.DB.prepare(
          "SELECT * FROM clients WHERE owner_id = ? ORDER BY created_at",
        )
          .bind(owner)
          .all()
      ).results as any[];
      const ids = clients.map((c) => c.id);
      if (!ids.length)
        return json({
          clients: [],
          connections: [],
          jobs: [],
          sources: [],
          sourceFiles: [],
          logs: [],
          snapshots: [],
          workers: [],
          google,
          cloud,
        });
      const marks = ids.map(() => "?").join(",");
      const db = env.DB;
      const [
        connections,
        jobs,
        sources,
        primaryInfoVersions,
        sourceFiles,
        logsResult,
        snapshots,
        workers,
      ] = await Promise.all([
        db
          .prepare(
            `SELECT id,client_id,connector,status,public_config,checked_at,updated_at FROM connections WHERE client_id IN (${marks})`,
          )
          .bind(...ids)
          .all(),
        db
          .prepare(
            `SELECT * FROM jobs WHERE client_id IN (${marks}) ORDER BY created_at DESC LIMIT 100`,
          )
          .bind(...ids)
          .all(),
        db
          .prepare(
            `SELECT * FROM sources WHERE client_id IN (${marks}) AND archived=0 ORDER BY is_canonical DESC,updated_at DESC,created_at DESC`,
          )
          .bind(...ids)
          .all(),
        db.prepare(`SELECT * FROM primary_info_versions WHERE client_id IN (${marks}) ORDER BY created_at DESC LIMIT 100`).bind(...ids).all(),
        db
          .prepare(
            `SELECT id,client_id,name,content_type,size,rights_confirmed,status,created_at FROM source_files WHERE client_id IN (${marks}) ORDER BY created_at DESC`,
          )
          .bind(...ids)
          .all(),
        db
          .prepare(
            `SELECT * FROM logs WHERE client_id IN (${marks}) ORDER BY created_at DESC LIMIT 200`,
          )
          .bind(...ids)
          .all(),
        db
          .prepare(`SELECT * FROM snapshots WHERE client_id IN (${marks})`)
          .bind(...ids)
          .all(),
        db
          .prepare(
            `SELECT id,client_id,name,last_seen_at,created_at FROM worker_tokens WHERE client_id IN (${marks}) ORDER BY created_at DESC`,
          )
          .bind(...ids)
          .all(),
      ]);
      const payload = {
        clients,
        connections: connections.results.map((x: any) => ({
          ...x,
          public_config: parse(x.public_config, {}),
        })),
        jobs: jobs.results.map((x: any) => ({
          ...x,
          payload: parse(x.payload, {}),
          result: parse(x.result, null),
        })),
        sources: sources.results,
        primaryInfoVersions: primaryInfoVersions.results.map((row: any) => ({ ...row, interview: parse(row.interview_json, []) })),
        sourceFiles: sourceFiles.results,
        logs: logsResult.results,
        snapshots: snapshots.results.map((x: any) => ({
          ...x,
          data: parse(x.data, {}),
        })),
        workers: workers.results,
        google,
        cloud,
      };
      // Multiple open tabs can refresh together. A tiny owner-scoped cache
      // prevents that burst from overloading D1 without leaving the dashboard
      // stale after an action.
      bootstrapCache.set(owner, { expiresAt: Date.now() + 2000, payload });
      return json(payload);
    }
    if (route === "connectors")
      return json({
        fields: connectorFields,
        local: [],
        google: ["ga", "gsc", "drive", "youtube"],
        manual: ["note"],
      });
    const wordpressCategoriesRoute = route.match(/^clients\/([^/]+)\/wordpress\/categories$/);
    if (wordpressCategoriesRoute) {
      const owner = await requireOwner(request);
      const clientId = wordpressCategoriesRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      return json({ categories: await wordpressCategoriesInventory(clientId) });
    }
    const googleResourceRoute = route.match(
      /^clients\/([^/]+)\/google\/resources$/,
    );
    if (googleResourceRoute) {
      const owner = await requireOwner(request);
      const clientId = googleResourceRoute[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      return json({ ok: true, ...(await googleResources(clientId, request)) });
    }
    const autopilotRoute = route.match(/^clients\/([^/]+)\/autopilot$/);
    if (autopilotRoute) {
      const owner=await requireOwner(request),clientId=autopilotRoute[1];
      if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);
      const db=runtime().DB;
      const [settings,global,runs,actions,measurements,audit,input]=await Promise.all([
        db.prepare("SELECT * FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>(),
        db.prepare("SELECT * FROM global_autopilot_settings WHERE id='global'").first<any>(),
        db.prepare("SELECT * FROM autopilot_runs WHERE client_id=? ORDER BY created_at DESC LIMIT 20").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM autopilot_actions WHERE client_id=? ORDER BY created_at DESC LIMIT 20").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM autopilot_measurements WHERE client_id=? ORDER BY measured_at DESC LIMIT 100").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM autopilot_audit_log WHERE client_id=? ORDER BY created_at DESC LIMIT 100").bind(clientId).all<any>(),
        autopilotInput(clientId),
      ]);
      const [titleProposals,titleHistory,internalHistory]=await Promise.all([db.prepare("SELECT * FROM title_optimization_proposals WHERE client_id=? ORDER BY updated_at DESC").bind(clientId).all<any>(),db.prepare("SELECT * FROM title_optimization_history_v2 WHERE client_id=? ORDER BY created_at DESC").bind(clientId).all<any>(),db.prepare("SELECT h.*,sm.article_title source_title,tm.article_title target_title,sk.topic source_topic,tk.topic target_topic,sc.cluster source_cluster,tc.cluster target_cluster FROM internal_link_execution_history h LEFT JOIN article_mapping_candidates sm ON sm.client_id=h.client_id AND sm.article_id=h.source_article_id LEFT JOIN article_mapping_candidates tm ON tm.client_id=h.client_id AND tm.article_id=h.target_article_id LEFT JOIN (SELECT k.id,k.topic_id,t.name topic,c.name cluster FROM seo_keywords k LEFT JOIN topics t ON t.id=k.topic_id LEFT JOIN keyword_clusters c ON c.id=k.cluster_id) sk ON sk.id=sm.current_keyword_id LEFT JOIN (SELECT k.id,k.topic_id,t.name topic,c.name cluster FROM seo_keywords k LEFT JOIN topics t ON t.id=k.topic_id LEFT JOIN keyword_clusters c ON c.id=k.cluster_id) tk ON tk.id=tm.current_keyword_id WHERE h.client_id=? ORDER BY h.updated_at DESC").bind(clientId).all<any>()]);
      const parsedMeasurements=measurements.results.map((x:any)=>({...x,metrics:parse(x.metrics_json,{})})),titleActionIds=new Set(titleProposals.results.map((x:any)=>x.action_id)),internalActionIds=new Set(internalHistory.results.map((x:any)=>x.action_id));
      return json({ settings:settings||{mode:"OFF",new_article_priority_mode:0,paused:0,weekly_action_limit:1,serp_refresh_limit:4,article_generation_limit:1,last_run_at:null},global:{killSwitchEnabled:Boolean(global?.kill_switch_enabled)},freshness:input.freshness, recommended:actions.results[0]||null, actions:actions.results.map((x:any)=>({...x,reason:parse(x.reason_json,{}),evidence:parse(x.evidence_json,{}),beforeMetrics:parse(x.before_metrics_json,{}),afterMetrics:parse(x.after_metrics_json,{}),executionResult:parse(x.execution_result_json,{})})), titleProposals:titleProposals.results.map((x:any)=>({...x,targetQueries:parse(x.target_queries_json,[]),evidence:parse(x.evidence_json,[]),beforeMetrics:parse(x.before_metrics_json,{})})), titleHistory:titleHistory.results.map((x:any)=>({...x,targetQueries:parse(x.target_queries_json,[]),evidence:parse(x.evidence_json,[])})), titleMeasurements:parsedMeasurements.filter((x:any)=>titleActionIds.has(x.action_id)), internalLinkHistory:internalHistory.results.map((x:any)=>({...x,result:parse(x.result_json,{}),safetyNotes:parse(x.result_json,{}).safety_notes||"DATA_NOT_AVAILABLE"})), internalLinkMeasurements:parsedMeasurements.filter((x:any)=>internalActionIds.has(x.action_id)), runs:runs.results.map((x:any)=>({...x,freshness:parse(x.freshness_json,{}),result:parse(x.result_json,{})})), measurements:parsedMeasurements, audit:audit.results.map((x:any)=>({...x,detail:parse(x.detail_json,{})})) });
    }
    const seoMapRoute = route.match(/^clients\/([^/]+)\/seo-map$/);
    const linkGraphRoute = route.match(/^clients\/([^/]+)\/link-graph$/);
    if (linkGraphRoute) {
      const owner = await requireOwner(request), clientId = linkGraphRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const rows = (await runtime().DB.prepare("SELECT m.article_id,m.article_title,m.article_url,k.keyword primary_keyword,k.topic_id,k.cluster_id,t.name topic,c.name cluster,(SELECT status FROM article_versions v WHERE v.client_id=m.client_id AND v.article_id=m.article_id ORDER BY version_no DESC LIMIT 1) current_status,(SELECT COUNT(*) FROM internal_link_candidates l WHERE l.client_id=? AND l.target_article_id=m.article_id AND l.status='APPROVED') incoming,(SELECT COUNT(*) FROM internal_link_candidates l WHERE l.client_id=? AND l.source_article_id=m.article_id AND l.status='APPROVED') outgoing,(SELECT COUNT(*) FROM keyword_article_relations r WHERE r.article_id=m.article_id) keyword_count FROM article_mapping_candidates m LEFT JOIN seo_keywords k ON k.id=m.current_keyword_id LEFT JOIN topics t ON t.id=k.topic_id LEFT JOIN keyword_clusters c ON c.id=k.cluster_id WHERE m.client_id=? AND m.status IN ('APPROVED','MODIFIED')").bind(clientId, clientId, clientId).all<any>()).results;
      const related = (row: any) => rows.filter((candidate: any) => candidate.article_id !== row.article_id && (candidate.topic_id === row.topic_id || candidate.cluster_id === row.cluster_id));
      const articles = rows.map((row: any) => {
        const incoming = Number(row.incoming), outgoing = Number(row.outgoing), relatedArticles = related(row);
        const orphanReasons = [
          ...(incoming === 0 ? ["NO_INCOMING_LINK"] : []),
          ...(outgoing === 0 ? ["NO_OUTGOING_LINK"] : []),
          ...(relatedArticles.some((item: any) => item.topic_id === row.topic_id) ? ["RELATED_ARTICLES_EXIST_IN_TOPIC"] : []),
          ...(relatedArticles.some((item: any) => item.cluster_id === row.cluster_id) ? ["RELATED_ARTICLES_EXIST_IN_CLUSTER"] : []),
        ];
        const hubReasons = [
          ...(Number(row.keyword_count) > 1 ? ["RELATED_KEYWORD_COUNT"] : []),
          ...(incoming > 0 ? ["INCOMING_LINK_COUNT"] : []),
          ...(outgoing > 0 ? ["OUTGOING_LINK_COUNT"] : []),
          ...(row.topic_id ? ["TOPIC_RELEVANCE"] : []),
          ...(row.cluster_id ? ["CLUSTER_RELEVANCE"] : []),
        ];
        return { ...row, incoming, outgoing, orphan: incoming + outgoing === 0 && relatedArticles.length > 0, orphanReasons, hubCandidate: hubReasons.length >= 4, hubReasons };
      });
      const aggregate = (key: "topic" | "cluster") => Object.values(articles.reduce((groups: Record<string, any>, article: any) => {
        const name = article[key] || "未分類", current = groups[name] || { name, articleCount: 0, keywordIds: new Set<string>(), incoming: 0, outgoing: 0, orphans: 0, hubs: 0 };
        current.articleCount += 1; current.keywordIds.add(article.primary_keyword || article.article_id); current.incoming += article.incoming; current.outgoing += article.outgoing; current.orphans += article.orphan ? 1 : 0; current.hubs += article.hubCandidate ? 1 : 0; groups[name] = current; return groups;
      }, {})).map((item: any) => ({ ...item, keywordCount: item.keywordIds.size, keywordIds: undefined, coverage: item.articleCount ? Math.round((item.articleCount - item.orphans) * 100 / item.articleCount) : 0 }));
      return json({ articles, topics: aggregate("topic"), clusters: aggregate("cluster") });
    }
    const contentIntelligenceRoute = route.match(/^clients\/([^/]+)\/content-intelligence\/([^/]+)$/);
    if (contentIntelligenceRoute) {
      const owner=await requireOwner(request), clientId=contentIntelligenceRoute[1], articleId=contentIntelligenceRoute[2];
      if (!(await ownedClient(clientId,owner))) return json({error:"クライアントが見つかりません。"},404);
      const db=runtime().DB, versions=await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC").bind(clientId,articleId).all<any>();
      const version=versions.results[0]; if(!version) return json({versions:[],claims:[],sources:[],eeat:null,ymyl:null,review:null,links:[],quality:null,graph:{incoming:0,outgoing:0,orphan:false,hubCandidate:false}});
      const [claims,sources,eeat,ymyl,review,links,quality,graph]=await Promise.all([
        db.prepare("SELECT * FROM content_claims WHERE client_id=? AND article_version_id=? ORDER BY paragraph_index").bind(clientId,version.id).all<any>(),
        db.prepare("SELECT s.* FROM claim_sources s JOIN content_claims c ON c.id=s.claim_id WHERE s.client_id=? AND c.article_version_id=?").bind(clientId,version.id).all<any>(),
        db.prepare("SELECT * FROM article_eeat_assessments WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>(),db.prepare("SELECT * FROM article_ymyl_assessments WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>(),db.prepare("SELECT * FROM human_review_queue WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>(),db.prepare("SELECT * FROM internal_link_candidates WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).all<any>(),db.prepare("SELECT * FROM article_quality_reviews WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>(),db.prepare("SELECT COUNT(*) incoming,(SELECT COUNT(*) FROM internal_link_candidates WHERE client_id=? AND article_version_id=?) outgoing").bind(clientId,version.id,clientId,version.id).first<any>(),
      ]);
      const reviewEvents=await db.prepare("SELECT e.*,v.version_no,q.reason_codes_json FROM human_review_events e JOIN article_versions v ON v.id=e.article_version_id LEFT JOIN human_review_queue q ON q.id=e.review_id WHERE e.client_id=? AND v.article_id=? ORDER BY e.created_at DESC").bind(clientId,articleId).all<any>(),statusHistory=await db.prepare("SELECT h.*,v.version_no FROM article_status_history h JOIN article_versions v ON v.id=h.article_version_id WHERE h.client_id=? AND v.article_id=? ORDER BY h.changed_at").bind(clientId,articleId).all<any>();
      const [publishing,history,snapshots,redirects,seoData]=await Promise.all([publishEligibility(clientId,version.id),db.prepare("SELECT * FROM wordpress_publish_history WHERE client_id=? AND article_id=? ORDER BY created_at DESC").bind(clientId,articleId).all<any>(),db.prepare("SELECT * FROM wordpress_article_versions WHERE client_id=? AND article_id=? ORDER BY captured_at DESC").bind(clientId,articleId).all<any>(),db.prepare("SELECT * FROM redirect_recommendations WHERE client_id=? AND article_id=? ORDER BY created_at DESC").bind(clientId,articleId).all<any>(),db.prepare("SELECT * FROM article_seo_data WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>()]);
      return json({versions:versions.results.map((row:any)=>({...row,article:parse(row.draft_json,{})})),claims:claims.results,sources:sources.results,eeat:{...eeat,missingEvidence:parse(eeat?.missing_evidence_json,[])},ymyl:{...ymyl,requiredReviews:parse(ymyl?.required_reviews_json,[])},review:{...review,reasonCodes:parse(review?.reason_codes_json,[])},reviewEvents:reviewEvents.results.map((event:any)=>({...event,reasonCodes:parse(event.reason_codes_json,[])})),statusHistory:statusHistory.results,links:links.results,quality:{...quality,breakdown:parse(quality?.breakdown_json,{}),reasons:parse(quality?.reasons_json,[])},graph:{incoming:Number(graph?.incoming||0),outgoing:Number(graph?.outgoing||0),orphan:Number(graph?.incoming||0)+Number(graph?.outgoing||0)===0,hubCandidate:Number(graph?.incoming||0)>=3},publishing, publishHistory:history.results, wordpressSnapshots:snapshots.results, redirects:redirects.results, seoData});
    }
    const serpIntelligenceRoute = route.match(/^clients\/([^/]+)\/serp-intelligence$/);
    if (serpIntelligenceRoute) {
      const owner = await requireOwner(request), clientId = serpIntelligenceRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const db = runtime().DB;
      const [snapshots, results, analyses, insights, decisions, cannibals] = await Promise.all([
        db.prepare("SELECT s.*,k.keyword FROM serp_snapshots s JOIN seo_keywords k ON k.id=s.keyword_id WHERE s.client_id=? ORDER BY s.checked_at DESC LIMIT 30").bind(clientId).all<any>(),
        db.prepare("SELECT r.* FROM serp_results r JOIN serp_snapshots s ON s.id=r.snapshot_id WHERE r.client_id=? ORDER BY r.snapshot_id,r.rank LIMIT 300").bind(clientId).all<any>(),
        db.prepare("SELECT a.* FROM competitor_page_analysis a WHERE a.client_id=? ORDER BY a.created_at DESC LIMIT 300").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM keyword_serp_insights WHERE client_id=? ORDER BY analyzed_at DESC LIMIT 30").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM content_decisions WHERE client_id=? ORDER BY created_at DESC LIMIT 30").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM cannibalization_assessments WHERE client_id=? ORDER BY created_at DESC LIMIT 30").bind(clientId).all<any>(),
      ]);
      return json({ snapshots: snapshots.results.map((row:any) => ({ ...row, raw_data: undefined })), results: results.results, analyses: analyses.results.map((row:any) => ({ ...row, headings: parse(row.headings_json, []), coveredTopics: parse(row.covered_topics_json, []), uniqueTopics: parse(row.unique_topics_json, []), questions: parse(row.questions_json, []), analysis: parse(row.analysis_json, {}) })), insights: insights.results.map((row:any) => ({ ...row, comparisonAxes: parse(row.comparison_axes, []), missingTopics: parse(row.missing_topics, []), weakCompetitorTopics: parse(row.weak_competitor_topics, []), differentiationOpportunities: parse(row.differentiation_opportunities, []), serpConsensus: parse(row.serp_consensus, {}) })), decisions: decisions.results, cannibalization: cannibals.results });
    }
    const mappingRoute = route.match(/^clients\/([^/]+)\/article-mappings$/);
    if (mappingRoute) {
      const owner = await requireOwner(request), clientId = mappingRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const rows = await runtime().DB.prepare("SELECT * FROM article_mapping_candidates WHERE client_id=? ORDER BY updated_at DESC").bind(clientId).all<any>();
      return json({ candidates: rows.results });
    }
    const weightsRoute = route.match(/^clients\/([^/]+)\/priority-weights$/);
    if (weightsRoute) {
      const owner = await requireOwner(request), clientId = weightsRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const setting = await runtime().DB.prepare("SELECT * FROM client_priority_weights WHERE client_id=?").bind(clientId).first<any>();
      return json({ weights: { ...defaultPriorityWeights, ...parse(setting?.weights_json, {}) }, highConfidenceThreshold: Number(setting?.high_confidence_threshold ?? .9), mediumConfidenceThreshold: Number(setting?.medium_confidence_threshold ?? .7), updatedAt: setting?.updated_at || null });
    }
    if (seoMapRoute) {
      const owner = await requireOwner(request), clientId = seoMapRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const db = runtime().DB;
      const [topics, clusters, keywords, relations, briefs, weightSetting, gsc, ga4] = await Promise.all([
        db.prepare("SELECT * FROM topics WHERE client_id=? ORDER BY name").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM keyword_clusters WHERE client_id=? ORDER BY name").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM seo_keywords WHERE client_id=? ORDER BY priority_score DESC,keyword").bind(clientId).all<any>(),
        db.prepare("SELECT r.* FROM keyword_article_relations r JOIN seo_keywords k ON k.id=r.keyword_id WHERE k.client_id=?").bind(clientId).all<any>(),
        db.prepare("SELECT * FROM content_briefs WHERE client_id=? ORDER BY updated_at DESC").bind(clientId).all<any>(),
        db.prepare("SELECT weights_json FROM client_priority_weights WHERE client_id=?").bind(clientId).first<any>(),
        db.prepare("SELECT SUM(clicks) clicks,SUM(impressions) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND date>=?").bind(clientId, isoDay(-28)).first<any>(),
        db.prepare("SELECT SUM(organic_sessions) organic_sessions,SUM(conversions) conversions,SUM(revenue) revenue FROM ga4_page_performance WHERE client_id=? AND date>=?").bind(clientId, isoDay(-28)).first<any>(),
      ]);
      const covered = new Set(relations.results.filter((item: any) => Number(item.confidence) >= 0.7).map((item: any) => item.keyword_id));
      const enrich = (items: any[], field: string, value: string) => { const ks = items.filter((item: any) => item[field] === value); const coveredKeywords = ks.filter((item: any) => covered.has(item.id)).length; const articleIds = new Set(relations.results.filter((item: any) => ks.some((keyword: any) => keyword.id === item.keyword_id) && Number(item.confidence) >= .7).map((item: any) => item.article_id)); return { targetKeywords: ks.length, coveredKeywords, missingKeywords: Math.max(0, ks.length - coveredKeywords), publishedArticles: articleIds.size, coverage: topicCoverage(ks.length, coveredKeywords) }; };
      const enrichedTopics = topics.results.map((topic: any) => ({ ...topic, ...enrich(keywords.results, "topic_id", topic.id) }));
      const enrichedClusters = clusters.results.map((cluster: any) => ({ ...cluster, ...enrich(keywords.results, "cluster_id", cluster.id) }));
      const clientWeights = { ...defaultPriorityWeights, ...parse(weightSetting?.weights_json, {}) };
      return json({ topics: enrichedTopics, clusters: enrichedClusters, keywords: keywords.results.map((item:any) => ({ ...item, priority_breakdown: priorityBreakdown(item, clientWeights) })), relations: relations.results, briefs: briefs.results, performance: { period: "28d", gsc, ga4 } });
    }
    const seoPerformanceRoute = route.match(/^clients\/([^/]+)\/seo-performance$/);
    if (seoPerformanceRoute) {
      const owner = await requireOwner(request), clientId = seoPerformanceRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const requested = Number(new URL(request.url).searchParams.get("days"));
      const days = [7, 28, 90].includes(requested) ? requested : 28, since = isoDay(-(days - 1)), db = runtime().DB;
      const [gsc, ga4, topQueries, topPages, organicPages] = await Promise.all([
        db.prepare("SELECT COALESCE(SUM(clicks),0) clicks,COALESCE(SUM(impressions),0) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position,COUNT(*) rows FROM gsc_search_performance WHERE client_id=? AND date>=?").bind(clientId, since).first<any>(),
        db.prepare("SELECT COALESCE(SUM(organic_sessions),0) organic_sessions,COALESCE(SUM(engaged_sessions),0) engaged_sessions,CASE WHEN SUM(organic_sessions)>0 THEN SUM(engaged_sessions)*1.0/SUM(organic_sessions) ELSE 0 END engagement_rate,COALESCE(SUM(conversions),0) conversions,COALESCE(SUM(revenue),0) revenue,COUNT(*) rows FROM ga4_page_performance WHERE client_id=? AND date>=?").bind(clientId, since).first<any>(),
        db.prepare("SELECT query,SUM(clicks) clicks,SUM(impressions) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND date>=? GROUP BY query ORDER BY clicks DESC,impressions DESC LIMIT 20").bind(clientId, since).all<any>(),
        db.prepare("SELECT page,SUM(clicks) clicks,SUM(impressions) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND date>=? GROUP BY page ORDER BY clicks DESC,impressions DESC LIMIT 20").bind(clientId, since).all<any>(),
        db.prepare("SELECT landing_page,SUM(organic_sessions) organic_sessions,SUM(engaged_sessions) engaged_sessions,SUM(conversions) conversions,SUM(revenue) revenue FROM ga4_page_performance WHERE client_id=? AND date>=? GROUP BY landing_page ORDER BY organic_sessions DESC LIMIT 20").bind(clientId, since).all<any>(),
      ]);
      return json({ period: `${days}d`, since, gsc: { ...gsc, status: Number(gsc?.rows || 0) ? "ready" : "DATA_NOT_AVAILABLE" }, ga4: { ...ga4, status: Number(ga4?.rows || 0) ? "ready" : "DATA_NOT_AVAILABLE" }, topQueries: topQueries.results, topPages: topPages.results, organicPages: organicPages.results });
    }
    if (route === "google/callback") return await googleCallback(request);
    if (route === "ubersuggest/callback") return await ubersuggestCallback(request);
    if (route === "worker/poll") {
      const registered = await worker(request);
      if (!registered)
        return json({ error: "ワーカートークンが無効です。" }, 401);
      const db = runtime().DB;
      const anchor = await db
        .prepare("SELECT owner_id FROM clients WHERE id=?")
        .bind(registered.client_id)
        .first<any>();
      if (!anchor)
        return json(
          { error: "ワーカーの登録先が見つかりません。再登録してください。" },
          401,
        );
      await enqueueScheduledContentJobs(anchor.owner_id);
      await stopStuckUbersuggestJobs(anchor.owner_id);
      await stopStuckAiJobs(anchor.owner_id);
      await db
        .prepare(
          "UPDATE jobs SET status='queued',lease_until=NULL,updated_at=? WHERE client_id IN (SELECT id FROM clients WHERE owner_id=?) AND status='running' AND lease_until<? AND attempts<3",
        )
        .bind(now(), anchor.owner_id, now())
        .run();
      const requestedJobId = new URL(request.url).searchParams.get("jobId");
      const jobQuery = requestedJobId
        ? "SELECT j.* FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.id=? AND j.status='queued' AND j.type IN ('ubersuggest_sync','article_generate','content_intelligence_review','title_optimize','internal_link_analyze','internal_link_update','wordpress_seo_plugin_sync','monthly_report','aio_observe','primary_info_assist','keyword_strategy','content_audit','wordpress_verify','wordpress_publish','wordpress_rollback','sync_google','article_mapping_analyze','serp_analyze','serp_competitor_analyze','autopilot_execute') AND (json_extract(j.payload,'$.scheduledFor') IS NULL OR json_extract(j.payload,'$.scheduledFor')<=?) LIMIT 1"
        : "SELECT j.* FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.status='queued' AND j.type IN ('ubersuggest_sync','article_generate','content_intelligence_review','title_optimize','internal_link_analyze','internal_link_update','wordpress_seo_plugin_sync','monthly_report','aio_observe','primary_info_assist','keyword_strategy','content_audit','wordpress_verify','wordpress_publish','wordpress_rollback','sync_google','article_mapping_analyze','serp_analyze','serp_competitor_analyze','autopilot_execute') AND (json_extract(j.payload,'$.scheduledFor') IS NULL OR json_extract(j.payload,'$.scheduledFor')<=?) ORDER BY j.created_at LIMIT 1";
      const job = await db
        .prepare(jobQuery)
        .bind(...(requestedJobId ? [anchor.owner_id, requestedJobId, now()] : [anchor.owner_id, now()]))
        .first<any>();
      await db
        .prepare("UPDATE worker_tokens SET last_seen_at = ? WHERE id = ?")
        .bind(now(), registered.id)
        .run();
      if (!job) return json({ job: null });
      const lease = new Date(Date.now() + 45 * 60 * 1000).toISOString();
      await db
        .prepare(
          "UPDATE jobs SET status='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'",
        )
        .bind(lease, now(), job.id)
        .run();
      const [client, sources, sourceFiles, snapshots, wordpressConnection, anthropicConnection, serpContext] = await Promise.all([
        db
          .prepare(
            "SELECT id,name,site,niche,primary_info_status FROM clients WHERE id=?",
          )
          .bind(job.client_id)
          .first(),
        db
          .prepare(
            "SELECT id,type,title,note,url,rights,approved,is_canonical,archived,canonical_status,created_at,updated_at FROM sources WHERE client_id=? ORDER BY is_canonical DESC,updated_at DESC,created_at DESC LIMIT 100",
          )
          .bind(job.client_id)
          .all(),
        db
          .prepare(
            "SELECT id,object_key,name,content_type,size,rights_confirmed,status FROM source_files WHERE client_id=? AND status='uploaded' ORDER BY created_at DESC LIMIT 5",
          )
          .bind(job.client_id)
          .all(),
        db
          .prepare(
            "SELECT connector,data,retrieved_at FROM snapshots WHERE client_id=?",
          )
          .bind(job.client_id)
          .all(),
        ["wordpress_verify","wordpress_publish","wordpress_rollback","wordpress_seo_plugin_sync","internal_link_update"].includes(job.type)
          ? db.prepare("SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress'").bind(job.client_id).first<any>()
          : Promise.resolve(null),
        db.prepare("SELECT secret_cipher FROM connections WHERE client_id=? AND connector='anthropic' AND status='connected'").bind(job.client_id).first<any>(),
        job.type === "serp_competitor_analyze" ? db.prepare("SELECT s.id snapshot_id,s.keyword_id,k.keyword FROM serp_snapshots s JOIN seo_keywords k ON k.id=s.keyword_id WHERE s.id=? AND s.client_id=?").bind(String(parse(job.payload, {}).snapshotId || ""), job.client_id).first<any>() : Promise.resolve(null),
      ]);
      // Do not stream uploaded bytes into an AI prompt as base64. It is not a
      // usable representation for PDF/Office/image files and can make one
      // small interview wait minutes. The worker receives metadata only until
      // a dedicated text-extraction path provides verified text evidence.
      const files = [] as any[];
      if (job.type === "primary_info_assist" && runtime().FILES)
        for (const item of sourceFiles.results as any[]) {
          // Keep the R2 object private and verify its reference without
          // materialising its bytes in the model request.
          if (!(await runtime().FILES!.get(item.object_key))) continue;
          files.push({
            id: item.id,
            objectKey: item.object_key,
            name: item.name,
            contentType: item.content_type,
            size: item.size,
            rightsConfirmed: Boolean(item.rights_confirmed),
          });
        }
      let wordpressPosts: any[] = [];
      let wordpressMedia: any[] = [];
      let wordpressCategories: any[] = [];
      if (
        ["article_generate", "content_intelligence_review", "keyword_strategy", "content_audit", "aio_observe", "article_mapping_analyze", "serp_competitor_analyze"].includes(
          job.type,
        )
      )
        try {
          [wordpressPosts, wordpressMedia, wordpressCategories] = await Promise.all([
            wordpressInventory(job.client_id),
            job.type === "article_generate"
              ? wordpressMediaInventory(job.client_id)
              : Promise.resolve([]),
            ["article_generate", "keyword_strategy"].includes(job.type)
              ? wordpressCategoriesInventory(job.client_id)
              : Promise.resolve([]),
          ]);
        } catch (error: any) {
          await log(
            job.client_id,
            "WordPress記事一覧を取得できませんでした",
            "warn",
            { error: String(error.message || error).slice(0, 500) },
          );
        }
      let cannibalization: any = {};
      if (job.type === "serp_competitor_analyze" && serpContext) {
        const [keyword, relations, candidates, gsc] = await Promise.all([
          db.prepare("SELECT id,keyword,search_intent,topic_id,cluster_id FROM seo_keywords WHERE id=? AND client_id=?").bind(serpContext.keyword_id, job.client_id).first<any>(),
          db.prepare("SELECT * FROM keyword_article_relations WHERE keyword_id=? AND client_id=?").bind(serpContext.keyword_id, job.client_id).all<any>(),
          db.prepare("SELECT * FROM article_mapping_candidates WHERE client_id=? AND suggested_keyword_id=? ORDER BY updated_at DESC LIMIT 50").bind(job.client_id, serpContext.keyword_id).all<any>(),
          db.prepare("SELECT query,SUM(clicks) clicks,SUM(impressions) impressions,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND lower(query)=lower(?) GROUP BY query LIMIT 10").bind(job.client_id, serpContext.keyword).all<any>(),
        ]);
        cannibalization = { keyword, keywordArticleRelations: relations.results, articleMappings: candidates.results, gscQuery: gsc.results, existingArticles: wordpressPosts.map((post:any) => ({ id: post.id, title: post.title, url: post.url, excerpt: post.excerpt || "" })).slice(0,100) };
      }
      const jobPayload=parse(job.payload,{});
      // A primary-information interview is a sequence. Keep the submitted
      // answers as structured, bounded context instead of asking the model to
      // reconstruct a conversation from its own prose summary.
      const primaryInterviewHistory = job.type === "primary_info_assist"
        ? (await db.prepare("SELECT payload FROM jobs WHERE client_id=? AND type='primary_info_assist' AND status='completed' AND id<>? ORDER BY created_at ASC LIMIT 20").bind(job.client_id, job.id).all<any>()).results
            .map((row: any) => parse(row.payload, {})?.answers || {})
            .map((answers: any) => ({
              questionKey: String(answers.questionKey || "").slice(0, 40),
              askedQuestion: String(answers.askedQuestion || "").slice(0, 600),
              message: String(answers.message || "").slice(0, 2500),
            }))
            .filter((answers: any) => answers.questionKey && answers.message)
        : [];
      const persistedBrief=["article_generate","content_intelligence_review"].includes(job.type) ? (await db.prepare("SELECT b.* FROM content_briefs b LEFT JOIN seo_keywords k ON k.id=b.keyword_id WHERE b.client_id=? AND (b.keyword_id=? OR lower(k.keyword)=lower(?)) ORDER BY CASE WHEN b.keyword_id=? THEN 0 ELSE 1 END,b.updated_at DESC LIMIT 1").bind(job.client_id,String(jobPayload.keywordId||""),String(jobPayload.keyword||""),String(jobPayload.keywordId||"")).first<any>()) : {};
      if(job.type==="article_generate"&&!completeContentBrief(persistedBrief)) return json({error:"CONTENT_BRIEF_INCOMPLETE",code:"CONTENT_BRIEF_INCOMPLETE",jobId:job.id},422);
      const revisionSource=job.type==="article_generate"&&jobPayload.revisionOfVersionId?await db.prepare("SELECT draft_json FROM article_versions WHERE id=? AND client_id=?").bind(String(jobPayload.revisionOfVersionId),job.client_id).first<any>():null;
      const revisionInstruction=job.type==="article_generate"&&jobPayload.revisionInstructionId?await db.prepare("SELECT instruction_json FROM article_revision_instructions WHERE id=? AND client_id=?").bind(String(jobPayload.revisionInstructionId),job.client_id).first<any>():null;
      const titleAction=job.type==="title_optimize"?await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=? AND action_type='TITLE_OPTIMIZATION'").bind(String(jobPayload.actionId||""),job.client_id).first<any>():null;
      const titleVersion=titleAction?await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC LIMIT 1").bind(job.client_id,titleAction.target_article_id).first<any>():null;
      const titleSeo=titleVersion?await db.prepare("SELECT * FROM article_seo_data WHERE client_id=? AND article_version_id=?").bind(job.client_id,titleVersion.id).first<any>():null;
      const titleKeyword=titleAction?.target_keyword_id?await db.prepare("SELECT keyword,search_intent FROM seo_keywords WHERE id=? AND client_id=?").bind(titleAction.target_keyword_id,job.client_id).first<any>():null;
      const titleGsc=titleKeyword?await db.prepare("SELECT query,SUM(clicks) clicks,SUM(impressions) impressions,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)*1.0/SUM(impressions) ELSE 0 END ctr,AVG(position) position FROM gsc_search_performance WHERE client_id=? AND lower(query)=lower(?) GROUP BY query LIMIT 20").bind(job.client_id,titleKeyword.keyword).all<any>():{results:[]};
      const internalAction=["internal_link_analyze","internal_link_update"].includes(job.type)?await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=? AND action_type='INTERNAL_LINK'").bind(String(jobPayload.actionId||""),job.client_id).first<any>():null;
      const internalCandidate=internalAction?await db.prepare("SELECT * FROM internal_link_candidates WHERE client_id=? AND source_article_id=? AND status='APPROVED' ORDER BY updated_at DESC LIMIT 1").bind(job.client_id,internalAction.target_article_id).first<any>():null;
      const internalSource=internalCandidate?await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC LIMIT 1").bind(job.client_id,internalCandidate.source_article_id).first<any>():null;
      const internalTarget=internalCandidate?await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC LIMIT 1").bind(job.client_id,internalCandidate.target_article_id).first<any>():null;
      return json({
        job: {
          ...job,
          payload: parse(job.payload, {}),
          context: {
            client,
            primaryInterviewHistory,
            sources:
              ["article_generate", "content_intelligence_review"].includes(job.type)
                ? (sources.results as any[]).filter(
                    (item) => item.approved && item.is_canonical && !item.archived,
                  )
                : sources.results,
            confirmedPrimary: job.type === "serp_competitor_analyze" ? (sources.results as any[]).filter((item:any) => item.approved && item.is_canonical && !item.archived).map((item:any) => ({ title: item.title, note: String(item.note || "").slice(0, 3000), url: item.url || null })) : [],
            sourceFiles: files,
            wordpressPosts,
            articleDraft: ["content_intelligence_review","wordpress_publish"].includes(job.type) ? (job.type === "wordpress_publish" ? parse((await db.prepare("SELECT draft_json FROM article_versions WHERE id=? AND client_id=?").bind(String(parse(job.payload,{}).articleVersionId || ""),job.client_id).first<any>())?.draft_json,{}) : parse((await db.prepare("SELECT result FROM jobs WHERE id=? AND client_id=? AND type='article_generate'").bind(String(parse(job.payload,{}).articleJobId || ""),job.client_id).first<any>())?.result, {})?.article) || {} : {},
            rollbackSnapshot: job.type === "wordpress_rollback" ? await db.prepare("SELECT * FROM wordpress_article_versions WHERE id=? AND client_id=?").bind(String(parse(job.payload,{}).snapshotId || ""),job.client_id).first<any>() : null,
            approvedInternalLinks: job.type === "wordpress_publish" ? (await db.prepare("SELECT target_url,anchor_text FROM internal_link_candidates WHERE client_id=? AND article_version_id=? AND status='APPROVED'").bind(job.client_id,String(parse(job.payload,{}).articleVersionId || "")).all<any>()).results : [],
            // The Writer and the post-draft auditor both receive the same
            // persisted brief selected for this keyword.  A brief that merely
            // exists in D1 is not sufficient: it is part of the Writer input.
            contentBrief: persistedBrief,
            revisionSource: revisionSource?parse(revisionSource.draft_json,{}):null,
            revisionInstruction: revisionInstruction?parse(revisionInstruction.instruction_json,{}):null,
            currentSeo:titleSeo||{}, keyword:titleKeyword||{}, gsc:titleGsc.results||[], serpTitles:wordpressPosts.map((post:any)=>post.title).filter(Boolean).slice(0,10), articleSummary:titleVersion?parse(titleVersion.draft_json,{}):{},
            sourceArticle:internalSource?parse(internalSource.draft_json,{}):{}, targetArticle:internalTarget?parse(internalTarget.draft_json,{}):{}, sourceContext:internalAction?{topicId:internalAction.target_topic_id,clusterId:internalAction.target_cluster_id}: {},targetContext:{},internalLinkCandidate:internalCandidate||null,
            internalLinks: job.type === "content_intelligence_review" ? wordpressPosts.map((post:any) => ({ id:post.id,url:post.url,title:post.title,excerpt:post.excerpt || "" })).filter((post:any) => post.url).slice(0,100) : [],
            wordpressMedia,
            wordpressCategories,
            topicMap: job.type === "article_mapping_analyze" ? {
              topics: (await db.prepare("SELECT id,name,description FROM topics WHERE client_id=? AND status='active'").bind(job.client_id).all<any>()).results,
              clusters: (await db.prepare("SELECT id,topic_id,name,description FROM keyword_clusters WHERE client_id=? AND status='active'").bind(job.client_id).all<any>()).results,
              keywords: (await db.prepare("SELECT id,topic_id,cluster_id,keyword,search_intent FROM seo_keywords WHERE client_id=? AND status<>'archived'").bind(job.client_id).all<any>()).results,
            } : null,
            serpResults: job.type === "serp_competitor_analyze" && serpContext ? (await db.prepare("SELECT * FROM serp_results WHERE snapshot_id=? AND client_id=? ORDER BY rank LIMIT 10").bind(serpContext.snapshot_id, job.client_id).all<any>()).results : [],
            cannibalization,
            snapshots: snapshots.results.map((x: any) => ({
              ...x,
              data: parse(x.data, {}),
            })),
            wordpress:
              wordpressConnection?.secret_cipher
                ? {
                    ...parse(wordpressConnection.public_config, {}),
                    applicationPassword: (await decrypt<any>(wordpressConnection.secret_cipher)).applicationPassword,
                  }
                : null,
            // This is returned only to the authenticated Cloudflare job
            // worker over its service token; it never reaches the browser.
            anthropicApiKey: anthropicConnection?.secret_cipher
              ? (await decrypt<any>(anthropicConnection.secret_cipher)).apiKey
              : null,
            ubersuggestAccessToken:
              ["ubersuggest_sync", "serp_analyze"].includes(job.type)
                ? await ubersuggestAccessToken(job.client_id)
                : null,
          },
        },
      });
    }
    return json({ error: "APIが見つかりません。" }, 404);
  } catch (error: any) {
    if (error instanceof Response) return error;
    return json({ error: error.message || "処理できませんでした。" }, 400);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await ensureSchema();
    const parts = (await context.params).path || [];
    const route = parts.join("/");
    if(route==="autopilot/global") { const owner=await requireOwner(request),body:any=await input(request),stamp=now(); await runtime().DB.prepare("INSERT INTO global_autopilot_settings (id,kill_switch_enabled,updated_at) VALUES ('global',?,?) ON CONFLICT(id) DO UPDATE SET kill_switch_enabled=excluded.kill_switch_enabled,updated_at=excluded.updated_at").bind(body.killSwitchEnabled?1:0,stamp).run(); return json({ok:true,killSwitchEnabled:Boolean(body.killSwitchEnabled),updatedBy:owner}); }
    const autopilotSettingsRoute=route.match(/^clients\/([^/]+)\/autopilot\/settings$/);
    if(autopilotSettingsRoute){const owner=await requireOwner(request),clientId=autopilotSettingsRoute[1],body:any=await input(request);if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const mode=["OFF","RECOMMEND_ONLY","AUTO_EXECUTE_SAFE_ACTIONS"].includes(String(body.mode))?String(body.mode):"OFF",stamp=now();await runtime().DB.prepare("INSERT INTO client_autopilot_settings (client_id,mode,new_article_priority_mode,paused,weekly_action_limit,serp_refresh_limit,article_generation_limit,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET mode=excluded.mode,new_article_priority_mode=excluded.new_article_priority_mode,paused=excluded.paused,weekly_action_limit=excluded.weekly_action_limit,serp_refresh_limit=excluded.serp_refresh_limit,article_generation_limit=excluded.article_generation_limit,updated_at=excluded.updated_at").bind(clientId,mode,body.newArticlePriorityMode?1:0,body.paused?1:0,1,Math.max(1,Math.min(12,Number(body.serpRefreshLimit||4))),Math.max(0,Math.min(3,Number(body.articleGenerationLimit||1))),stamp).run();await saveAutopilotAudit(clientId,"SETTINGS_UPDATED",{mode,paused:Boolean(body.paused),newArticlePriorityMode:Boolean(body.newArticlePriorityMode)});return json({ok:true,mode});}
    const autopilotRunRoute=route.match(/^clients\/([^/]+)\/autopilot\/run$/);
    if(autopilotRunRoute){const owner=await requireOwner(request),clientId=autopilotRunRoute[1],body:any=await input(request);if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);return json(await runAutopilot(clientId,"MANUAL",Boolean(body.manualRerun)));}
    const autopilotActionRoute=route.match(/^clients\/([^/]+)\/autopilot\/actions\/([^/]+)$/);
    // TITLE and INTERNAL_LINK recommendations first queue analysis only. Their
    // separate proposal Execute APIs are the sole paths that may write WordPress.
    if(autopilotActionRoute&&(await input(request).catch(()=>({}))).command==="APPROVE"){const owner=await requireOwner(request),clientId=autopilotActionRoute[1],actionId=autopilotActionRoute[2],db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const action=await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=? AND action_type IN ('TITLE_OPTIMIZATION','INTERNAL_LINK')").bind(actionId,clientId).first<any>();if(action){const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type='autopilot_execute' AND json_extract(payload,'$.actionId')=? AND status IN ('queued','running')").bind(clientId,actionId).first<any>();if(existing)return json({ok:true,status:"QUEUED",jobId:existing.id,idempotent:true});const stamp=now(),handoff={id:id(),client_id:clientId,type:"autopilot_execute",status:"queued",payload:JSON.stringify({actionId}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.batch([db.prepare("UPDATE autopilot_actions SET status='QUEUED',updated_at=? WHERE id=? AND client_id=?").bind(stamp,actionId,clientId),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(handoff))]);await dispatchCloudJob(handoff.id,false,new URL(request.url).origin).catch(()=>undefined);await saveAutopilotAudit(clientId,action.action_type==="TITLE_OPTIMIZATION"?"TITLE_PROPOSAL_GENERATION_QUEUED":"INTERNAL_LINK_PROPOSAL_GENERATION_QUEUED",{by:owner},action.run_id,actionId);return json({ok:true,status:"QUEUED",jobId:handoff.id});}}
    if(autopilotActionRoute){const owner=await requireOwner(request),clientId=autopilotActionRoute[1],actionId=autopilotActionRoute[2],body:any=await input(request),db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const action=await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=?").bind(actionId,clientId).first<any>();if(!action)return json({error:"Autopilot actionが見つかりません。"},404);const command=String(body.command||"");if(!["APPROVE","REJECT","CHANGE_ACTION","EXECUTE_NOW","PAUSE"].includes(command))return json({error:"操作が不正です。"},422);const requiresAutopilotReview=(type:string,risk:string)=>["MERGE","REDIRECT","TITLE_OPTIMIZATION","INTERNAL_LINK"].includes(type)||risk==="HIGH";let status=action.status,actionType=action.action_type;if(command==="APPROVE")status="APPROVED";if(command==="REJECT")status="SKIPPED";if(command==="PAUSE"){await db.prepare("INSERT INTO client_autopilot_settings (client_id,paused,updated_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET paused=excluded.paused,updated_at=excluded.updated_at").bind(clientId,1,now()).run();status="SKIPPED";}if(command==="CHANGE_ACTION"){const next=String(body.actionType||"");if(!["NEW_ARTICLE","REWRITE","EXPAND","TITLE_OPTIMIZATION","INTERNAL_LINK","MERGE","REDIRECT","NO_ACTION"].includes(next))return json({error:"Action Typeが不正です。"},422);actionType=next;status=requiresAutopilotReview(next,String(action.risk))?"HUMAN_REVIEW_REQUIRED":"RECOMMENDED";}if(command==="EXECUTE_NOW"){if(requiresAutopilotReview(actionType,String(action.risk)))status="HUMAN_REVIEW_REQUIRED";else {status="QUEUED";const job={id:id(),client_id:clientId,type:"autopilot_execute",status:"queued",payload:JSON.stringify({actionId}),result:null,attempts:0,lease_until:null,error:null,created_at:now(),updated_at:now()};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false,new URL(request.url).origin).catch(()=>undefined);}}await db.prepare("UPDATE autopilot_actions SET action_type=?,status=?,updated_at=? WHERE id=? AND client_id=?").bind(actionType,status,now(),actionId,clientId).run();await saveAutopilotAudit(clientId,`MANUAL_${command}`,{from:action.action_type,to:actionType,status,by:owner,note:String(body.note||"").slice(0,2000)},action.run_id,actionId);return json({ok:true,status,actionType});}
    const publishSettingsRoute=route.match(/^clients\/([^/]+)\/publish-settings$/);
    if(publishSettingsRoute){const owner=await requireOwner(request),clientId=publishSettingsRoute[1],body:any=await input(request);if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const auto=body.autoPublishEnabled?1:0,autoCategory=body.autoCreateCategory?1:0,tagLimit=Math.max(1,Math.min(10,Number(body.tagLimit||5)));await runtime().DB.prepare("INSERT INTO client_publish_settings (client_id,auto_publish_enabled,auto_create_category,tag_limit,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET auto_publish_enabled=excluded.auto_publish_enabled,auto_create_category=excluded.auto_create_category,tag_limit=excluded.tag_limit,updated_at=excluded.updated_at").bind(clientId,auto,autoCategory,tagLimit,now()).run();return json({ok:true,autoPublishEnabled:Boolean(auto),autoCreateCategory:Boolean(autoCategory),tagLimit});}
    const redirectRoute=route.match(/^clients\/([^/]+)\/redirect-recommendations$/);
    if(redirectRoute){const owner=await requireOwner(request),clientId=redirectRoute[1],body:any=await input(request),sourceUrl=String(body.sourceUrl||""),targetUrl=String(body.targetUrl||"");if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);if(!/^https:\/\//i.test(sourceUrl)||!/^https:\/\//i.test(targetUrl))return json({error:"Redirect候補には確認済みHTTPS URLだけを指定してください。"},422);const stamp=now();await runtime().DB.prepare("INSERT INTO redirect_recommendations (id,client_id,article_id,source_url,target_url,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,source_url,target_url) DO UPDATE SET reason=excluded.reason,status='PENDING',updated_at=excluded.updated_at").bind(id(),clientId,body.articleId||null,sourceUrl,targetUrl,String(body.reason||"MERGE recommendation").slice(0,2000),"PENDING",stamp,stamp).run();return json({ok:true,status:"PENDING"});}
    const publishRoute=route.match(/^clients\/([^/]+)\/articles\/([^/]+)\/publish$/);
    if(publishRoute){const owner=await requireOwner(request),clientId=publishRoute[1],articleId=publishRoute[2],body:any=await input(request),db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const version=await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC LIMIT 1").bind(clientId,articleId).first<any>();if(!version)return json({error:"記事バージョンが見つかりません。"},404);const operation=String(body.operation||"");if(!["DRAFT","MANUAL_PUBLISH","AUTO_PUBLISH","UPDATE_EXISTING"].includes(operation))return json({error:"公開操作が不正です。"},422);const eligibility=await publishEligibility(clientId,version.id);if(operation==="AUTO_PUBLISH"&&!eligibility.eligible)return json({error:"自動公開条件を満たしていません。",blockers:eligibility.blockers},422);if(["MANUAL_PUBLISH","UPDATE_EXISTING"].includes(operation)&&!body.acknowledged)return json({error:"内容を確認し、手動公開するチェックが必要です。",warnings:eligibility.blockers},422);let targetPostId="";if(operation==="UPDATE_EXISTING"){targetPostId=String(body.targetPostId||"");const mapping=targetPostId&&await db.prepare("SELECT article_id,article_url FROM article_mapping_candidates WHERE client_id=? AND article_id=? AND status IN ('APPROVED','MODIFIED')").bind(clientId,targetPostId).first<any>();if(!mapping)return json({error:"承認済みArticle Mappingで確認できるWordPress Post IDを指定してください。"},422);}const requestId=String(body.requestId||`${operation}:${version.id}`).slice(0,240);const prior=await db.prepare("SELECT id,status FROM wordpress_publish_history WHERE client_id=? AND article_version_id=? AND operation=? AND request_id=?").bind(clientId,version.id,operation,requestId).first<any>();if(prior)return json({ok:true,idempotent:true,historyId:prior.id,status:prior.status});const stamp=now(),job={id:id(),client_id:clientId,type:"wordpress_publish",status:"queued",payload:JSON.stringify({articleId,articleVersionId:version.id,operation,targetPostId,requestId,requestedBy:owner}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false,new URL(request.url).origin).catch(()=>undefined);return json({ok:true,jobId:job.id,operation,warnings:eligibility.blockers});}
    const rollbackRoute=route.match(/^clients\/([^/]+)\/articles\/([^/]+)\/rollback$/);
    if(rollbackRoute){const owner=await requireOwner(request),clientId=rollbackRoute[1],articleId=rollbackRoute[2],body:any=await input(request),db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const snapshot=await db.prepare("SELECT * FROM wordpress_article_versions WHERE id=? AND client_id=? AND article_id=?").bind(String(body.snapshotId||""),clientId,articleId).first<any>();if(!snapshot)return json({error:"復元対象Snapshotが見つかりません。"},404);const requestId=String(body.requestId||`ROLLBACK:${snapshot.id}`).slice(0,240),prior=await db.prepare("SELECT id FROM wordpress_publish_history WHERE client_id=? AND article_version_id=? AND operation='ROLLBACK' AND request_id=?").bind(clientId,snapshot.article_version_id,requestId).first<any>();if(prior)return json({ok:true,idempotent:true,historyId:prior.id});const stamp=now(),job={id:id(),client_id:clientId,type:"wordpress_rollback",status:"queued",payload:JSON.stringify({articleId,articleVersionId:snapshot.article_version_id,snapshotId:snapshot.id,requestId,requestedBy:owner}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false,new URL(request.url).origin).catch(()=>undefined);return json({ok:true,jobId:job.id,operation:"ROLLBACK"});}
    const reviewRoute = route.match(/^clients\/([^/]+)\/human-reviews\/([^/]+)$/);
    if (reviewRoute) {
      const owner = await requireOwner(request), clientId = reviewRoute[1], reviewId = reviewRoute[2], body: any = await input(request);
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const review = await runtime().DB.prepare("SELECT * FROM human_review_queue WHERE id=? AND client_id=?").bind(reviewId, clientId).first<any>();
      if (!review) return json({ error: "レビューが見つかりません。" }, 404);
      const status = ({ APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", REJECT: "REJECTED" } as any)[body.action];
      if (!status) return json({ error: "操作が不正です。" }, 422);
      const note = String(body.note || "").slice(0, 4000);
      if (status === "CHANGES_REQUESTED" && !note) return json({ error: "修正理由・指示を入力してください。" }, 422);
      const stamp = now();
      await runtime().DB.batch([
        runtime().DB.prepare("UPDATE human_review_queue SET status=?,notes=?,updated_at=? WHERE id=? AND client_id=?").bind(status, note, stamp, reviewId, clientId),
        runtime().DB.prepare("INSERT INTO human_review_events (id,client_id,article_version_id,review_id,reviewed_by,review_status,review_note,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id(), clientId, review.article_version_id, reviewId, owner, status, note, stamp),
      ]);
      if (status !== "APPROVED") {
        await transitionArticleStatus({
          clientId, owner, articleVersionId: review.article_version_id,
          toStatus: status === "CHANGES_REQUESTED" ? "DRAFT" : "FAILED",
          reason: note || "Human review rejected the article version.", changedBy: owner,
          transitionEvent: `human_review:${reviewId}:${status}:${stamp}`,
        });
      }
      return json({ ok: true, status, reviewedBy: owner, reviewedAt: stamp, reviewNote: note });
    }
    const internalLinkRoute = route.match(/^clients\/([^/]+)\/internal-links\/([^/]+)$/);
    if (internalLinkRoute) {
      const owner=await requireOwner(request),clientId=internalLinkRoute[1],linkId=internalLinkRoute[2],body:any=await input(request);
      if(!(await ownedClient(clientId,owner))) return json({error:"クライアントが見つかりません。"},404);
      const link=await runtime().DB.prepare("SELECT * FROM internal_link_candidates WHERE id=? AND client_id=?").bind(linkId,clientId).first<any>();
      if(!link) return json({error:"内部リンク候補が見つかりません。"},404);
      const status=["PENDING","APPROVED","REJECTED"].includes(String(body.status))?String(body.status):link.status;
      const anchor=String(body.anchorText??link.anchor_text).slice(0,500);
      if(!anchor) return json({error:"アンカーテキストを入力してください。"},422);
      await runtime().DB.prepare("UPDATE internal_link_candidates SET status=?,anchor_text=?,updated_at=? WHERE id=? AND client_id=?").bind(status,anchor,now(),linkId,clientId).run();
      return json({ok:true,status,anchorText:anchor});
    }
    if (route === "worker/autopilot-weekly") {
      const registered=await worker(request); if(!registered)return json({error:"ワーカートークンが無効です。"},401);
      const anchor=await runtime().DB.prepare("SELECT owner_id FROM clients WHERE id=?").bind(registered.client_id).first<any>(); if(!anchor)return json({error:"ワーカーの登録先が見つかりません。"},401);
      const clients=(await runtime().DB.prepare("SELECT id FROM clients WHERE owner_id=?").bind(anchor.owner_id).all<any>()).results;
      const results=[] as any[]; for(const item of clients) { const run=await runAutopilot(item.id,"CRON",false); const actions=(await runtime().DB.prepare("SELECT * FROM autopilot_actions WHERE client_id=? AND status IN ('COMPLETED','EXECUTING')").bind(item.id).all<any>()).results; for(const action of actions){const age=Math.floor((Date.now()-new Date(action.created_at).getTime())/86400000);for(const windowDays of [7,28])if(age>=windowDays){const current:any=action.action_type==="TITLE_OPTIMIZATION"?await titleMetricSummary(item.id,action,windowDays):action.action_type==="INTERNAL_LINK"?await internalLinkMetricSummary(item.id,action,windowDays):await metricSummary(item.id,windowDays),before=parse(action.before_metrics_json,{}),measurement=action.action_type==="INTERNAL_LINK"?measureAutopilot(before.source||{},current.source||{}):measureAutopilot(before,current);await runtime().DB.prepare("INSERT INTO autopilot_measurements (id,client_id,action_id,window_days,metrics_json,result_status,measured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(action_id,window_days) DO UPDATE SET metrics_json=excluded.metrics_json,result_status=excluded.result_status,measured_at=excluded.measured_at").bind(id(),item.id,action.id,windowDays,JSON.stringify({before,after:current,deltas:measurement.deltas}),measurement.status,now()).run();}} results.push({clientId:item.id,...run}); }
      return json({ok:true,results});
    }
    if (route === "worker/autopilot-execute") {
      const registered=await worker(request); if(!registered)return json({error:"ワーカートークンが無効です。"},401);
      const body:any=await input(request),db=runtime().DB,anchor=await db.prepare("SELECT owner_id FROM clients WHERE id=?").bind(registered.client_id).first<any>(),clientId=String(body.clientId||registered.client_id),action=await db.prepare("SELECT a.* FROM autopilot_actions a JOIN clients c ON c.id=a.client_id WHERE a.id=? AND a.client_id=? AND c.owner_id=?").bind(String(body.actionId||""),clientId,anchor?.owner_id||"").first<any>();
      if(!action)return json({error:"Autopilot actionが見つかりません。"},404);
      const [globalAutopilot,clientAutopilot]=await Promise.all([db.prepare("SELECT kill_switch_enabled FROM global_autopilot_settings WHERE id='global'").first<any>(),db.prepare("SELECT paused FROM client_autopilot_settings WHERE client_id=?").bind(action.client_id).first<any>()]);
      if(Number(globalAutopilot?.kill_switch_enabled)||Number(clientAutopilot?.paused)){await db.prepare("UPDATE autopilot_actions SET status='SKIPPED',updated_at=? WHERE id=? AND client_id=? AND status IN ('QUEUED','APPROVED')").bind(now(),action.id,action.client_id).run();await saveAutopilotAudit(action.client_id,"EXECUTION_STOPPED_BY_KILL_SWITCH",{global:Boolean(globalAutopilot?.kill_switch_enabled),paused:Boolean(clientAutopilot?.paused)},action.run_id,action.id);return json({ok:true,status:"SKIPPED"});}
      if(!["QUEUED","APPROVED"].includes(action.status))return json({ok:true,idempotent:true,status:action.status});
      if(["MERGE","REDIRECT"].includes(action.action_type)||action.risk==="HIGH"){await db.prepare("UPDATE autopilot_actions SET status='HUMAN_REVIEW_REQUIRED',updated_at=? WHERE id=? AND client_id=?").bind(now(),action.id,action.client_id).run();await saveAutopilotAudit(action.client_id,"EXECUTION_BLOCKED_BY_SAFETY",{actionType:action.action_type},action.run_id,action.id);return json({ok:true,status:"HUMAN_REVIEW_REQUIRED"});}
      if(action.action_type==="INTERNAL_LINK"){
        const candidate=await db.prepare("SELECT * FROM internal_link_candidates WHERE client_id=? AND source_article_id=? AND status='APPROVED' ORDER BY updated_at DESC LIMIT 1").bind(action.client_id,action.target_article_id).first<any>();
        const mapping=async(articleId:string)=>db.prepare("SELECT * FROM wordpress_article_mappings WHERE client_id=? AND article_id=? AND wordpress_post_id<>'' ORDER BY updated_at DESC LIMIT 1").bind(action.client_id,articleId).first<any>();
        const approvedArticle=async(articleId:string)=>db.prepare("SELECT id FROM article_mapping_candidates WHERE client_id=? AND article_id=? AND status IN ('APPROVED','MODIFIED') LIMIT 1").bind(action.client_id,articleId).first<any>();
        const [sourceMap,targetMap,sourceArticle,targetArticle]=candidate?await Promise.all([mapping(candidate.source_article_id),mapping(candidate.target_article_id),approvedArticle(candidate.source_article_id),approvedArticle(candidate.target_article_id)]):[null,null,null,null];
        if(!candidate||candidate.source_article_id===candidate.target_article_id||!sourceMap||!targetMap||!sourceArticle||!targetArticle||!/^https:\/\//i.test(String(targetMap.wordpress_url||candidate.target_url||""))){await db.prepare("UPDATE autopilot_actions SET status='HUMAN_REVIEW_REQUIRED',updated_at=? WHERE id=? AND client_id=?").bind(now(),action.id,action.client_id).run();return json({ok:true,status:"HUMAN_REVIEW_REQUIRED",reason:"INTERNAL_LINK_VALIDATION_FAILED"});}
        const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type='internal_link_analyze' AND json_extract(payload,'$.actionId')=? AND status IN ('queued','running')").bind(action.client_id,action.id).first<any>(); if(existing)return json({ok:true,status:"EXECUTING",handoffJobId:existing.id,idempotent:true});
        const stamp=now(),handoff={id:id(),client_id:action.client_id,type:"internal_link_analyze",status:"queued",payload:JSON.stringify({actionId:action.id,sourceArticleId:candidate.source_article_id,targetArticleId:candidate.target_article_id,sourceArticleVersionId:candidate.article_version_id,sourceWpPostId:sourceMap.wordpress_post_id,confirmedTargetUrl:targetMap.wordpress_url}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.batch([db.prepare("UPDATE autopilot_actions SET status='EXECUTING',updated_at=? WHERE id=? AND client_id=?").bind(stamp,action.id,action.client_id),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(handoff))]);await dispatchCloudJob(handoff.id,false).catch(()=>undefined);return json({ok:true,status:"EXECUTING",handoffJobId:handoff.id});
      }
      if(action.action_type==="TITLE_OPTIMIZATION"){const stamp=now(),handoff={id:id(),client_id:action.client_id,type:"title_optimize",status:"queued",payload:JSON.stringify({actionId:action.id}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.batch([db.prepare("UPDATE autopilot_actions SET status='EXECUTING',updated_at=? WHERE id=? AND client_id=?").bind(stamp,action.id,action.client_id),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(handoff))]);await dispatchCloudJob(handoff.id,false).catch(()=>undefined);return json({ok:true,status:"EXECUTING",handoffJobId:handoff.id});}
      const keyword=action.target_keyword_id&&await db.prepare("SELECT keyword,search_intent FROM seo_keywords WHERE id=? AND client_id=?").bind(action.target_keyword_id,action.client_id).first<any>();
      if(!keyword&&action.action_type!=="NO_ACTION")return json({error:"実行対象Keywordが見つかりません。"},422);
      if(action.action_type==="NO_ACTION"){await db.prepare("UPDATE autopilot_actions SET status='COMPLETED',execution_result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify({result:"NO_ACTION"}),now(),action.id,action.client_id).run();return json({ok:true,status:"COMPLETED"});}
      const stamp=now(),handoff={id:id(),client_id:action.client_id,type:"article_generate",status:"queued",payload:JSON.stringify({keyword:keyword?.keyword||"",intent:keyword?.search_intent||"unknown",articleId:action.target_article_id||undefined,autopilotActionId:action.id,autopilotActionType:action.action_type,brief:`Autopilot ${action.action_type}: ${parse(action.reason_json,{}).reason||"実データに基づく改善"}`}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};
      await db.batch([db.prepare("UPDATE autopilot_actions SET status='EXECUTING',updated_at=? WHERE id=? AND client_id=? AND status IN ('QUEUED','APPROVED')").bind(stamp,action.id,action.client_id),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(handoff))]);await dispatchCloudJob(handoff.id,false).catch(()=>undefined);await saveAutopilotAudit(action.client_id,"PIPELINE_HANDOFF",{actionType:action.action_type,handoffJobId:handoff.id},action.run_id,action.id);return json({ok:true,status:"EXECUTING",handoffJobId:handoff.id});
    }
    if (route === "worker/google-sync") {
      const registered = await worker(request);
      if (!registered) return json({ error: "ワーカートークンが無効です。" }, 401);
      const body: any = await input(request);
      const job = await runtime().DB.prepare("SELECT client_id FROM jobs WHERE id=? AND type='sync_google'").bind(String(body.jobId || "")).first<any>();
      if (!job) return json({ error: "Google同期ジョブが見つかりません。" }, 404);
      const connector = String(body.connector || "");
      if (connector !== "gsc" && connector !== "ga") return json({ error: "同期対象が不正です。" }, 422);
      const result = connector === "gsc" ? await syncGscHistory(job.client_id, request) : await syncGa4History(job.client_id, request);
      return json({ ok: true, result });
    }
    if (route === "worker/healthcheck") {
      const registered = await worker(request);
      if (!registered) return json({ error: "ワーカートークンが無効です。" }, 401);
      const anchor = await runtime().DB.prepare("SELECT owner_id FROM clients WHERE id=?").bind(registered.client_id).first<any>();
      if (!anchor) return json({ error: "ワーカーの登録先が見つかりません。" }, 401);
      return json({ ok: true, ...(await checkConnectionHealth(request, anchor.owner_id)) });
    }
    if (route === "settings/google") {
      const owner = await requireOwner(request);
      const body = await input(request);
      const clientId = String(body.clientId || "").trim();
      const clientSecret = String(body.clientSecret || "").trim();
      const redirectUri = `${new URL(request.url).origin}/api/google/callback`;
      if (!clientId.endsWith(".apps.googleusercontent.com"))
        return json(
          {
            error:
              "Googleのウェブアプリ用クライアントIDを正確に入力してください。",
          },
          422,
        );
      if (clientSecret.length < 10)
        return json(
          { error: "クライアントシークレットを正確に入力してください。" },
          422,
        );
      const cipher = await encrypt({ clientId, clientSecret });
      const stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO app_settings (id,owner_id,setting_key,public_config,secret_cipher,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,setting_key) DO UPDATE SET public_config=excluded.public_config,secret_cipher=excluded.secret_cipher,updated_at=excluded.updated_at",
        )
        .bind(
          id(),
          owner,
          "google_oauth",
          JSON.stringify({ redirectUri }),
          cipher,
          stamp,
        )
        .run();
      return json(
        {
          ok: true,
          google: {
            configured: true,
            redirectUri,
            source: "encrypted_settings",
            updatedAt: stamp,
          },
        },
        201,
      );
    }
    if (route === "clients") {
      const owner = await requireOwner(request);
      const body = await input(request);
      if (!body.name) return json({ error: "クライアント名が必要です。" }, 422);
      const client = {
        id: id(),
        owner_id: owner,
        name: body.name.slice(0, 120),
        site: (body.site || "").slice(0, 1000),
        niche: (body.niche || "").slice(0, 300),
        primary_info_status: "missing",
        created_at: now(),
        updated_at: now(),
      };
      await runtime()
        .DB.prepare(
          "INSERT INTO clients (id,owner_id,name,site,niche,primary_info_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(...Object.values(client))
        .run();
      return json({ ok: true, client }, 201);
    }
    const primaryStatusRoute = route.match(
      /^clients\/([^/]+)\/primary-info-status$/,
    );
    if (primaryStatusRoute) {
      const owner = await requireOwner(request);
      const clientId = primaryStatusRoute[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      if (body.confirmFacts !== "yes" || body.confirmRights !== "yes")
        return json(
          {
            error:
              "内容が事実であることと、記事利用の許可を両方確認してください。",
          },
          422,
        );
      const database = runtime().DB;
      const canonical = await database
        .prepare(
          "SELECT id FROM sources WHERE client_id=? AND is_canonical=1 AND archived=0 AND length(trim(note))>=30 LIMIT 1",
        )
        .bind(clientId)
        .first<any>();
      if (!canonical?.id)
        return json(
          {
            error:
              "具体的な内容が入った正式な一次情報を1件以上登録してください。",
          },
          422,
        );
      const stamp = now();
      await database.batch([
        database
          .prepare(
            "UPDATE sources SET rights='approved',approved=1,canonical_status='ready',updated_at=? WHERE id=? AND client_id=? AND is_canonical=1 AND archived=0",
          )
          .bind(stamp, canonical.id, clientId),
        database
          .prepare(
            "UPDATE clients SET primary_info_status='sufficient',updated_at=? WHERE id=?",
          )
          .bind(stamp, clientId),
      ]);
      await log(
        clientId,
        "所有者が事実確認・利用許可を確認し、一次情報を十分として確定",
      );
      return json({
        ok: true,
        status: "sufficient",
        sourceId: canonical.id,
        updatedAt: stamp,
      });
    }
    const sourceUpload = route.match(/^clients\/([^/]+)\/source-files$/);
    if (sourceUpload) {
      const owner = await requireOwner(request);
      const clientId = sourceUpload[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      if (!runtime().FILES)
        return json(
          {
            error:
              "資料ファイルの保存先（Cloudflare R2）が未有効です。現在はテキスト入力・URL登録を利用できます。PDF・Word・画像の保存を使う場合はR2を有効化してください。",
          },
          503,
        );
      const form = await request.formData();
      const file = form.get("file");
      // This workspace is operated by the content owner. The simple PDF flow
      // treats an upload as the owner's instruction to use that file for
      // article preparation, without making them repeat a consent checkbox.
      const rights = true;
      if (!(file instanceof File))
        return json({ error: "資料ファイルを選択してください。" }, 422);
      const allowed = [
        "application/pdf",
        "text/plain",
        "text/csv",
        "text/markdown",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "image/jpeg",
        "image/png",
        "image/webp",
      ];
      if (!allowed.includes(file.type))
        return json(
          {
            error:
              "PDF・Word・Excel・PowerPoint・テキスト・CSV・画像を選択してください。",
          },
          422,
        );
      if (file.size <= 0)
        return json({ error: "空の資料ファイルはアップロードできません。" }, 422);
      if (file.size > 20 * 1024 * 1024)
        return json({ error: "1ファイル20MB以内にしてください。" }, 422);
      const fileId = id();
      const objectKey = `primary-info/${owner}/${clientId}/${fileId}`;
      await runtime().FILES!.put(objectKey, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { originalName: file.name.slice(0, 240) },
      });
      const stamp = now();
      try {
        await runtime()
          .DB.prepare(
            "INSERT INTO source_files (id,client_id,object_key,name,content_type,size,rights_confirmed,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            fileId,
            clientId,
            objectKey,
            file.name.slice(0, 240),
            file.type,
            file.size,
            rights ? 1 : 0,
            "uploaded",
            stamp,
          )
          .run();
      } catch (error) {
        await runtime().FILES!.delete(objectKey).catch(() => undefined);
        throw error;
      }
      await log(
        clientId,
        `一次情報資料をアップロード: ${file.name.slice(0, 180)}`,
      );
      return json(
        {
          ok: true,
          file: {
            id: fileId,
            name: file.name,
            size: file.size,
            status: "uploaded",
          },
        },
        201,
      );
    }
    const googleSelectRoute = route.match(/^clients\/([^/]+)\/google\/select$/);
    if (googleSelectRoute) {
      const owner = await requireOwner(request);
      const clientId = googleSelectRoute[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      const resources = await googleResources(clientId, request);
      const selected: any[] = [];
      const ga = resources.ga4.find(
        (item: any) => item.id === String(body.gaPropertyId || ""),
      );
      const gsc = resources.gsc.find(
        (item: any) => item.id === String(body.gscSiteUrl || ""),
      );
      const drive = body.connectDrive ? resources.drive : null;
      const youtube = resources.youtube.find(
        (item: any) => item.id === String(body.youtubeChannelId || ""),
      );
      if (ga) selected.push(["ga", ga]);
      if (gsc) selected.push(["gsc", gsc]);
      if (drive) selected.push(["drive", drive]);
      if (youtube) selected.push(["youtube", youtube]);
      if (!selected.length)
        return json(
          { error: "接続するGoogleサービスを1つ以上選択してください。" },
          422,
        );
      for (const [connector, resource] of selected)
        await verifyGoogleResource(clientId, request, connector, resource.id);
      const db = runtime().DB;
      const stamp = now();
      for (const [connector, resource] of selected)
        await db
          .prepare(
            "UPDATE connections SET status='connected',public_config=?,checked_at=?,updated_at=? WHERE client_id=? AND connector=?",
          )
          .bind(
            JSON.stringify({
              resourceId: resource.id,
              resourceName: resource.name,
              accountName: resource.account || null,
              permission: resource.permission || null,
              email: resource.email || null,
            }),
            stamp,
            stamp,
            clientId,
            connector,
          )
          .run();
      await log(
        clientId,
        `Google取得先を確認: ${selected.map((item) => item[0]).join(", ")}`,
      );
      return json({
        ok: true,
        connected: selected.map(([connector, resource]) => ({
          connector,
          resource,
        })),
      });
    }
    const connection = route.match(/^clients\/([^/]+)\/connections\/([^/]+)$/);
    if (connection) {
      const owner = await requireOwner(request);
      const [, clientId, connector] = connection;
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      if (["ga", "gsc", "drive", "youtube"].includes(connector))
        return googleStart(request, clientId, owner);
      if (connector === "ubersuggest") return ubersuggestStart(request, clientId, owner);
      if (["backlinks", "codex"].includes(connector))
        return json(
          {
            error:
              "先にこのクライアント用のローカルワーカーを登録してください。",
          },
          409,
        );
      if (connector === "note")
        return json({
          ok: true,
          connection: { connector, status: "manual_export" },
        });
      if (connector === "wordpress") {
        const siteUrl = wordpressBase(body.siteUrl);
        const username = String(body.username || "").trim();
        const applicationPassword = String(body.applicationPassword || "").trim();
        if (!username || !applicationPassword)
          return json({ error: "ユーザー名とApplication Passwordを入力してください。" }, 422);
        const stamp = now();
        const cipher = await encrypt({ applicationPassword });
        await runtime().DB.batch([
          runtime().DB.prepare("INSERT INTO connections (id,client_id,connector,status,public_config,secret_cipher,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,secret_cipher=excluded.secret_cipher,checked_at=excluded.checked_at,updated_at=excluded.updated_at").bind(id(), clientId, connector, "verifying", JSON.stringify({ siteUrl, username, authMode: "pending" }), cipher, null, stamp),
          runtime().DB.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id(), clientId, "wordpress_verify", "queued", "{}", null, 0, null, null, stamp, stamp),
        ]);
        await log(clientId, "MacワーカーへWordPress接続確認を依頼");
        return json({ ok: true, connection: { connector, status: "verifying" }, message: "MacワーカーがWordPress接続を確認しています。" }, 202);
      }
      const checked = await verify(
        connector,
        body,
        runtime().META_GRAPH_VERSION,
      );
      const cipher = await encrypt({
        ...checked.secret,
        ...Object.fromEntries(
          Object.entries(body).filter(
            ([key]) =>
              ![
                "applicationPassword",
                "apiKey",
                "accessToken",
                "bearerToken",
                "token",
              ].includes(key),
          ),
        ),
      });
      const stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO connections (id,client_id,connector,status,public_config,secret_cipher,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,secret_cipher=excluded.secret_cipher,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
        )
        .bind(
          id(),
          clientId,
          connector,
          "connected",
          JSON.stringify(checked.publicConfig),
          cipher,
          stamp,
          stamp,
        )
        .run();
      await log(clientId, `${connector}の実接続を確認`);
      return json({
        ok: true,
        connection: {
          connector,
          status: "connected",
          public_config: checked.publicConfig,
          checked_at: stamp,
        },
      });
    }
    const source = route.match(/^clients\/([^/]+)\/sources$/);
    const weightsRoute = route.match(/^clients\/([^/]+)\/priority-weights$/);
    if (weightsRoute) {
      const owner = await requireOwner(request), clientId = weightsRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request), candidate = body.weights && typeof body.weights === "object" ? body.weights as any : body as any;
      const keys = Object.keys(defaultPriorityWeights) as (keyof typeof defaultPriorityWeights)[];
      const weights = Object.fromEntries(keys.map(key => [key, Number(candidate[key])])) as any;
      if (keys.some(key => !Number.isFinite(weights[key]) || weights[key] < 0) || Math.round(keys.reduce((sum, key) => sum + weights[key], 0) * 100) !== 10000) return json({ error: "ウェイト合計を100にしてください。負の値は使えません。" }, 422);
      const high = Number(body.highConfidenceThreshold ?? .9), medium = Number(body.mediumConfidenceThreshold ?? .7);
      if (!(high >= medium && high <= 1 && medium >= 0 && medium <= 1)) return json({ error: "Confidence閾値を0〜1の範囲かつHIGH ≥ MEDIUMで設定してください。" }, 422);
      const db = runtime().DB, stamp = now();
      await db.prepare("INSERT INTO client_priority_weights (client_id,weights_json,high_confidence_threshold,medium_confidence_threshold,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET weights_json=excluded.weights_json,high_confidence_threshold=excluded.high_confidence_threshold,medium_confidence_threshold=excluded.medium_confidence_threshold,updated_at=excluded.updated_at").bind(clientId,JSON.stringify(weights),high,medium,stamp).run();
      const keywords = await db.prepare("SELECT * FROM seo_keywords WHERE client_id=?").bind(clientId).all<any>();
      const updates = keywords.results.map((keyword: any) => db.prepare("UPDATE seo_keywords SET priority_score=?,updated_at=? WHERE id=? AND client_id=?").bind(scoreKeyword(keyword, weights),stamp,keyword.id,clientId));
      for (let offset = 0; offset < updates.length; offset += 50) await db.batch(updates.slice(offset, offset + 50));
      await log(clientId, "Priority Weightを保存しKeyword Scoreを再計算", "info", { count: updates.length });
      return json({ ok: true, recalculated: updates.length, weights, highConfidenceThreshold: high, mediumConfidenceThreshold: medium });
    }
    const mappingAction = route.match(/^clients\/([^/]+)\/article-mappings\/([^/]+)\/(approve|reject)$/);
    if (mappingAction) {
      const owner = await requireOwner(request), [, clientId, mappingId, action] = mappingAction;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const db = runtime().DB, item = await db.prepare("SELECT * FROM article_mapping_candidates WHERE id=? AND client_id=?").bind(mappingId,clientId).first<any>();
      if (!item) return json({ error: "記事マッピング候補が見つかりません。" }, 404);
      if (action === "reject") { await db.prepare("UPDATE article_mapping_candidates SET status='REJECTED',updated_at=? WHERE id=? AND client_id=?").bind(now(),mappingId,clientId).run(); await log(clientId,"記事マッピング候補を却下"); return json({ok:true,status:"REJECTED"}); }
      const body = await input(request), topicId = String(body.topicId || item.suggested_topic_id || "") || null, clusterId = String(body.clusterId || item.suggested_cluster_id || "") || null;
      let keywordId = String(body.keywordId || item.suggested_keyword_id || "") || null;
      const keywordText = String(body.keywordText || item.suggested_keyword_text || "").trim();
      if (topicId && !(await db.prepare("SELECT id FROM topics WHERE id=? AND client_id=?").bind(topicId,clientId).first())) return json({error:"このクライアントのTopicを選んでください。"},422);
      if (clusterId && !(await db.prepare("SELECT id FROM keyword_clusters WHERE id=? AND client_id=?").bind(clusterId,clientId).first())) return json({error:"このクライアントのClusterを選んでください。"},422);
      if (!keywordId && keywordText) { const normalized = normalizeKeyword(keywordText); const existing = await db.prepare("SELECT id FROM seo_keywords WHERE client_id=? AND normalized_keyword=?").bind(clientId,normalized).first<any>(); keywordId = existing?.id || id(); if (!existing) await db.prepare("INSERT INTO seo_keywords (id,client_id,topic_id,cluster_id,keyword,normalized_keyword,priority_score,status,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(keywordId,clientId,topicId,clusterId,keywordText.slice(0,240),normalized,scoreKeyword({},defaultPriorityWeights),"candidate","article_mapping",now(),now()).run(); }
      if (!keywordId) return json({ error:"Primary Keywordを選ぶか、新規候補を入力してください。" },422);
      if (!(await db.prepare("SELECT id FROM seo_keywords WHERE id=? AND client_id=?").bind(keywordId,clientId).first())) return json({error:"このクライアントのKeywordを選んでください。"},422);
      const modified = topicId !== item.suggested_topic_id || clusterId !== item.suggested_cluster_id || keywordId !== item.suggested_keyword_id;
      await db.batch([db.prepare("UPDATE article_mapping_candidates SET current_topic_id=?,current_cluster_id=?,current_keyword_id=?,status=?,updated_at=? WHERE id=? AND client_id=?").bind(topicId,clusterId,keywordId,modified?"MODIFIED":"APPROVED",now(),mappingId,clientId),db.prepare("INSERT INTO keyword_article_relations (id,keyword_id,article_id,relation_type,confidence,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(keyword_id,article_id,relation_type) DO UPDATE SET confidence=excluded.confidence").bind(id(),keywordId,item.article_id,"primary",1,now())]);
      await log(clientId, modified ? "記事マッピングを修正して承認" : "記事マッピングを承認"); return json({ok:true,status:modified?"MODIFIED":"APPROVED",keywordId});
    }
    const briefRoute = route.match(/^clients\/([^/]+)\/briefs$/);
    if (briefRoute) {
      const owner = await requireOwner(request), clientId = briefRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request), stamp = now(), keywordId = String(body.keywordId || "") || null;
      if (keywordId && !(await runtime().DB.prepare("SELECT id FROM seo_keywords WHERE id=? AND client_id=?").bind(keywordId, clientId).first())) return json({ error: "このクライアントのキーワードを選んでください。" }, 422);
      const item = { id: id(), clientId, keywordId, intent: String(body.searchIntent || "unknown").slice(0, 50), targetUser: String(body.targetUser || "").slice(0, 2000), explicitNeed: String(body.explicitNeed || "").slice(0, 4000), latentNeed: String(body.latentNeed || "").slice(0, 4000), desiredOutcome: String(body.desiredOutcome || "").slice(0, 4000), cta: String(body.cta || "").slice(0, 2000), status: "draft", stamp };
      await runtime().DB.prepare("INSERT INTO content_briefs (id,client_id,keyword_id,search_intent,target_user,explicit_need,latent_need,desired_outcome,cta,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(item.id,item.clientId,item.keywordId,item.intent,item.targetUser,item.explicitNeed,item.latentNeed,item.desiredOutcome,item.cta,item.status,item.stamp,item.stamp).run();
      await log(clientId, "Content Briefを作成");
      return json({ ok: true, item }, 201);
    }
    const seoEntity = route.match(/^clients\/([^/]+)\/(topics|clusters|keywords)$/);
    if (seoEntity) {
      const owner = await requireOwner(request), [, clientId, kind] = seoEntity;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request), stamp = now(), db = runtime().DB;
      if (kind === "topics") {
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "Topic名を入力してください。" }, 422);
        const item = { id: id(), clientId, parentTopicId: String(body.parentTopicId || "") || null, name: name.slice(0, 160), description: String(body.description || "").slice(0, 3000), status: "active", createdAt: stamp, updatedAt: stamp };
        await db.prepare("INSERT INTO topics (id,client_id,parent_topic_id,name,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(item.id,item.clientId,item.parentTopicId,item.name,item.description,item.status,item.createdAt,item.updatedAt).run();
        return json({ ok: true, item }, 201);
      }
      if (kind === "clusters") {
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "Cluster名を入力してください。" }, 422);
        const item = { id: id(), clientId, topicId: String(body.topicId || "") || null, parentClusterId: String(body.parentClusterId || "") || null, name: name.slice(0,160), description: String(body.description || "").slice(0,3000), status:"active", createdAt:stamp, updatedAt:stamp };
        await db.prepare("INSERT INTO keyword_clusters (id,client_id,topic_id,parent_cluster_id,name,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(item.id,item.clientId,item.topicId,item.parentClusterId,item.name,item.description,item.status,item.createdAt,item.updatedAt).run();
        return json({ ok:true,item },201);
      }
      const keyword = String(body.keyword || "").trim(), normalized = normalizeKeyword(keyword);
      if (!normalized) return json({ error:"キーワードを入力してください。" },422);
      const existing = await db.prepare("SELECT id FROM seo_keywords WHERE client_id=? AND normalized_keyword=?").bind(clientId,normalized).first<any>();
      if (existing) return json({ error:"同じ表記のキーワードは既に登録されています。" },409);
      const raw = { searchVolume:body.searchVolume, keywordDifficulty:body.keywordDifficulty, businessRelevance:body.businessRelevance, conversionPotential:body.conversionPotential, topicalRelevance:body.topicalRelevance, rankingOpportunity:body.rankingOpportunity, currentPosition:body.currentPosition, impressions:body.impressions };
      const item = { id:id(), clientId, topicId:String(body.topicId||"")||null, clusterId:String(body.clusterId||"")||null, keyword:keyword.slice(0,240), normalized, intent:String(body.searchIntent||"unknown"), status:String(body.status||"candidate"), priority:scoreKeyword(raw, defaultPriorityWeights), stamp };
      await db.prepare("INSERT INTO seo_keywords (id,client_id,topic_id,cluster_id,keyword,normalized_keyword,search_intent,search_volume,keyword_difficulty,current_position,impressions,business_relevance,conversion_potential,topical_relevance,ranking_opportunity,priority_score,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(item.id,item.clientId,item.topicId,item.clusterId,item.keyword,item.normalized,item.intent,Number(body.searchVolume)||null,Number(body.keywordDifficulty)||null,Number(body.currentPosition)||null,Number(body.impressions)||null,Number(body.businessRelevance)||null,Number(body.conversionPotential)||null,Number(body.topicalRelevance)||null,Number(body.rankingOpportunity)||null,item.priority,item.status,item.stamp,item.stamp).run();
      return json({ ok:true,item },201);
    }
    if (source) {
      const owner = await requireOwner(request);
      const clientId = source[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      const title = String(body.title || "").trim();
      const note = String(body.note || "").trim();
      if (!title) return json({ error: "タイトルを入力してください。" }, 422);
      if (!note)
        return json({ error: "一次情報の内容を入力してください。" }, 422);
      const rights = String(body.rights || "unconfirmed").slice(0, 100);
      const stamp = now();
      const canonical = await runtime()
        .DB.prepare(
          "SELECT * FROM sources WHERE client_id=? AND is_canonical=1 AND archived=0 LIMIT 1",
        )
        .bind(clientId)
        .first<any>();
      if (canonical) {
        const nextNote =
          `${String(canonical.note || "").trim()}\n\n【手動追加：${title.slice(0, 120)}】\n${note}`.slice(
            0,
            10000,
          );
        const approved = rights === "approved" ? 1 : 0;
        await runtime()
          .DB.prepare(
            "UPDATE sources SET note=?,rights=?,approved=?,canonical_status='candidate',updated_at=? WHERE id=? AND client_id=?",
          )
          .bind(nextNote, rights, approved, stamp, canonical.id, clientId)
          .run();
        await runtime()
          .DB.prepare(
            "UPDATE clients SET primary_info_status='missing',updated_at=? WHERE id=?",
          )
          .bind(stamp, clientId)
          .run();
        await log(clientId, `正式な一次情報へ手入力を追加: ${title}`);
        return json({
          ok: true,
          updatedCanonical: true,
          source: {
            ...canonical,
            note: nextNote,
            rights,
            approved,
            canonical_status: "candidate",
            updated_at: stamp,
          },
        });
      }
      const item = {
        id: id(),
        client_id: clientId,
        type: String(body.type || "manual_entry").slice(0, 80),
        title: title.slice(0, 200),
        note: note.slice(0, 10000),
        url: String(body.url || "")
          .trim()
          .slice(0, 2000),
        rights,
        approved: rights === "approved" || body.approved ? 1 : 0,
        is_canonical: 1,
        archived: 0,
        canonical_status: "candidate",
        created_at: stamp,
        updated_at: stamp,
      };
      await runtime()
        .DB.prepare(
          "INSERT INTO sources (id,client_id,type,title,note,url,rights,approved,is_canonical,archived,canonical_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(...Object.values(item))
        .run();
      await log(clientId, "正式な一次情報を手入力で作成");
      return json({ ok: true, source: item }, 201);
    }
    const retryJobRoute = route.match(
      /^clients\/([^/]+)\/jobs\/([^/]+)\/retry$/,
    );
    if (retryJobRoute) {
      const owner = await requireOwner(request);
      const clientId = retryJobRoute[1];
      const jobId = retryJobRoute[2];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const database = runtime().DB;
      const previous = await database
        .prepare(
          "SELECT * FROM jobs WHERE id=? AND client_id=? AND type IN ('keyword_strategy','content_audit')",
        )
        .bind(jobId, clientId)
        .first<any>();
      if (!previous)
        return json({ error: "再実行できる処理が見つかりません。" }, 404);
      if (!["running", "failed"].includes(previous.status))
        return json(
          { error: "待機中または完了済みの処理は再実行できません。" },
          409,
        );
      const stamp = now();
      const nextId = id();
      await database.batch([
        database
          .prepare(
            "UPDATE jobs SET status='failed',error='利用者が停止して再実行しました',lease_until=NULL,updated_at=? WHERE id=? AND client_id=?",
          )
          .bind(stamp, jobId, clientId),
        database
          .prepare(
            "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            nextId,
            clientId,
            previous.type,
            "queued",
            previous.payload,
            null,
            0,
            null,
            null,
            stamp,
            stamp,
          ),
      ]);
      // A retry requested from the dashboard should not wait for the next
      // five-minute cron tick. Dispatch failure still leaves the durable
      // queued job for the Queue/cron fallback.
      await dispatchCloudJob(nextId, false, new URL(request.url).origin).catch(() => undefined);
      await log(clientId, `${previous.type}の停止処理を再実行`);
      return json({ ok: true, jobId: nextId }, 202);
    }
    const automationRoute = route.match(
      /^clients\/([^/]+)\/content-automation$/,
    );
    const automationToggleRoute = route.match(
      /^clients\/([^/]+)\/content-automation\/toggle$/,
    );
    if (automationToggleRoute) {
      const owner = await requireOwner(request);
      const clientId = automationToggleRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const existing = await runtime().DB.prepare("SELECT public_config FROM connections WHERE client_id=? AND connector='content_automation'").bind(clientId).first<any>();
      const config = parse(existing?.public_config, {
        auditHour: 6, strategyDay: 1, strategyHour: 9, weeklyArticles: 3,
        maxRewrites: 2, autoCreateDrafts: true, scheduleDays: [1], publishHour: 10,
        categoryRotation: [], defaultCategoryId: 0, safetyMode: "wordpress_draft_only",
      });
      const enabled = !Boolean(config.enabled);
      const stamp = now();
      await runtime().DB.prepare(
        "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
      ).bind(id(), clientId, "content_automation", enabled ? "connected" : "disabled", JSON.stringify({ ...config, enabled }), stamp, stamp).run();
      await log(clientId, enabled ? "自動運用を有効化" : "自動運用を無効化");
      return json({ ok: true, enabled, config: { ...config, enabled } });
    }
    if (automationRoute) {
      const owner = await requireOwner(request);
      const clientId = automationRoute[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      const scheduleDays = String(body.scheduleDays || "1,4").split(",").map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).slice(0, 7);
      const categoryRotation = String(body.categoryRotation || "").split(",").map(Number).filter((categoryId) => Number.isInteger(categoryId) && categoryId > 0).slice(0, 20);
      const config = {
        enabled: body.enabled === "yes",
        auditHour: Math.min(23, Math.max(0, Number(body.auditHour || 6))),
        strategyDay: Math.min(6, Math.max(0, Number(body.strategyDay ?? 1))),
        strategyHour: Math.min(23, Math.max(0, Number(body.strategyHour ?? 9))),
        weeklyArticles: Math.min(
          7,
          Math.max(1, Number(body.weeklyArticles || 3)),
        ),
        maxRewrites: Math.min(5, Math.max(1, Number(body.maxRewrites || 2))),
        autoCreateDrafts: body.autoCreateDrafts === "yes",
        scheduleDays: scheduleDays.length ? scheduleDays : [1],
        publishHour: Math.min(23, Math.max(0, Number(body.publishHour ?? 10))),
        categoryRotation,
        defaultCategoryId: Math.max(0, Number(body.defaultCategoryId || 0)),
        safetyMode: "wordpress_draft_only",
      };
      const stamp = now();
      await runtime()
        .DB.prepare(
          "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
        )
        .bind(
          id(),
          clientId,
          "content_automation",
          config.enabled ? "connected" : "disabled",
          JSON.stringify(config),
          stamp,
          stamp,
        )
        .run();
      await log(clientId, "記事の自動選定・点検設定を更新");
      return json({ ok: true, config });
    }
    const wordpressTestDraftRoute = route.match(
      /^clients\/([^/]+)\/wordpress\/test-draft$/,
    );
    const featuredImageRoute = route.match(/^clients\/([^/]+)\/jobs\/([^/]+)\/generate-featured-image$/);
    if (featuredImageRoute) {
      const owner = await requireOwner(request);
      const [, clientId, jobId] = featuredImageRoute;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const job = await runtime().DB.prepare("SELECT result FROM jobs WHERE id=? AND client_id=? AND type='article_generate'").bind(jobId, clientId).first<any>();
      const result = parse(job?.result, null);
      if (!result?.article || !result?.wordpressDraft?.id) return json({ error: "WordPressへ入稿済みの記事だけにアイキャッチを追加できます。" }, 400);
      const generated = await generateRequiredArticleImages(clientId, result.article);
      const featured = generated.media[0];
      if (!featured?.id) return json({ error: generated.errors[0] || "GPT Image 2でアイキャッチを生成できませんでした。" }, 502);
      const wp = await runtime().DB.prepare("SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'").bind(clientId).first<any>();
      const config = parse(wp?.public_config, {}); const secret = wp?.secret_cipher ? await decrypt<any>(wp.secret_cipher) : null;
      const response = await fetch(`${wordpressBase(config.siteUrl)}/wp-json/wp/v2/posts/${result.wordpressDraft.id}`, { method: "POST", headers: { Authorization: `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}`, "Content-Type": "application/json" }, body: JSON.stringify({ content: generated.article.html, featured_media: featured.id, categories: Number(result.article.category_id || 0) > 0 ? [Number(result.article.category_id)] : undefined }) });
      const draft = await response.json().catch(() => ({})) as any;
      if (!response.ok) return json({ error: draft.message || `WordPress ${response.status}` }, 502);
      result.article = generated.article; result.generatedImages = [...(result.generatedImages || []), ...generated.media]; result.featuredMediaId = featured.id; result.wordpressDraft.featuredMediaId = featured.id;
      await runtime().DB.prepare("UPDATE jobs SET result=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify(result), now(), jobId, clientId).run();
      await log(clientId, "既存WordPress下書きへGPT Image 2のアイキャッチを設定", "info", { jobId, postId: result.wordpressDraft.id, featuredMediaId: featured.id });
      return json({ ok: true, featuredMediaId: featured.id, link: draft.link || result.wordpressDraft.link });
    }
    if (wordpressTestDraftRoute) {
      const owner = await requireOwner(request);
      const clientId = wordpressTestDraftRoute[1];
      const client = await ownedClient(clientId, owner);
      if (!client)
        return json({ error: "クライアントが見つかりません。" }, 404);
      const wp = await runtime()
        .DB.prepare(
          "SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'",
        )
        .bind(clientId)
        .first<any>();
      if (!wp?.secret_cipher)
        return json(
          {
            error:
              "WordPressが未接続です。連携設定でWordPressの接続確認を完了してください。",
          },
          409,
        );
      try {
        const config = parse(wp.public_config, {});
        const secret = await decrypt<any>(wp.secret_cipher);
        const stamp = new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date());
        const title = `【公開禁止・動作確認】SEO Loopテスト入稿 ${stamp}`;
        const content = `<p><strong>これはSEO LoopとWordPressの接続確認専用テストです。公開しないでください。</strong></p><p>対象クライアント：${String(client.name || "").replace(/[<>&\"']/g, "")}</p><p>対象サイト：${String(client.site || "").replace(/[<>&\"']/g, "")}</p><p>この下書きが表示されていれば、SEO LoopからWordPressへの入稿連携は正常です。確認後は削除して構いません。</p>`;
        if (config.authMode === "xmlrpc") {
          const draft = await wordpressXmlRpcDraft(config.siteUrl, config.username, secret.applicationPassword, title, content);
          await log(clientId, `WordPressテスト下書きを作成（投稿ID: ${draft.id}、未公開）`);
          return json({ ok: true, draft: { ...draft, status: "draft", link: "" } }, 201);
        }
        const response = await fetch(
          `${wordpressBase(config.siteUrl)}/wp-json/wp/v2/posts`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title,
              content,
              status: "draft",
            }),
          },
        );
        const rawDraft = await response.text();
        let draft: any;
        try { draft = rawDraft ? JSON.parse(rawDraft) : {}; } catch { throw new Error("WordPress REST APIがHTMLを返しました。連携設定でWordPress URLを保存し直してください（/wp-adminや/wp-login.phpは不要です）。"); }
        if (!response.ok)
          throw new Error(draft.message || `WordPress ${response.status}`);
        const siteUrl = wordpressBase(config.siteUrl);
        await log(
          clientId,
          `WordPressテスト下書きを作成（投稿ID: ${draft.id}、未公開）`,
        );
        return json(
          {
            ok: true,
            draft: {
              id: draft.id,
              status: draft.status,
              link: draft.link,
              editUrl: `${siteUrl}/wp-admin/post.php?post=${draft.id}&action=edit`,
            },
          },
          201,
        );
      } catch (error: any) {
        await log(clientId, "WordPressテスト下書きの作成に失敗");
        return json(
          {
            error: `WordPressへのテスト入稿に失敗しました：${error.message || String(error)}`,
          },
          502,
        );
      }
    }
    const cancelJobRoute = route.match(/^clients\/([^/]+)\/jobs\/([^/]+)\/cancel$/);
    if (cancelJobRoute) {
      const owner = await requireOwner(request);
      const [, clientId, jobId] = cancelJobRoute;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const job = await runtime().DB.prepare("SELECT type,status,payload FROM jobs WHERE id=? AND client_id=?").bind(jobId, clientId).first<any>();
      if (!job || job.type !== "article_generate") return json({ error: "停止できる記事生成ジョブが見つかりません。" }, 404);
      if (!["queued", "running"].includes(job.status)) return json({ error: "完了・停止済みの記事は停止できません。" }, 409);
      await runtime().DB.prepare("UPDATE jobs SET status='cancelled',lease_until=NULL,error=?,updated_at=? WHERE id=? AND client_id=?").bind("利用者が記事生成を停止", now(), jobId, clientId).run();
      await log(clientId, "記事生成を個別停止");
      return json({ ok: true, status: "cancelled" });
    }
    const cancelImmediateJobsRoute = route.match(/^clients\/([^/]+)\/jobs\/immediate\/cancel-all$/);
    if (cancelImmediateJobsRoute) {
      const owner = await requireOwner(request);
      const clientId = cancelImmediateJobsRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const stopped = await runtime().DB.prepare("UPDATE jobs SET status='cancelled',lease_until=NULL,error=?,updated_at=? WHERE client_id=? AND type='article_generate' AND status IN ('queued','running') AND (json_extract(payload,'$.immediate')=true OR json_extract(payload,'$.automaticComplement')=true)").bind("利用者が即日入稿を一括停止", now(), clientId).run();
      await log(clientId, "即日入稿を全件停止", "warn", { count: stopped.meta.changes || 0 });
      return json({ ok: true, count: stopped.meta.changes || 0 });
    }
    if (route === "jobs/articles/cancel-all") {
      const owner = await requireOwner(request);
      const stopped = await runtime().DB.prepare("UPDATE jobs SET status='cancelled',lease_until=NULL,error=?,updated_at=? WHERE type='article_generate' AND status IN ('queued','running') AND client_id IN (SELECT id FROM clients WHERE owner_id=?)").bind("利用者が全記事生成を停止", now(), owner).run();
      return json({ ok: true, count: stopped.meta.changes || 0 });
    }
    const jobRoute = route.match(/^clients\/([^/]+)\/jobs$/);
    const mappingAnalyzeRoute = route.match(/^clients\/([^/]+)\/article-mappings\/analyze$/);
    if (mappingAnalyzeRoute) {
      const owner = await requireOwner(request), clientId = mappingAnalyzeRoute[1];
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request), articleId = String(body.articleId || "");
      const stamp = now(), job = { id:id(), client_id:clientId, type:"article_mapping_analyze", status:"queued", payload:JSON.stringify({articleId:articleId || null}), result:null, attempts:0, lease_until:null, error:null, created_at:stamp, updated_at:stamp };
      if (articleId) await runtime().DB.prepare("UPDATE article_mapping_candidates SET status='REANALYZING',updated_at=? WHERE client_id=? AND article_id=?").bind(stamp,clientId,articleId).run();
      await runtime().DB.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();
      await dispatchCloudJob(job.id,true,new URL(request.url).origin).catch(() => undefined);
      await log(clientId,"WordPress記事マッピングのAI再分析をQueueへ追加"); return json({ok:true,job},202);
    }
    if (jobRoute) {
      const owner = await requireOwner(request);
      const clientId = jobRoute[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body: any = await input(request);
      const allowed = [
        "ubersuggest_sync",
        "article_generate",
        "monthly_report",
        "aio_observe",
        "sync_google",
        "sync_connector",
        "primary_info_assist",
        "keyword_strategy",
        "content_audit",
        "article_mapping_analyze",
        "serp_analyze",
        "serp_competitor_analyze",
      ];
      if (!allowed.includes(body.type))
        return json({ error: "未対応のジョブです。" }, 422);
      if (body.type === "serp_analyze") {
        const keywordId = String(body.payload?.keywordId || ""), keyword = await runtime().DB.prepare("SELECT keyword FROM seo_keywords WHERE id=? AND client_id=? AND status<>'archived'").bind(keywordId, clientId).first<any>();
        if (!keyword) return json({ error: "有効なSEO Keywordを選択してください。" }, 422);
        body.payload = { ...body.payload, keywordId, keyword: keyword.keyword, language: typeof body.payload?.language === "string" ? body.payload.language.slice(0,20) : "", device: body.payload?.device === "mobile" ? "mobile" : "desktop" };
      }
      if (body.type === "serp_competitor_analyze") {
        const snapshotId = String(body.payload?.snapshotId || "");
        const snapshot = await runtime().DB.prepare("SELECT s.id,k.keyword FROM serp_snapshots s JOIN seo_keywords k ON k.id=s.keyword_id WHERE s.id=? AND s.client_id=? AND s.status='SUCCESS'").bind(snapshotId, clientId).first<any>();
        if (!snapshot) return json({ error: "完了済みのSERP取得結果を選択してください。" }, 422);
        body.payload = { ...body.payload, snapshotId, keyword: snapshot.keyword };
      }
      // A sync request is idempotent while it is already waiting or running.
      // Older deployments could leave a D1 job without its Queue message, so
      // retry delivery of that exact job instead of creating a duplicate.
      if (body.type === "ubersuggest_sync") {
        const pending = await runtime()
          .DB.prepare(
            "SELECT * FROM jobs WHERE client_id=? AND type='ubersuggest_sync' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
          )
          .bind(clientId)
          .first<any>();
        if (pending) {
          try {
            const dispatched = await dispatchCloudJob(
              pending.id,
              true,
              new URL(request.url).origin,
            );
            if (!dispatched)
              throw new Error("Cloudflare Workerの送信先URLが未設定です。");
            await log(clientId, "待機中のUbersuggest同期をCloudflare Queueへ再送");
          } catch (error: any) {
            await log(
              clientId,
              "待機中Ubersuggest同期のQueue再送に失敗。定期実行で再試行します。",
              "warn",
              { error: String(error?.message || error).slice(0, 300) },
            );
          }
          return json(
            { ok: true, replayed: true, job: { ...pending, payload: parse(pending.payload, {}) } },
            202,
          );
        }
      }
      if (body.type === "primary_info_assist") {
        const pending = await runtime()
          .DB.prepare(
            "SELECT * FROM jobs WHERE client_id=? AND type='primary_info_assist' AND status IN ('queued','running') ORDER BY updated_at DESC LIMIT 1",
          )
          .bind(clientId)
          .first<any>();
        if (pending) {
          const idleMs = Date.now() - Date.parse(String(pending.updated_at || 0));
          // The request itself has a 60-second budget plus one finite retry.
          // Four minutes without a progress/result update is therefore stale,
          // rather than a reason to permanently disable the user's retry.
          if (Number.isFinite(idleMs) && idleMs > 4 * 60 * 1000) {
            await runtime()
              .DB.prepare("UPDATE jobs SET status='failed',lease_until=NULL,error=?,updated_at=? WHERE id=? AND client_id=? AND status IN ('queued','running')")
              .bind("一次情報のAI処理が4分間更新されなかったため、安全に停止しました。", now(), pending.id, clientId)
              .run();
            await log(clientId, "停止した一次情報AI処理を再実行可能な状態へ戻しました", "warn");
          } else {
            return json(
              { ok: true, idempotent: true, job: { ...pending, payload: parse(pending.payload, {}) } },
              202,
            );
          }
        }
      }
      if (body.type === "article_generate" && body.payload?.planKey) {
        const existing = await runtime()
          .DB.prepare(
            "SELECT id,status,payload FROM jobs WHERE client_id=? AND type='article_generate' AND status IN ('queued','running','completed') ORDER BY created_at DESC LIMIT 200",
          )
          .bind(clientId)
          .all<any>();
        const duplicate = existing.results.find(
          (job: any) =>
            parse(job.payload, {}).planKey === body.payload.planKey,
        );
        if (
          duplicate &&
          body.payload.immediate &&
          duplicate.status === "queued" &&
          !parse(duplicate.payload, {}).immediate
        ) {
          const scheduledPayload = parse(duplicate.payload, {});
          const variationAngle = "比較・選び方と判断基準";
          await runtime()
            .DB.prepare("UPDATE jobs SET payload=?,updated_at=? WHERE id=? AND client_id=?")
            .bind(
              JSON.stringify({
                ...scheduledPayload,
                planKey: `${body.payload.planKey}:auto-complement`,
                plannedTitle: `${scheduledPayload.plannedTitle || scheduledPayload.keyword || "同テーマの記事"}｜${variationAngle}`,
                automaticComplement: true,
                variationAngle,
                brief: `${scheduledPayload.brief || ""}\n即日入稿済みの主記事とは異なる切り口（${variationAngle}）で、タイトル・見出し・事例・FAQを重複させない補完記事を作成してください。`,
              }),
              now(),
              duplicate.id,
              clientId,
            )
            .run();
        } else if (duplicate)
          return json(
            {
              error:
                duplicate.status === "completed"
                  ? "このAI計画の記事はすでに制作済みです。記事ジョブまたはWordPress下書きを確認してください。"
                  : "このAI計画の記事はすでに制作待ち、または制作中です。",
              jobId: duplicate.id,
            },
            409,
          );
      }
      const item = {
        id: id(),
        client_id: clientId,
        type: body.type,
        status: "queued",
        payload: JSON.stringify(body.payload || {}),
        result: null,
        attempts: 0,
        lease_until: null,
        error: null,
        created_at: now(),
        updated_at: now(),
      };
      await runtime()
        .DB.prepare(
          "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(...Object.values(item))
        .run();
      if (body.type === "article_generate" && body.payload?.immediate && body.payload?.planKey) {
        const automation = await runtime()
          .DB.prepare("SELECT public_config FROM connections WHERE client_id=? AND connector='content_automation' AND status='connected'")
          .bind(clientId)
          .first<any>();
        const automationConfig = parse(automation?.public_config, {});
        const complementaryPlanKey = `${body.payload.planKey}:auto-complement`;
        const existingComplement = await runtime()
          .DB.prepare("SELECT id FROM jobs WHERE client_id=? AND type='article_generate' AND json_extract(payload,'$.planKey')=? LIMIT 1")
          .bind(clientId, complementaryPlanKey)
          .first<any>();
        if (automationConfig.autoCreateDrafts && !existingComplement) {
          const variationAngle = "導入手順と実践のポイント";
          const complementaryPayload = {
            ...body.payload,
            immediate: false,
            planKey: complementaryPlanKey,
            plannedTitle: `${body.payload.plannedTitle || body.payload.keyword || "同テーマの記事"}｜${variationAngle}`,
            automaticComplement: true,
            variationAngle,
            brief: `${body.payload.brief || ""}\n即日入稿済みの主記事とは異なる切り口（${variationAngle}）で、タイトル・見出し・事例・FAQを重複させない補完記事を作成してください。`,
          };
          const scheduledItem = {
            ...item,
            id: id(),
            payload: JSON.stringify(complementaryPayload),
            created_at: now(),
            updated_at: now(),
          };
          await runtime()
            .DB.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .bind(...Object.values(scheduledItem))
            .run();
          await log(clientId, "即日入稿済みの計画に対し、自動投稿用の補完記事を予約");
        }
      }
      await log(clientId, `${body.type}をキューへ追加`);
      try {
        await dispatchCloudJob(
          item.id,
          body.type === "ubersuggest_sync",
          new URL(request.url).origin,
        );
      } catch (error: any) {
        // The D1 job remains queued and the five-minute cron runner will pick
        // it up.  Saving the request must not be rolled back only because an
        // immediate Queue delivery was temporarily unavailable.
        await log(
          clientId,
          "Cloudflare Queueへの即時送信に失敗。定期実行で再試行します。",
          "warn",
          { error: String(error?.message || error).slice(0, 300) },
        );
      }
      return json(
        { ok: true, job: { ...item, payload: body.payload || {} } },
        202,
      );
    }
    const register = route.match(/^clients\/([^/]+)\/worker\/register$/);
    if (register) {
      const owner = await requireOwner(request);
      const clientId = register[1];
      if (!(await ownedClient(clientId, owner)))
        return json({ error: "クライアントが見つかりません。" }, 404);
      const body = await input(request);
      const token = `slw_${crypto.randomUUID().replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "")}`;
      const db = runtime().DB;
      await db
        .prepare(
          "DELETE FROM worker_tokens WHERE client_id IN (SELECT id FROM clients WHERE owner_id=?)",
        )
        .bind(owner)
        .run();
      await db
        .prepare(
          "INSERT INTO worker_tokens (id,client_id,token_hash,name,last_seen_at,created_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          id(),
          clientId,
          await sha256(token),
          (body.name || "Macローカルワーカー").slice(0, 120),
          null,
          now(),
        )
        .run();
      await db.batch([
        db
          .prepare(
            "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,updated_at=excluded.updated_at",
          )
          .bind(
            id(),
            clientId,
            "codex",
            "waiting_worker",
            JSON.stringify({ mode: "local_subscription_oauth" }),
            null,
            now(),
          ),
        db
          .prepare(
            "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,updated_at=excluded.updated_at",
          )
          .bind(
            id(),
            clientId,
            "ubersuggest",
            "waiting_worker",
            JSON.stringify({ mode: "codex_mcp" }),
            null,
            now(),
          ),
      ]);
      await log(
        clientId,
        "Macワーカートークンを再発行し、全クライアント共通ワーカーとして登録",
      );
      return json(
        {
          ok: true,
          token,
          note: "以前のワーカートークンは無効化されました。このトークンは再表示されません。",
        },
        201,
      );
    }
    if (route === "worker/retry-schema-failed-article") {
      const registered = await worker(request);
      if (!registered)
        return json({ error: "ワーカートークンが無効です。" }, 401);
      const db = runtime().DB;
      const anchor = await db
        .prepare("SELECT owner_id FROM clients WHERE id=?")
        .bind(registered.client_id)
        .first<any>();
      if (!anchor)
        return json({ error: "ワーカーの登録先が見つかりません。" }, 401);
      const active = await db
        .prepare(
          "SELECT j.id FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.type='article_generate' AND j.status IN ('queued','running') LIMIT 1",
        )
        .bind(anchor.owner_id)
        .first();
      if (active) return json({ ok: true, alreadyQueued: true });
      const failed = await db
        .prepare(
          "SELECT j.* FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.type='article_generate' AND j.status='failed' ORDER BY j.updated_at DESC LIMIT 1",
        )
        .bind(anchor.owner_id)
        .first<any>();
      if (!failed)
        return json({ error: "再実行する失敗済みの記事ジョブがありません。" }, 404);
      const stamp = now();
      const item = {
        id: id(), client_id: failed.client_id, type: "article_generate", status: "queued",
        payload: failed.payload, result: null, attempts: 0, lease_until: null, error: null,
        created_at: stamp, updated_at: stamp,
      };
      await db.batch([
        db.prepare("UPDATE jobs SET error='Codexスキーマ修正後に自動再実行',updated_at=? WHERE id=?").bind(stamp, failed.id),
        db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(item)),
      ]);
      await log(failed.client_id, "Codexスキーマ修正後に記事生成を1回自動再実行");
      return json({ ok: true, jobId: item.id }, 202);
    }
    if (route === "worker/retry-latest-primary") {
      const registered = await worker(request);
      if (!registered)
        return json({ error: "ワーカートークンが無効です。" }, 401);
      const db = runtime().DB;
      const anchor = await db
        .prepare("SELECT owner_id FROM clients WHERE id=?")
        .bind(registered.client_id)
        .first<any>();
      if (!anchor)
        return json({ error: "ワーカーの登録先が見つかりません。" }, 401);
      const active = await db
        .prepare(
          "SELECT j.id FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.type='primary_info_assist' AND j.status IN ('queued','running') LIMIT 1",
        )
        .bind(anchor.owner_id)
        .first();
      if (active) return json({ ok: true, alreadyQueued: true });
      const failed = await db
        .prepare(
          "SELECT j.* FROM jobs j JOIN clients c ON c.id=j.client_id WHERE c.owner_id=? AND j.type='primary_info_assist' AND j.status='failed' ORDER BY j.updated_at DESC LIMIT 1",
        )
        .bind(anchor.owner_id)
        .first<any>();
      if (!failed)
        return json({ error: "再実行できる一次情報ジョブがありません。" }, 404);
      const stamp = now();
      const item = {
        id: id(),
        client_id: failed.client_id,
        type: "primary_info_assist",
        status: "queued",
        payload: failed.payload,
        result: null,
        attempts: 0,
        lease_until: null,
        error: null,
        created_at: stamp,
        updated_at: stamp,
      };
      await db
        .prepare(
          "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(...Object.values(item))
        .run();
      await log(failed.client_id, "失敗した一次情報整理を前回回答で再実行");
      return json({ ok: true, jobId: item.id }, 202);
    }
    const titleManualRoute=route.match(/^clients\/([^/]+)\/title-optimization\/([^/]+)\/(approve|reject|execute)$/);
    if(titleManualRoute){const owner=await requireOwner(request),clientId=titleManualRoute[1],actionId=titleManualRoute[2],command=titleManualRoute[3],body:any=await input(request),db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const proposal=await db.prepare("SELECT * FROM title_optimization_proposals WHERE client_id=? AND action_id=?").bind(clientId,actionId).first<any>(),action=await db.prepare("SELECT * FROM autopilot_actions WHERE client_id=? AND id=? AND action_type='TITLE_OPTIMIZATION'").bind(clientId,actionId).first<any>();if(!proposal||!action)return json({error:"TITLE Proposalが見つかりません。"},404);if(command==="approve"){if(proposal.execution_status==="REJECTED")return json({error:"却下済みProposalは承認できません。"},409);if(proposal.execution_status==="APPROVED"||proposal.execution_status==="EXECUTED")return json({ok:true,status:proposal.execution_status,idempotent:true});await db.prepare("UPDATE title_optimization_proposals SET execution_status='APPROVED',updated_at=? WHERE client_id=? AND action_id=?").bind(now(),clientId,actionId).run();await saveAutopilotAudit(clientId,"TITLE_APPROVED",{by:owner},action.run_id,actionId);return json({ok:true,status:"APPROVED"});}if(command==="reject"){if(proposal.execution_status==="EXECUTED")return json({error:"実行済みProposalは却下できません。"},409);if(proposal.execution_status==="REJECTED")return json({ok:true,status:"REJECTED",idempotent:true});await db.prepare("UPDATE title_optimization_proposals SET execution_status='REJECTED',reason=?,updated_at=? WHERE client_id=? AND action_id=?").bind(`${proposal.reason}${body.reason?`\nReject: ${String(body.reason).slice(0,1000)}`:""}`,now(),clientId,actionId).run();await saveAutopilotAudit(clientId,"TITLE_REJECTED",{by:owner,reason:String(body.reason||"").slice(0,1000)},action.run_id,actionId);return json({ok:true,status:"REJECTED"});}if(proposal.execution_status==="EXECUTED")return json({ok:true,status:"EXECUTED",idempotent:true});if(proposal.execution_status!=="APPROVED")return json({error:"承認済みProposalだけ実行できます。"},409);const [global,settings,article]=await Promise.all([db.prepare("SELECT kill_switch_enabled FROM global_autopilot_settings WHERE id='global'").first<any>(),db.prepare("SELECT paused FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>(),db.prepare("SELECT id FROM article_versions WHERE id=? AND client_id=? AND article_id=?").bind(proposal.article_version_id,clientId,proposal.article_id).first<any>()]);if(Number(global?.kill_switch_enabled)||Number(settings?.paused)||proposal.safety_status!=="SAFE"||!article)return json({error:"TITLE_EXECUTION_BLOCKED",status:"HUMAN_REVIEW_REQUIRED"},409);const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type='title_optimize' AND json_extract(payload,'$.actionId')=? AND status IN ('queued','running')").bind(clientId,actionId).first<any>();if(existing)return json({ok:true,status:"QUEUED",jobId:existing.id,idempotent:true});const stamp=now(),job={id:id(),client_id:clientId,type:"title_optimize",status:"queued",payload:JSON.stringify({actionId,manualExecute:true,requestedBy:owner}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await dispatchCloudJob(job.id,false,new URL(request.url).origin).catch(()=>undefined);await saveAutopilotAudit(clientId,"TITLE_MANUAL_EXECUTE_QUEUED",{by:owner},action.run_id,actionId);return json({ok:true,status:"QUEUED",jobId:job.id});}
    const internalManualRoute=route.match(/^clients\/([^/]+)\/internal-links\/([^/]+)\/(approve|reject|execute|rollback)$/);
    if(internalManualRoute){const owner=await requireOwner(request),clientId=internalManualRoute[1],actionId=internalManualRoute[2],command=internalManualRoute[3],body:any=await input(request),db=runtime().DB;if(!(await ownedClient(clientId,owner)))return json({error:"クライアントが見つかりません。"},404);const history=await db.prepare("SELECT * FROM internal_link_execution_history WHERE client_id=? AND action_id=?").bind(clientId,actionId).first<any>();if(!history)return json({error:"INTERNAL_LINK Proposalが見つかりません。"},404);if(command==="approve"){if(history.execution_status==="REJECTED")return json({error:"却下済みProposalは承認できません。"},409);if(["APPROVED","QUEUED","EXECUTED","ALREADY_LINKED"].includes(history.execution_status))return json({ok:true,status:history.execution_status,idempotent:true});await db.prepare("UPDATE internal_link_execution_history SET execution_status='APPROVED',executed_by=?,updated_at=? WHERE id=? AND client_id=?").bind(owner,now(),history.id,clientId).run();return json({ok:true,status:"APPROVED"});}if(command==="reject"){if(["EXECUTED","ALREADY_LINKED"].includes(history.execution_status))return json({error:"実行済みProposalは却下できません。"},409);if(history.execution_status==="REJECTED")return json({ok:true,status:"REJECTED",idempotent:true});await db.prepare("UPDATE internal_link_execution_history SET execution_status='REJECTED',reject_reason=?,executed_by=?,updated_at=? WHERE id=? AND client_id=?").bind(String(body.reason||"").slice(0,2000),owner,now(),history.id,clientId).run();return json({ok:true,status:"REJECTED"});}if(command==="rollback"){if(!history.snapshot_id)return json({error:"Rollback Snapshotが見つかりません。"},404);const snap=await db.prepare("SELECT * FROM wordpress_article_versions WHERE id=? AND client_id=? AND article_id=?").bind(history.snapshot_id,clientId,history.source_article_id).first<any>();if(!snap)return json({error:"Rollback Snapshotが見つかりません。"},404);const job={id:id(),client_id:clientId,type:"wordpress_rollback",status:"queued",payload:JSON.stringify({articleId:history.source_article_id,articleVersionId:snap.article_version_id,snapshotId:snap.id,requestId:`INTERNAL_LINK_ROLLBACK:${history.id}`,requestedBy:owner}),result:null,attempts:0,lease_until:null,error:null,created_at:now(),updated_at:now()};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job)).run();await db.prepare("UPDATE internal_link_execution_history SET execution_status='ROLLED_BACK',updated_at=? WHERE id=? AND client_id=?").bind(now(),history.id,clientId).run();return json({ok:true,status:"ROLLED_BACK",jobId:job.id});}if(history.execution_status==="EXECUTED"||history.execution_status==="ALREADY_LINKED")return json({ok:true,status:history.execution_status,idempotent:true});if(history.execution_status!=="APPROVED")return json({error:"承認済みProposalだけ実行できます。"},409);const [global,settings,sourceMap,targetMap,sourceArticle,targetArticle]=await Promise.all([db.prepare("SELECT kill_switch_enabled FROM global_autopilot_settings WHERE id='global'").first<any>(),db.prepare("SELECT paused FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>(),db.prepare("SELECT * FROM wordpress_article_mappings WHERE client_id=? AND article_id=? AND wordpress_post_id=?").bind(clientId,history.source_article_id,history.source_wp_post_id).first<any>(),db.prepare("SELECT * FROM wordpress_article_mappings WHERE client_id=? AND article_id=? ORDER BY updated_at DESC LIMIT 1").bind(clientId,history.target_article_id).first<any>(),db.prepare("SELECT id FROM article_mapping_candidates WHERE client_id=? AND article_id=? AND status IN ('APPROVED','MODIFIED')").bind(clientId,history.source_article_id).first<any>(),db.prepare("SELECT id FROM article_mapping_candidates WHERE client_id=? AND article_id=? AND status IN ('APPROVED','MODIFIED')").bind(clientId,history.target_article_id).first<any>()]);if(Number(global?.kill_switch_enabled)||Number(settings?.paused)||history.safety_status!=="SAFE"||!sourceMap||!targetMap||!sourceArticle||!targetArticle||!/^https:\/\//i.test(String(targetMap.wordpress_url||""))||String(targetMap.wordpress_url)!==String(history.target_url))return json({error:"INTERNAL_LINK_EXECUTION_BLOCKED"},409);const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type='internal_link_update' AND json_extract(payload,'$.executionId')=? AND status IN ('queued','running')").bind(clientId,history.id).first<any>();if(existing)return json({ok:true,status:"QUEUED",jobId:existing.id,idempotent:true});const job={id:id(),client_id:clientId,type:"internal_link_update",status:"queued",payload:JSON.stringify({actionId,executionId:history.id,sourceArticleId:history.source_article_id,sourceArticleVersionId:history.source_article_version_id,sourceWpPostId:history.source_wp_post_id,targetUrl:history.target_url,placement:{anchor_text:history.anchor_text,placement_type:history.placement_type,placement_reference:history.placement_reference},requestedBy:owner}),result:null,attempts:0,lease_until:null,error:null,created_at:now(),updated_at:now()};await db.batch([db.prepare("UPDATE internal_link_execution_history SET execution_status='QUEUED',executed_by=?,updated_at=? WHERE id=? AND client_id=?").bind(owner,now(),history.id,clientId),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job))]);await dispatchCloudJob(job.id,false,new URL(request.url).origin).catch(()=>undefined);return json({ok:true,status:"QUEUED",jobId:job.id});}
    if(route==="worker/internal-link-execution-permit"){const registered=await worker(request);if(!registered)return json({error:"ワーカートークンが無効です。"},401);const body:any=await input(request),db=runtime().DB,history=await db.prepare("SELECT id FROM internal_link_execution_history WHERE id=? AND action_id=? AND client_id=? AND execution_status='QUEUED'").bind(String(body.executionId||""),String(body.actionId||""),registered.client_id).first<any>(),controls=await Promise.all([db.prepare("SELECT kill_switch_enabled FROM global_autopilot_settings WHERE id='global'").first<any>(),db.prepare("SELECT paused FROM client_autopilot_settings WHERE client_id=?").bind(registered.client_id).first<any>()]);if(!history||Number(controls[0]?.kill_switch_enabled)||Number(controls[1]?.paused))return json({error:"INTERNAL_LINK_EXECUTION_BLOCKED"},409);return json({ok:true});}
    if(route==="worker/internal-link-snapshot"){const registered=await worker(request);if(!registered)return json({error:"ワーカートークンが無効です。"},401);const body:any=await input(request),db=runtime().DB,history=await db.prepare("SELECT * FROM internal_link_execution_history WHERE id=? AND action_id=? AND client_id=?").bind(String(body.executionId||""),String(body.actionId||""),registered.client_id).first<any>();if(!history)return json({error:"Internal Link executionが見つかりません。"},404);if(history.snapshot_id)return json({ok:true,snapshotId:history.snapshot_id,idempotent:true});const before=body.before||{},snapId=id(),stamp=now();await db.prepare("INSERT INTO wordpress_article_versions (id,client_id,article_id,article_version_id,wordpress_post_id,wp_title,wp_slug,wp_content,wp_excerpt,wp_status,categories_json,tags_json,featured_media_id,seo_meta_json,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(snapId,registered.client_id,history.source_article_id,history.source_article_version_id,history.source_wp_post_id,String(before.title?.raw||before.title?.rendered||""),String(before.slug||""),String(before.content?.raw||before.content?.rendered||""),String(before.excerpt?.raw||before.excerpt?.rendered||""),String(before.status||""),JSON.stringify(before.categories||[]),JSON.stringify(before.tags||[]),before.featured_media?String(before.featured_media):null,JSON.stringify(before.meta||{}),stamp).run();await db.prepare("UPDATE internal_link_execution_history SET snapshot_id=?,updated_at=? WHERE id=? AND client_id=? AND snapshot_id IS NULL").bind(snapId,stamp,history.id,registered.client_id).run();return json({ok:true,snapshotId:snapId});}
    if (route === "worker/progress") {
      const registered = await worker(request);
      if (!registered)
        return json({ error: "ワーカートークンが無効です。" }, 401);
      const body = (await request.json()) as any;
      const db = runtime().DB;
      const anchor = await db
        .prepare("SELECT owner_id FROM clients WHERE id=?")
        .bind(registered.client_id)
        .first<any>();
      if (!anchor)
        return json({ error: "ワーカーの登録先が見つかりません。" }, 401);
      const percent = Math.max(0, Math.min(99, Number(body.percent || 0)));
      const stage = String(body.stage || "working").slice(0, 80);
      const detail = String(body.detail || "").slice(0, 300);
      const lease = new Date(Date.now() + 45 * 60 * 1000).toISOString();
      const updated = await db
        .prepare(
          "UPDATE jobs SET result=?,lease_until=?,updated_at=? WHERE id=? AND client_id IN (SELECT id FROM clients WHERE owner_id=?) AND status='running'",
        )
        .bind(
          JSON.stringify({ progress: { percent, stage, detail, updatedAt: now() } }),
          lease,
          now(),
          body.jobId,
          anchor.owner_id,
        )
        .run();
      await db.prepare("UPDATE worker_tokens SET last_seen_at=? WHERE id=?").bind(now(), registered.id).run();
      if (!updated.meta.changes)
        return json({ error: "進捗を更新できる実行中ジョブがありません。" }, 409);
      return json({ ok: true, percent, stage });
    }
    if (route === "worker/result") {
      const registered = await worker(request);
      if (!registered)
        return json({ error: "ワーカートークンが無効です。" }, 401);
      const body = (await request.json()) as any;
      const db = runtime().DB;
      const anchor = await db
        .prepare("SELECT owner_id FROM clients WHERE id=?")
        .bind(registered.client_id)
        .first<any>();
      if (!anchor)
        return json({ error: "ワーカーの登録先が見つかりません。" }, 401);
      const job = await db
        .prepare(
          "SELECT j.* FROM jobs j JOIN clients c ON c.id=j.client_id WHERE j.id=? AND c.owner_id=?",
        )
        .bind(body.jobId, anchor.owner_id)
        .first<any>();
      if (!job) return json({ error: "ジョブが見つかりません。" }, 404);
      await db.prepare("UPDATE worker_tokens SET last_seen_at=? WHERE id=?").bind(now(), registered.id).run();
      // A stopped job must win even if the runner has just finished its work.
      // In particular, do not begin Image 2 generation or WordPress posting.
      if (job.status !== "running")
        return json({ ok: true, ignored: true, status: job.status });
      const clientId = job.client_id;
      let result = body.result || null;
      if (body.ok && job.type === "title_optimize" && result) {
        const payload=parse(job.payload,{}), action=await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=?").bind(String(payload.actionId||""),clientId).first<any>();
        if(!action) throw new Error("TITLE_OPTIMIZATION actionが見つかりません。");
        const version=await db.prepare("SELECT * FROM article_versions WHERE client_id=? AND article_id=? ORDER BY version_no DESC LIMIT 1").bind(clientId,action.target_article_id).first<any>();
        if(!version) throw new Error("対象Article Versionが見つかりません。");
        const seo=await db.prepare("SELECT * FROM article_seo_data WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>();
        const ymyl=await db.prepare("SELECT risk FROM article_ymyl_assessments WHERE client_id=? AND article_version_id=?").bind(clientId,version.id).first<any>();
        const confidence=String(result.confidence||"LOW").toUpperCase(),risk=String(result.risk||"HIGH").toUpperCase();
        const blocked=String(ymyl?.risk)==="HIGH"||confidence==="LOW"||risk==="HIGH"||Boolean(result.misleading||result.intentMismatch||result.contentMismatch||result.unsupportedNumericalClaim||result.unsupportedSuperlative);
        const stamp=now(),before=parse(action.before_metrics_json,{}), proposal={id:id(),client_id:clientId,action_id:action.id,article_id:version.article_id,article_version_id:version.id,old_seo_title:String(seo?.seo_title||parse(version.draft_json,{}).title||""),old_meta_description:String(seo?.meta_description||parse(version.draft_json,{}).meta_description||""),proposed_seo_title:String(result.proposed_seo_title||"").slice(0,500),proposed_meta_description:String(result.proposed_meta_description||"").slice(0,1000),target_queries_json:JSON.stringify(Array.isArray(result.target_queries)?result.target_queries:[]),reason:String(result.reason||"").slice(0,2000),evidence_json:JSON.stringify(Array.isArray(result.evidence)?result.evidence:[]),confidence,risk,safety_status:blocked?"HUMAN_REVIEW_REQUIRED":"SAFE",prompt_version:String(result.prompt_version||"title-optimizer-v1"),before_metrics_json:JSON.stringify(before),execution_status:blocked?"HUMAN_REVIEW_REQUIRED":"PROPOSED",created_at:stamp,updated_at:stamp};
        await db.prepare("INSERT INTO title_optimization_proposals (id,client_id,action_id,article_id,article_version_id,old_seo_title,old_meta_description,proposed_seo_title,proposed_meta_description,target_queries_json,reason,evidence_json,confidence,risk,safety_status,prompt_version,before_metrics_json,execution_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,action_id) DO UPDATE SET proposed_seo_title=excluded.proposed_seo_title,proposed_meta_description=excluded.proposed_meta_description,target_queries_json=excluded.target_queries_json,reason=excluded.reason,evidence_json=excluded.evidence_json,confidence=excluded.confidence,risk=excluded.risk,safety_status=excluded.safety_status,prompt_version=excluded.prompt_version,execution_status=excluded.execution_status,updated_at=excluded.updated_at").bind(...Object.values(proposal)).run();
        const settings:any=await db.prepare("SELECT mode FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>();if(Boolean(payload.manualExecute))settings.mode="AUTO_EXECUTE_SAFE_ACTIONS";
        if(String(settings?.mode)==="AUTO_EXECUTE_SAFE_ACTIONS"&&!blocked){const titleBefore=await titleMetricSummary(clientId,action,28),nextVersionId=id(),draft=String(version.draft_json);await db.prepare("INSERT INTO autopilot_measurements (id,client_id,action_id,window_days,metrics_json,result_status,measured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(action_id,window_days) DO UPDATE SET metrics_json=excluded.metrics_json,result_status=excluded.result_status,measured_at=excluded.measured_at").bind(id(),clientId,action.id,0,JSON.stringify({before:titleBefore,dataStatus:titleBefore.dataStatus}),"INSUFFICIENT_DATA",stamp).run();await db.prepare("UPDATE autopilot_actions SET before_metrics_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify(titleBefore),stamp,action.id,clientId).run();await db.prepare("INSERT INTO article_versions (id,client_id,article_id,version_no,draft_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(nextVersionId,clientId,version.article_id,Number(version.version_no)+1,draft,"DRAFT",stamp,stamp).run();await db.prepare("INSERT INTO article_seo_data (id,client_id,article_id,article_version_id,seo_title,meta_description,focus_keyword,canonical_url,robots,schema_recommendation_json,provider,plugin_sync_status,canonical_status,schema_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id(),clientId,version.article_id,nextVersionId,proposal.proposed_seo_title,proposal.proposed_meta_description,String(seo?.focus_keyword||""),String(seo?.canonical_url||""),String(seo?.robots||"index,follow"),String(seo?.schema_recommendation_json||"{}"),"NATIVE_SEO_LOOP","SEO_PLUGIN_SYNC_NOT_AVAILABLE",String(seo?.canonical_status||"CANONICAL_STORED_IN_SEO_LOOP"),String(seo?.schema_status||"SCHEMA_OUTPUT_NOT_AVAILABLE"),stamp,stamp).run();await db.prepare("INSERT INTO title_optimization_history_v2 (id,client_id,action_id,article_id,article_version_id,old_seo_title,new_seo_title,old_meta_description,new_meta_description,target_queries_json,reason,evidence_json,confidence,risk,prompt_version,execution_status,executed_by,idempotency_key,created_at,native_seo_status,detected_plugin,plugin_sync_status,plugin_sync_error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,idempotency_key) DO NOTHING").bind(id(),clientId,action.id,version.article_id,nextVersionId,proposal.old_seo_title,proposal.proposed_seo_title,proposal.old_meta_description,proposal.proposed_meta_description,proposal.target_queries_json,proposal.reason,proposal.evidence_json,confidence,risk,proposal.prompt_version,"EXECUTED",String(payload.requestedBy||"system"),`TITLE:${action.id}`,stamp,"SUCCESS","UNKNOWN","SEO_PLUGIN_SYNC_NOT_AVAILABLE",null).run();const wpMapping=await db.prepare("SELECT wordpress_post_id FROM wordpress_article_mappings WHERE client_id=? AND article_id=? ORDER BY updated_at DESC LIMIT 1").bind(clientId,version.article_id).first<any>();if(wpMapping?.wordpress_post_id){const syncJob={id:id(),client_id:clientId,type:"wordpress_seo_plugin_sync",status:"queued",payload:JSON.stringify({actionId:action.id,articleVersionId:nextVersionId,wordpressPostId:String(wpMapping.wordpress_post_id),seoTitle:proposal.proposed_seo_title,metaDescription:proposal.proposed_meta_description}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(syncJob)).run();await dispatchCloudJob(syncJob.id,false,new URL(request.url).origin).catch(()=>undefined);}await db.prepare("UPDATE title_optimization_proposals SET execution_status='EXECUTED',updated_at=? WHERE client_id=? AND action_id=?").bind(stamp,clientId,action.id).run();await db.prepare("UPDATE autopilot_actions SET status='COMPLETED',before_metrics_json=?,execution_result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify(titleBefore),JSON.stringify({bodyUnchanged:true,provider:"NATIVE_SEO_LOOP",pluginSync:"OPTIONAL_PENDING",measurement:"SCHEDULED_7D_28D"}),stamp,action.id,clientId).run();}
      }
      if (body.ok && job.type === "internal_link_analyze" && result) {
        const payload=parse(job.payload,{}),action=await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=? AND action_type='INTERNAL_LINK'").bind(String(payload.actionId||""),clientId).first<any>(),candidate=await db.prepare("SELECT * FROM internal_link_candidates WHERE client_id=? AND source_article_id=? AND target_article_id=? AND status='APPROVED'").bind(clientId,String(payload.sourceArticleId||""),String(payload.targetArticleId||"")).first<any>();
        if(!action||!candidate||candidate.source_article_id===candidate.target_article_id||!/^https:\/\//i.test(String(payload.confirmedTargetUrl||"")))throw new Error("INTERNAL_LINK_VALIDATION_FAILED");
        const source=await db.prepare("SELECT * FROM article_versions WHERE id=? AND client_id=? AND article_id=?").bind(String(payload.sourceArticleVersionId||candidate.article_version_id),clientId,candidate.source_article_id).first<any>(); const ymyl=source&&await db.prepare("SELECT risk FROM article_ymyl_assessments WHERE client_id=? AND article_version_id=?").bind(clientId,source.id).first<any>(); if(!source)throw new Error("INTERNAL_LINK_SOURCE_NOT_FOUND");
        const confidence=String(result.confidence||"LOW").toUpperCase(),anchor=String(result.anchor_text||"").trim(),reference=String(result.placement_reference||"").trim(),unsafe=!anchor||!reference||/<|>|https?:\/\//i.test(anchor),safety=unsafe||confidence==="LOW"||String(ymyl?.risk)==="HIGH"?"HUMAN_REVIEW_REQUIRED":"SAFE",status=safety==="SAFE"?"PROPOSED":"HUMAN_REVIEW_REQUIRED",stamp=now();
        await db.prepare("INSERT INTO internal_link_execution_history (id,client_id,action_id,source_article_id,source_article_version_id,target_article_id,source_wp_post_id,target_url,anchor_text,placement_type,placement_reference,reason,confidence,safety_status,snapshot_id,execution_status,prompt_version,executed_by,reject_reason,idempotency_key,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,action_id) DO UPDATE SET anchor_text=excluded.anchor_text,placement_type=excluded.placement_type,placement_reference=excluded.placement_reference,reason=excluded.reason,confidence=excluded.confidence,safety_status=excluded.safety_status,execution_status=excluded.execution_status,prompt_version=excluded.prompt_version,result_json=excluded.result_json,updated_at=excluded.updated_at").bind(id(),clientId,action.id,candidate.source_article_id,source.id,candidate.target_article_id,String(payload.sourceWpPostId||""),String(payload.confirmedTargetUrl),anchor,String(result.placement_type||"inline").slice(0,80),reference.slice(0,1000),String(result.reason||"").slice(0,2000),confidence,safety,null,status,String(result.prompt_version||"internal-link-placement-v1"),"system","",`INTERNAL_LINK:${action.id}`,JSON.stringify({safety_notes:String(result.safety_notes||"").slice(0,1000)}),stamp,stamp).run();
        const mode=await db.prepare("SELECT mode FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>();
        if(status==="PROPOSED"&&String(mode?.mode)==="AUTO_EXECUTE_SAFE_ACTIONS"){const execution=await db.prepare("SELECT * FROM internal_link_execution_history WHERE client_id=? AND action_id=?").bind(clientId,action.id).first<any>(),job={id:id(),client_id:clientId,type:"internal_link_update",status:"queued",payload:JSON.stringify({actionId:action.id,executionId:execution.id,sourceArticleId:execution.source_article_id,sourceArticleVersionId:execution.source_article_version_id,sourceWpPostId:execution.source_wp_post_id,targetUrl:execution.target_url,placement:{anchor_text:execution.anchor_text,placement_type:execution.placement_type,placement_reference:execution.placement_reference},requestedBy:"system"}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.batch([db.prepare("UPDATE internal_link_execution_history SET execution_status='QUEUED',updated_at=? WHERE id=? AND client_id=?").bind(stamp,execution.id,clientId),db.prepare("UPDATE autopilot_actions SET status='EXECUTING',updated_at=? WHERE id=? AND client_id=?").bind(stamp,action.id,clientId),db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(job))]);await dispatchCloudJob(job.id,false).catch(()=>undefined);}else await db.prepare("UPDATE autopilot_actions SET status=?,updated_at=? WHERE id=? AND client_id=?").bind(status==="PROPOSED"?"HUMAN_REVIEW_REQUIRED":status,stamp,action.id,clientId).run();
      }
      if (body.ok && job.type === "internal_link_update" && result) {
        const payload=parse(job.payload,{}),history=await db.prepare("SELECT * FROM internal_link_execution_history WHERE id=? AND client_id=?").bind(String(payload.executionId||""),clientId).first<any>(); if(!history)throw new Error("INTERNAL_LINK_HISTORY_NOT_FOUND"); const stamp=now();
        if(result.executionStatus==="ALREADY_LINKED"){await db.prepare("UPDATE internal_link_execution_history SET execution_status='ALREADY_LINKED',updated_at=? WHERE id=? AND client_id=?").bind(stamp,history.id,clientId).run();}
        else if(result.executionStatus==="HUMAN_REVIEW_REQUIRED"){await db.prepare("UPDATE internal_link_execution_history SET execution_status='HUMAN_REVIEW_REQUIRED',updated_at=? WHERE id=? AND client_id=?").bind(stamp,history.id,clientId).run();}
        else if(result.executionStatus==="EXECUTED") { const source=await db.prepare("SELECT * FROM article_versions WHERE id=? AND client_id=?").bind(history.source_article_version_id,clientId).first<any>();if(!source)throw new Error("INTERNAL_LINK_SOURCE_VERSION_NOT_FOUND");const draft={...parse(source.draft_json,{}),html:String(result.updatedContent||"")},nextId=id(),action=await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=?").bind(history.action_id,clientId).first<any>();await db.prepare("INSERT INTO article_versions (id,client_id,article_id,version_no,draft_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(nextId,clientId,source.article_id,Number(source.version_no)+1,JSON.stringify(draft),"DRAFT",stamp,stamp).run();await db.prepare("UPDATE internal_link_execution_history SET execution_status='EXECUTED',snapshot_id=COALESCE(snapshot_id,?),result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(result.snapshotId||null,JSON.stringify({newArticleVersionId:nextId,bodyChangedOnlyBy:"internal_link"}),stamp,history.id,clientId).run();if(action){const before=await internalLinkMetricSummary(clientId,action,28);await db.prepare("INSERT INTO autopilot_measurements (id,client_id,action_id,window_days,metrics_json,result_status,measured_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(action_id,window_days) DO NOTHING").bind(id(),clientId,action.id,0,JSON.stringify({before,dataStatus:before.dataStatus}),"INSUFFICIENT_DATA",stamp).run();await db.prepare("UPDATE autopilot_actions SET status='COMPLETED',before_metrics_json=?,execution_result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify(before),JSON.stringify({executionId:history.id,newArticleVersionId:nextId,measurement:"SCHEDULED_7D_28D"}),stamp,history.action_id,clientId).run();} }
      }
      if (!body.ok && ["internal_link_analyze","internal_link_update"].includes(job.type)) { const payload=parse(job.payload,{}); if(payload.executionId)await db.prepare("UPDATE internal_link_execution_history SET execution_status='FAILED',result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify({error:String(body.error||"").slice(0,1000)}),now(),String(payload.executionId),clientId).run(); }
      if (body.ok && job.type === "wordpress_seo_plugin_sync" && result) {
        const payload=parse(job.payload,{}), actionId=String(payload.actionId||""), versionId=String(payload.articleVersionId||""), pluginStatus=String(result.pluginSyncStatus||"SEO_PLUGIN_SYNC_NOT_AVAILABLE"), detectedPlugin=String(result.detectedPlugin||"UNKNOWN"), errorCode=result.pluginSyncErrorCode?String(result.pluginSyncErrorCode).slice(0,120):null;
        const history=await db.prepare("SELECT id FROM title_optimization_history_v2 WHERE client_id=? AND action_id=? ORDER BY created_at DESC LIMIT 1").bind(clientId,actionId).first<any>();
        if(history) await db.prepare("UPDATE title_optimization_history_v2 SET native_seo_status=?,detected_plugin=?,plugin_sync_status=?,plugin_sync_error_code=? WHERE id=? AND client_id=?").bind("SUCCESS",detectedPlugin,pluginStatus,errorCode,history.id,clientId).run();
        await db.prepare("UPDATE article_seo_data SET plugin_sync_status=?,updated_at=? WHERE client_id=? AND article_version_id=?").bind(pluginStatus,now(),clientId,versionId).run();
        const action=await db.prepare("SELECT execution_result_json FROM autopilot_actions WHERE id=? AND client_id=?").bind(actionId,clientId).first<any>();
        if(action) await db.prepare("UPDATE autopilot_actions SET execution_result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(JSON.stringify({...parse(action.execution_result_json,{}),nativeSeoStatus:"SUCCESS",detectedPlugin,pluginSyncStatus:pluginStatus,pluginSyncErrorCode:errorCode}),now(),actionId,clientId).run();
      }
      if (body.ok && job.type === "serp_analyze" && result) {
        const keywordId = String(parse(job.payload, {}).keywordId || "");
        const keyword = await db.prepare("SELECT id FROM seo_keywords WHERE id=? AND client_id=?").bind(keywordId, clientId).first<any>();
        if (!keyword) throw new Error("SERP対象Keywordが見つかりません。");
        const existing = await db.prepare("SELECT id FROM serp_snapshots WHERE job_id=? AND client_id=?").bind(job.id,clientId).first<any>();
        const snapshotId = existing?.id || id(), stamp = now(), normalized = result.normalizedResult || {}, rows = Array.isArray(normalized.results) ? normalized.results.slice(0,10) : [];
        const audit = safeMcpAudit({ provider: result.provider, tool_name: result.toolName, requested_at: result.requestedAt, raw_tool_result: result.rawToolResult, normalized_result: normalized });
        if (!existing) await db.prepare("INSERT INTO serp_snapshots (id,client_id,keyword_id,job_id,provider,location,language,device,checked_at,status,raw_data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(snapshotId,clientId,keywordId,job.id,"ubersuggest",String(result.location||""),String(result.language||""),String(result.device||"desktop"),String(result.requestedAt||stamp),rows.length?"SUCCESS":"FAILED",JSON.stringify(audit),stamp).run();
        for (const row of rows) await db.prepare("INSERT INTO serp_results (id,client_id,snapshot_id,rank,result_type,url,domain,title,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_id,rank,url) DO NOTHING").bind(id(),clientId,snapshotId,Number(row.rank),String(row.resultType||"organic"),String(row.url),String(row.domain||""),String(row.title||""),String(row.description||""),stamp).run();
        if (!existing) await db.prepare("INSERT INTO serp_usage_events (id,client_id,provider,keyword_id,request_count,created_at) VALUES (?,?,?,?,?,?)").bind(id(),clientId,"ubersuggest",keywordId,1,stamp).run();
        result.snapshotId = snapshotId;
      }
      if (body.ok && job.type === "serp_competitor_analyze" && result) {
        const snapshotId = String(parse(job.payload, {}).snapshotId || ""), stamp = now();
        const snapshot = await db.prepare("SELECT keyword_id FROM serp_snapshots WHERE id=? AND client_id=? AND status='SUCCESS'").bind(snapshotId, clientId).first<any>();
        if (!snapshot) throw new Error("SERP分析対象が見つかりません。");
        const resultRows = await db.prepare("SELECT id FROM serp_results WHERE snapshot_id=? AND client_id=?").bind(snapshotId, clientId).all<any>();
        const validIds = new Set(resultRows.results.map((row:any) => row.id));
        const pages = Array.isArray(result.pages) ? result.pages : [], modelPages = Array.isArray(result.analysis?.pages) ? result.analysis.pages : [];
        for (const fetched of pages.slice(0, 10)) {
          const serpResultId = String(fetched?.serpResultId || ""); if (!validIds.has(serpResultId)) continue;
          const model = modelPages.find((item:any) => String(item?.serpResultId || "") === serpResultId) || {};
          const evidence = fetched?.evidence || {};
          await db.prepare("INSERT INTO competitor_page_analysis (id,client_id,serp_result_id,fetch_status,page_type,search_intent,h1,headings_json,covered_topics_json,unique_topics_json,questions_json,tables_detected,comparison_detected,examples_detected,original_data_detected,source_quality,author_info,freshness_info,cta_type,analysis_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(serp_result_id) DO UPDATE SET fetch_status=excluded.fetch_status,page_type=excluded.page_type,search_intent=excluded.search_intent,h1=excluded.h1,headings_json=excluded.headings_json,covered_topics_json=excluded.covered_topics_json,unique_topics_json=excluded.unique_topics_json,questions_json=excluded.questions_json,tables_detected=excluded.tables_detected,comparison_detected=excluded.comparison_detected,examples_detected=excluded.examples_detected,original_data_detected=excluded.original_data_detected,source_quality=excluded.source_quality,author_info=excluded.author_info,freshness_info=excluded.freshness_info,cta_type=excluded.cta_type,analysis_json=excluded.analysis_json,created_at=excluded.created_at").bind(id(),clientId,serpResultId,String(fetched?.fetchStatus || "unavailable"),String(model?.pageType || "DATA_NOT_AVAILABLE").slice(0,120),["informational","commercial","transactional","navigational","local"].includes(String(model?.searchIntent || "").toLowerCase()) ? String(model.searchIntent).toLowerCase() : "DATA_NOT_AVAILABLE",String(evidence?.h1 || "").slice(0,500),JSON.stringify(Array.isArray(evidence?.headings) ? evidence.headings.slice(0,30) : []),JSON.stringify(Array.isArray(model?.coveredTopics) ? model.coveredTopics.slice(0,30) : []),JSON.stringify(Array.isArray(model?.uniqueTopics) ? model.uniqueTopics.slice(0,30) : []),JSON.stringify(Array.isArray(model?.questions) ? model.questions.slice(0,20) : []),Number(evidence?.tableCount || 0),model?.comparisonDetected ? 1 : 0,model?.examplesDetected ? 1 : 0,model?.originalDataDetected ? 1 : 0,String(model?.sourceQuality || "DATA_NOT_AVAILABLE").slice(0,300),String(model?.authorInfo || (evidence?.hasAuthor ? "detected" : "DATA_NOT_AVAILABLE")).slice(0,500),String(model?.freshnessInfo || (evidence?.hasDate ? "detected" : "DATA_NOT_AVAILABLE")).slice(0,500),String(model?.ctaType || "DATA_NOT_AVAILABLE").slice(0,300),JSON.stringify({ notes: Array.isArray(model?.notes) ? model.notes.slice(0,20) : [], fetched_url: fetched?.url || null, main_content_excerpt: String(evidence?.text || "").slice(0,6000) }),stamp).run();
        }
        const insight = result.analysis?.insight || {}, cannibal = result.analysis?.cannibalization || {}, decision = result.analysis?.decision || {};
        const allowedIntents = ["informational","commercial","transactional","navigational","local"], normalizedIntent = allowedIntents.includes(String(insight.searchIntent || "").toLowerCase()) ? String(insight.searchIntent).toLowerCase() : "DATA_NOT_AVAILABLE";
        const consensus = insight.serpConsensus && typeof insight.serpConsensus === "object" ? insight.serpConsensus : {};
        const requiredTopics = Array.isArray(consensus.requiredTopics) ? consensus.requiredTopics.slice(0,30) : [];
        await db.prepare("INSERT INTO keyword_serp_insights (id,client_id,keyword_id,snapshot_id,search_intent,explicit_need,latent_need,anxiety,comparison_axes,desired_outcome,likely_funnel_stage,serp_consensus,missing_topics,weak_competitor_topics,differentiation_opportunities,recommended_content_type,recommended_depth,analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,keyword_id,snapshot_id) DO UPDATE SET search_intent=excluded.search_intent,explicit_need=excluded.explicit_need,latent_need=excluded.latent_need,anxiety=excluded.anxiety,comparison_axes=excluded.comparison_axes,desired_outcome=excluded.desired_outcome,likely_funnel_stage=excluded.likely_funnel_stage,serp_consensus=excluded.serp_consensus,missing_topics=excluded.missing_topics,weak_competitor_topics=excluded.weak_competitor_topics,differentiation_opportunities=excluded.differentiation_opportunities,recommended_content_type=excluded.recommended_content_type,recommended_depth=excluded.recommended_depth,analyzed_at=excluded.analyzed_at").bind(id(),clientId,snapshot.keyword_id,snapshotId,normalizedIntent,String(insight.explicitNeed || "").slice(0,2000),String(insight.latentNeed || "").slice(0,2000),String(insight.anxiety || "").slice(0,2000),JSON.stringify(Array.isArray(insight.comparisonAxes) ? insight.comparisonAxes.slice(0,20) : []),String(insight.desiredOutcome || "").slice(0,2000),String(insight.likelyFunnelStage || "").slice(0,300),JSON.stringify(consensus),JSON.stringify(Array.isArray(insight.missingTopics) ? insight.missingTopics.slice(0,30) : []),JSON.stringify(Array.isArray(insight.weakCompetitorTopics) ? insight.weakCompetitorTopics.slice(0,30) : []),JSON.stringify(Array.isArray(insight.differentiationOpportunities) && insight.differentiationOpportunities.length ? insight.differentiationOpportunities.slice(0,30) : ["NO_CONFIRMED_DIFFERENTIATION"]),String(insight.recommendedContentType || "DATA_NOT_AVAILABLE").slice(0,500),String(insight.recommendedDepth || "DATA_NOT_AVAILABLE").slice(0,500),stamp).run();
        const risk = ["NONE","LOW","MEDIUM","HIGH","DATA_NOT_AVAILABLE"].includes(String(cannibal.risk || "").toUpperCase()) ? String(cannibal.risk).toUpperCase() : "DATA_NOT_AVAILABLE";
        await db.prepare("INSERT INTO cannibalization_assessments (id,client_id,keyword_id,snapshot_id,risk,score,reason,signals_json,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,keyword_id,snapshot_id) DO UPDATE SET risk=excluded.risk,score=excluded.score,reason=excluded.reason,signals_json=excluded.signals_json,created_at=excluded.created_at").bind(id(),clientId,snapshot.keyword_id,snapshotId,risk,Math.max(0,Math.min(100,Number(cannibal.score) || 0)),String(cannibal.reason || "DATA_NOT_AVAILABLE").slice(0,2000),JSON.stringify(cannibal.signals && typeof cannibal.signals === "object" ? cannibal.signals : {}),stamp).run();
        let action = ["NEW_ARTICLE","UPDATE_EXISTING","MERGE","CHANGE_ANGLE","DO_NOT_CREATE","HUMAN_REVIEW"].includes(String(decision.action || "").toUpperCase()) ? String(decision.action).toUpperCase() : "HUMAN_REVIEW";
        if (risk === "HIGH" && action === "NEW_ARTICLE") action = "HUMAN_REVIEW";
        const requestedTargetArticleId = String(decision.targetArticleId || "") || null;
        const targetArticleId = requestedTargetArticleId && await db.prepare("SELECT article_id FROM article_mapping_candidates WHERE client_id=? AND article_id=?").bind(clientId, requestedTargetArticleId).first<any>() ? requestedTargetArticleId : null;
        await db.prepare("INSERT INTO content_decisions (id,client_id,keyword_id,snapshot_id,action,target_article_id,reason,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,keyword_id,snapshot_id) DO UPDATE SET action=excluded.action,target_article_id=excluded.target_article_id,reason=excluded.reason,confidence=excluded.confidence,created_at=excluded.created_at").bind(id(),clientId,snapshot.keyword_id,snapshotId,action,targetArticleId,String(decision.reason || "根拠不足のため判断保留").slice(0,2000),Math.max(0,Math.min(1,Number(decision.confidence) || 0)),stamp).run();
        const brief = await db.prepare("SELECT id FROM content_briefs WHERE client_id=? AND keyword_id=? ORDER BY updated_at DESC LIMIT 1").bind(clientId,snapshot.keyword_id).first<any>();
        const briefGap = JSON.stringify({ missingTopics: Array.isArray(insight.missingTopics) ? insight.missingTopics.slice(0,30) : [], weakCompetitorTopics: Array.isArray(insight.weakCompetitorTopics) ? insight.weakCompetitorTopics.slice(0,30) : [], competitorWeaknesses: Array.isArray(consensus.competitorWeaknesses) ? consensus.competitorWeaknesses.slice(0,30) : [], recommendedContentType: String(insight.recommendedContentType || "DATA_NOT_AVAILABLE"), recommendedDepth: String(insight.recommendedDepth || "DATA_NOT_AVAILABLE") });
        if (brief) await db.prepare("UPDATE content_briefs SET search_intent=?,explicit_need=?,latent_need=?,anxiety=?,comparison_axes=?,desired_outcome=?,funnel_stage=?,serp_consensus=?,required_topics=?,content_gap=?,differentiation=?,status='draft',version=version+1,updated_at=? WHERE id=? AND client_id=?").bind(normalizedIntent,String(insight.explicitNeed || ""),String(insight.latentNeed || ""),String(insight.anxiety || ""),JSON.stringify(Array.isArray(insight.comparisonAxes) ? insight.comparisonAxes.slice(0,20) : []),String(insight.desiredOutcome || ""),String(insight.likelyFunnelStage || ""),JSON.stringify(consensus),JSON.stringify(requiredTopics),briefGap,JSON.stringify(Array.isArray(insight.differentiationOpportunities) && insight.differentiationOpportunities.length ? insight.differentiationOpportunities.slice(0,30) : ["NO_CONFIRMED_DIFFERENTIATION"]),stamp,brief.id,clientId).run();
        else await db.prepare("INSERT INTO content_briefs (id,client_id,keyword_id,search_intent,explicit_need,latent_need,anxiety,comparison_axes,desired_outcome,funnel_stage,serp_consensus,required_topics,content_gap,differentiation,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id(),clientId,snapshot.keyword_id,normalizedIntent,String(insight.explicitNeed || ""),String(insight.latentNeed || ""),String(insight.anxiety || ""),JSON.stringify(Array.isArray(insight.comparisonAxes) ? insight.comparisonAxes.slice(0,20) : []),String(insight.desiredOutcome || ""),String(insight.likelyFunnelStage || ""),JSON.stringify(consensus),JSON.stringify(requiredTopics),briefGap,JSON.stringify(Array.isArray(insight.differentiationOpportunities) && insight.differentiationOpportunities.length ? insight.differentiationOpportunities.slice(0,30) : ["NO_CONFIRMED_DIFFERENTIATION"]),"draft",stamp,stamp).run();
        result.snapshotId = snapshotId;
      }
      if (body.ok && job.type === "article_mapping_analyze" && result) {
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        for (const candidate of candidates.slice(0, 200)) {
          const articleId = String(candidate.article_id || candidate.articleId || "");
          if (!articleId) continue;
          const topicId = String(candidate.suggested_topic_id || "") || null, clusterId = String(candidate.suggested_cluster_id || "") || null, keywordId = String(candidate.suggested_keyword_id || "") || null;
          const validTopic = !topicId || await db.prepare("SELECT id FROM topics WHERE id=? AND client_id=?").bind(topicId,clientId).first();
          const validCluster = !clusterId || await db.prepare("SELECT id FROM keyword_clusters WHERE id=? AND client_id=?").bind(clusterId,clientId).first();
          const validKeyword = !keywordId || await db.prepare("SELECT id FROM seo_keywords WHERE id=? AND client_id=?").bind(keywordId,clientId).first();
          await db.prepare("INSERT INTO article_mapping_candidates (id,client_id,article_id,article_title,article_url,suggested_topic_id,suggested_cluster_id,suggested_keyword_id,suggested_keyword_text,confidence,reasoning,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,article_id) DO UPDATE SET article_title=excluded.article_title,article_url=excluded.article_url,suggested_topic_id=excluded.suggested_topic_id,suggested_cluster_id=excluded.suggested_cluster_id,suggested_keyword_id=excluded.suggested_keyword_id,suggested_keyword_text=excluded.suggested_keyword_text,confidence=excluded.confidence,reasoning=excluded.reasoning,status='PENDING',updated_at=excluded.updated_at").bind(id(),clientId,articleId,String(candidate.article_title||candidate.title||"").slice(0,500),String(candidate.article_url||candidate.url||"").slice(0,2000),validTopic?topicId:null,validCluster?clusterId:null,validKeyword?keywordId:null,String(candidate.suggested_keyword_text||candidate.keyword_text||"").slice(0,240),Math.max(0,Math.min(1,Number(candidate.confidence)||0)),String(candidate.reasoning||"").slice(0,4000),"PENDING",now(),now()).run();
        }
      }
      if (body.ok && job.type === "article_generate" && result?.article) {
        const generatedImages = await generateRequiredArticleImages(
          clientId,
          result.article,
        );
        result.article = generatedImages.article;
        result.generatedImages = generatedImages.media;
        result.featuredMediaId = generatedImages.media[0]?.id || null;
        if (generatedImages.errors.length) {
          result.imageGenerationErrors = generatedImages.errors;
          await log(clientId, "記事画像の一部を生成・登録できませんでした", "warn", {
            errors: generatedImages.errors,
          });
        }
        if (generatedImages.media.length) {
          const previous = result.gutenbergBlocks || {};
          const totalImages = Number(previous.validImages || 0) + generatedImages.media.length;
          result.gutenbergBlocks = {
            ...previous,
            imageBlocks: Number(previous.imageBlocks || 0) + generatedImages.media.length,
            validImages: totalImages,
            invalidImages: Number(previous.invalidImages || 0),
            imagesOk: totalImages >= 2 && Number(previous.invalidImages || 0) === 0,
          };
          if (result.status === "draft_only_missing_images" && result.gutenbergBlocks.imagesOk) {
            const payload = parse(job.payload, {});
            const highRisk = ["high", "ymyl"].includes(payload.risk) || ["high", "ymyl"].includes(result.review?.risk_level);
            result.status = payload.primaryInfoStatus === "missing"
              ? "draft_only_missing_primary_info"
              : highRisk
                ? "awaiting_human_approval"
                : result.qualityException
                  ? "best_after_three"
                  : "ready_for_publish";
            result.publishAllowed = !highRisk && payload.primaryInfoStatus !== "missing";
          }
          await log(clientId, "GPT Image 2の画像をWordPressメディアへ登録", "info", {
            count: generatedImages.media.length,
            metadata: generatedImages.media.map((item: any) => ({ id: item.id, alt: item.alt, caption: item.caption, benefit: item.benefit })),
          });
        }
        // A quality exception is never an automatic-publication exception.
        // Below-threshold articles remain editable WordPress drafts until a
        // future explicit human-approval endpoint records who approved them.
        const publishBestAfterThree = false;
        const wordpressPostStatus = "draft";
        result = {
          ...result,
          progress: {
            percent: 95,
            stage: "wordpress",
                detail: "WordPressへ本番用下書きを保存しています",
            updatedAt: now(),
          },
        };
        const wp = await db
          .prepare(
            "SELECT public_config,secret_cipher FROM connections WHERE client_id=? AND connector='wordpress' AND status='connected'",
          )
          .bind(clientId)
          .first<any>();
        // Autopilot REWRITE/EXPAND must create a new version of the mapped
        // article, never a second WordPress post.  The existing Phase 4
        // UPDATE_EXISTING flow performs the later snapshot/update action.
        const autopilotExistingArticleUpdate = ["REWRITE", "EXPAND"].includes(String(parse(job.payload, {}).autopilotActionType || ""));
        if (wp?.secret_cipher && !autopilotExistingArticleUpdate) {
          try {
            const config = parse(wp.public_config, {});
            const secret = await decrypt<any>(wp.secret_cipher);
            const response = await fetch(
              `${wordpressBase(config.siteUrl)}/wp-json/wp/v2/posts`,
              {
                method: "POST",
                headers: {
                  Authorization: `Basic ${btoa(`${config.username}:${secret.applicationPassword}`)}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  title: result.article.title,
                  slug: result.article.slug || undefined,
                  content: result.article.html || "",
                  // WordPress core has an excerpt field but no standard SEO-description
                  // field. Keep the two editorial assets separate; an SEO-plugin adapter
                  // can map meta_description to its own registered REST meta key later.
                  excerpt: result.article.excerpt || "",
                  categories: Number(parse(job.payload, {}).categoryId || result.article.category_id || 0) > 0
                    ? [Number(parse(job.payload, {}).categoryId || result.article.category_id)]
                    : undefined,
                  featured_media: result.featuredMediaId || undefined,
                  status: wordpressPostStatus,
                }),
              },
            );
            const draft = (await response.json()) as any;
            if (!response.ok)
              throw new Error(draft.message || `WordPress ${response.status}`);
            result = {
              ...result,
              progress: {
                percent: 100,
                stage: "completed",
                detail: "WordPress本番用下書きへの入稿が完了しました",
                updatedAt: now(),
              },
              wordpressDraft: {
                id: draft.id,
                status: draft.status,
                link: draft.link,
                publicationReason: "品質・安全ゲートによりWordPress下書きとして保存",
                slug: draft.slug || result.article.slug || "",
                excerpt: result.article.excerpt || "",
                metaDescription: result.article.meta_description || "",
                featuredMediaId: result.featuredMediaId || null,
                replacesPostId:
                  parse(job.payload, {}).rewriteSourcePostId || null,
                replacesPostUrl:
                  parse(job.payload, {}).rewriteSourceUrl || null,
                createdAt: now(),
              },
            };
          } catch (error: any) {
            result = {
              ...result,
              wordpressDraftError: error.message || String(error),
            };
          }
        }
      }
      if (body.ok && job.type === "article_generate" && result?.article) {
        const generatedForArticleId = String(parse(job.payload,{}).articleId || job.id), versionId = id(), stamp = now(), previousVersion = await db.prepare("SELECT MAX(version_no) version_no FROM article_versions WHERE client_id=? AND article_id=?").bind(clientId,generatedForArticleId).first<any>();
        result.articleVersionId = versionId;
        await db.prepare("INSERT INTO article_versions (id,client_id,article_id,version_no,draft_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(versionId,clientId,generatedForArticleId,Number(previousVersion?.version_no||0)+1,JSON.stringify(result.article),"GENERATING",stamp,stamp).run();
        await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:"REVIEWING",reason:"Article draft generation completed.",transitionEvent:`article_generated:${job.id}`});
        const articlePayload=parse(job.payload,{});
        const reviewJob = { id:id(),client_id:clientId,type:"content_intelligence_review",status:"queued",payload:JSON.stringify({articleJobId:job.id,articleVersionId:versionId,autopilotActionId:articlePayload.autopilotActionId||null,autopilotActionType:articlePayload.autopilotActionType||null}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp };
        await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(reviewJob)).run();
        await dispatchCloudJob(reviewJob.id,false,new URL(request.url).origin).catch(() => undefined);
      }
      if (body.ok && job.type === "content_intelligence_review" && result) {
        const versionId = String(parse(job.payload,{}).articleVersionId || ""), version = await db.prepare("SELECT * FROM article_versions WHERE id=? AND client_id=?").bind(versionId,clientId).first<any>();
        if (!version) throw new Error("記事バージョンが見つかりません。");
        const stamp = now(), claims = Array.isArray(result.claims) ? result.claims.slice(0,300) : [];
        for (const claim of claims) {
          const claimId=id(), status=["UNCHECKED","VERIFIED","PARTIALLY_VERIFIED","UNSUPPORTED","CONFLICTING","PRIMARY_SOURCE_REQUIRED","HUMAN_REVIEW_REQUIRED","NOT_APPLICABLE"].includes(String(claim.verificationStatus||"")) ? String(claim.verificationStatus) : "UNCHECKED";
          await db.prepare("INSERT INTO content_claims (id,client_id,article_version_id,article_id,paragraph_index,sentence,claim_text,claim_type,risk_level,requires_verification,verification_status,verification_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_version_id,paragraph_index,claim_text) DO NOTHING").bind(claimId,clientId,versionId,version.article_id,Number(claim.paragraphIndex||0),String(claim.sentence||"").slice(0,4000),String(claim.claimText||"").slice(0,2000),String(claim.claimType||"general_fact").slice(0,80),["LOW","MEDIUM","HIGH","CRITICAL"].includes(String(claim.riskLevel||""))?String(claim.riskLevel):"MEDIUM",claim.requiresVerification?1:0,status,String(claim.verificationReason||"").slice(0,2000),stamp,stamp).run();
          const storedClaim = await db.prepare("SELECT id FROM content_claims WHERE article_version_id=? AND paragraph_index=? AND claim_text=?").bind(versionId,Number(claim.paragraphIndex||0),String(claim.claimText||"").slice(0,2000)).first<any>();
          for (const source of (Array.isArray(claim.sources)?claim.sources:[]).slice(0,10)) await db.prepare("INSERT INTO claim_sources (id,client_id,claim_id,source_type,source_url,source_title,publisher,published_at,accessed_at,evidence_excerpt,evidence_strength,supports_claim,contradiction_detected,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_id,source_type,source_url,evidence_excerpt) DO NOTHING").bind(id(),clientId,storedClaim?.id||claimId,String(source.sourceType||"EVIDENCE_PROVIDER_NOT_AVAILABLE").slice(0,80),String(source.sourceUrl||"").slice(0,2000),String(source.sourceTitle||"").slice(0,500),String(source.publisher||"").slice(0,300),null,stamp,String(source.evidenceExcerpt||"").slice(0,4000),String(source.evidenceStrength||"7"),source.supportsClaim?1:0,source.contradictionDetected?1:0,stamp).run();
        }
        for (const link of (Array.isArray(result.internalLinks)?result.internalLinks:[]).slice(0,30)) {
          const targetUrl=String(link.targetUrl||""), targetId=String(link.targetArticleId||"");
          const valid=targetUrl && targetId && (await db.prepare("SELECT article_id FROM article_mapping_candidates WHERE client_id=? AND article_id=? AND article_url=?").bind(clientId,targetId,targetUrl).first<any>());
          if (!valid) continue;
          await db.prepare("INSERT INTO internal_link_candidates (id,client_id,article_version_id,source_article_id,target_article_id,source_url,target_url,anchor_text,anchor_type,relation_type,relevance_score,intent_match,status,validation_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(article_version_id,target_article_id,anchor_text) DO UPDATE SET relevance_score=excluded.relevance_score,intent_match=excluded.intent_match,status=excluded.status,validation_reason=excluded.validation_reason,updated_at=excluded.updated_at").bind(id(),clientId,versionId,version.article_id,targetId,"",targetUrl,String(link.anchorText||"").slice(0,500),["exact","partial","natural","brand","url"].includes(String(link.anchorType))?String(link.anchorType):"natural",String(link.relationType||"supporting").slice(0,80),Math.max(0,Math.min(1,Number(link.relevanceScore)||0)),link.intentMatch?1:0,["PENDING","APPROVED","REJECTED"].includes(String(link.status))?String(link.status):"PENDING",String(link.validationReason||"URL・マッピング・関連性を確認").slice(0,1000),stamp,stamp).run();
        }
        const ymyl=result.ymyl||{}, eeat=result.eeat||{}, quality=result.quality||{}, total=Math.max(0,Math.min(100,Number(quality.searchIntent||0)+Number(quality.informationQuality||0)+Number(quality.originalValue||0)+Number(quality.eeat||0)+Number(quality.structureUx||0)+Number(quality.seo||0)+Number(quality.conversion||0)+Number(quality.safetyFactCheck||0)));
        const critical=claims.some((c:any)=>String(c.riskLevel)==="CRITICAL"&&["UNSUPPORTED","CONFLICTING"].includes(String(c.verificationStatus))), conflicting=claims.some((c:any)=>String(c.verificationStatus)==="CONFLICTING"), unsupported=claims.some((c:any)=>["UNSUPPORTED","PRIMARY_SOURCE_REQUIRED"].includes(String(c.verificationStatus))&&["HIGH","CRITICAL"].includes(String(c.riskLevel))), highYmyl=String(ymyl.risk||"")==="HIGH";
        const primarySourceRequired=claims.some((c:any)=>String(c.verificationStatus)==="PRIMARY_SOURCE_REQUIRED");
        const reasons=[...(total<95?["QUALITY_SCORE_BELOW_95"]:[]),...(highYmyl?["YMYL"]:[]),...(critical?["CRITICAL_CLAIM"]:[]),...(conflicting?["CONFLICTING_EVIDENCE"]:[]),...(unsupported?["UNSUPPORTED_CLAIM"]:[]),...(primarySourceRequired&&!(Array.isArray(parse((await db.prepare("SELECT result FROM jobs WHERE id=? AND client_id=?").bind(String(parse(job.payload,{}).articleJobId||""),clientId).first<any>())?.result,{}).sources)?true:false)?["PRIMARY_SOURCE_REQUIRED"]:[])]; const requiresReview=reasons.length>0;
        const originPayload=parse((await db.prepare("SELECT payload FROM jobs WHERE id=? AND client_id=? AND type='article_generate'").bind(String(parse(job.payload,{}).articleJobId||""),clientId).first<any>())?.payload,{});
        const revisionCount=Number((await db.prepare("SELECT COUNT(*) count FROM article_revision_instructions WHERE client_id=? AND article_id=?").bind(clientId,version.article_id).first<any>())?.count||0);
        const maxAutoRevisions=Math.max(0,Math.min(2,Number((await db.prepare("SELECT max_auto_revisions FROM client_autopilot_settings WHERE client_id=?").bind(clientId).first<any>())?.max_auto_revisions??2)));
        const safetyStop=highYmyl||critical||conflicting||unsupported||primarySourceRequired;
        const autoRevise=requiresReview&&!safetyStop&&revisionCount<maxAutoRevisions;
        const revisionInstruction=autoRevise?{failed_dimensions:Object.entries(quality).filter(([,value])=>Number(value)<95/8).map(([key])=>key),current_score:total,target_score:95,unsupported_claims:claims.filter((c:any)=>String(c.verificationStatus)==="UNSUPPORTED").map((c:any)=>c.claimText),conflicting_claims:claims.filter((c:any)=>String(c.verificationStatus)==="CONFLICTING").map((c:any)=>c.claimText),primary_source_required:[],missing_topics:parse((await db.prepare("SELECT content_gap FROM content_briefs WHERE client_id=? AND keyword_id=? ORDER BY updated_at DESC LIMIT 1").bind(clientId,originPayload.keywordId||"").first<any>())?.content_gap,{}).missingTopics||[],search_intent_gaps:[],eeat_gaps:Array.isArray(eeat.missingEvidence)?eeat.missingEvidence:[],structure_issues:[],seo_issues:[],conversion_issues:[],safety_issues:reasons,revision_instructions:"監査で特定された項目だけを修正し、未確認の根拠は追加しない。"}:null;
        const finalReviewRequired=requiresReview&&!autoRevise;
        await db.batch([
          db.prepare("INSERT INTO article_eeat_assessments (id,client_id,article_version_id,experience_score,expertise_score,authoritativeness_score,trust_score,missing_evidence_json,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(article_version_id) DO UPDATE SET experience_score=excluded.experience_score,expertise_score=excluded.expertise_score,authoritativeness_score=excluded.authoritativeness_score,trust_score=excluded.trust_score,missing_evidence_json=excluded.missing_evidence_json").bind(id(),clientId,versionId,Math.min(15,Number(eeat.experience)||0),Math.min(15,Number(eeat.expertise)||0),Math.min(15,Number(eeat.authoritativeness)||0),Math.min(15,Number(eeat.trust)||0),JSON.stringify(Array.isArray(eeat.missingEvidence)?eeat.missingEvidence:[]),stamp),
          db.prepare("INSERT INTO article_ymyl_assessments (id,client_id,article_version_id,risk,reason,required_reviews_json,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(article_version_id) DO UPDATE SET risk=excluded.risk,reason=excluded.reason,required_reviews_json=excluded.required_reviews_json").bind(id(),clientId,versionId,["NONE","LOW","MEDIUM","HIGH"].includes(String(ymyl.risk))?String(ymyl.risk):"NONE",String(ymyl.reason||""),JSON.stringify(Array.isArray(ymyl.requiredReviews)?ymyl.requiredReviews:[]),stamp),
          db.prepare("INSERT INTO article_quality_reviews (id,client_id,article_version_id,total_score,breakdown_json,auto_publish_status,reasons_json,manual_publish_allowed,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(article_version_id) DO UPDATE SET total_score=excluded.total_score,breakdown_json=excluded.breakdown_json,auto_publish_status=excluded.auto_publish_status,reasons_json=excluded.reasons_json,manual_publish_allowed=excluded.manual_publish_allowed").bind(id(),clientId,versionId,total,JSON.stringify(quality),autoRevise?"REVIEWING":finalReviewRequired?"HUMAN_REVIEW_REQUIRED":total>=95?"AUTO_PUBLISH_READY":"BELOW_AUTO_PUBLISH_THRESHOLD",JSON.stringify(reasons),1,stamp),
          ...(finalReviewRequired?[db.prepare("INSERT INTO human_review_queue (id,client_id,article_version_id,status,reason_codes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(article_version_id) DO UPDATE SET status='REQUIRED',reason_codes_json=excluded.reason_codes_json,updated_at=excluded.updated_at").bind(id(),clientId,versionId,"REQUIRED",JSON.stringify(reasons),stamp,stamp)]:[]),
        ]);
        if(autoRevise){const instructionId=id();await db.prepare("INSERT INTO article_revision_instructions (id,client_id,article_id,from_article_version_id,revision_no,instruction_json,prompt_version,status,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,from_article_version_id) DO NOTHING").bind(instructionId,clientId,version.article_id,versionId,revisionCount+1,JSON.stringify(revisionInstruction),"revision-controller-v1","QUEUED",stamp).run();const existing=await db.prepare("SELECT id FROM jobs WHERE client_id=? AND type='article_generate' AND json_extract(payload,'$.revisionOfVersionId')=? AND status IN ('queued','running')").bind(clientId,versionId).first<any>();if(!existing){const revisionJob={id:id(),client_id:clientId,type:"article_generate",status:"queued",payload:JSON.stringify({...originPayload,articleId:version.article_id,revisionOfVersionId:versionId,revisionInstructionId:instructionId}),result:null,attempts:0,lease_until:null,error:null,created_at:stamp,updated_at:stamp};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(revisionJob)).run();await dispatchCloudJob(revisionJob.id,false,new URL(request.url).origin).catch(()=>undefined);}await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:"DRAFT",reason:"Independent audit requested finite automatic revision.",transitionEvent:`revision_requested:${job.id}`});}else await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:finalReviewRequired?"HUMAN_REVIEW_REQUIRED":total>=95?"AUTO_PUBLISH_READY":"BELOW_AUTO_PUBLISH_THRESHOLD",reason:reasons.join(" / ")||"Quality gate passed.",transitionEvent:`quality_review:${job.id}`});
        const autoEligibility=await publishEligibility(clientId,versionId);
        const autopilotExistingArticleUpdate=["REWRITE","EXPAND"].includes(String(parse(job.payload,{}).autopilotActionType||""));
        if(autoEligibility.eligible&&!autopilotExistingArticleUpdate){const autoJob={id:id(),client_id:clientId,type:"wordpress_publish",status:"queued",payload:JSON.stringify({articleId:version.article_id,articleVersionId:versionId,operation:"AUTO_PUBLISH",requestId:`AUTO_PUBLISH:${versionId}`,requestedBy:"system"}),result:null,attempts:0,lease_until:null,error:null,created_at:now(),updated_at:now()};await db.prepare("INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(...Object.values(autoJob)).run();await dispatchCloudJob(autoJob.id,false,new URL(request.url).origin).catch(()=>undefined);}
      }
      if (!body.ok && job.type === "content_intelligence_review") {
        const versionId = String(parse(job.payload, {}).articleVersionId || "");
        if (versionId) await transitionArticleStatus({
          clientId, owner: anchor.owner_id, articleVersionId: versionId,
          toStatus: "FAILED", reason: String(body.error || "Content Intelligence review failed."),
          transitionEvent: `content_intelligence_failed:${job.id}`,
        });
      }
      if (body.ok && ["wordpress_publish","wordpress_rollback"].includes(job.type) && result) {
        const payload=parse(job.payload,{}), versionId=String(payload.articleVersionId||""), version=await db.prepare("SELECT * FROM article_versions WHERE id=? AND client_id=?").bind(versionId,clientId).first<any>();
        if(!version) throw new Error("公開対象の記事バージョンが見つかりません。");
        const post=result.post||{}, postId=String(post.id||payload.targetPostId||""), operation=String(result.operation||payload.operation||"ROLLBACK"), stamp=now(), before=result.before;
        if(before?.id) await db.prepare("INSERT INTO wordpress_article_versions (id,client_id,article_id,article_version_id,wordpress_post_id,wp_title,wp_slug,wp_content,wp_excerpt,wp_status,categories_json,tags_json,featured_media_id,seo_meta_json,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id(),clientId,version.article_id,versionId,String(before.id),String(before.title?.raw||before.title?.rendered||""),String(before.slug||""),String(before.content?.raw||before.content?.rendered||""),String(before.excerpt?.raw||before.excerpt?.rendered||""),String(before.status||""),JSON.stringify(before.categories||[]),JSON.stringify(before.tags||[]),before.featured_media?String(before.featured_media):null,JSON.stringify({status:result.seoMetaStatus||"SEO_META_WRITE_NOT_AVAILABLE"}),stamp).run();
        await db.batch([
          db.prepare("INSERT INTO wordpress_article_mappings (id,client_id,article_id,article_version_id,wordpress_connection_id,wordpress_post_id,wordpress_url,wordpress_status,seo_plugin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,article_version_id,wordpress_post_id) DO UPDATE SET wordpress_url=excluded.wordpress_url,wordpress_status=excluded.wordpress_status,seo_plugin=excluded.seo_plugin,updated_at=excluded.updated_at").bind(id(),clientId,version.article_id,versionId,null,postId,String(post.link||""),String(post.status||""),String(result.seoPlugin||"UNKNOWN"),stamp,stamp),
          db.prepare("INSERT INTO wordpress_publish_history (id,client_id,article_id,article_version_id,job_id,operation,publish_type,wordpress_post_id,wordpress_url,wordpress_status,request_id,response_status,result_json,error_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,article_version_id,operation,request_id) DO NOTHING").bind(id(),clientId,version.article_id,versionId,job.id,operation,operation==="AUTO_PUBLISH"?"AUTOMATIC":operation==="MANUAL_PUBLISH"?"MANUAL":operation,String(postId||""),String(post.link||""),String(post.status||""),String(payload.requestId||job.id),Number(result.responseStatus||200),JSON.stringify({seoMetaStatus:result.seoMetaStatus||"",partialFailure:result.partialFailure||null}),result.partialFailure||null,stamp),
        ]);
        const draft=parse(version.draft_json,{});await db.prepare("INSERT INTO article_seo_data (id,client_id,article_id,article_version_id,seo_title,meta_description,focus_keyword,canonical_url,robots,schema_recommendation_json,provider,plugin_sync_status,canonical_status,schema_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,article_version_id) DO UPDATE SET seo_title=excluded.seo_title,meta_description=excluded.meta_description,focus_keyword=excluded.focus_keyword,canonical_url=excluded.canonical_url,provider=excluded.provider,plugin_sync_status=excluded.plugin_sync_status,canonical_status=excluded.canonical_status,schema_status=excluded.schema_status,updated_at=excluded.updated_at").bind(id(),clientId,version.article_id,versionId,String(draft.seo_title||draft.title||""),String(draft.meta_description||""),String(draft.focus_keyword||payload.keyword||""),String(post.link||""),"index,follow",JSON.stringify(draft.schema_recommendation||{}),"NATIVE_SEO_LOOP",String(result.seoMetaStatus||"NOT_APPLICABLE"),String(result.canonicalStatus||"CANONICAL_STORED_IN_SEO_LOOP"),String(result.schemaStatus||"SCHEMA_OUTPUT_NOT_AVAILABLE"),stamp,stamp).run();
        if(operation==="DRAFT") await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:"DRAFT",reason:"Saved as WordPress draft.",transitionEvent:`wordpress_draft:${job.id}`});
        if(operation==="MANUAL_PUBLISH"||operation==="UPDATE_EXISTING") await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:"PUBLISHED_MANUALLY",reason:`WordPress ${operation} completed.`,transitionEvent:`wordpress_manual:${job.id}`});
        if(operation==="AUTO_PUBLISH") await transitionArticleStatus({clientId,owner:anchor.owner_id,articleVersionId:versionId,toStatus:"PUBLISHED_AUTOMATICALLY",reason:"All automatic publish gates passed.",transitionEvent:`wordpress_auto:${job.id}`});
        if(operation==="ROLLBACK") await log(clientId,"WordPress rollback completed","warn",{articleId:version.article_id,postId});
      }
      if (job.type === "autopilot_execute") {
        const actionId=String(parse(job.payload,{}).actionId||"");
        const action=actionId&&await db.prepare("SELECT * FROM autopilot_actions WHERE id=? AND client_id=?").bind(actionId,clientId).first<any>();
        if(action){const executionStatus=body.ok?"COMPLETED":"FAILED";await db.prepare("UPDATE autopilot_actions SET status=?,execution_result_json=?,updated_at=? WHERE id=? AND client_id=?").bind(executionStatus,JSON.stringify(body.ok?result||{}:{error:String(body.error||"").slice(0,1000)}),now(),actionId,clientId).run();await saveAutopilotAudit(clientId,body.ok?"EXECUTION_COMPLETED":"EXECUTION_FAILED",body.ok?result||{}:{error:String(body.error||"").slice(0,1000)},action.run_id,actionId);}
      }
      const status = body.ok ? "completed" : "failed";
      await db
        .prepare(
          "UPDATE jobs SET status=?,result=?,error=?,lease_until=NULL,updated_at=? WHERE id=?",
        )
        .bind(
          status,
          result ? JSON.stringify(result) : null,
          body.error || null,
          now(),
          job.id,
        )
        .run();
      if (
        body.ok &&
        job.type === "keyword_strategy" &&
        parse(job.payload, {}).autoCreate &&
        Array.isArray(result?.recommended_keywords)
      ) {
        const payload = parse(job.payload, {});
        const count = Math.min(
          7,
          Math.max(1, Number(payload.articleCount || 3)),
        );
        const client = await db
          .prepare("SELECT primary_info_status FROM clients WHERE id=?")
          .bind(clientId)
          .first<any>();
        const scheduleStart = String(result.schedule_start || "");
        const match = scheduleStart.match(/^(\d{4})-(\d{2})$/);
        const today = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const monthNumber = match
          ? Math.max(
              1,
              Math.min(
                12,
                (today.getUTCFullYear() - Number(match[1])) * 12 +
                  (today.getUTCMonth() + 1 - Number(match[2])) +
                  1,
              ),
            )
          : 1;
        const currentWeek = Math.ceil(today.getUTCDate() / 7);
        const monthPlan = (result.monthly_schedule || []).find(
          (month: any) => Number(month.month_number) === monthNumber,
        );
        const plannedArticles = (monthPlan?.articles || [])
          .filter(
            (article: any) =>
              payload.runPlannedNow ||
              Number(article.publish_week || 1) <= currentWeek,
          )
          .map((article: any) => ({
            ...article,
            cluster: monthPlan?.focus || "SEO改善",
            rationale: article.content_summary,
            target_article_type: article.title,
            planKey: `${scheduleStart || "rolling"}:${monthNumber}:${article.publish_week || 1}:${article.weekly_position || 1}:${article.keyword}`,
          }));
        const candidates = plannedArticles.length
          ? plannedArticles
          : result.recommended_keywords.map((keyword: any) => ({
              ...keyword,
              planKey: `recommendation:${scheduleStart || "rolling"}:${keyword.keyword}`,
            }));
        const existingJobs = await db
          .prepare(
            "SELECT payload FROM jobs WHERE client_id=? AND type='article_generate'",
          )
          .bind(clientId)
          .all<any>();
        const existingPlanKeys = new Set(
          existingJobs.results
            .map((item: any) => parse(item.payload, {}).planKey)
            .filter(Boolean),
        );
        let created = 0;
        for (const [candidateIndex, keyword] of candidates.entries()) {
          if (created >= count) break;
          const basePlanAlreadyUsed = existingPlanKeys.has(keyword.planKey);
          const complementaryPlanKey = `${keyword.planKey}:auto-complement`;
          const planKey = basePlanAlreadyUsed
            ? complementaryPlanKey
            : keyword.planKey;
          // An immediate submission consumes the original plan.  It must not
          // consume the scheduled publishing slot: reserve one distinct,
          // complementary article for that slot instead.
          if (existingPlanKeys.has(planKey)) continue;
          const variationAngles = [
            "導入手順と実践のポイント",
            "比較・選び方と判断基準",
            "よくある失敗と改善チェックリスト",
            "運用の具体例と成果を確認する方法",
          ];
          const variationAngle = variationAngles[candidateIndex % variationAngles.length];
          const stamp = now();
          const articlePayload = {
            keyword: keyword.keyword,
            intent: keyword.intent,
            risk: "low",
            primaryInfoStatus: client?.primary_info_status || "missing",
            brief: [
              `記事クラスター: ${keyword.cluster || "未分類"}`,
              `選定理由: ${keyword.rationale || "Ubersuggestと既存記事から選定"}`,
              `記事形式: ${keyword.target_article_type || "解説記事"}`,
              keyword.series_part
                ? `シリーズ: ${keyword.series_part}`
                : "単独記事または関連記事として構成",
              `内部リンク候補: ${(keyword.internal_link_targets || []).join("、") || "既存記事一覧から選定"}`,
              basePlanAlreadyUsed
                ? `同じ計画の記事は即日入稿済みです。自動投稿枠には「${variationAngle}」という別切り口の補完記事を作成し、タイトル・見出し・事例・FAQを元記事と重複させないでください。`
                : "この計画の主記事として作成します。",
            ].join("\n"),
            strategyGenerated: true,
            planKey,
            plannedTitle: basePlanAlreadyUsed
              ? `${keyword.title || keyword.target_article_type || keyword.keyword}｜${variationAngle}`
              : keyword.title || keyword.target_article_type || "",
            automaticComplement: basePlanAlreadyUsed,
            variationAngle: basePlanAlreadyUsed ? variationAngle : null,
            targetCharacters: Number(payload.targetCharacters || 10000),
            categoryId: Number((payload.categoryRotation || [])[candidateIndex % Math.max(1, (payload.categoryRotation || []).length)] || payload.defaultCategoryId || keyword.category_id || 0) || null,
            categoryName: (payload.categoryRotation || []).length || payload.defaultCategoryId ? "" : keyword.category_name || "",
            scheduledFor: keyword.scheduledFor || null,
          };
          await db
            .prepare(
              "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              id(),
              clientId,
              "article_generate",
              "queued",
              JSON.stringify(articlePayload),
              null,
              0,
              null,
              null,
              stamp,
              stamp,
            )
            .run();
          existingPlanKeys.add(planKey);
          created++;
        }
        await log(
          clientId,
          created
            ? `AI計画から約1万字の記事下書き${created}本を予約`
            : "AI計画を確認（今週の投稿枠はすべて予約済み）",
        );
      }
      if (
        body.ok &&
        job.type === "content_audit" &&
        parse(job.payload, {}).autoCreate &&
        Array.isArray(result?.rewrite_candidates)
      ) {
        const payload = parse(job.payload, {});
        const count = Math.min(
          5,
          Math.max(1, Number(payload.maxRewrites || 2)),
        );
        for (const candidate of result.rewrite_candidates.slice(0, count)) {
          const stamp = now();
          await db
            .prepare(
              "INSERT INTO jobs (id,client_id,type,status,payload,result,attempts,lease_until,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              id(),
              clientId,
              "article_generate",
              "queued",
              JSON.stringify({
                keyword: candidate.primary_keyword || candidate.title,
                intent: candidate.intent || "Know",
                risk: candidate.risk || "low",
                primaryInfoStatus: payload.primaryInfoStatus || "missing",
                brief: candidate.rewrite_brief,
                rewriteSourcePostId: candidate.post_id,
                rewriteSourceUrl: candidate.url,
                internalLinkTargets: candidate.internal_links || [],
                targetCharacters: 10000,
              }),
              null,
              0,
              null,
              null,
              stamp,
              stamp,
            )
            .run();
        }
        await log(clientId, `既存記事の改稿下書き${count}本を予約`);
      }
      if (
        job.type === "ubersuggest_sync" &&
        (!body.ok ||
          (body.ok &&
            Array.isArray(result?.notes) &&
            result.notes.some((note: any) =>
              /(oauth|auth|login|logged in|unauthori|認証|ログイン|token.*expired)/i.test(
                String(note),
              ),
            )))
      ) {
        const stamp = now();
        const errorText = String(body.error || "");
        const needsLogin =
          /(oauth|auth|login|log in|logged in|unauthori|認証|ログイン|token.*expired)/i.test(
            errorText,
          );
        // A timeout or an MCP-side error does not invalidate the OAuth token.
        // Preserve the usable connection so the next sync can retry with the
        // same credential; only a genuine OAuth rejection asks the user to
        // connect again.
        const connectionStatus = needsLogin ? "reauth_required" : "connected";
        await db
          .prepare(
            "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,updated_at=excluded.updated_at",
          )
          .bind(
            id(),
            clientId,
            "ubersuggest",
            connectionStatus,
            JSON.stringify({
              mode: "codex_mcp",
              mcpName: "Ubersuggest",
              mcpUrl: "https://ubersuggest-mcp.neilpatelapi.com/mcp",
            }),
            null,
            stamp,
          )
          .run();
      }
      if (job.type === "primary_info_assist") {
        const stamp = now();
        const authError =
          !body.ok &&
          /Codex.*ログイン認証|not logged in|authentication|401/i.test(
            String(body.error || ""),
          );
        const connectionStatus = body.ok
          ? "connected"
          : authError
            ? "reauth_required"
            : "connection_error";
        await db
          .prepare(
            "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,public_config=excluded.public_config,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
          )
          .bind(
            id(),
            clientId,
            "codex",
            connectionStatus,
            JSON.stringify({
              mode: "local_subscription_oauth",
              lastError: body.ok
                ? null
                : String(body.error || "").slice(0, 500),
            }),
            stamp,
            stamp,
          )
          .run();
      }
      if (job.type === "wordpress_verify") {
        const stamp = now();
        const existing = await db.prepare("SELECT public_config FROM connections WHERE client_id=? AND connector='wordpress'").bind(clientId).first<any>();
        const config = { ...parse(existing?.public_config, {}), ...(body.ok ? result : {}), lastError: body.ok ? null : String(body.error || "").slice(0, 500) };
        await db.prepare("UPDATE connections SET status=?,public_config=?,checked_at=?,updated_at=? WHERE client_id=? AND connector='wordpress'").bind(body.ok ? "connected" : "connection_error", JSON.stringify(config), stamp, stamp, clientId).run();
        await log(clientId, body.ok ? "MacワーカーがWordPress接続を確認" : "MacワーカーのWordPress接続確認に失敗", body.ok ? "info" : "warn", { error: body.ok ? null : String(body.error || "").slice(0, 500) });
      }
      if (body.ok && result && job.type !== "wordpress_verify") {
        const connector =
          job.type === "ubersuggest_sync"
            ? "ubersuggest"
            : job.type === "article_generate"
              ? "codex"
              : job.type;
        const stamp = now();
        await db
          .prepare(
            "INSERT INTO snapshots (id,client_id,connector,data,retrieved_at) VALUES (?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET data=excluded.data,retrieved_at=excluded.retrieved_at",
          )
          .bind(id(), clientId, connector, JSON.stringify(result), stamp)
          .run();
        if (["ubersuggest", "codex"].includes(connector))
          await db
            .prepare(
              "INSERT INTO connections (id,client_id,connector,status,public_config,checked_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,updated_at=excluded.updated_at",
            )
            .bind(
              id(),
              clientId,
              connector,
              "connected",
              JSON.stringify({
                mode:
                  connector === "ubersuggest"
                    ? "codex_mcp"
                    : "local_subscription_oauth",
              }),
              stamp,
              stamp,
            )
            .run();
        if (job.type === "ubersuggest_sync")
          await db
            .prepare(
              "UPDATE jobs SET status='cancelled',error=NULL,updated_at=? WHERE client_id=? AND type='ubersuggest_sync' AND status='failed' AND id<>?",
            )
            .bind(stamp, clientId, job.id)
            .run();
      }
      if (body.ok && job.type === "primary_info_assist" && result) {
        const stamp = now();
        const primaryPayload = parse(job.payload, {});
        const ownerFinalized =
          primaryPayload?.mode === "finalize_article_information" &&
          primaryPayload?.answers?.factsConfirmed === "yes" &&
          primaryPayload?.answers?.rightsApproved === "yes";
        const qualityPassed = Number(result.quality_score || 0) >= 80;
        const [canonical, client] = await Promise.all([
          db
            .prepare(
              "SELECT * FROM sources WHERE client_id=? AND is_canonical=1 AND archived=0 LIMIT 1",
            )
            .bind(clientId)
            .first<any>(),
          db
            .prepare("SELECT name FROM clients WHERE id=?")
            .bind(clientId)
            .first<any>(),
        ]);
        // A completed primary-information master is explicitly approved by
        // this single-owner application. Later chat updates therefore keep it
        // usable while preserving every revised version; a manual edit still
        // follows the stricter confirmation flow below.
        const approvedChatUpdate =
          primaryPayload?.mode === "chat_interview" &&
          primaryPayload?.answers?.questionKey === "update" &&
          Boolean(canonical?.approved) &&
          String(canonical?.rights || "") === "approved";
        const confirmedForUse =
          ownerFinalized || approvedChatUpdate || result.sufficiency === "sufficient";
        const canonicalStatus =
          qualityPassed && confirmedForUse
            ? "ready"
            : "needs_confirmation";
        const sourceItem = {
          id: canonical?.id || id(),
          client_id: clientId,
          type: String(result.type || "interview").slice(0, 80),
          title: String(
            `${client?.name || "クライアント"} 正式一次情報（記事利用マスター）`,
          ).slice(0, 200),
          note: String(
            result.client_facing_summary || result.article_ready_text || result.summary || "",
          ).slice(0, 10000),
          url: "",
          rights: ownerFinalized || approvedChatUpdate
            ? "approved"
            : String(result.rights_status || "unconfirmed").slice(0, 100),
          approved: qualityPassed && (confirmedForUse || result.ready_for_use) ? 1 : 0,
          is_canonical: 1,
          archived: 0,
          canonical_status: canonicalStatus,
          created_at: canonical?.created_at || stamp,
          updated_at: stamp,
        };
        await recordPrimaryInfoVersion(clientId, sourceItem.id, sourceItem.note, primaryPayload?.answers || {}, String(result.quality_summary || "一次情報を更新"));
        if (canonical)
          await db
            .prepare(
              "UPDATE sources SET type=?,title=?,note=?,url=?,rights=?,approved=?,is_canonical=1,archived=0,canonical_status=?,updated_at=? WHERE id=? AND client_id=?",
            )
            .bind(
              sourceItem.type,
              sourceItem.title,
              sourceItem.note,
              sourceItem.url,
              sourceItem.rights,
              sourceItem.approved,
              sourceItem.canonical_status,
              sourceItem.updated_at,
              sourceItem.id,
              clientId,
            )
            .run();
        else
          await db
            .prepare(
              "INSERT INTO sources (id,client_id,type,title,note,url,rights,approved,is_canonical,archived,canonical_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(...Object.values(sourceItem))
            .run();
        await db
          .prepare(
            "UPDATE sources SET archived=1,is_canonical=0,canonical_status='superseded',updated_at=? WHERE client_id=? AND id<>?",
          )
          .bind(stamp, clientId, sourceItem.id)
          .run();
        const processedIds = (
          Array.isArray(result.processed_file_ids)
            ? result.processed_file_ids
            : []
        )
          .map(String)
          .filter(Boolean)
          .slice(0, 5);
        if (processedIds.length) {
          const marks = processedIds.map(() => "?").join(",");
          await db
            .prepare(
              `UPDATE source_files SET status='processed' WHERE client_id=? AND id IN (${marks})`,
            )
            .bind(clientId, ...processedIds)
            .run();
        }
        await db
          .prepare(
            "UPDATE clients SET primary_info_status=?,updated_at=? WHERE id=?",
          )
          .bind(
            qualityPassed && confirmedForUse
              ? "sufficient"
              : "missing",
            stamp,
            clientId,
          )
          .run();
        await log(
          clientId,
          !qualityPassed
            ? `Codexが記事情報を${Number(result.quality_score || 0)}点と採点（80点未満）`
            : ownerFinalized
            ? "所有者確認済みのため、Codexが記事に使う記事情報を完成として確定"
            : approvedChatUpdate
              ? "確認済みの一次情報へチャット更新を反映"
            : canonical
              ? "Codexが正式な一次情報を更新"
              : "Codexが正式な一次情報を作成",
        );
      }
      await log(
        clientId,
        body.ok ? `${job.type}が完了` : `${job.type}が失敗`,
        body.ok ? "info" : "error",
        { error: body.error },
      );
      return json({ ok: true });
    }
    return json({ error: "APIが見つかりません。" }, 404);
  } catch (error: any) {
    if (error instanceof Response) return error;
    return json({ error: error.message || "処理できませんでした。" }, 400);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    await ensureSchema();
    const owner = await requireOwner(request);
    const route = ((await context.params).path || []).join("/");
    const seoEntity = route.match(/^clients\/([^/]+)\/(topics|clusters|keywords|briefs)\/([^/]+)$/);
    if (seoEntity) {
      const [, clientId, kind, itemId] = seoEntity;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const table = kind === "topics" ? "topics" : kind === "clusters" ? "keyword_clusters" : kind === "keywords" ? "seo_keywords" : "content_briefs";
      const existing = await runtime().DB.prepare(`SELECT * FROM ${table} WHERE id=? AND client_id=?`).bind(itemId, clientId).first<any>();
      if (!existing) return json({ error: "対象データが見つかりません。" }, 404);
      const body = await input(request), stamp = now(), db = runtime().DB;
      if (kind === "topics") {
        const name = String(body.name ?? existing.name).trim(); if (!name) return json({ error: "Topic名を入力してください。" }, 422);
        await db.prepare("UPDATE topics SET name=?,description=?,status=?,updated_at=? WHERE id=? AND client_id=?").bind(name.slice(0,160),String(body.description ?? existing.description).slice(0,3000),String(body.status ?? existing.status)==="archived"?"archived":"active",stamp,itemId,clientId).run();
      } else if (kind === "clusters") {
        const name = String(body.name ?? existing.name).trim(); if (!name) return json({ error: "Cluster名を入力してください。" }, 422);
        const topicId = String(body.topicId ?? existing.topic_id ?? "") || null;
        if (topicId && !(await db.prepare("SELECT id FROM topics WHERE id=? AND client_id=?").bind(topicId,clientId).first())) return json({ error:"このクライアントのTopicを選んでください。" },422);
        await db.prepare("UPDATE keyword_clusters SET name=?,description=?,topic_id=?,status=?,updated_at=? WHERE id=? AND client_id=?").bind(name.slice(0,160),String(body.description ?? existing.description).slice(0,3000),topicId,String(body.status ?? existing.status)==="archived"?"archived":"active",stamp,itemId,clientId).run();
      } else if (kind === "keywords") {
        const keyword = String(body.keyword ?? existing.keyword).trim(), normalized = normalizeKeyword(keyword); if (!normalized) return json({ error:"キーワードを入力してください。" },422);
        const duplicate = await db.prepare("SELECT id FROM seo_keywords WHERE client_id=? AND normalized_keyword=? AND id<>?").bind(clientId,normalized,itemId).first(); if (duplicate) return json({ error:"同じ表記のキーワードは既に登録されています。" },409);
        const topicId = String(body.topicId ?? existing.topic_id ?? "") || null, clusterId = String(body.clusterId ?? existing.cluster_id ?? "") || null;
        if (topicId && !(await db.prepare("SELECT id FROM topics WHERE id=? AND client_id=?").bind(topicId,clientId).first())) return json({error:"このクライアントのTopicを選んでください。"},422);
        if (clusterId && !(await db.prepare("SELECT id FROM keyword_clusters WHERE id=? AND client_id=?").bind(clusterId,clientId).first())) return json({error:"このクライアントのClusterを選んでください。"},422);
        const values = { searchVolume: body.searchVolume ?? existing.search_volume, keywordDifficulty: body.keywordDifficulty ?? existing.keyword_difficulty, businessRelevance: body.businessRelevance ?? existing.business_relevance, conversionPotential: body.conversionPotential ?? existing.conversion_potential, topicalRelevance: body.topicalRelevance ?? existing.topical_relevance, rankingOpportunity: body.rankingOpportunity ?? existing.ranking_opportunity, currentPosition: body.currentPosition ?? existing.current_position, impressions: body.impressions ?? existing.impressions };
        const priority = scoreKeyword(values, defaultPriorityWeights);
        await db.prepare("UPDATE seo_keywords SET keyword=?,normalized_keyword=?,topic_id=?,cluster_id=?,search_intent=?,search_volume=?,keyword_difficulty=?,current_position=?,impressions=?,business_relevance=?,conversion_potential=?,topical_relevance=?,ranking_opportunity=?,priority_score=?,status=?,updated_at=? WHERE id=? AND client_id=?").bind(keyword.slice(0,240),normalized,topicId,clusterId,String(body.searchIntent ?? existing.search_intent).slice(0,50),Number(values.searchVolume)||null,Number(values.keywordDifficulty)||null,Number(values.currentPosition)||null,Number(values.impressions)||null,Number(values.businessRelevance)||null,Number(values.conversionPotential)||null,Number(values.topicalRelevance)||null,Number(values.rankingOpportunity)||null,priority,String(body.status ?? existing.status).slice(0,50),stamp,itemId,clientId).run();
      } else {
        await db.prepare("UPDATE content_briefs SET keyword_id=?,search_intent=?,target_user=?,explicit_need=?,latent_need=?,desired_outcome=?,cta=?,status=?,version=version+1,updated_at=? WHERE id=? AND client_id=?").bind(String(body.keywordId ?? existing.keyword_id ?? "")||null,String(body.searchIntent ?? existing.search_intent).slice(0,50),String(body.targetUser ?? existing.target_user).slice(0,2000),String(body.explicitNeed ?? existing.explicit_need).slice(0,4000),String(body.latentNeed ?? existing.latent_need).slice(0,4000),String(body.desiredOutcome ?? existing.desired_outcome).slice(0,4000),String(body.cta ?? existing.cta).slice(0,2000),String(body.status ?? existing.status).slice(0,50),stamp,itemId,clientId).run();
      }
      await log(clientId, `${kind}を更新`);
      return json({ ok: true });
    }
    const match = route.match(/^clients\/([^/]+)\/sources\/([^/]+)$/);
    if (!match) return json({ error: "APIが見つかりません。" }, 404);
    const [, clientId, sourceId] = match;
    if (!(await ownedClient(clientId, owner)))
      return json({ error: "クライアントが見つかりません。" }, 404);
    const existing = await runtime()
      .DB.prepare(
        "SELECT * FROM sources WHERE id=? AND client_id=?",
      )
      .bind(sourceId, clientId)
      .first<any>();
    if (!existing) return json({ error: "一次情報が見つかりません。" }, 404);
    const body = await input(request);
    const title = String(body.title || "").trim();
    const note = String(body.note || "").trim();
    if (!title) return json({ error: "タイトルを入力してください。" }, 422);
    if (!note)
      return json({ error: "一次情報の内容を入力してください。" }, 422);
    const rights = String(body.rights || "unconfirmed").slice(0, 100);
    const item = {
      type: String(body.type || "manual_entry").slice(0, 80),
      title: title.slice(0, 200),
      note: note.slice(0, 10000),
      url: String(body.url || "")
        .trim()
        .slice(0, 2000),
      rights,
      approved: rights === "approved" || body.approved ? 1 : 0,
    };
    await runtime()
      .DB.prepare(
        "UPDATE sources SET type=?,title=?,note=?,url=?,rights=?,approved=?,canonical_status=?,updated_at=? WHERE id=? AND client_id=?",
      )
      .bind(
        item.type,
        item.title,
        item.note,
        item.url,
        item.rights,
        item.approved,
        existing.is_canonical
          ? body.autoConsolidate
            ? "candidate"
            : "needs_confirmation"
          : "superseded",
        now(),
        sourceId,
        clientId,
      )
      .run();
    await runtime()
      .DB.prepare(
        "UPDATE clients SET primary_info_status='missing',updated_at=? WHERE id=?",
      )
      .bind(now(), clientId)
      .run();
    await recordPrimaryInfoVersion(clientId, sourceId, item.note, [], "手動編集で一次情報を更新");
    await log(clientId, `一次情報を編集: ${item.title}`);
    return json({
      ok: true,
      source: { id: sourceId, client_id: clientId, ...item },
    });
  } catch (error: any) {
    if (error instanceof Response) return error;
    return json(
      { error: error.message || "一次情報を更新できませんでした。" },
      400,
    );
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    await ensureSchema();
    const owner = await requireOwner(request);
    const parts = (await context.params).path || [];
    const seoEntity = parts.join("/").match(/^clients\/([^/]+)\/(topics|clusters|keywords|briefs)\/([^/]+)$/);
    if (seoEntity) {
      const [, clientId, kind, itemId] = seoEntity;
      if (!(await ownedClient(clientId, owner))) return json({ error: "クライアントが見つかりません。" }, 404);
      const table = kind === "topics" ? "topics" : kind === "clusters" ? "keyword_clusters" : kind === "keywords" ? "seo_keywords" : "content_briefs";
      const found = await runtime().DB.prepare(`SELECT id FROM ${table} WHERE id=? AND client_id=?`).bind(itemId, clientId).first();
      if (!found) return json({ error: "対象データが見つかりません。" }, 404);
      if (kind === "briefs") await runtime().DB.prepare("DELETE FROM content_briefs WHERE id=? AND client_id=?").bind(itemId, clientId).run();
      else await runtime().DB.prepare(`UPDATE ${table} SET status='archived',updated_at=? WHERE id=? AND client_id=?`).bind(now(), itemId, clientId).run();
      await log(clientId, `${kind}を${kind === "briefs" ? "削除" : "無効化"}`);
      return json({ ok: true, archived: kind !== "briefs" });
    }
    const match = parts.join("/").match(/^clients\/([^/]+)$/);
    if (!match) return json({ error: "APIが見つかりません。" }, 404);
    const client = (await ownedClient(match[1], owner)) as any;
    if (!client) return json({ error: "クライアントが見つかりません。" }, 404);
    const body = await input(request);
    if (body.confirmation !== client.name)
      return json(
        { error: `確認欄へ「${client.name}」と正確に入力してください。` },
        422,
      );
    const db = runtime().DB;
    const active = await db
      .prepare(
        "SELECT id FROM jobs WHERE client_id=? AND status IN ('queued','running') LIMIT 1",
      )
      .bind(client.id)
      .first();
    if (active)
      return json(
        {
          error:
            "同期・記事生成などの実行中処理があります。完了後に削除してください。",
        },
        409,
      );
    const storedFiles = await db
      .prepare("SELECT object_key FROM source_files WHERE client_id=?")
      .bind(client.id)
      .all();
    if (runtime().FILES)
      for (const file of storedFiles.results as any[])
        await runtime().FILES!.delete(file.object_key);
    const replacement = await db
      .prepare(
        "SELECT id FROM clients WHERE owner_id=? AND id<>? ORDER BY created_at LIMIT 1",
      )
      .bind(owner, client.id)
      .first<any>();
    const statements = [
      db.prepare("DELETE FROM oauth_states WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM connections WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM sources WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM source_files WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM jobs WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM snapshots WHERE client_id=?").bind(client.id),
      db.prepare("DELETE FROM logs WHERE client_id=?").bind(client.id),
      replacement
        ? db
            .prepare("UPDATE worker_tokens SET client_id=? WHERE client_id=?")
            .bind(replacement.id, client.id)
        : db
            .prepare("DELETE FROM worker_tokens WHERE client_id=?")
            .bind(client.id),
      db
        .prepare("DELETE FROM clients WHERE id=? AND owner_id=?")
        .bind(client.id, owner),
    ];
    await db.batch(statements);
    return json({ ok: true, deleted: { id: client.id, name: client.name } });
  } catch (error: any) {
    if (error instanceof Response) return error;
    return json({ error: error.message || "削除できませんでした。" }, 400);
  }
}

async function googleStart(request: Request, clientId: string, owner: string) {
  const env = runtime();
  const credentials = await googleCredentials(owner, request);
  if (!credentials)
    return json({ error: "Google OAuthの管理者設定が未完了です。" }, 503);
  const state = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state,client_id,owner_id,expires_at) VALUES (?,?,?,?)",
  )
    .bind(
      state,
      clientId,
      owner,
      new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    )
    .run();
  const scope = [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/youtube.readonly",
  ].join(" ");
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return json({
    ok: true,
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
}
async function googleCallback(request: Request) {
  const env = runtime();
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const finish = (result: string) =>
    Response.redirect(
      `${url.origin}/?google=${encodeURIComponent(result)}`,
      302,
    );
  const pending = await env.DB.prepare(
    "SELECT * FROM oauth_states WHERE state=? AND expires_at>?",
  )
    .bind(state, now())
    .first<any>();
  if (!pending) return finish("session_expired");
  try {
    if (url.searchParams.get("error")) return finish("denied");
    const credentials = await googleCredentials(pending.owner_id, request);
    if (!credentials) return finish("settings_missing");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: url.searchParams.get("code") || "",
        grant_type: "authorization_code",
        redirect_uri: credentials.redirectUri,
      }),
    });
    const tokens = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      const reason =
        tokens.error === "invalid_client"
          ? "invalid_client"
          : tokens.error === "invalid_grant"
            ? "invalid_grant"
            : tokens.error === "redirect_uri_mismatch"
              ? "redirect_mismatch"
              : "token_exchange_failed";
      console.error("Google OAuth token exchange failed", {
        reason,
        status: response.status,
      });
      return finish(reason);
    }
    const previous = await env.DB.prepare(
      "SELECT secret_cipher FROM connections WHERE client_id=? AND connector='gsc'",
    )
      .bind(pending.client_id)
      .first<any>();
    const previousTokens = previous?.secret_cipher
      ? await decrypt<any>(previous.secret_cipher).catch(() => ({}))
      : {};
    const savedTokens = {
      ...tokens,
      refresh_token: tokens.refresh_token || previousTokens.refresh_token || "",
      expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    };
    const cipher = await encrypt(savedTokens);
    const stamp = now();
    for (const connector of googleConnectors)
      await env.DB.prepare(
        "INSERT INTO connections (id,client_id,connector,status,public_config,secret_cipher,checked_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(client_id,connector) DO UPDATE SET status=excluded.status,secret_cipher=excluded.secret_cipher,updated_at=excluded.updated_at",
      )
        .bind(
          id(),
          pending.client_id,
          connector,
          "authorized_needs_resource",
          "{}",
          cipher,
          null,
          stamp,
        )
        .run();
    await log(pending.client_id, "Google OAuth認証が完了");
    return finish("authorized");
  } catch (error: any) {
    console.error("Google OAuth callback failed", {
      name: error?.name || "Error",
      message: String(error?.message || "unknown").slice(0, 240),
    });
    return finish("callback_failed");
  } finally {
    await env.DB.prepare("DELETE FROM oauth_states WHERE state=?")
      .bind(state)
      .run()
      .catch(() => null);
  }
}
