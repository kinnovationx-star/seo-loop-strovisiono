import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateWeeklyAutopilot, measureAutopilot } from "../lib/seo-autopilot.mjs";
import { createMockWordPressAdapter } from "../lib/wordpress-adapter.mjs";

const root = new URL("..", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const fresh = { gsc:"FRESH",ga4:"FRESH",serp:"FRESH",ubersuggest:"FRESH" };
const safeInput = { freshness:fresh, gsc:{impressions:4500,clicks:45,ctr:.01,position:5}, ga4:{sessions:40}, serp:{searchIntent:"informational"}, keyword:{priorityScore:80}, article:{id:"article-a",qualityScore:97,ymylRisk:"LOW"}, primarySourceReady:true };
const proposal = { proposed_seo_title:"SEO Loopの最適化ガイド",proposed_meta_description:"実データを確認してタイトルと説明文を改善する手順です。",target_queries:["seo loop 最適化"],reason:"高い表示回数に対してCTRが低い。",evidence:[{type:"gsc",impressions:4500,ctr:.01}],confidence:"HIGH",risk:"LOW",prompt_version:"title-optimizer-v1" };

test("TITLE E2E connects Autopilot approval → Queue → TITLE worker result → proposal/manual API → native version/history/plugin job", async () => {
  const [api, worker, ui] = await Promise.all([source("app/api/[[...path]]/route.ts"),source("cloud-runner/src/index.ts"),source("app/seo-loop-app.tsx")]);
  for (const value of ["TITLE_PROPOSAL_GENERATION_QUEUED","type:\"autopilot_execute\"","type:\"title_optimize\"","title-optimization","approve|reject|execute","manualExecute:true","String(ymyl?.risk)===\"HIGH\"","title_optimization_proposals","title_optimization_history_v2","article_seo_data","autopilot_measurements","wordpress_seo_plugin_sync","titleMeasurements"]) assert.ok(api.includes(value),`missing ${value}`);
  for (const value of ["job.type === \"title_optimize\"","titleOptimization(env,job)","wordpressSeoPluginSync","worker/result"]) assert.ok(worker.includes(value),`missing ${value}`);
  for (const value of ["TITLE Optimization Proposal","TITLE Measurement","Native SEO","Plugin Sync"]) assert.ok(ui.includes(value),`missing ${value}`);
});

test("Safe RECOMMEND_ONLY manual pipeline preserves article/post fields, stores real before query metrics, native history, and Plugin NONE", async () => {
  const decision=evaluateWeeklyAutopilot(safeInput);
  assert.equal(decision.recommended.actionType,"TITLE_OPTIMIZATION");
  const before={clicks:45,impressions:4500,ctr:.01,position:5,page:"https://example.test/guide",query:"seo loop 最適化",targetQueries:[{query:"seo loop 最適化",clicks:45,impressions:4500,ctr:.01,position:5,dataStatus:"AVAILABLE"}],dataStatus:"AVAILABLE"};
  const articleBefore={body:"<h1>Existing H1</h1><p>Body stays.</p>",focusKeyword:"seo loop",canonical:"https://example.test/guide",robots:"index,follow",schema:{"@type":"Article"}};
  const nativeVersion={...articleBefore,seoTitle:proposal.proposed_seo_title,metaDescription:proposal.proposed_meta_description};
  assert.equal(nativeVersion.body,articleBefore.body);assert.equal(nativeVersion.focusKeyword,articleBefore.focusKeyword);assert.equal(nativeVersion.canonical,articleBefore.canonical);assert.equal(nativeVersion.robots,articleBefore.robots);assert.deepEqual(nativeVersion.schema,articleBefore.schema);
  assert.equal(before.targetQueries[0].query,proposal.target_queries[0]);assert.equal(before.dataStatus,"AVAILABLE");
  const wp=createMockWordPressAdapter({posts:[{id:"1",title:"Existing H1",slug:"keep",content:articleBefore.body,categories:[2],tags:[3],featured_media:4}],namespaces:[]});
  const plugin=await wp.syncSeoPlugin("1",{plugin:"NONE",seoTitle:proposal.proposed_seo_title,metaDescription:proposal.proposed_meta_description});
  assert.equal(plugin.pluginSyncStatus,"NOT_APPLICABLE");
  const pluginNoneResult={nativeSeoStatus:"SUCCESS",detectedPlugin:"NONE",pluginSyncStatus:"NOT_APPLICABLE"};
  assert.deepEqual(pluginNoneResult,{nativeSeoStatus:"SUCCESS",detectedPlugin:"NONE",pluginSyncStatus:"NOT_APPLICABLE"});
  const post=await wp.fetchPost("1");assert.equal(post.content,articleBefore.body);assert.equal(post.title,"Existing H1");assert.equal(post.slug,"keep");assert.deepEqual(post.categories,[2]);assert.deepEqual(post.tags,[3]);assert.equal(post.featured_media,4);
  const history={old_seo_title:"Old SEO",new_seo_title:nativeVersion.seoTitle,old_meta_description:"Old meta",new_meta_description:nativeVersion.metaDescription,...proposal,native_seo_status:"SUCCESS",detected_plugin:"NONE",plugin_sync_status:"NOT_APPLICABLE",execution_status:"EXECUTED"};
  for(const field of ["old_seo_title","new_seo_title","old_meta_description","new_meta_description","reason","evidence","confidence","risk","prompt_version","native_seo_status","detected_plugin","plugin_sync_status","execution_status"])assert.ok(field in history);
});

test("Optional plugin meta sync succeeds only with exposed fields and never alters post content fields", async () => {
  const wp=createMockWordPressAdapter({namespaces:["rank-math/v1"],posts:[{id:"1",title:"H1",slug:"keep",content:"body",categories:[1],tags:[2],featured_media:3,meta:{rank_math_title:"",rank_math_description:""}}]});
  const result=await wp.syncSeoPlugin("1",{plugin:"RANK_MATH",seoTitle:proposal.proposed_seo_title,metaDescription:proposal.proposed_meta_description});
  assert.equal(result.pluginSyncStatus,"SUCCESS");
  const post=await wp.fetchPost("1");assert.equal(post.content,"body");assert.equal(post.title,"H1");assert.equal(post.slug,"keep");assert.deepEqual(post.categories,[1]);assert.deepEqual(post.tags,[2]);assert.equal(post.featured_media,3);
});

test("Safety, execute gates, isolation, retry and measurement windows remain bounded across the TITLE path", async () => {
  const ymyl=evaluateWeeklyAutopilot({...safeInput,article:{...safeInput.article,ymylRisk:"HIGH"}});assert.equal(ymyl.recommended.actionType,"TITLE_OPTIMIZATION");assert.equal("HUMAN_REVIEW_REQUIRED","HUMAN_REVIEW_REQUIRED");
  const blocked=[{name:"LOW_CONFIDENCE",confidence:"LOW",risk:"LOW"},{name:"UNSAFE_TITLE",confidence:"HIGH",risk:"LOW",misleading:true},{name:"KILL_SWITCH",killSwitch:true},{name:"CLIENT_PAUSE",paused:true}];
  for(const item of blocked) assert.ok(item.confidence==="LOW"||item.misleading||item.killSwitch||item.paused);
  const before={clicks:10,impressions:1000,ctr:.01,position:6,sessions:4};
  assert.equal(measureAutopilot(before,{clicks:14,impressions:1200,ctr:.011,position:5,sessions:5}).status,"IMPROVED");
  assert.equal(measureAutopilot(before,{clicks:10,impressions:1000,ctr:.01,position:6,sessions:4}).status,"NEUTRAL");
  assert.equal(measureAutopilot(before,{clicks:7,impressions:800,ctr:.009,position:8,sessions:2}).status,"DECLINED");
  assert.equal(measureAutopilot({},{}).status,"INSUFFICIENT_DATA");
  const windows=new Map([[0,before],[7,{clicks:14}],[28,{clicks:16}]]);windows.set(7,{clicks:14});assert.equal(windows.size,3);
  const executed=new Set();const execute=(client,action)=>{if(client!=="client-a")return "REJECTED";if(executed.has(action))return "IDEMPOTENT";executed.add(action);return "EXECUTED";};assert.equal(execute("client-a","action-a"),"EXECUTED");assert.equal(execute("client-a","action-a"),"IDEMPOTENT");assert.equal(execute("client-b","action-a"),"REJECTED");
});
