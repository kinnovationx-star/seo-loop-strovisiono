import { normalizeUbersuggestSerp } from "../../lib/serp-provider";
import { buildUbersuggestSerpArguments, selectUbersuggestSerpTool, UbersuggestMcpClient, UbersuggestMcpError } from "./ubersuggest-mcp";

interface Env { DB: D1Database; CREDENTIALS_ENCRYPTION_KEY: string; }
const issuer = "https://ubersuggest-mcp.neilpatelapi.com";
const text = new TextEncoder();
const now = () => new Date().toISOString();
const html = (body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>SEO Loop MCP検証</title><main style="font-family:system-ui;max-width:760px;margin:48px auto;line-height:1.7"><h1>SEO Loop MCP検証環境</h1>${body}</main>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function key(env: Env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", text.encode(env.CREDENTIALS_ENCRYPTION_KEY)), "AES-GCM", false, ["encrypt", "decrypt"]); }
function b64(bytes: Uint8Array) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function unb64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
async function seal(env: Env, value: unknown) { const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), text.encode(JSON.stringify(value))); return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`; }
async function open<T>(env: Env, value: string): Promise<T> { const [iv, encrypted] = value.split("."); const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(encrypted)); return JSON.parse(new TextDecoder().decode(clear)); }
async function digest(value: string) { return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function schema(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS verification_oauth_states (state TEXT PRIMARY KEY, secret_cipher TEXT NOT NULL, expires_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS verification_connections (id TEXT PRIMARY KEY, secret_cipher TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS serp_snapshots (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, keyword TEXT NOT NULL, provider TEXT NOT NULL, tool_name TEXT NOT NULL, requested_at TEXT NOT NULL, raw_data TEXT NOT NULL, normalized_data TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS serp_results (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, rank INTEGER, url TEXT, domain TEXT, title TEXT, description TEXT, result_type TEXT, created_at TEXT NOT NULL, UNIQUE(snapshot_id,rank,url))"),
    db.prepare("CREATE TABLE IF NOT EXISTS serp_usage_events (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, request_count INTEGER NOT NULL, created_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS verification_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, error_code TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"),
  ]);
}
function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => (/authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password/i.test(k) ? [k, "[REDACTED]"] : [k, redact(v)])));
}
async function start(request: Request, env: Env) {
  const base = new URL(request.url).origin, redirectUri = `${base}/oauth/callback`;
  const registration = await fetch(`${issuer}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "SEO Loop Direct MCP Verification", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const registered: any = await registration.json().catch(() => ({}));
  if (!registration.ok || !registered.client_id) return html("<p>Ubersuggest MCPの検証用OAuthクライアントを登録できませんでした。もう一度お試しください。</p>", 502);
  const state = crypto.randomUUID(), verifier = b64(crypto.getRandomValues(new Uint8Array(48))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  await env.DB.prepare("INSERT INTO verification_oauth_states (state,secret_cipher,expires_at) VALUES (?,?,?)").bind(state, await seal(env, { clientId: registered.client_id, verifier, redirectUri }), new Date(Date.now() + 10 * 60 * 1000).toISOString()).run();
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri, scope: "serp", state, code_challenge: await digest(verifier), code_challenge_method: "S256" }).toString();
  return Response.redirect(authorize.toString(), 302);
}
async function callback(request: Request, env: Env) {
  const url = new URL(request.url), state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  const row = await env.DB.prepare("SELECT secret_cipher,expires_at FROM verification_oauth_states WHERE state=?").bind(state).first<any>();
  await env.DB.prepare("DELETE FROM verification_oauth_states WHERE state=?").bind(state).run();
  if (!row || !code || Date.parse(row.expires_at) < Date.now()) return html("<p>認証の有効時間が切れました。最初からやり直してください。</p>", 400);
  const pending = await open<{clientId:string; verifier:string; redirectUri:string}>(env, row.secret_cipher);
  const tokenResponse = await fetch(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: pending.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.verifier }) });
  const token: any = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) return html("<p>Ubersuggest MCPの検証用認証を完了できませんでした。最初からやり直してください。</p>", 502);
  const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000).toISOString();
  await env.DB.prepare("INSERT INTO verification_connections (id,secret_cipher,expires_at,updated_at) VALUES ('ubersuggest',?,?,?) ON CONFLICT(id) DO UPDATE SET secret_cipher=excluded.secret_cipher,expires_at=excluded.expires_at,updated_at=excluded.updated_at").bind(await seal(env, { clientId: pending.clientId, accessToken: token.access_token, refreshToken: token.refresh_token || "" }), expiresAt, now()).run();
  return html("<p><strong>検証用のUbersuggest接続が完了しました。</strong></p><p>次は安全な一般キーワードで、Claudeを使わないSERP取得・保存を1回だけ実行します。</p><form method=\"post\" action=\"/run\"><button>直接MCPでSERP取得を実行</button></form>");
}
async function accessToken(env: Env) {
  const connection = await env.DB.prepare("SELECT secret_cipher,expires_at FROM verification_connections WHERE id='ubersuggest'").first<any>();
  if (!connection) throw new UbersuggestMcpError("MCP_AUTH_FAILED", "検証用のUbersuggest接続がありません。");
  const secret = await open<{clientId:string; accessToken:string; refreshToken:string}>(env, connection.secret_cipher);
  if (Date.parse(connection.expires_at) > Date.now() + 60_000) return secret.accessToken;
  if (!secret.refreshToken) throw new UbersuggestMcpError("MCP_TOKEN_REFRESH_FAILED", "検証用Ubersuggest接続の更新情報がありません。再接続してください。");
  const refreshed = await fetch(`${issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: secret.refreshToken, client_id: secret.clientId }) });
  const token: any = await refreshed.json().catch(() => ({}));
  if (!refreshed.ok || !token.access_token) throw new UbersuggestMcpError("MCP_TOKEN_REFRESH_FAILED", "検証用Ubersuggest接続を更新できませんでした。再接続してください。");
  await env.DB.prepare("UPDATE verification_connections SET secret_cipher=?,expires_at=?,updated_at=? WHERE id='ubersuggest'").bind(await seal(env, { clientId: secret.clientId, accessToken: token.access_token, refreshToken: token.refresh_token || secret.refreshToken }), new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000).toISOString(), now()).run();
  return token.access_token as string;
}
async function run(request: Request, env: Env) {
  const suppliedJobId = new URL(request.url).searchParams.get("jobId");
  const jobId = suppliedJobId && /^[a-zA-Z0-9_-]{1,80}$/.test(suppliedJobId) ? suppliedJobId : crypto.randomUUID(), stamp = now();
  const previous = await env.DB.prepare("SELECT status,detail FROM verification_runs WHERE job_id=?").bind(jobId).first<any>();
  if (previous?.status === "SUCCESS") return html("<p><strong>同じ検証ジョブはすでに保存済みです。</strong></p><p>外部MCPを再実行せず、重複Snapshotを作成していません。</p>");
  let discovery: unknown = null;
  await env.DB.prepare("INSERT INTO verification_runs (id,job_id,status,created_at,updated_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), jobId, "RUNNING", stamp, stamp).run();
  try {
    const client = new UbersuggestMcpClient(await accessToken(env));
    const tools = await client.listTools();
    discovery = tools.map(tool => ({ name: tool.name, description: tool.description || "", input_schema: tool.inputSchema || {} }));
    await env.DB.prepare("UPDATE verification_runs SET detail=?,updated_at=? WHERE job_id=?").bind(JSON.stringify({ discovery }), now(), jobId).run();
    const tool = selectUbersuggestSerpTool(tools);
    const rawToolResult = await client.callTool(tool.name, buildUbersuggestSerpArguments(tool, "seo 対策", { limit: 10 }));
    const call = { toolName: tool.name, requestedAt: now(), rawToolResult };
    const normalized = normalizeUbersuggestSerp(call.rawToolResult, call.requestedAt);
    const snapshotId = crypto.randomUUID(), raw = redact(call.rawToolResult), normal = redact(normalized);
    await env.DB.prepare("INSERT INTO serp_snapshots (id,job_id,keyword,provider,tool_name,requested_at,raw_data,normalized_data,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(snapshotId, jobId, "seo 対策", "ubersuggest", call.toolName, call.requestedAt, JSON.stringify(raw), JSON.stringify(normal), normalized.results.length ? "SUCCESS" : "EMPTY", now()).run();
    for (const item of normalized.results) await env.DB.prepare("INSERT INTO serp_results (id,snapshot_id,rank,url,domain,title,description,result_type,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_id,rank,url) DO NOTHING").bind(crypto.randomUUID(), snapshotId, item.rank || null, item.url || null, item.domain || null, item.title || null, item.description || null, item.resultType || null, now()).run();
    await env.DB.prepare("INSERT INTO serp_usage_events (id,snapshot_id,provider,request_count,created_at) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(), snapshotId, "ubersuggest", 1, now()).run();
    await env.DB.prepare("UPDATE verification_runs SET status='SUCCESS',detail=?,updated_at=? WHERE job_id=?").bind(JSON.stringify({ snapshotId, toolName: call.toolName, resultCount: normalized.results.length, features: Object.keys(normalized.features), discovery }), now(), jobId).run();
    return html(`<p><strong>成功しました。</strong></p><ul><li>Tool: ${call.toolName}</li><li>正規化SERP結果: ${normalized.results.length}件</li><li>Claude呼び出し: なし</li><li>検証用D1保存: 完了</li></ul><p>認証情報は表示・保存していません。</p>`);
  } catch (error: any) {
    const code = error instanceof UbersuggestMcpError ? error.code : "MCP_PROVIDER_FAILED";
    await env.DB.prepare("UPDATE verification_runs SET status='FAILED',error_code=?,detail=?,updated_at=? WHERE job_id=?").bind(code, JSON.stringify({ message: String(error?.message || "MCP検証に失敗しました").slice(0, 500), discovery }), now(), jobId).run();
    return html(`<p><strong>検証は完了しませんでした。</strong></p><p>安全なエラーコード: ${code}</p><p>${String(error?.message || "MCP検証に失敗しました")}</p>`, 502);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    await schema(env.DB);
    const path = new URL(request.url).pathname;
    if (path === "/health") return response({ ok: true, environment: "isolated-serp-mcp-verification" });
    if (path === "/oauth/start") return start(request, env);
    if (path === "/oauth/callback") return callback(request, env);
    if (path === "/run" && request.method === "POST") return run(request, env);
    return html("<p>このWorkerは本番と分離された、Ubersuggest Direct MCP検証専用環境です。</p><p><a href=\"/oauth/start\">Ubersuggestを安全に接続する</a></p>");
  },
};
