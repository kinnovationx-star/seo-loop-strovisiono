import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("primary-information UI keeps a focused one-question chat and retains the answer key", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  for (const value of ["interviewSteps", "activeInterviewStep", "questionKey", "AIからの質問", "simple-interview", "interview-details"]) assert.match(ui, new RegExp(value));
  assert.match(ui, /記事用にまとめる/);
  assert.doesNotMatch(ui, /入力内容を記事作成に使う許可を確認済み/);
});

test("primary-information UI safely renders legacy structured follow-up questions", async () => {
  const ui = await readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8");
  assert.match(ui, /const questionItems = Array\.isArray\(result\?\.follow_up_questions\)/);
  assert.match(ui, /typeof item\.question === "string"/);
  assert.match(ui, /typeof item\.next_question_key === "string"/);
  assert.match(ui, /const questions = questionItems/);
  assert.match(ui, /window\.setInterval\(\(\) => void refresh\(\), 3_000\)/);
});

test("guided primary interview scores coverage without inventing a claim", async () => {
  const worker = await readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8");
  assert.match(worker, /quality_score: score/);
  assert.match(worker, /50 \+ completed\.length \* 5/);
  assert.match(worker, /未確認の数値・実績・表現は、確認が終わるまで記事で断定しません/);
  assert.match(worker, /ready_for_use: false/);
});

test("primary interview retains completed answers and advances with application-owned state", async () => {
  const [worker, route] = await Promise.all([
    readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8"),
  ]);
  assert.match(route, /const primaryInterviewHistory = job\.type === "primary_info_assist"/);
  assert.match(route, /primaryInterviewHistory,/);
  assert.match(worker, /context\.primaryInterviewHistory/);
  assert.match(worker, /const guided = primaryInfoFallback\(job\)/);
  assert.match(worker, /next_question_key: guided\.next_question_key/);
  assert.match(worker, /follow_up_questions: modelQuestion/);
});

test("primary-information chat is the default, asks client-specific follow-ups, and retains update history", async () => {
  const [ui, worker, sql] = await Promise.all([
    readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8"),
    readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8"),
    readFile(path.join(root, "drizzle", "0017_primary_information_versions.sql"), "utf8"),
  ]);
  assert.match(ui, /AIとの会話で、記事に使える一次情報をつくる/);
  assert.match(ui, /一次情報の更新履歴/);
  assert.match(ui, /Excel \/ PDFを使ってまとめて追加する（任意）/);
  assert.match(worker, /これは固定アンケートではありません/);
  assert.match(worker, /回答済みのことを聞き直さず/);
  assert.match(worker, /follow_up_questions: modelQuestion/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS primary_info_versions/);
});

test("primary-information interview establishes the company and article goal before comparison questions", async () => {
  const [ui, worker] = await Promise.all([
    readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8"),
    readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8"),
  ]);
  for (const source of [ui, worker]) {
    const company = source.indexOf('key: "company"');
    const business = source.indexOf('key: "business"');
    const goal = source.indexOf('key: "content_goal"');
    const difference = source.indexOf('key: "difference"');
    assert.ok(company >= 0 && company < business && business < goal && goal < difference);
  }
  assert.match(worker, /最初に会社の実態、次に事業内容、次に今回の記事の目的を確認/);
  assert.match(worker, /専門用語や曖昧な営業表現を避けた自然で丁寧な日本語/);
  assert.match(ui, /const modelQuestionMatchesActiveStep/);
  assert.match(ui, /earliest missing foundation/);
});

test("confirmed primary information accepts incremental chat updates without losing the prior master", async () => {
  const [ui, worker, route] = await Promise.all([
    readFile(path.join(root, "app", "seo-loop-app.tsx"), "utf8"),
    readFile(path.join(root, "cloud-runner", "src", "index.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "[[...path]]", "route.ts"), "utf8"),
  ]);
  assert.match(ui, /内容が変わったら、変更内容と「いつから変わったか」だけを送ってください/);
  assert.match(ui, /変更を反映する/);
  assert.match(worker, /function primaryInfoUpdates/);
  assert.match(worker, /【今回の更新】/);
  assert.match(route, /const approvedChatUpdate/);
  assert.match(route, /確認済みの一次情報へチャット更新を反映/);
  assert.match(route, /recordPrimaryInfoVersion/);
});
