import assert from "node:assert/strict";
import { createHttpWordPressAdapter, detectSeoPlugin } from "../lib/wordpress-adapter.mjs";

const required = ["WP_TEST_URL", "WP_TEST_USERNAME", "WP_TEST_APPLICATION_PASSWORD"];
if (required.some((key) => !process.env[key])) throw new Error("PHASE4_REST_CONFIGURATION_MISSING");

const siteUrl = process.env.WP_TEST_URL.replace(/\/$/, "");
const authorization = `Basic ${Buffer.from(`${process.env.WP_TEST_USERNAME}:${process.env.WP_TEST_APPLICATION_PASSWORD}`).toString("base64")}`;
const adapter = createHttpWordPressAdapter({
  siteUrl,
  username: process.env.WP_TEST_USERNAME,
  applicationPassword: process.env.WP_TEST_APPLICATION_PASSWORD,
});
const check = async (label, action) => {
  try {
    return await action();
  } catch {
    throw new Error(`PHASE4_REST_${label}_FAILED`);
  }
};
const core = async (path, init = {}) => {
  const response = await fetch(`${siteUrl}/wp-json/wp/v2${path}`, {
    ...init,
    headers: { Authorization: authorization, ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error("CORE_REQUEST_FAILED");
  return response.json();
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3zgAAAABJRU5ErkJggg==", "base64");

const root = await check("CONNECTION", async () => {
  const response = await fetch(`${siteUrl}/wp-json`);
  assert.equal(response.ok, true);
  return response.json();
});
await check("AUTHENTICATION", async () => {
  const me = await core("/users/me?context=edit");
  assert.ok(me.id);
});
await check("PLUGIN_DETECTION", async () => assert.equal(detectSeoPlugin(root.namespaces || []), "NONE"));

const categories = await check("CATEGORY_LIST", () => adapter.fetchCategories());
const tags = await check("TAG_LIST", () => adapter.fetchTags());
const categoryId = categories[0]?.id;
let tagId = tags[0]?.id;
if (!tagId) {
  const createdTag = await check("TEST_TAG_CREATE", () => core("/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `SEO LOOP PHASE4 TAG ${Date.now()}` }),
  }));
  tagId = createdTag.id;
}

const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const slug = `seo-loop-phase4-verification-${marker}`;
const title = `SEO LOOP PHASE4 VERIFICATION ${marker}`;
const draft = await check("DRAFT_CREATE", () => adapter.create({
  title,
  slug,
  status: "draft",
  content: "<p>SEO LOOP PHASE4 VERIFICATION test article.</p>",
  categories: categoryId ? [categoryId] : [],
  tags: [tagId],
}));
assert.equal(draft.status, "draft");
assert.equal(draft.slug, slug);
if (categoryId) assert.ok(draft.categories.includes(categoryId));
assert.ok(draft.tags.includes(tagId));

const snapshotBeforeUpdate = {
  title: draft.title?.raw || draft.title?.rendered || title,
  slug: draft.slug,
  status: draft.status,
  content: draft.content?.raw || "<p>SEO LOOP PHASE4 VERIFICATION test article.</p>",
  categories: draft.categories,
  tags: draft.tags,
  featured_media: draft.featured_media || 0,
};

const media = await check("MEDIA_CREATE", async () => {
  const response = await fetch(`${siteUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="seo-loop-phase4-${marker}.png"`,
    },
    body: png,
  });
  if (!response.ok) throw new Error("MEDIA_CREATE_FAILED");
  return response.json();
});
assert.ok(media.id);

const updated = await check("ARTICLE_UPDATE", () => adapter.update(draft.id, {
  title: `${title} Updated`,
  slug,
  status: "draft",
  content: `<p>Updated content with a verified internal link: <a href="${draft.link}">verification article</a>.</p>`,
  categories: categoryId ? [categoryId] : [],
  tags: [tagId],
  featured_media: media.id,
}));
assert.equal(updated.slug, slug);
assert.equal(updated.featured_media, media.id);
assert.ok(updated.tags.includes(tagId));

const published = await check("MANUAL_PUBLISH", () => adapter.update(draft.id, { status: "publish" }));
assert.equal(published.status, "publish");
const snapshotBeforeRollback = {
  title: published.title?.raw || published.title?.rendered || `${title} Updated`,
  slug: published.slug,
  status: published.status,
  content: published.content?.raw || updated.content?.raw,
  categories: published.categories,
  tags: published.tags,
  featured_media: published.featured_media || 0,
};

const changed = await check("POST_PUBLISH_UPDATE", () => adapter.update(draft.id, {
  title: `${title} Changed`,
  slug,
  status: "publish",
  content: "<p>Temporary post-publish change.</p>",
}));
assert.equal(changed.slug, slug);
const rolledBack = await check("ROLLBACK", () => adapter.update(draft.id, snapshotBeforeRollback));
assert.equal(rolledBack.slug, slug);
assert.equal(rolledBack.status, "publish");

await check("IDEMPOTENCY", async () => {
  const retry = await adapter.update(draft.id, snapshotBeforeRollback);
  assert.equal(retry.id, draft.id);
  const sameSlugPosts = await core(`/posts?context=edit&slug=${encodeURIComponent(slug)}&per_page=10`);
  assert.equal(sameSlugPosts.filter((post) => post.id === draft.id).length, 1);
});
await check("FINAL_DRAFT_RESTORE", async () => {
  const restored = await adapter.update(draft.id, snapshotBeforeUpdate);
  assert.equal(restored.status, "draft");
  assert.equal(restored.slug, slug);
});

console.log("PHASE4_WP_REST_INTEGRATION_OK");
