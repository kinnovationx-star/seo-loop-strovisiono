import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const compact = (value) => value.replace(/\s+/g, " ");

test("production dashboard never manufactures an owner for anonymous browser traffic", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "full.ts"), "utf8");
  assert.doesNotMatch(worker, /x-seo-loop-dashboard-owner/);
  assert.doesNotMatch(worker, /cloudflare-dashboard-owner/);
  assert.match(worker, /return dashboard\.fetch\(request, env, ctx\)/);
});

test("public no-login mode resolves only the server-side configured single owner", async () => {
  const server = await readFile(path.join(root, "lib", "server.ts"), "utf8");
  const owner = server.slice(server.indexOf("export function ownerId"), server.indexOf("const schema"));
  assert.doesNotMatch(owner, /request\.headers\.get/);
  assert.doesNotMatch(owner, /request\.url.*owner/i);
  assert.match(owner, /runtime\(\)\.PUBLIC_NO_LOGIN === "true"/);
  assert.match(owner, /runtime\(\)\.APP_OWNER_ID\?\.trim\(\) \|\| ""/);
  assert.match(compact(owner), /localhost.*local-development-user/);
  assert.match(compact(owner), /\? "local-development-user" : ""/);
});

test("template deployment configuration does not commit an owner secret", async () => {
  const config = await readFile(path.join(root, "cloud-runner", "dashboard-wrangler.example.jsonc"), "utf8");
  assert.doesNotMatch(config, /"APP_OWNER_ID"/);
});

test("protected client APIs require an owner while health and OAuth callbacks stay intentionally public", async () => {
  const api = await readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8");
  assert.match(api, /if \(route === "bootstrap"\) \{\s*const owner = await requireOwner\(request\)/);
  assert.match(api, /if \(route === "clients"\) \{\s*const owner = await requireOwner\(request\)/);
  assert.match(api, /const owner = await requireOwner\(request\), clientId = linkGraphRoute\[1\]/);
  assert.match(api, /const owner=await requireOwner\(request\),clientId=autopilotRoute\[1\]/);
  assert.match(api, /if\(titleManualRoute\)\{const owner=await requireOwner\(request\)/);
  assert.match(api, /if \(internalLinkRoute\) \{\s*const owner=await requireOwner\(request\)/);
  assert.match(api, /const sourceUpload = route\.match/);
  assert.match(api, /if \(route === "google\/callback"\) return await googleCallback\(request\)/);
  assert.match(api, /if \(route === "ubersuggest\/callback"\) return await ubersuggestCallback\(request\)/);
  assert.match(api, /if \(route === "health"\)/);
});

test("internal queue endpoints retain independent dispatch-token authentication", async () => {
  const runner = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(runner, /request\.headers\.get\("X-SEO-Loop-Dispatch"\) !== env\.CLOUD_DISPATCH_TOKEN/);
  assert.match(runner, /return new Response\("unauthorized", \{ status: 401 \}\)/);
});
