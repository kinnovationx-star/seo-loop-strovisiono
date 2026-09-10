import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("the primary-information Excel template is available as a real workbook", async () => {
  const template = path.join(root, "public", "primary-information-template.xlsx");
  await access(template);
  const bytes = await readFile(template);
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");
});

test("the simple PDF flow downloads the template, uploads one PDF, and queues formalization", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  for (const token of [
    "Excelテンプレートをダウンロード",
    "/primary-information-template.xlsx",
    "PDFを追加して文章にする",
    'mode: "pdf_import"',
    'accept="application/pdf,.pdf"',
    "文章化した一次情報",
    "SourceCard source={canonicalSource}",
  ]) assert.ok(ui.includes(token), token);
});

test("PDF primary information stays private, is read only by the worker, and is marked processed once", async () => {
  const [api, worker] = await Promise.all([
    readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8"),
    readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8"),
  ]);
  assert.match(api, /objectKey: item\.object_key/);
  assert.match(worker, /async function primaryPdfAttachments/);
  assert.match(worker, /env\.FILES\.get/);
  assert.match(worker, /mode === "pdf_import"/);
  assert.match(worker, /processed_file_ids: documents\.processedFileIds/);
  assert.match(api, /UPDATE source_files SET status='processed'/);
  assert.doesNotMatch(api, /R2_ACCESS_KEY/);
});
