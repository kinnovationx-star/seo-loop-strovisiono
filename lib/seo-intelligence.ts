export const DATA_NOT_AVAILABLE = "DATA_NOT_AVAILABLE";

export type PriorityWeights = {
  searchDemand: number;
  difficulty: number;
  businessRelevance: number;
  conversionPotential: number;
  topicalRelevance: number;
  rankingOpportunity: number;
  existingPosition: number;
  impressions: number;
  contentGap: number;
};

export const defaultPriorityWeights: PriorityWeights = {
  searchDemand: 18,
  difficulty: 10,
  businessRelevance: 16,
  conversionPotential: 14,
  topicalRelevance: 12,
  rankingOpportunity: 12,
  existingPosition: 8,
  impressions: 5,
  contentGap: 5,
};

export const normalizeKeyword = (value: unknown) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s　]+/g, " ");

const clamp = (value: unknown) =>
  Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0));

export function scoreKeyword(input: Record<string, unknown>, weights = defaultPriorityWeights) {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0) || 1;
  const volume = clamp(Math.log10(Math.max(1, Number(input.searchVolume || input.search_volume || 0) + 1)) * 25);
  const difficulty = 100 - clamp(input.keywordDifficulty || input.keyword_difficulty);
  const position = Number(input.currentPosition || input.current_position);
  const existingPosition = position > 0 && position <= 100 ? 100 - Math.min(100, Math.abs(position - 12) * 5) : 45;
  const impressions = clamp(Math.log10(Math.max(1, Number(input.impressions || 0) + 1)) * 25);
  const signals: Record<keyof PriorityWeights, number> = {
    searchDemand: volume,
    difficulty,
    businessRelevance: clamp(input.businessRelevance || input.business_relevance),
    conversionPotential: clamp(input.conversionPotential || input.conversion_potential),
    topicalRelevance: clamp(input.topicalRelevance || input.topical_relevance),
    rankingOpportunity: clamp(input.rankingOpportunity || input.ranking_opportunity),
    existingPosition,
    impressions,
    contentGap: clamp(input.contentGap || input.content_gap),
  };
  return Math.round(
    Object.entries(weights).reduce((sum, [key, weight]) => sum + signals[key as keyof PriorityWeights] * weight, 0) / total,
  );
}

export function priorityBreakdown(input: Record<string, unknown>, weights = defaultPriorityWeights) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  const score = scoreKeyword(input, weights);
  const scoreMap: Record<keyof PriorityWeights, number> = {
    searchDemand: clamp(Math.log10(Math.max(1, Number(input.searchVolume || input.search_volume || 0) + 1)) * 25),
    difficulty: 100 - clamp(input.keywordDifficulty || input.keyword_difficulty),
    businessRelevance: clamp(input.businessRelevance || input.business_relevance),
    conversionPotential: clamp(input.conversionPotential || input.conversion_potential),
    topicalRelevance: clamp(input.topicalRelevance || input.topical_relevance),
    rankingOpportunity: clamp(input.rankingOpportunity || input.ranking_opportunity),
    existingPosition: Number(input.currentPosition || input.current_position) > 0 ? 100 - Math.min(100, Math.abs(Number(input.currentPosition || input.current_position) - 12) * 5) : 45,
    impressions: clamp(Math.log10(Math.max(1, Number(input.impressions || 0) + 1)) * 25),
    contentGap: clamp(input.contentGap || input.content_gap),
  };
  return { score, contributions: Object.fromEntries(Object.entries(weights).map(([key, weight]) => [key, Math.round(scoreMap[key as keyof PriorityWeights] * weight / total * 10) / 10])) };
}

export function topicCoverage(targetKeywords: number, coveredKeywords: number) {
  if (targetKeywords <= 0) return 0;
  return Math.round(Math.max(0, Math.min(100, (coveredKeywords / targetKeywords) * 100)) * 10) / 10;
}
