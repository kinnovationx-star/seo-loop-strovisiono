// Small, deliberately conservative primitives shared by the Internal Link
// worker and its tests.  They never invent or rewrite a target URL.
export const normalizeInternalLinkUrl = (value) => String(value || "").replace(/\/$/, "");
export const isConfirmedHttpsUrl = (value) => /^https:\/\//i.test(String(value || ""));

export function targetAlreadyLinked(html, confirmedUrl) {
  const target = normalizeInternalLinkUrl(confirmedUrl);
  return /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi.test(String(html || ""))
    ? [...String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)].some((match) => normalizeInternalLinkUrl(match[2]) === target)
    : false;
}

export function validatePlacement(value) {
  const anchor = String(value?.anchor_text || "").trim();
  const reference = String(value?.placement_reference || "").trim();
  const confidence = String(value?.confidence || "").toUpperCase();
  const unsafe = !anchor || !reference || /<|>|javascript:|\bhttps?:\/\//i.test(anchor) ||
    !["HIGH", "MEDIUM", "LOW"].includes(confidence) || anchor.length > 180 || reference.length > 1000;
  return { ok: !unsafe, anchor, reference, confidence, safetyStatus: unsafe ? "HUMAN_REVIEW_REQUIRED" : confidence === "LOW" ? "HUMAN_REVIEW_REQUIRED" : "SAFE" };
}

export function insertMinimalInternalLink(html, confirmedUrl, placement) {
  const check = validatePlacement(placement);
  if (!check.ok) throw new Error("INTERNAL_LINK_ANCHOR_SAFETY_FAILED");
  if (!isConfirmedHttpsUrl(confirmedUrl)) throw new Error("INTERNAL_LINK_TARGET_URL_INVALID");
  const source = String(html || "");
  const index = source.indexOf(check.reference);
  if (index < 0) throw new Error("INTERNAL_LINK_PLACEMENT_AMBIGUOUS");
  const link = `<a href="${String(confirmedUrl).replace(/"/g, "%22")}">${check.anchor.replace(/</g, "&lt;")}</a>`;
  const next = source.slice(0, index) + link + source.slice(index + check.reference.length);
  // The exact one-span replacement is our integrity contract: no H1, SEO,
  // media, slug, categories, tags, or unrelated content is touched.
  if (next.replace(link, check.reference) !== source) throw new Error("INTERNAL_LINK_INTEGRITY_FAILED");
  return { html: next, link, placement: check };
}
