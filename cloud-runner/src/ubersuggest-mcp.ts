/**
 * Direct, Streamable-HTTP MCP client for the Ubersuggest connector.
 *
 * Facts returned from this client are intentionally kept separate from
 * Claude.  The only inputs accepted by the SERP provider are the actual
 * `tools/call` result and the tool schema discovered from this MCP server.
 * No credentials are ever included in errors, logs, or returned payloads.
 */
export type McpTool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };
export type McpSerpCall = { toolName: string; requestedAt: string; rawToolResult: unknown };

export class UbersuggestMcpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const endpoint = "https://ubersuggest-mcp.neilpatelapi.com/mcp";
const protocolVersion = "2025-11-25";
const safeTransportReason = (error: unknown) => String(error instanceof Error ? error.message : "unknown")
  .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
  .replace(/(access|refresh)[_-]?token=[^\s&]+/gi, "$1_token=[REDACTED]")
  .slice(0, 240);

function safeError(code: string, response: Response) {
  if (response.status === 401 || response.status === 403)
    return new UbersuggestMcpError("MCP_AUTH_FAILED", "Ubersuggest MCPの認証に失敗しました。再接続してください。");
  if (response.status === 429)
    return new UbersuggestMcpError("MCP_RATE_LIMITED", "Ubersuggest MCPの利用上限に達しました。時間をおいて再試行してください。");
  return new UbersuggestMcpError(code, `Ubersuggest MCPへの接続に失敗しました（HTTP ${response.status}）。`);
}

function parseRpcPayload(contentType: string, body: string): any {
  if (contentType.includes("text/event-stream")) {
    const data = body.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean);
    const last = data.at(-1);
    if (!last) throw new UbersuggestMcpError("MCP_CONNECTION_FAILED", "Ubersuggest MCPから有効な応答を受信できませんでした。");
    return JSON.parse(last);
  }
  return JSON.parse(body);
}

function resultOrThrow(payload: any) {
  if (payload?.error) {
    const code = payload.error.code === -32601 ? "MCP_TOOL_UNAVAILABLE" : "MCP_PROVIDER_FAILED";
    throw new UbersuggestMcpError(code, `Ubersuggest MCPがリクエストを受け付けませんでした（${payload.error.code ?? "unknown"}）。`);
  }
  if (!("result" in (payload || {}))) throw new UbersuggestMcpError("MCP_CONNECTION_FAILED", "Ubersuggest MCPの応答形式を確認できませんでした。");
  return payload.result;
}

/** Find one unambiguous SERP tool. The tool name is never hard-coded. */
export function selectUbersuggestSerpTool(tools: McpTool[]) {
  const broadCandidates = tools.filter(tool => /serp/i.test(tool.name));
  // Verified through the live Ubersuggest MCP tool discovery on 2026-08-30:
  // `serp_analysis` is the retrieval tool; `estimate_serp_clicks` is only a
  // calculator. Keep this selection conditional on discovery so a changed
  // provider never silently becomes a different API call.
  const exact = broadCandidates.filter(tool => tool.name === "serp_analysis");
  const candidates = exact.length === 1 ? exact : broadCandidates;
  if (candidates.length !== 1)
    throw new UbersuggestMcpError(
      "MCP_SERP_TOOL_UNAVAILABLE",
      candidates.length ? "Ubersuggest MCPのSERPツールを一意に選択できませんでした。" : "Ubersuggest MCPにSERP取得ツールが見つかりませんでした。",
    );
  const tool = candidates[0];
  const properties = tool.inputSchema?.properties || {};
  // The schema must explicitly advertise the keyword field. We do not infer
  // arbitrary argument names because that can silently call a different tool.
  if (!("keyword" in properties))
    throw new UbersuggestMcpError("MCP_SERP_ARGUMENT_UNAVAILABLE", "Ubersuggest MCPのSERPツールにkeyword引数が定義されていません。");
  return tool;
}

export function buildUbersuggestSerpArguments(tool: McpTool, keyword: string, options: { language?: string; locId?: number; limit?: number } = {}) {
  const properties = tool.inputSchema?.properties || {};
  const arguments_: Record<string, unknown> = { keyword };
  for (const key of ["language", "locId", "limit"] as const)
    if (options[key] && key in properties) arguments_[key] = options[key];
  return arguments_;
}
export function selectUbersuggestKeywordSuggestionTool(tools: McpTool[]) {
  const candidates = tools.filter(tool => /(?:keyword.*(?:suggest|idea)|(?:suggest|idea).*keyword)/i.test(tool.name));
  if (candidates.length !== 1) throw new UbersuggestMcpError("MCP_KEYWORD_SUGGESTIONS_UNAVAILABLE", "Ubersuggest MCPのキーワード候補ツールを一意に選択できませんでした。");
  const tool = candidates[0], properties = tool.inputSchema?.properties || {};
  const argument = ["keyword", "seed_keyword", "query"].find(name => name in properties);
  if (!argument) throw new UbersuggestMcpError("MCP_KEYWORD_SUGGESTIONS_ARGUMENT_UNAVAILABLE", "Ubersuggest MCPのキーワード候補ツールに主軸キーワード引数が定義されていません。");
  return { tool, argument };
}

export class UbersuggestMcpClient {
  private sessionId = "";
  private initialized = false;
  private negotiatedProtocolVersion = protocolVersion;

  constructor(
    private readonly accessToken: string,
    // Wrap the platform function so Cloudflare's native fetch keeps its
    // required global receiver; storing bare `fetch` loses that receiver.
    private readonly request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    if (!accessToken) throw new UbersuggestMcpError("MCP_AUTH_FAILED", "Ubersuggest MCPの接続情報がありません。再接続してください。");
  }

  private async rpc(method: string, params?: unknown, notification = false) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.negotiatedProtocolVersion,
    };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method, params: params || {} };
    if (!notification) payload.id = crypto.randomUUID();
    let response: Response;
    try {
      response = await this.request(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (error) {
      throw new UbersuggestMcpError("MCP_CONNECTION_FAILED", `Ubersuggest MCPへ接続できませんでした。通信状態を確認してください。 (${safeTransportReason(error)})`);
    }
    if (!response.ok) throw safeError("MCP_CONNECTION_FAILED", response);
    const session = response.headers.get("MCP-Session-Id");
    if (session) this.sessionId = session;
    if (notification) return null;
    let data: any;
    try { data = parseRpcPayload(response.headers.get("content-type") || "", await response.text()); }
    catch (error) {
      if (error instanceof UbersuggestMcpError) throw error;
      throw new UbersuggestMcpError("MCP_CONNECTION_FAILED", "Ubersuggest MCPの応答を解析できませんでした。");
    }
    return resultOrThrow(data);
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.rpc("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "seo-loop-serp-provider", version: "1.0.0" } });
    // Subsequent calls use the version explicitly negotiated by the server.
    if (typeof result?.protocolVersion === "string") this.negotiatedProtocolVersion = result.protocolVersion;
    await this.rpc("notifications/initialized", {}, true);
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.rpc("tools/list");
    if (!Array.isArray(result?.tools)) throw new UbersuggestMcpError("MCP_TOOL_DISCOVERY_FAILED", "Ubersuggest MCPのツール一覧を取得できませんでした。");
    return result.tools;
  }

  async callTool(name: string, arguments_: Record<string, unknown>) {
    await this.initialize();
    return this.rpc("tools/call", { name, arguments: arguments_ });
  }

  async callSerp(keyword: string, options: { language?: string; locId?: number; limit?: number } = {}): Promise<McpSerpCall> {
    const tool = selectUbersuggestSerpTool(await this.listTools());
    const rawToolResult = await this.callTool(tool.name, buildUbersuggestSerpArguments(tool, keyword, options));
    return { toolName: tool.name, requestedAt: new Date().toISOString(), rawToolResult };
  }
  async callKeywordSuggestions(keyword: string) {
    const selected = selectUbersuggestKeywordSuggestionTool(await this.listTools());
    const rawToolResult = await this.callTool(selected.tool.name, { [selected.argument]: keyword });
    return { toolName: selected.tool.name, requestedAt: new Date().toISOString(), rawToolResult };
  }
}
