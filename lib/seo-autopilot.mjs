const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const available = (source) => source && source.status !== "DATA_NOT_AVAILABLE" && source.status !== "NOT_AVAILABLE";
const level = (value, medium, high) => value >= high ? "HIGH" : value >= medium ? "MEDIUM" : "LOW";

export const ACTION_TYPES = ["NEW_ARTICLE", "REWRITE", "EXPAND", "TITLE_OPTIMIZATION", "INTERNAL_LINK", "MERGE", "REDIRECT", "NO_ACTION"];

export function freshnessStatus(value, maxAgeHours = 36, current = Date.now()) {
  if (!value) return "NOT_AVAILABLE";
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "NOT_AVAILABLE";
  return current - at <= maxAgeHours * 3600_000 ? "FRESH" : "STALE";
}

export function scoreAction({ impact = "LOW", confidence = "LOW", effort = "MEDIUM", risk = "LOW", priority = 0 }) {
  const weights = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  const score = weights[impact] * 30 + weights[confidence] * 20 + Math.max(0, 3 - weights[effort]) * 10 + Math.max(0, 3 - weights[risk]) * 10 + Math.max(0, Math.min(100, number(priority))) * .3;
  return Math.round(score * 10) / 10;
}

const candidate = (actionType, details) => ({ actionType, status: details.humanReview ? "HUMAN_REVIEW_REQUIRED" : "RECOMMENDED", ...details, score: scoreAction(details) });

export function evaluateWeeklyAutopilot(input = {}) {
  const freshness = input.freshness || {};
  const gsc = input.gsc || {}, ga4 = input.ga4 || {}, serp = input.serp || {}, ubersuggest = input.ubersuggest || {};
  const keyword = input.keyword || {}, article = input.article || {}, cannibalization = String(input.cannibalization?.risk || "DATA_NOT_AVAILABLE").toUpperCase();
  const dataState = { gsc: freshness.gsc || "NOT_AVAILABLE", ga4: freshness.ga4 || "NOT_AVAILABLE", serp: freshness.serp || "NOT_AVAILABLE", ubersuggest: freshness.ubersuggest || "NOT_AVAILABLE" };
  const criticalMissing = dataState.gsc !== "FRESH" && dataState.ga4 !== "FRESH";
  const reasons = [];
  const candidates = [];
  const priority = number(keyword.priorityScore);
  const position = number(gsc.position || keyword.position);
  const impressions = number(gsc.impressions);
  const ctr = number(gsc.ctr);
  const positionDelta = number(gsc.positionDelta);
  const impressionsGrowth = number(gsc.impressionsGrowth);
  const quality = number(article.qualityScore);
  const hasGap = Boolean(serp.contentGap || serp.requiredTopics?.length || serp.intentChanged || serp.competitorChanged);
  const hasMappedArticle = Boolean(article.id);
  const isYmylHigh = String(article.ymylRisk || "").toUpperCase() === "HIGH";

  if (criticalMissing) reasons.push("GSCとGA4の両方が最新でないため、重要な判断データが不足しています。");
  if (cannibalization === "HIGH") {
    candidates.push(candidate("MERGE", { impact: "HIGH", confidence: available(gsc) ? "HIGH" : "MEDIUM", effort: "HIGH", risk: "HIGH", priority, humanReview: true, reason: "カニバリゼーションHIGH。新規記事は選択せず、統合先を人間確認します。", evidence: { cannibalization: input.cannibalization } }));
    if (article.sourceUrl && article.targetUrl) candidates.push(candidate("REDIRECT", { impact: "MEDIUM", confidence: "MEDIUM", effort: "MEDIUM", risk: "HIGH", priority, humanReview: true, reason: "統合が承認された場合のRedirect候補。自動301は実行しません。", evidence: { sourceUrl: article.sourceUrl, targetUrl: article.targetUrl } }));
  }
  if (!criticalMissing && hasMappedArticle && impressions >= 100 && position > 0 && position <= 10 && ctr > 0 && ctr < .02 && !hasGap && quality >= 95) candidates.push(candidate("TITLE_OPTIMIZATION", { impact: level(impressions, 500, 3000), confidence: "HIGH", effort: "LOW", risk: "LOW", priority, reason: "表示回数があり順位は良好ですがCTRが低く、検索意図・品質に大きな問題がありません。", evidence: { impressions, position, ctr, quality } }));
  if (!criticalMissing && hasMappedArticle && position >= 4 && position <= 15 && (hasGap || impressionsGrowth > 0)) candidates.push(candidate("EXPAND", { impact: "HIGH", confidence: available(serp) ? "HIGH" : "MEDIUM", effort: "MEDIUM", risk: isYmylHigh ? "HIGH" : "LOW", priority, humanReview: isYmylHigh, reason: "4〜15位で表示があり、既存記事と検索意図が一致するため新規作成より内容強化を優先します。", evidence: { position, impressions, impressionsGrowth, contentGap: serp.contentGap || "DATA_NOT_AVAILABLE" } }));
  if (!criticalMissing && hasMappedArticle && (positionDelta >= 1 || serp.intentChanged || serp.competitorChanged || quality > 0 && quality < 95 || article.freshness === "STALE")) candidates.push(candidate("REWRITE", { impact: "HIGH", confidence: available(serp) ? "HIGH" : "MEDIUM", effort: "HIGH", risk: isYmylHigh || article.highPerforming ? "HIGH" : "MEDIUM", priority, humanReview: isYmylHigh || article.highPerforming, reason: "順位低下・SERP/意図変化・品質または鮮度の問題を実データで確認しました。", evidence: { positionDelta, intentChanged: Boolean(serp.intentChanged), competitorChanged: Boolean(serp.competitorChanged), quality, freshness: article.freshness || "DATA_NOT_AVAILABLE" } }));
  if (!criticalMissing && hasMappedArticle && (article.orphan || article.hubCandidate) && position >= 4 && position <= 15 && article.relatedArticleCount > 0) candidates.push(candidate("INTERNAL_LINK", { impact: "MEDIUM", confidence: "HIGH", effort: "LOW", risk: "LOW", priority, reason: "関連する承認済み記事があり、Link Graphの孤立/Hubシグナルと順位機会が一致します。", evidence: { orphan: Boolean(article.orphan), hubCandidate: Boolean(article.hubCandidate), relatedArticleCount: number(article.relatedArticleCount), position } }));
  const newArticleReady = !hasMappedArticle && priority >= 60 && available(serp) && String(serp.searchIntent || "DATA_NOT_AVAILABLE") !== "DATA_NOT_AVAILABLE" && cannibalization !== "HIGH" && Boolean(input.primarySourceReady) && !isYmylHigh && dataState.ubersuggest === "FRESH";
  if (newArticleReady) candidates.push(candidate("NEW_ARTICLE", { impact: "HIGH", confidence: "HIGH", effort: "HIGH", risk: "MEDIUM", priority: input.newArticlePriorityMode ? priority + 10 : priority, reason: "優先度が高く、Topic/Clusterの未カバー、SERP意図、一次情報、安全条件を確認しました。", evidence: { priority, searchIntent: serp.searchIntent, topicCoverage: input.topicCoverage, primarySourceReady: true, searchVolume: number(ubersuggest.searchVolume), seoDifficulty: number(ubersuggest.seoDifficulty), ranking: number(ubersuggest.ranking) } }));
  const noAction = candidate("NO_ACTION", { impact: "LOW", confidence: criticalMissing ? "LOW" : "MEDIUM", effort: "LOW", risk: "LOW", priority: 0, reason: criticalMissing ? reasons.join(" ") : "現在の実データでは、変更による効果が安全に見込める候補がありません。", evidence: { freshness: dataState } });
  candidates.push(noAction);
  const learnedCandidates = candidates.map((item) => {
    const history = input.learning?.byAction?.[item.actionType];
    const samples = number(history?.samples), successRate = number(history?.successRate);
    // Only completed 7/28-day measurements may influence ranking. This keeps
    // new or unmeasured actions neutral instead of inventing an outcome.
    const learningAdjustment = samples >= 5 ? successRate >= .6 ? 8 : successRate <= .4 ? -8 : 0 : 0;
    return { ...item, score: Math.round((item.score + learningAdjustment) * 10) / 10, learning: { status: samples >= 5 ? "APPLIED" : "INSUFFICIENT_DATA", samples, successRate, adjustment: learningAdjustment } };
  });
  const selectable = learnedCandidates.filter((item) => item.actionType !== "REDIRECT" || learnedCandidates.some((other) => other.actionType === "MERGE"));
  const ranked = selectable.sort((a, b) => b.score - a.score || ACTION_TYPES.indexOf(a.actionType) - ACTION_TYPES.indexOf(b.actionType));
  let recommended = ranked[0] || noAction;
  if (criticalMissing) recommended = noAction;
  if (cannibalization === "HIGH" && recommended.actionType === "NEW_ARTICLE") recommended = ranked.find((item) => item.actionType === "MERGE") || noAction;
  const dataCount = Object.values(dataState).filter((status) => status === "FRESH").length;
  const learning = recommended.learning || { status: "INSUFFICIENT_DATA", samples: 0, successRate: 0, adjustment: 0 };
  return { recommended, candidates: ranked, freshness: dataState, expectedImpact: recommended.impact, confidence: dataCount >= 3 ? recommended.confidence : recommended.confidence === "HIGH" ? "MEDIUM" : "LOW", safety: { humanReviewRequired: Boolean(recommended.humanReview), autoPublishAllowed: false, ymylHigh: isYmylHigh, cannibalization }, learning, reasons };
}

export function measureAutopilot(before = {}, after = {}) {
  const keys = ["clicks", "impressions", "ctr", "position", "sessions", "engagement", "conversions", "revenue"];
  if (!Object.keys(after).length) return { status: "INSUFFICIENT_DATA", deltas: {} };
  const deltas = Object.fromEntries(keys.map((key) => [key, number(after[key]) - number(before[key]) ]));
  const meaningful = ["clicks", "sessions", "conversions"].filter((key) => number(before[key]) || number(after[key]));
  if (!meaningful.length) return { status: "INSUFFICIENT_DATA", deltas };
  const positive = meaningful.filter((key) => deltas[key] > 0).length, negative = meaningful.filter((key) => deltas[key] < 0).length;
  return { status: positive > negative ? "IMPROVED" : negative > positive ? "DECLINED" : "NEUTRAL", deltas };
}
