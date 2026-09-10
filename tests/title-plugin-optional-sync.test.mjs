import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMockWordPressAdapter, createSeoMetaProvider, detectSeoPlugin } from "../lib/wordpress-adapter.mjs";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Plugin NONE and UNKNOWN preserve Native SEO and never make plugin sync a TITLE failure", () => {
  assert.equal(detectSeoPlugin([]), "NONE");
  assert.equal(createSeoMetaProvider("NONE").syncStatus, "NOT_APPLICABLE");
  assert.equal(detectSeoPlugin(null), "UNKNOWN");
  assert.equal(createSeoMetaProvider("UNKNOWN").syncStatus, "SEO_PLUGIN_SYNC_NOT_AVAILABLE");
});

test("Rank Math and Yoast sync only exposed safe meta fields and leave post content/H1/slug/taxonomy/media untouched", async () => {
  for (const [plugin, namespaces, meta] of [["RANK_MATH", ["rank-math/v1"], { rank_math_title:"",rank_math_description:"" }], ["YOAST", ["yoast/v1"], { _yoast_wpseo_title:"",_yoast_wpseo_metadesc:"" }]]) {
    const wp=createMockWordPressAdapter({namespaces,posts:[{id:"1",title:"H1 stays",slug:"keep",content:"body stays",categories:[3],tags:[4],featured_media:5,meta}]});
    const result=await wp.syncSeoPlugin("1",{plugin,seoTitle:"SEO title",metaDescription:"SEO description"});
    assert.equal(result.pluginSyncStatus,"SUCCESS");
    const post=(await wp.fetchPost("1"));
    assert.equal(post.title,"H1 stays");assert.equal(post.slug,"keep");assert.equal(post.content,"body stays");assert.deepEqual(post.categories,[3]);assert.deepEqual(post.tags,[4]);assert.equal(post.featured_media,5);
  }
});

test("Unsupported plugin fields and HTTP auth/plugin errors are isolated as optional sync results", async () => {
  for(const plugin of ["RANK_MATH","YOAST"]){const wp=createMockWordPressAdapter({namespaces:[plugin==="RANK_MATH"?"rank-math/v1":"yoast/v1"],posts:[{id:"1",meta:{}}]});const result=await wp.syncSeoPlugin("1",{plugin,seoTitle:"x",metaDescription:"y"});assert.equal(result.pluginSyncStatus,"SEO_PLUGIN_SYNC_NOT_AVAILABLE");}
  const api=await source("app/api/[[...path]]/route.ts"),worker=await source("cloud-runner/src/index.ts"),adapter=await source("lib/wordpress-adapter.mjs");
  for(const value of ["wordpress_seo_plugin_sync","native_seo_status","detected_plugin","plugin_sync_status","plugin_sync_error_code","SEO_PLUGIN_SYNC_NOT_AVAILABLE","ON CONFLICT(client_id,idempotency_key) DO NOTHING","ownedClient(clientId,owner)"])assert.ok(api.includes(value),`missing ${value}`);
  for(const value of ["wordpressSeoPluginSync","WORDPRESS_401","WORDPRESS_403","syncSeoPlugin","nativeSeoStatus:\"SUCCESS\""])assert.ok(worker.includes(value),`missing ${value}`);
  assert.ok(adapter.includes("attempt < 3"));
});

test("Optional sync result updates only the same client/action/version history and does not log credentials", async () => {
  const api=await source("app/api/[[...path]]/route.ts");
  for(const value of ["WHERE client_id=? AND action_id=?","WHERE client_id=? AND article_version_id=?","plugin_sync_error_code","wordpressConnection?.secret_cipher","applicationPassword: (await decrypt"])assert.ok(api.includes(value),`missing ${value}`);
  assert.doesNotMatch(api,/plugin_sync_error_code[^\n]{0,400}applicationPassword/);
});
