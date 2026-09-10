import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const root=new URL("..",import.meta.url);const source=(p)=>readFile(new URL(p,root),"utf8");
test("TITLE UI renders proposal comparison, safety, controls, empty state, and immutable history",async()=>{const [api,ui]=await Promise.all([source("app/api/[[...path]]/route.ts"),source("app/seo-loop-app.tsx")]);for(const value of ["titleProposals","titleHistory","title_optimization_proposals","title_optimization_history_v2"])assert.match(api,new RegExp(value));for(const value of ["TITLE Optimization Proposal","Current:","Proposed:","Safety:","Prompt:","Approve","Reject","Execute","TITLE Optimization Proposalはまだありません。","History","execution_status!==\"APPROVED\""])assert.match(ui,new RegExp(value));});
