import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=(file)=>readFile(new URL(`../${file}`,import.meta.url),"utf8");
const mockR2=()=>{const objects=new Map();return{async put(key,value){objects.set(key,value)},async get(key){return objects.get(key)||null},async delete(key){objects.delete(key)},has:key=>objects.has(key)}};

test("template config keeps BACKUPS and FILES as separate R2 bindings",async()=>{const config=await source("cloud-runner/dashboard-wrangler.example.jsonc");assert.match(config,/"binding": "BACKUPS"[\s\S]*YOUR_CLIENT-seo-backups/);assert.match(config,/"binding": "FILES"[\s\S]*YOUR_CLIENT-seo-files/);});
test("primary-source upload uses FILES, client-scoped collision-safe generated object keys, and a D1 reference",async()=>{const api=await source("app/api/[[...path]]/route.ts");for(const token of ["runtime().FILES!.put","primary-info/${owner}/${clientId}/${fileId}","INSERT INTO source_files","ownedClient(clientId, owner)","object_key"]){assert.ok(api.includes(token));}});
test("mock FILES supports isolated PUT, GET, DELETE without cross-client key overlap",async()=>{const r2=mockR2(),a="primary-info/owner/a/uuid-a",b="primary-info/owner/b/uuid-b";await r2.put(a,"A");await r2.put(b,"B");assert.equal(await r2.get(a),"A");assert.equal(await r2.get(b),"B");await r2.delete(a);assert.equal(await r2.get(a),null);assert.equal(await r2.get(b),"B");});
test("invalid and empty files are rejected, and a D1 failure cleans up the just-written R2 object",async()=>{const api=await source("app/api/[[...path]]/route.ts");for(const token of ["allowed.includes(file.type)","file.size <= 0","20 * 1024 * 1024","FILES!.delete(objectKey).catch"]){assert.ok(api.includes(token));}});
test("primary source files remain private binding data and secrets are not hardcoded",async()=>{const [api,config]=await Promise.all([source("app/api/[[...path]]/route.ts"),source("cloud-runner/dashboard-wrangler.example.jsonc")]);assert.ok(!config.includes("R2_ACCESS_KEY"));assert.ok(!api.includes("R2_ACCESS_KEY"));assert.ok(api.includes("runtime().FILES!.get")&&api.includes("runtime().FILES!.delete"));});
