import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

export type PrimaryExcelEntry = {
  sheet: string;
  cell: string;
  label: string;
  answer: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});
const list = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
const valueText = (value: any): string => {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join("");
  return valueText(value.t ?? value.r ?? "");
};

export function parsePrimaryExcel(bytes: Uint8Array): PrimaryExcelEntry[] {
  if (bytes.length < 100 || bytes.length > 8 * 1024 * 1024)
    throw new Error("Excelファイルは8MB以内の.xlsx形式にしてください。");
  let entryCount = 0;
  let expandedBytes = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter(file) {
        entryCount += 1;
        if (entryCount > 300) throw new Error("Excelに含まれるファイルが多すぎます。");
        const relevant = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(file.name);
        if (!relevant) return false;
        expandedBytes += file.originalSize;
        if (file.originalSize > 2 * 1024 * 1024 || expandedBytes > 5 * 1024 * 1024)
          throw new Error("Excelの内容が大きすぎます。回答用シートだけにして再保存してください。");
        return true;
      },
    });
  } catch (error: any) {
    if (String(error?.message || "").startsWith("Excel")) throw error;
    throw new Error("Excelファイルを読み取れません。破損していない.xlsxを選択してください。");
  }
  const readXml = (name: string) => archive[name] ? parser.parse(new TextDecoder().decode(archive[name])) : {};
  const workbook = readXml("xl/workbook.xml");
  const relationships = readXml("xl/_rels/workbook.xml.rels");
  const sheets = list(workbook?.workbook?.sheets?.sheet);
  const rels = new Map(list(relationships?.Relationships?.Relationship).map((rel: any) => [String(rel?.["@_Id"] || ""), String(rel?.["@_Target"] || "")]));
  if (!sheets.length || sheets.length > 20) throw new Error("回答が入ったExcelシートを確認してください。");
  const shared = list(readXml("xl/sharedStrings.xml")?.sst?.si).map(valueText);
  const entries: PrimaryExcelEntry[] = [];
  for (const sheet of sheets) {
    const name = String(sheet?.["@_name"] || "シート").slice(0, 80);
    const target = String(rels.get(String(sheet?.["@_id"] || "")) || "");
    const worksheetPath = target.startsWith("/xl/")
      ? target.slice(1)
      : target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(worksheetPath)) continue;
    const rows = list(readXml(worksheetPath)?.worksheet?.sheetData?.row);
    for (const row of rows) {
      const cells = new Map(list(row?.c).map((cell: any) => [String(cell?.["@_r"] || ""), cell]));
      const rowNumber = Number(row?.["@_r"] || 0);
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 500) continue;
      const readCell = (cell: any) => {
        if (!cell) return "";
        const raw = cell?.["@_t"] === "inlineStr" ? valueText(cell?.is) : valueText(cell?.v);
        return (cell?.["@_t"] === "s" ? shared[Number(raw)] || "" : raw).trim();
      };
      const label = readCell(cells.get(`A${rowNumber}`));
      const answerCell = cells.get(`B${rowNumber}`);
      const answer = readCell(answerCell);
      if (!label || !answer || label === "項目") continue;
      if (answerCell?.f != null)
        throw new Error(`${name}!B${rowNumber}は数式です。回答を値として入力してください。`);
      if (label.length > 300 || answer.length > 2500)
        throw new Error(`${name}!B${rowNumber}の内容が長すぎます。回答を分けてください。`);
      entries.push({ sheet: name, cell: `B${rowNumber}`, label, answer });
      if (entries.length > 100) throw new Error("Excelの回答は100項目以内にしてください。");
    }
  }
  if (!entries.length)
    throw new Error("回答が見つかりません。A列に項目、B列に回答を入力して保存してください。");
  return entries;
}

export function primaryExcelText(fileName: string, entries: PrimaryExcelEntry[]): string {
  const text = [`【取り込んだExcel】${fileName}`, ...entries.map(({ sheet, cell, label, answer }) => `【${sheet}!${cell}｜${label}】\n${answer}`)].join("\n\n");
  if (text.length > 9000)
    throw new Error("Excelの回答が長すぎます。回答を分けて取り込んでください。");
  return text;
}
