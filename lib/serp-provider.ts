/** Provider-neutral contract. Implementations must never synthesize SERP data. */
export type SerpParams = { keyword: string; location?: string; language?: string; device?: "desktop" | "mobile" };
export type SerpResult = { rank: number; url: string; domain?: string; title?: string; description?: string; resultType?: string };
export type SerpSearchResult = { provider: string; checkedAt: string; results: SerpResult[]; features: Record<string, unknown>; raw: unknown };
export interface SerpProvider { search(params: SerpParams): Promise<SerpSearchResult>; }

/** Extracts a JSON object only when it is literally present in an MCP result. */
export function rawMcpStructuredValue(toolResult: any): any {
  if (toolResult?.structuredContent && typeof toolResult.structuredContent === "object") return toolResult.structuredContent;
  const text = Array.isArray(toolResult?.content)
    ? toolResult.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n")
    : "";
  if (!text) return toolResult;
  try { return JSON.parse(text); } catch { return toolResult; }
}

/** Normalizes only MCP results actually returned by Ubersuggest. */
export function normalizeUbersuggestSerp(value: any, checkedAt = new Date().toISOString()): SerpSearchResult {
  const source = rawMcpStructuredValue(value);
  // `serpEntries` is the field returned by Ubersuggest MCP's verified
  // `serp_analysis` tool. The other names remain for compatible providers.
  const rows = Array.isArray(source?.serpEntries) ? source.serpEntries : Array.isArray(source?.results) ? source.results : Array.isArray(source?.serp_results) ? source.serp_results : [];
  return {
    provider: "ubersuggest",
    checkedAt,
    results: rows.slice(0, 10).map((row: any, index: number) => ({ rank: Number(row.rank ?? row.position ?? index + 1), url: String(row.url || row.link || ""), domain: row.domain ? String(row.domain) : undefined, title: row.title ? String(row.title) : undefined, description: row.description || row.snippet ? String(row.description || row.snippet) : undefined, resultType: row.result_type || row.type ? String(row.result_type || row.type) : "organic" })).filter((row: SerpResult) => row.url),
    // Do not infer PAA, AI Overview, Local Pack, or other features from an
    // organic-only response. The explicit unavailable markers are persisted
    // so the UI never presents an absent provider field as a negative result.
    features: {
      ai_overview: source?.features?.ai_overview ?? source?.ai_overview ?? "DATA_NOT_AVAILABLE",
      people_also_ask: source?.features?.people_also_ask ?? source?.people_also_ask ?? "DATA_NOT_AVAILABLE",
      local_pack: source?.features?.local_pack ?? source?.local_pack ?? "DATA_NOT_AVAILABLE",
      detailed_serp_features: source?.features ?? "DATA_NOT_AVAILABLE",
    }, raw: value,
  };
}
