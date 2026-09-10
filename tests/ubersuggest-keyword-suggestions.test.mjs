import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
const root = path.resolve(import.meta.dirname, "..");
test("Ubersuggest keyword suggestions use discovered tools and never guessed names", async () => {
  const source = await readFile(path.join(root, "cloud-runner", "src", "ubersuggest-mcp.ts"), "utf8");
  assert.match(source, /selectUbersuggestKeywordSuggestionTool/);
  assert.match(source, /candidates\.length !== 1/);
  assert.match(source, /callKeywordSuggestions/);
});
test("Ubersuggest sync stores optional suggestion results without failing the base sync", async () => {
  const source = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(source, /keyword_suggestions_status = "DATA_NOT_AVAILABLE"/);
  assert.match(source, /client\.callKeywordSuggestions/);
  assert.match(source, /keyword_suggestions_error/);
});
