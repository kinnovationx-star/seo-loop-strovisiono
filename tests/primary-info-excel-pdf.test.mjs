import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { parsePrimaryExcel, primaryExcelText } from "../lib/primary-excel.ts";

const root = path.resolve(import.meta.dirname, "..");

test("the primary-information Excel template is available as a real workbook", async () => {
  const template = path.join(root, "public", "primary-information-template.xlsx");
  await access(template);
  const bytes = await readFile(template);
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");
});

test("Excel imports answer cells directly and retains workbook provenance", async () => {
  const bytes = await readFile(path.join(root, "public", "primary-information-template.xlsx"));
  const archive = unzipSync(bytes);
  const sheetName = "xl/worksheets/sheet1.xml";
  const sheet = new TextDecoder().decode(archive[sheetName]);
  const filled = sheet
    .replace('<x:c r="B5" s="14" t="str" />', '<x:c r="B5" s="14" t="str"><x:v>株式会社テスト</x:v></x:c>')
    .replace('<x:c r="B6" s="14" t="str" />', '<x:c r="B6" s="14" t="str"><x:v>SEO支援を提供</x:v></x:c>');
  assert.notEqual(filled, sheet);
  archive[sheetName] = strToU8(filled);
  const entries = parsePrimaryExcel(zipSync(archive));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { sheet: "一次情報入力", cell: "B5", label: "会社名・サービス名", answer: "株式会社テスト" });
  assert.match(primaryExcelText("回答.xlsx", entries), /【一次情報入力!B6｜どのようなサービス・授業をしていますか？】\nSEO支援を提供/);
  assert.throws(() => parsePrimaryExcel(bytes), /回答が見つかりません/);
});

test("Excel imports directly while the PDF path still queues formalization", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  for (const token of [
    "Excelテンプレートをダウンロード",
    "/primary-information-template.xlsx",
    "ファイルを追加する",
    'mode: "pdf_import"',
    '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,application/pdf',
    "Excelから取り込んだ一次情報",
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
