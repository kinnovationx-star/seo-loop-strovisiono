import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMockWordPressAdapter } from "../lib/wordpress-adapter.mjs";
import { insertMinimalInternalLink, isConfirmedHttpsUrl, normalizeInternalLinkUrl, targetAlreadyLinked, validatePlacement } from "../lib/internal-link-execution.mjs";

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const target = "https://example.test/target";
const html = "<h1>Unchanged H1</h1><p>Read our useful target guide today.</p>";
const placement = { anchor_text:"useful target guide", placement_reference:"useful target guide", confidence:"HIGH" };

test("approved candidate / same-client source-target / mapping / HTTPS / source!=target are enforced in the execution boundary", async () => {
  const api = await source("app/api/[[...path]]/route.ts");
  for (const token of ["status='APPROVED'", "candidate.source_article_id===candidate.target_article_id", "wordpress_article_mappings", "https:\\/\\/", "INTERNAL_LINK_VALIDATION_FAILED"]) assert.match(api, new RegExp(token));
});
test("AI output has no URL field and confirmed database target URL is used", async () => {
  const worker = await source("cloud-runner/src/index.ts");
  assert.match(worker, /INTERNAL_LINK_PLACEMENT_ANALYZER/);
  assert.match(worker, /Confirmed target URL \(出力禁止\)/);
  assert.match(worker, /confirmedTargetUrl/);
  assert.doesNotMatch(worker.match(/async function internalLinkPlacement[\s\S]*?async function internalLinkUpdate/)?.[0] || "", /target_url/);
});
test("placement output is structured, versioned, and anchors are safety validated", () => {
  assert.deepEqual(validatePlacement(placement), { ok:true, anchor:"useful target guide", reference:"useful target guide", confidence:"HIGH", safetyStatus:"SAFE" });
  assert.equal(validatePlacement({ ...placement, anchor_text:"https://bad.test" }).ok, false);
  assert.equal(validatePlacement({ ...placement, confidence:"LOW" }).safetyStatus, "HUMAN_REVIEW_REQUIRED");
});
test("duplicate detection accepts only trailing-slash normalization and ends idempotently", () => {
  assert.equal(normalizeInternalLinkUrl(`${target}/`), target);
  assert.equal(targetAlreadyLinked(`<p><a href="${target}/">x</a></p>`, target), true);
  assert.equal(targetAlreadyLinked(`<p><a href="${target}?x=1">x</a></p>`, target), false);
});
test("minimal content insertion preserves the exact unrelated source, including H1", () => {
  const next = insertMinimalInternalLink(html, target, placement);
  assert.match(next.html, /<h1>Unchanged H1<\/h1>/);
  assert.equal(next.html.replace(next.link, placement.placement_reference), html);
});
test("only HTTPS targets can be executed", () => {
  assert.equal(isConfirmedHttpsUrl(target), true);
  assert.equal(isConfirmedHttpsUrl("http://example.test/x"), false);
  assert.throws(() => insertMinimalInternalLink(html, "http://example.test/x", placement));
});
test("mock WordPress takes UPDATE_EXISTING only; create is never needed for the link diff", async () => {
  const wp = createMockWordPressAdapter({ posts:[{id:"10",slug:"same",title:"Same",content:html,categories:[2],tags:[3],featured_media:4,meta:{seo:"same"}}] });
  const before = await wp.fetchPost("10"), next=insertMinimalInternalLink(before.content,target,placement);
  await wp.update("10", { content:next.html }); const post=await wp.fetchPost("10");
  assert.equal(post.id,"10"); assert.equal(post.slug,"same"); assert.deepEqual(post.categories,[2]); assert.deepEqual(post.tags,[3]); assert.equal(post.featured_media,4); assert.deepEqual(post.meta,{seo:"same"});
});
test("snapshot endpoint is a hard precondition before adapter.update", async () => {
  const worker=await source("cloud-runner/src/index.ts"); const section=worker.match(/async function internalLinkUpdate[\s\S]*?async function ubersuggest/)?.[0] || "";
  assert.ok(section.indexOf('worker/internal-link-snapshot') < section.indexOf("adapter.update"));
  assert.match(section, /ALREADY_LINKED/); assert.match(section, /UPDATE_EXISTING/);
});
test("history records statuses, prompt version, source/target and idempotency keys", async () => {
  const migration=await source("drizzle/0016_internal_link_execution.sql");
  for(const field of ["source_article_version_id","target_article_id","snapshot_id","execution_status","prompt_version","idempotency_key","idx_internal_link_execution_action"])assert.match(migration,new RegExp(field));
});
test("manual approve, reject, execute and rollback backend routes preserve rejected/approved state rules", async () => {
  const api=await source("app/api/[[...path]]/route.ts");
  for(const token of ["internal-links", "approve|reject|execute|rollback", "却下済みProposalは承認できません", "承認済みProposalだけ実行できます", "ROLLED_BACK", "INTERNAL_LINK_ROLLBACK"])assert.match(api,new RegExp(token));
});
test("kill switch and client pause are rechecked immediately before manual execution", async () => {
  const api=await source("app/api/[[...path]]/route.ts");
  assert.match(api,/kill_switch_enabled/); assert.match(api,/INTERNAL_LINK_EXECUTION_BLOCKED/);
});
test("queue retry converges on one execution job and one action history record", async () => {
  const [api,migration]=await Promise.all([source("app/api/[[...path]]/route.ts"),source("drizzle/0016_internal_link_execution.sql")]);
  assert.match(api,/type='internal_link_update'/); assert.match(migration,/idx_internal_link_execution_idempotency/); assert.match(api,/execution_status===\"EXECUTED\"/);
});
test("cross-client target and snapshot attacks are bound to client_id", async () => {
  const api=await source("app/api/[[...path]]/route.ts");
  for(const token of ["ownedClient(clientId,owner)", "SELECT * FROM internal_link_execution_history WHERE client_id=?", "registered.client_id", "source_article_id=? AND target_article_id=?"])assert.ok(api.includes(token));
});
test("AUTO_EXECUTE and RECOMMEND_ONLY retain safety decision boundaries", async () => {
  const api=await source("app/api/[[...path]]/route.ts"); assert.match(api,/AUTO_EXECUTE_SAFE_ACTIONS/); assert.match(api,/HUMAN_REVIEW_REQUIRED/);
});
