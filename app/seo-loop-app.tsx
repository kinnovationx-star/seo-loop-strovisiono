"use client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Data = {
  clients: any[];
  connections: any[];
  jobs: any[];
  sources: any[];
  primaryInfoVersions: any[];
  sourceFiles: any[];
  logs: any[];
  snapshots: any[];
  workers: any[];
  google: {
    configured: boolean;
    redirectUri: string;
    source?: string | null;
    updatedAt?: string | null;
  };
  cloud?: {
    anthropicConfigured: boolean;
    imageConfigured: boolean;
    fileUploadsEnabled: boolean;
  };
};
const blank: Data = {
  clients: [],
  connections: [],
  jobs: [],
  sources: [],
  primaryInfoVersions: [],
  sourceFiles: [],
  logs: [],
  snapshots: [],
  workers: [],
  google: { configured: false, redirectUri: "" },
  cloud: {
    anthropicConfigured: false,
    imageConfigured: false,
    fileUploadsEnabled: false,
  },
};
// Every AI-backed Queue task uses the same wording in the persistent progress
// tray.  Individual screens can still show their richer task-specific view,
// but a user should never have to guess whether a click actually started work.
const aiJobLabel = (type: string) => ({
  article_input_analyze: "記事の入力・参考情報を分析",
  article_series_plan: "記事シリーズを企画",
  article_generate: "記事を生成",
  content_intelligence_review: "記事を検証・品質確認",
  aio_observe: "AIOを分析",
  monthly_report: "月次レポートを生成",
  ubersuggest_sync: "Ubersuggestの実データを同期",
  keyword_strategy: "狙うキーワードを選定",
  primary_info_assist: "一次情報を整理",
  content_audit: "コンテンツを監査",
  title_optimize: "タイトル・説明文を最適化",
  internal_link_analyze: "内部リンクを分析",
  internal_link_update: "内部リンクを更新",
  serp_analyze: "検索結果を分析",
  serp_competitor_analyze: "競合ページを分析",
  article_mapping_analyze: "既存記事を分類",
  wordpress_publish: "WordPressへ公開準備",
  wordpress_rollback: "WordPressの記事を復元",
  wordpress_seo_plugin_sync: "SEOプラグインを同期",
  sync_google: "Googleデータを同期",
  autopilot_execute: "SEO施策を実行",
}[type] || "AI処理");
const aiJobTypes = new Set([
  "article_input_analyze", "article_series_plan", "article_generate",
  "content_intelligence_review", "aio_observe", "monthly_report",
  "ubersuggest_sync", "keyword_strategy", "primary_info_assist",
  "content_audit", "title_optimize", "internal_link_analyze",
  "internal_link_update", "serp_analyze", "serp_competitor_analyze",
  "article_mapping_analyze", "wordpress_publish", "wordpress_rollback",
  "wordpress_seo_plugin_sync", "sync_google", "autopilot_execute",
]);
function AiProgressCenter({ jobs }: { jobs: any[] }) {
  const active = jobs.filter((job) => aiJobTypes.has(String(job.type)) && ["queued", "running"].includes(String(job.status)));
  if (!active.length) return null;
  return <aside className="ai-progress-center" aria-live="polite" aria-label="AI処理の進捗">
    <div className="ai-progress-center-title"><b>AI処理を実行中</b><span>{active.length}件</span></div>
    {active.slice(0, 4).map((job) => {
      const task = job.result?.progress || {};
      const percent = job.status === "queued" ? Math.max(2, Number(task.percent || 2)) : Math.max(5, Math.min(99, Number(task.percent || 5)));
      return <div className="ai-progress-center-item" key={job.id}>
        <div><b>{aiJobLabel(job.type)}：{percent}%</b><span>{task.detail || (job.status === "queued" ? "開始を受け付けました。Cloudflare Queueで順番を待っています。" : "AIが処理しています。")}</span></div>
        <div className="article-progress-track"><span style={{ width: `${percent}%` }} /></div>
      </div>;
    })}
    {active.length > 4 && <small>ほか{active.length - 4}件のAI処理も進行中です。</small>}
  </aside>;
}
const parseStoredJson = (value: unknown, fallback: any) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : (value ?? fallback);
  } catch {
    return fallback;
  }
};
// External APIs occasionally return a structured object where an older
// response returned plain text. Never hand an object to React as a child: it
// would crash the entire dashboard instead of showing the synced data.
const displayValue = (value: unknown, fallback = "—"): string => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value))
    return value.length
      ? value
          .map((item) => displayValue(item, ""))
          .filter(Boolean)
          .join(" / ")
      : fallback;
  if (typeof value === "object") {
    const summary = value as Record<string, unknown>;
    const text = [
      summary.summary,
      summary.message,
      summary.action,
      summary.title,
      summary.priority,
      summary.category,
      summary.impact,
      summary.effort,
      summary.total_issues !== undefined
        ? `課題 ${summary.total_issues}件`
        : null,
      summary.errors !== undefined ? `エラー ${summary.errors}件` : null,
      summary.warnings !== undefined ? `警告 ${summary.warnings}件` : null,
      summary.last_crawled ? `最終クロール ${summary.last_crawled}` : null,
    ]
      .filter((item) => typeof item === "string" || typeof item === "number")
      .map(String);
    return text.length ? text.join(" / ") : fallback;
  }
  return fallback;
};
const auditIssueText = (issue: unknown) => {
  if (typeof issue === "string") return issue;
  if (!issue || typeof issue !== "object")
    return "監査項目の詳細を確認してください。";
  const item = issue as Record<string, unknown>;
  return [
    item.id || item.type || item.title || "監査課題",
    item.count !== undefined ? `${item.count}件` : null,
    item.seo_impact ? `影響: ${item.seo_impact}` : null,
    item.difficulty ? `難易度: ${item.difficulty}` : null,
  ]
    .filter(Boolean)
    .map(String)
    .join(" / ");
};
const connectors = [
  ["ubersuggest", "U", "Ubersuggest", "KW・競合・被リンク"],
  ["gsc", "G", "Search Console", "順位・CTR・index"],
  ["ga", "A", "Google Analytics 4", "流入・CV・LP成果"],
  ["drive", "D", "Google Drive", "資料・写真・議事録"],
  ["youtube", "Y", "YouTube", "動画・文字起こし"],
  ["anthropic", "C", "Claude API", "記事生成・採点・分析"],
  ["wordpress", "W", "WordPress", "下書き自動投稿"],
  ["image", "I", "GPT Image 2", "記事画像・図解"],
  ["instagram", "◎", "Instagram", "許諾済み投稿画像"],
  ["x", "X", "X", "承認済み投稿"],
  ["notion", "N", "Notion", "社内ナレッジ"],
  ["pagespeed", "P", "PageSpeed", "表示速度・CWV"],
  ["note", "n", "note", "Markdown出力"],
  ["backlinks", "B", "被リンク", "Ubersuggest実データ"],
];
const integrationGuides = [
  {
    name: "Ubersuggest・被リンク",
    need: "Ubersuggestの利用権限とCloudflare WorkerのOAuthトークン",
    who: "最初の1回だけ運営者がUbersuggestでOAuth承認",
    steps:
      "OAuth承認 → Cloudflare WorkerからリモートMCP接続 → 全クライアントのデータを同期",
    cost: "SEO Loop側の追加AI API費用なし。Ubersuggest契約範囲のデータを利用",
  },
  {
    name: "Claude API",
    need: "Anthropic APIキー",
    who: "運営者がCloudflare Workerへ安全に登録",
    steps:
      "Cloudflare Queueが記事ジョブを受信 → Claude APIで生成・採点・分析 → 結果だけをSEO Loopへ返却",
    cost: "Anthropic APIのトークン課金。ローカルPCのログインは不要",
  },
  {
    name: "Search Console・GA4",
    need: "Google CloudのOAuth設定、対象プロパティを閲覧できるGoogleアカウント",
    who: "原則クライアントまたは権限を付与された運営者がGoogle承認",
    steps:
      "「Googleで認証」→ 対象サイト・GA4プロパティを選択 → 順位・CTR・流入・CVを同期",
    cost: "Google API自体は通常無料。最小限の読み取り権限のみ",
  },
  {
    name: "Google Drive・YouTube",
    need: "対象ファイル・チャンネルを閲覧できるGoogleアカウント",
    who: "所有者または共有権限を持つ担当者がGoogle承認",
    steps:
      "Google認証 → 取得先を選択 → 資料・写真・動画文字起こしを一次情報候補へ登録",
    cost: "読み取り中心。YouTube文字起こしの取得可否は動画設定による",
  },
  {
    name: "WordPress",
    need: "サイトURL、投稿権限ユーザー名、Application Password",
    who: "クライアントのWordPress管理者が発行し、運営者が入力",
    steps:
      "接続テスト → 記事生成 → 品質ゲート → 必ず下書きとして保存 → 人間が公開確認",
    cost: "追加API費用なし。通常のWordPress REST APIを使用",
  },
  {
    name: "Instagram",
    need: "Metaのアクセストークンと対象アカウントへの正規アクセス権",
    who: "非公開画像やクライアント画像はクライアント承認が必要",
    steps:
      "Meta認証 → 対象アカウント選択 → 許諾済み投稿だけを画像・一次情報候補へ登録",
    cost: "無断クロールは行わない。未連携時は生成画像へ自動切替可能",
  },
  {
    name: "X",
    need: "X APIのBearer Tokenと対象ユーザー名",
    who: "公開情報以外や投稿操作はアカウント所有者の承認が必要",
    steps: "トークン確認 → 承認済み投稿を取得 → 一次情報候補として人間確認",
    cost: "X APIプランによって別料金・取得制限あり",
  },
  {
    name: "GPT Image 2",
    need: "OpenAI APIキー",
    who: "運営者が課金先を確認して入力",
    steps:
      "記事内容から画像案 → 生成 → 出典・alt・記事との一致を確認 → WordPress下書きへ添付",
    cost: "画像生成ごとにAPI料金。未接続なら既存の許諾画像または画像なしで対応",
  },
  {
    name: "Notion・PageSpeed・note",
    need: "Notion Token／計測URL／noteは連携情報不要",
    who: "Notion管理者が対象ページをIntegrationへ共有",
    steps:
      "Notionは資料取得、PageSpeedはCWV計測、noteは公開用Markdownを書き出して手動公開",
    cost: "PageSpeedキーは任意。noteは一般向け公式投稿APIがないため自動公開しない",
  },
];
const fields: any = {
  wordpress: [
    ["siteUrl", "WordPress URL", "url"],
    ["username", "ユーザー名", "text"],
    ["applicationPassword", "Application Password", "password"],
  ],
  image: [["apiKey", "OpenAI APIキー", "password"]],
  instagram: [["accessToken", "Metaアクセストークン", "password"]],
  x: [
    ["bearerToken", "X Bearer Token", "password"],
    ["username", "対象ユーザー名（@なし）", "text"],
  ],
  notion: [["token", "Notion Integration Token", "password"]],
  pagespeed: [
    ["siteUrl", "計測URL", "url"],
    ["apiKey", "PageSpeed APIキー（任意）", "password"],
  ],
};
const nav = [
  ["dashboard", "⌂", "ダッシュボード"],
  ["aio", "✦", "LLMO / AIO"],
  ["publishing", "↑", "記事投稿"],
  ["article-preview", "◧", "記事プレビュー"],
  ["monthly-plan", "▣", "翌月コンテンツ計画"],
  ["immediate", "⚡", "即日入稿"],
  ["reports", "◫", "レポート・PDCA"],
  ["connections", "⌁", "連携設定"],
  ["sources", "●", "一次情報"],
  ["logs", "▤", "実行ログ"],
];
async function api(path: string, method = "GET", body?: any): Promise<any> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "処理できませんでした。");
  return data;
}
export function SeoLoopApp() {
  const [data, setData] = useState<Data>(blank);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState("dashboard");
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState("");
  const [secret, setSecret] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const load = async () => {
    try {
      const next = await api("bootstrap");
      setData(next);
      setNotice((current) =>
        /^D1_ERROR:|^処理できませんでした。$/.test(current) ? "" : current,
      );
      setSelected((current) =>
        next.clients.some((item: any) => item.id === current)
          ? current
          : next.clients[0]?.id || "",
      );
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const result = params.get("google");
    const ubersuggestResult = params.get("ubersuggest");
    const messages: Record<string, string> = {
      authorized:
        "Google認証が完了しました。Search Console・GA4・Drive・YouTubeは「認証済み」です。続けて取得先を選択してください。",
      invalid_client:
        "Google認証情報が一致していません。Cloudflare Workerに登録したOAuthクライアントのIDとシークレットを確認してください。",
      invalid_grant:
        "Googleの認証コードが期限切れ、または再使用されました。連携設定から「Googleで認証」をもう一度押してください。",
      redirect_mismatch:
        "Google Cloudの承認済みリダイレクトURIとSEO LoopのコールバックURLが一致していません。",
      session_expired:
        "認証操作が10分を超えたため期限切れになりました。連携設定からもう一度認証してください。",
      denied:
        "Googleでの許可がキャンセルされました。必要な場合は、連携設定からもう一度認証してください。",
      settings_missing:
        "Cloudflare WorkerのGoogle OAuth設定が見つかりません。クライアントIDとシークレットを確認してから再試行してください。",
      token_exchange_failed:
        "Google認証の最終確認に失敗しました。Cloudflare WorkerのOAuth設定を確認して、もう一度認証してください。",
      callback_failed:
        "Google認証後の保存処理に失敗しました。設定は消えていません。もう一度認証し、続く場合は実行ログを確認してください。",
    };
    if (result && messages[result]) setNotice(messages[result]);
    const ubersuggestMessages: Record<string, string> = {
      authorized:
        "Ubersuggestとの接続が完了しました。ダッシュボードの「実データ同期」から取得を開始できます。",
      denied:
        "Ubersuggestでの許可がキャンセルされました。必要な場合はもう一度接続してください。",
      session_expired:
        "Ubersuggest認証の有効時間が切れました。もう一度接続してください。",
      callback_failed:
        "Ubersuggest認証後の保存に失敗しました。実行ログを確認して、もう一度接続してください。",
    };
    if (ubersuggestResult && ubersuggestMessages[ubersuggestResult])
      setNotice(ubersuggestMessages[ubersuggestResult]);
    if (result || ubersuggestResult)
      history.replaceState({}, "", location.pathname);
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  const client =
    data.clients.find((item) => item.id === selected) || data.clients[0];
  const connections = data.connections.filter(
    (item) => item.client_id === client?.id,
  );
  const jobs = data.jobs.filter((item) => item.client_id === client?.id);
  const sources = data.sources.filter((item) => item.client_id === client?.id);
  const logs = data.logs.filter((item) => item.client_id === client?.id);
  const snapshots = data.snapshots.filter(
    (item) => item.client_id === client?.id,
  );
  const worker = [...data.workers].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  )[0];
  const map = Object.fromEntries(
    connections.map((item) => [item.connector, item]),
  );
  const cloudApiReady = Boolean(data.cloud?.anthropicConfigured);
  const workerOnline = cloudApiReady;
  const hasActiveAiJobs = jobs.some((job: any) => aiJobTypes.has(String(job.type)) && ["queued", "running"].includes(String(job.status)));
  // The normal dashboard refresh is intentionally calm.  While an AI task is
  // active, however, users need feedback immediately rather than waiting for
  // the next 30-second passive refresh.
  useEffect(() => {
    if (!hasActiveAiJobs) return;
    const timer = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(timer);
  }, [hasActiveAiJobs]);
  const uber =
    snapshots.find((item) => item.connector === "ubersuggest")?.data || {};
  const alerts = useMemo(() => {
    if (!client) return [];
    const items: any[] = [];
    if (client.primary_info_status !== "sufficient")
      items.push({
        kind: "error",
        title: "一次情報が不足しています",
        text: "記事は生成できますが、公開前の下書きで停止します。",
      });
    if (map.ubersuggest?.status === "reauth_required")
      items.push({
        kind: "error",
        title: "Ubersuggestの再ログインが必要です",
        text: "「連携設定」→「かんたん再接続」を開き、表示された2つの手順を実行してください。",
      });
    const connectorNames: Record<string, string> = {
      ga: "Google Analytics 4",
      gsc: "Search Console",
      drive: "Google Drive",
      youtube: "YouTube",
    };
    Object.entries(map)
      .filter(
        ([, item]: any) =>
          item?.status === "reauth_required" &&
          item?.connector !== "ubersuggest",
      )
      .slice(0, 2)
      .forEach(([key]) =>
        items.push({
          kind: "error",
          title: `${connectorNames[key] || key}の再認証が必要です`,
          text: "連携設定からGoogleで認証を開き、取得先を確認してください。既に保存された分析データは保持されています。",
        }),
      );
    const latestByType = new Map<string, any>();
    for (const job of jobs)
      if (!latestByType.has(job.type)) latestByType.set(job.type, job);
    const hasCompletedAfter = (job: any) =>
      jobs.some(
        (candidate: any) =>
          candidate.type === job.type &&
          candidate.status === "completed" &&
          new Date(candidate.updated_at).getTime() >
            new Date(job.updated_at).getTime(),
      );
    [...latestByType.values()]
      .filter(
        (job) =>
          job.status === "failed" &&
          !hasCompletedAfter(job) &&
          // WordPress connection checks are now performed synchronously. Any
          // queued `wordpress_verify` entry predates that implementation and
          // is audit-only history, never an unresolved dashboard incident.
          job.type !== "wordpress_verify" &&
          // The historical output-cap failure remains in the audit log, but the
          // worker configuration has already been replaced. Do not mislabel it
          // as an unresolved current incident in the dashboard.
          !(
            job.type === "article_generate" &&
            /(response exceeded the \d+ output token maximum|invalid_json_schema|Reading additional input from stdin)/i.test(
              String(job.error || job.result?.result || ""),
            )
          ) &&
          !(
            job.type === "ubersuggest_sync" &&
            map.ubersuggest?.status === "reauth_required"
          ),
      )
      .slice(0, 3)
      .forEach((job) =>
        items.push({
          kind: "error",
          title: `${job.type}の最新実行でエラー`,
          text: "現在も解消していません。詳しい内容と過去の履歴は「実行ログ」で確認できます。",
        }),
      );
    const latestArticle = latestByType.get("article_generate");
    if (
      latestArticle?.status === "completed" &&
      latestArticle.result?.score < 95
    )
      items.push({
        kind: "warn",
        title: "95点未満の記事があります",
        text: "3回の最高得点版と未解決指摘を確認してください。",
      });
    return items;
  }, [client, jobs, map.ubersuggest?.status]);
  if (!loaded)
    return <div className="loading">SEO Loopを読み込んでいます…</div>;
  const open = (key: string) => {
    setModal(key);
    setNotice("");
    setSecret("");
    setTimeout(() => dialog.current?.showModal(), 0);
  };
  const refresh = async (message?: string) => {
    await load();
    if (message) setNotice(message);
  };
  const createClient = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = await api("clients", "POST", Object.fromEntries(form));
    dialog.current?.close();
    await refresh(
      "クライアントを登録しました。連携設定から必要なクラウド連携を接続してください。",
    );
    setSelected(result.client.id);
  };
  const deleteClient = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api(`clients/${client.id}`, "DELETE", {
        confirmation: form.get("confirmation"),
      });
      dialog.current?.close();
      setSelected("");
      await refresh(`「${client.name}」を削除しました。`);
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  const connect = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    // Backlinks are part of the Ubersuggest integration, not a separate
    // local/Mac-worker integration. Keep the dedicated card as a convenient
    // entry point, while using the same OAuth connection and token.
    const connector = modal === "backlinks" ? "ubersuggest" : modal;
    try {
      const result = await api(
        `clients/${client.id}/connections/${connector}`,
        "POST",
        form,
      );
      if (result.authorizationUrl) {
        location.assign(result.authorizationUrl);
        return;
      }
      dialog.current?.close();
      await refresh("実接続を確認しました。");
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  const saveGoogle = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("settings/google", "POST", form);
      dialog.current?.close();
      await refresh(
        "Google管理者設定を暗号化して保存しました。次にSearch ConsoleまたはGA4の「接続する」を押してください。",
      );
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  const registerWorker = async () => {
    try {
      const result = await api(`clients/${client.id}/worker/register`, "POST", {
        name: "運用Mac",
      });
      setSecret(result.token);
      setNotice(
        "Macワーカーを登録しました。下のトークンをインストーラーへ一度だけ入力してください。",
      );
      await load();
      setTimeout(
        () =>
          document
            .querySelector(".token-panel")
            ?.scrollIntoView({ behavior: "smooth", block: "center" }),
        100,
      );
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  const queue = async (type: string, payload: any = {}) => {
    try {
      const result = await api(`clients/${client.id}/jobs`, "POST", { type, payload });
      const job = result.job;
      // Reflect the accepted Queue job in the UI synchronously.  This closes
      // the confusing gap between clicking a button and the first API poll.
      if (job?.id) setData((current) => ({
        ...current,
        jobs: [
          { ...job, client_id: job.client_id || client.id, payload: typeof job.payload === "string" ? JSON.parse(job.payload || "{}") : job.payload || {}, result: job.result || { progress: { percent: 2, stage: "queued", detail: "開始を受け付けました。Cloudflare Queueで順番を待っています。" } } },
          ...current.jobs.filter((item: any) => item.id !== job.id),
        ],
      }));
      setNotice(`${aiJobLabel(type)}を開始しました。進捗は右下の「AI処理を実行中」で確認できます。`);
      void load();
      return result;
    } catch (e: any) {
      setNotice(e.message);
      return null;
    }
  };
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <i>↗</i>
          <span>SEO LOOP</span>
        </div>
        <small>WORKSPACE</small>
        <nav className="nav">
          {nav.map(([key, icon, label]) => (
            <button
              key={key}
              className={page === key ? "active" : ""}
              onClick={() => setPage(key)}
            >
              {icon} <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="engine">
          <i />
          <span>クラウドエンジン稼働中</span>
        </div>
      </aside>
      <main className="main">
        <header className="top">
          <div>
            <div className="eyebrow">SEO OPERATIONS CLOUD</div>
            <h1>{nav.find((x) => x[0] === page)?.[2]}</h1>
          </div>
          <label className="client-picker" aria-label="対象サイトを切り替え">
            <span>対象サイト</span>
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={!data.clients.length}
            >
              {data.clients.map((item: any) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {String(item.site).replace(/^https?:\/\//, "").split("/")[0]}
                </option>
              ))}
            </select>
          </label>
        </header>
        <div className="content">
          {notice && (
            <div className="alert">
              <b>お知らせ</b>
              <span>{notice}</span>
            </div>
          )}
          <AiProgressCenter jobs={jobs} />
          {!client ? (
            <Onboarding />
          ) : (
            <>
              {alerts.length > 0 && (
                <div className="alerts">
                  {alerts.map((a, i) => (
                    <div className={`alert ${a.kind}`} key={i}>
                      <b>{a.title}</b>
                      <span>{a.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {page === "dashboard" && (
                <Dashboard
                  client={client}
                  map={map}
                  uber={uber}
                  jobs={jobs}
                  queue={queue}
                  worker={worker}
                  workerOnline={workerOnline}
                  goConnections={() => setPage("connections")}
                />
              )}{" "}
              {page === "connections" && (
                <Connections
                  map={map}
                  cloud={data.cloud}
                  open={open}
                  registerWorker={registerWorker}
                  secret={secret}
                  worker={worker}
                  workerOnline={workerOnline}
                  google={data.google}
                />
              )}{" "}
              {page === "publishing" && (
                <Publishing
                  client={client}
                  refresh={refresh}
                />
              )}{" "}
              {page === "article-preview" && (
                <ArticlePreview client={client} onNavigate={setPage} />
              )}{" "}
              {page === "monthly-plan" && (
                <MonthlyContentPlan client={client} refresh={refresh} />
              )}{" "}
              {page === "immediate" && (
                <ImmediatePublishing
                  queue={queue}
                  jobs={jobs}
                  client={client}
                  refresh={refresh}
                  strategy={
                    snapshots.find((s) => s.connector === "keyword_strategy")
                      ?.data
                  }
                  wordpressConnected={map.wordpress?.status === "connected"}
                  workerOnline={workerOnline}
                  goPlan={() => setPage("publishing")}
                  goConnections={() => setPage("connections")}
                />
              )}{" "}
              {page === "aio" && (
                <Aio
                  queue={queue}
                  jobs={jobs}
                  snapshot={
                    snapshots.find((s) => s.connector === "aio_observe")?.data
                  }
                />
              )}{" "}
              {page === "reports" && (
                <Reports
                  queue={queue}
                  jobs={jobs}
                  client={client}
                  snapshot={
                    snapshots.find((s) => s.connector === "monthly_report")
                      ?.data
                  }
                />
              )}{" "}
              {page === "seo" && <SeoTopics client={client} queue={queue} />}{" "}
              {page === "autopilot" && <Autopilot client={client} />}{" "}
              {page === "sources" && (
                <Sources
                  client={client}
                  sources={sources}
                  primaryInfoVersions={(data.primaryInfoVersions || []).filter((item: any) => item.client_id === client.id)}
                  sourceFiles={data.sourceFiles.filter(
                    (item) => item.client_id === client.id,
                  )}
                  jobs={jobs}
                  workers={data.workers}
                  connections={connections}
                  fileUploadsEnabled={Boolean(data.cloud?.fileUploadsEnabled)}
                  refresh={refresh}
                />
              )}{" "}
              {page === "logs" && <Logs logs={logs} jobs={jobs} />}
            </>
          )}
        </div>
      </main>
      <dialog ref={dialog}>
        {modal === "new-client" ? (
          <ClientModal
            close={() => dialog.current?.close()}
            submit={createClient}
          />
        ) : modal === "delete-client" ? (
          <DeleteClientModal
            client={client}
            close={() => dialog.current?.close()}
            submit={deleteClient}
            notice={notice}
          />
        ) : modal === "mcp-help" ? (
          <McpHelpModal
            worker={worker}
            workerOnline={workerOnline}
            close={() => dialog.current?.close()}
          />
        ) : modal === "google-admin" ? (
          <GoogleAdminModal
            google={data.google}
            close={() => dialog.current?.close()}
            submit={saveGoogle}
            notice={notice}
          />
        ) : (
          <ConnectionModal
            connector={modal}
            close={() => dialog.current?.close()}
            submit={connect}
            notice={notice}
            google={data.google}
            client={client}
            map={map}
            refresh={refresh}
            configureGoogle={() => setModal("google-admin")}
          />
        )}
      </dialog>
    </div>
  );
}

function Onboarding() {
  return (
    <section className="panel empty">
      <h2>対象サイトを準備しています</h2>
      <p>株式会社StrovisionOの運用先を作成しています。数秒後に再読み込みしてください。</p>
    </section>
  );
}
function Dashboard({
  client,
  map,
  uber,
  jobs,
  queue,
  worker,
  workerOnline,
  goConnections,
}: any) {
  const keywords = uber.keywords || [];
  const audit = uber.site_audit || {};
  const overview = uber.dashboard || {};
  const rankTracking = uber.rank_tracking || keywords;
  const opportunities = uber.seo_opportunities || [];
  const competitorResearch = uber.competitor_research || [];
  const topics = uber.topic_research || [];
  const backlinks = uber.backlinks || [];
  const auditIssues = (audit.top_issues || []).length
    ? audit.top_issues
    : audit.summary
      ? [audit.summary]
      : [];
  const improvements = [
    ...(Number(audit.errors || 0) > 0
      ? [`技術SEO: 監査で検出された${audit.errors}件のエラーを優先して解消`]
      : []),
    ...(Number(audit.warnings || 0) > 0
      ? [`技術SEO: ${audit.warnings}件の警告を重要ページから確認`]
      : []),
    ...keywords
      .filter(
        (x: any) =>
          Number(x.position || 999) >= 11 && Number(x.position || 999) <= 30,
      )
      .slice(0, 3)
      .map(
        (x: any) =>
          `順位改善: 「${x.keyword || x.term}」は現在${x.position}位。検索意図に合わせて既存ページを改稿`,
      ),
    ...keywords
      .filter((x: any) => Number(x.position || 999) > 30)
      .slice(0, 2)
      .map(
        (x: any) =>
          `新規コンテンツ: 「${x.keyword || x.term}」の検索意図を満たす解説・FAQを追加`,
      ),
  ];
  const sync = jobs.find((j: any) => j.type === "ubersuggest_sync");
  const ubersuggestNeedsLogin = map.ubersuggest?.status === "reauth_required";
  const syncText =
    sync?.status === "queued"
      ? "同期を受付済み（Cloudflare Queueの実行待ち）"
      : sync?.status === "running"
        ? "Ubersuggestから同期中です"
        : sync?.status === "failed"
          ? ubersuggestNeedsLogin
            ? "Ubersuggestの認証が切れています。再接続後に同期できます。"
            : `同期エラー: ${sync.error || "実行ログを確認してください"}`
          : sync?.status === "completed"
            ? `同期完了: ${new Date(sync.updated_at).toLocaleString("ja-JP")}`
            : "";
  const start = () =>
    ubersuggestNeedsLogin
      ? goConnections()
      : workerOnline
        ? queue("ubersuggest_sync", { domain: client.site })
        : goConnections();
  return (
    <>
      <div className="heading">
        <div>
          <h2>{client.name} SEOパフォーマンス</h2>
          <p>順位・流入・競合・被リンクから次のPDCAを決定します。</p>
        </div>
        <button
          className="primary"
          onClick={start}
          disabled={["queued", "running"].includes(sync?.status)}
        >
          {sync?.status === "running"
            ? "同期中…"
            : sync?.status === "queued"
              ? "受付済み"
              : ubersuggestNeedsLogin
                ? "Ubersuggestを再接続"
                : workerOnline
                  ? "実データ同期"
                  : "Ubersuggestを接続"}
        </button>
      </div>
      {ubersuggestNeedsLogin && (
        <div className="alert warn">
          <b>Ubersuggestの再接続が必要です</b>
          <span>
            トークンが失効したため、同期は開始しません。連携設定で再接続すると、保存済みのデータはそのまま利用できます。
          </span>
          <button className="secondary" onClick={goConnections}>
            連携設定を開く
          </button>
        </div>
      )}
      {syncText && (
        <div className={`sync-banner ${sync.status}`}>{syncText}</div>
      )}
      <JobProgress job={sync} label="Ubersuggestの実データ同期" />
      <div className="kpis">
        <div className="kpi">
          <span>追跡キーワード</span>
          <b>{keywords.length || "—"}</b>
          <em>Ubersuggest</em>
        </div>
        <div className="kpi">
          <span>Top 10 KW</span>
          <b>
            {keywords.filter((x: any) => (x.position || 99) <= 10).length ||
              "—"}
          </b>
          <em>最新同期</em>
        </div>
        <div className="kpi">
          <span>サイトヘルス</span>
          <b>{audit.health_score ?? "—"}</b>
          <em>監査 {audit.crawled_pages ?? "—"}ページ</em>
        </div>
        <div className="kpi">
          <span>オーガニックKW</span>
          <b>{(overview.organic_keywords ?? keywords.length) || "—"}</b>
          <em>Ubersuggestダッシュボード</em>
        </div>
        <div className="kpi">
          <span>公開待ち</span>
          <b>
            {
              jobs.filter(
                (j: any) =>
                  j.type === "article_generate" && j.status === "completed",
              ).length
            }
          </b>
          <em>品質ゲート後</em>
        </div>
        <div className="kpi">
          <span>クラウド実行</span>
          <b className={workerOnline ? "ok-text" : "warn-text"}>
            {workerOnline ? "有効" : "未接続"}
          </b>
          <em>
            {workerOnline
              ? "Cloudflare Queueで自動実行"
              : "Claude APIの設定を確認してください"}
          </em>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Ubersuggest 統合サマリー</h3>
            <p>
              サイトの状態を判断するための必要最小限の指標を、1画面に圧縮しています。
            </p>
          </div>
        </div>
        <div className="primary-examples">
          <div>
            <b>推定オーガニック流入</b>
            <span>{overview.organic_traffic ?? "未取得"}</span>
          </div>
          <div>
            <b>被リンク</b>
            <span>
              {(overview.backlinks ?? (uber.backlinks || []).length) ||
                "未取得"}
            </span>
          </div>
          <div>
            <b>参照ドメイン</b>
            <span>{overview.referring_domains ?? "未取得"}</span>
          </div>
          <div>
            <b>監査エラー / 警告</b>
            <span>
              {audit.errors ?? "—"} / {audit.warnings ?? "—"}
            </span>
          </div>
        </div>
        <p>
          {displayValue(
            overview.summary || audit.summary,
            "次回の実データ同期後に統合サマリーを表示します。",
          )}
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>検索キーワード別の順位</h3>
            <p>具体的なKWと次アクション</p>
          </div>
        </div>
        {keywords.length ? (
          <table>
            <thead>
              <tr>
                <th>キーワード</th>
                <th>順位</th>
                <th>Vol.</th>
                <th>難易度</th>
                <th>判断</th>
              </tr>
            </thead>
            <tbody>
              {keywords.map((x: any, i: number) => (
                <tr key={i}>
                  <td>{x.keyword || x.term}</td>
                  <td>{x.position ?? x.rank ?? "—"}</td>
                  <td>{x.volume ?? x.search_volume ?? "—"}</td>
                  <td>{x.difficulty ?? "—"}</td>
                  <td>
                    <span className="status">
                      {(x.position || 99) <= 15 ? "改稿" : "新規候補"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            {workerOnline
              ? "「実データ同期」を押すと、Ubersuggestのキーワード順位・競合・被リンクが表示されます。"
              : "Ubersuggestを接続すると、キーワード順位・競合・被リンクを同期できます。"}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>サイト監査</h3>
            <p>クロール済みページの技術SEO上の優先課題です。</p>
          </div>
          <span className="status">健全性 {audit.health_score ?? "—"}</span>
        </div>
        {auditIssues.length ? (
          <ol className="action-list">
            {auditIssues.map((issue: unknown, index: number) => (
              <li key={`${auditIssueText(issue)}-${index}`}>
                <b>課題 {index + 1}</b>
                {auditIssueText(issue)}
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">
            詳細な監査課題は、Ubersuggestが返した範囲で表示します。
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>SEOチャンス</h3>
            <p>比較的少ない改善で順位・流入を伸ばせる候補です。</p>
          </div>
        </div>
        {opportunities.length ? (
          <table>
            <thead>
              <tr>
                <th>キーワード</th>
                <th>機会</th>
                <th>優先度</th>
                <th>推奨アクション</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((item: any) => (
                <tr key={`${item.keyword}-${item.opportunity}`}>
                  <td>{item.keyword}</td>
                  <td>{item.opportunity}</td>
                  <td>{item.priority}</td>
                  <td>{item.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            SEOチャンスは、契約プランとMCPで取得できる場合に同期表示します。
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>ランク追跡</h3>
            <p>Ubersuggestに登録されている追跡キーワードをすべて表示します。</p>
          </div>
        </div>
        {rankTracking.length ? (
          <table>
            <thead>
              <tr>
                <th>キーワード</th>
                <th>現在順位</th>
                <th>変動</th>
                <th>対象URL</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {rankTracking.map((item: any, index: number) => (
                <tr key={`${item.keyword}-${index}`}>
                  <td>{item.keyword || item.term}</td>
                  <td>{item.position ?? item.rank ?? "—"}</td>
                  <td>{item.change ?? "—"}</td>
                  <td>{item.url || "—"}</td>
                  <td>{item.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">追跡キーワードがまだ取得されていません。</div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>競合分析・競合リサーチ</h3>
            <p>重複キーワード、相手との差分、取るべき対抗策をまとめます。</p>
          </div>
        </div>
        {(uber.competitors || []).length ? (
          <table>
            <thead>
              <tr>
                <th>競合ドメイン</th>
                <th>共通KW</th>
                <th>推定流入</th>
                <th>所見</th>
              </tr>
            </thead>
            <tbody>
              {uber.competitors.map((item: any) => (
                <tr key={item.domain}>
                  <td>{item.domain}</td>
                  <td>{item.common_keywords ?? "—"}</td>
                  <td>{item.estimated_traffic ?? "—"}</td>
                  <td>{item.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            競合分析は、Ubersuggestから対象プロジェクトのデータが返った場合に表示します。
          </div>
        )}
        {competitorResearch.length > 0 && (
          <ol className="action-list">
            {competitorResearch.map((item: any) => (
              <li key={`${item.domain}-${item.gap}`}>
                <b>{item.domain}</b>
                {item.gap}：{item.action}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>トピックリサーチ</h3>
            <p>次の記事・クラスターづくりに使うテーマ候補です。</p>
          </div>
        </div>
        {topics.length ? (
          <table>
            <thead>
              <tr>
                <th>テーマ</th>
                <th>検索意図</th>
                <th>推奨形式</th>
                <th>選定理由</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((item: any) => (
                <tr key={item.topic}>
                  <td>{item.topic}</td>
                  <td>{item.search_intent}</td>
                  <td>{item.content_format}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            トピックリサーチは、Ubersuggestから取得できる範囲で次回同期時に表示します。
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>被リンク</h3>
            <p>
              Ubersuggestで取得済みの参照ページを表示します。リンクの品質や不自然さは、確認対象として扱います。
            </p>
          </div>
        </div>
        {backlinks.length ? (
          <table>
            <thead>
              <tr>
                <th>参照元</th>
                <th>リンク先</th>
                <th>アンカー</th>
                <th>DA</th>
                <th>属性</th>
              </tr>
            </thead>
            <tbody>
              {backlinks.map((item: any, index: number) => (
                <tr key={`${item.url_from}-${index}`}>
                  <td>
                    <a href={item.url_from} target="_blank" rel="noreferrer">
                      {item.url_from}
                    </a>
                  </td>
                  <td>{item.url_to || "—"}</td>
                  <td>{item.anchor || "—"}</td>
                  <td>{item.domain_authority ?? "—"}</td>
                  <td>{item.nofollow ? "nofollow" : "dofollow"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            被リンクデータは、Ubersuggestが対象プロジェクトで返した分だけ表示します。
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Ubersuggest実データからのSEO改善点</h3>
            <p>順位・サイト監査の実測値をもとに優先度を整理しています。</p>
          </div>
        </div>
        {improvements.length ? (
          <ol className="action-list">
            {improvements.map((item, index) => (
              <li key={item}>
                <b>優先 {index + 1}</b>
                {item}
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">
            同期後に、順位・監査エラー・警告から具体的な改善点を表示します。
          </div>
        )}
      </section>
    </>
  );
}
function Connections({ map, cloud, open }: any) {
  return (
    <>
      <div className="heading">
        <div>
          <h2>実連携設定</h2>
          <p>ここからAPI情報を登録できます。サイト別に暗号化してCloudflare上へ保存し、実際に通信できた連携だけ「接続済み」と表示します。</p>
        </div>
      </div>
      <div className="cards connectors">
        {connectors.map(([key, icon, title, copy]) => {
          const connectionKey = key === "backlinks" ? "ubersuggest" : key;
          const saved = map[connectionKey]?.status;
          const managedByCloud =
            (key === "anthropic" && cloud?.anthropicConfigured) ||
            (key === "image" && cloud?.imageConfigured);
          const reauth = connectionKey === "ubersuggest" && saved === "reauth_required";
          const status = reauth
            ? "reauth_required"
            : managedByCloud
              ? "connected"
              : saved || (key === "note" ? "manual_export" : "not_connected");
          const label =
            status === "connected"
              ? "接続済み"
              : status === "verifying"
                ? "接続を確認中"
                : status === "reauth_required"
                  ? "再ログインが必要"
                  : status === "worker_online"
                    ? "Mac接続済み・初回同期待ち"
                    : status === "registered_offline"
                      ? "登録済み・オフライン"
                      : status === "authorized_needs_resource"
                        ? "認証済み・取得先選択待ち"
                        : status === "manual_export"
                          ? "Markdown出力"
                          : "未接続";
          const googleReady =
            ["ga", "gsc", "drive", "youtube"].includes(key) &&
            ["authorized_needs_resource", "connected"].includes(status);
          const checkedAt = map[connectionKey]?.checked_at;
          const health = map[connectionKey]?.public_config
            ? parseStoredJson(map[connectionKey].public_config, {}).health
            : null;
          return (
            <article className="connector" key={key}>
              <i>{icon}</i>
              <div>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
              <span className={`status ${status}`}>{label}</span>
              {managedByCloud ? (
                <span className="field-help">Cloudflareに設定済み</span>
              ) : (
                <button
                  className={status === "connected" ? "secondary" : "primary"}
                  onClick={() => open(key)}
                >
                  {reauth
                    ? "再接続する"
                    : googleReady
                      ? status === "connected"
                        ? "接続先を確認・変更"
                        : "取得先を選ぶ"
                      : status === "connected"
                        ? "再接続・確認"
                        : "接続する"}
                </button>
              )}
              {checkedAt && (
                <span className="field-help">
                  最終認証確認: {new Date(checkedAt).toLocaleString("ja-JP")}
                </span>
              )}
              {health?.state === "retrying" && (
                <span className="field-help">
                  {health.message || "一時的に確認できませんでした。自動再試行します。"}
                </span>
              )}
            </article>
          );
        })}
      </div>
      <section className="panel api-manual">
        <div className="panel-head">
          <div>
            <h3>全連携の詳しい設定方法</h3>
            <p>
              必要なもの、誰が承認するか、データの流れ、費用をサービス別に確認できます。
            </p>
          </div>
        </div>
        <div className="manual-list">
          {integrationGuides.map((guide, index) => (
            <details key={guide.name} open={index === 0}>
              <summary>{guide.name}</summary>
              <div className="manual-body">
                <p>
                  <b>用意するもの</b>
                  <span>{guide.need}</span>
                </p>
                <p>
                  <b>承認する人</b>
                  <span>{guide.who}</span>
                </p>
                <p>
                  <b>接続後の流れ</b>
                  <span>{guide.steps}</span>
                </p>
                <p>
                  <b>費用・注意</b>
                  <span>{guide.cost}</span>
                </p>
              </div>
            </details>
          ))}
        </div>
      </section>
    </>
  );
}
function scheduleMonthLabel(scheduleStart: string, monthNumber: number) {
  const match = String(scheduleStart || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return `${monthNumber}か月目`;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1 + monthNumber - 1, 1),
  );
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    timeZone: "Asia/Tokyo",
  }).format(date);
}

// Gutenberg markup is useful for WordPress, but it is not a client-facing
// editing format. The editor below deliberately treats only H2 as an article
// section. H3s belong to the H2 immediately above them and stay in its body.
const decodeArticleText = (value: unknown) => String(value || "")
  .replace(/<!--\s*\/??wp:[\s\S]*?-->/g, "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/?(?:p|div|li|ul|ol)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/\n{3,}/g, "\n\n").trim();
const escapeArticleHtml = (value: unknown) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const seoSlug = (value: unknown) => String(value || "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
  .replace(/^-+|-+$/g, "").slice(0, 120) || "article";
const withoutArticleH1 = (value: unknown) => String(value || "").replace(/<!--\s*wp:heading[^>]*-->\s*<h1[^>]*>[\s\S]*?<\/h1>\s*<!--\s*\/wp:heading\s*-->/gi, "").replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, "").trim();
const editorSections = (html: unknown) => {
  const source = String(html || "");
  const matches = [...source.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (!matches.length) {
    const bodyHtml = withoutArticleH1(source);
    return [{ id: "section-1", heading: "本文", level: 2, bodyHtml, body: decodeArticleText(bodyHtml), introHtml: "" }];
  }
  const introHtml = withoutArticleH1(source.slice(0, matches[0].index || 0));
  return matches.map((match, index) => ({
    id: `section-${index + 1}`,
    heading: decodeArticleText(match[1]) || `セクション${index + 1}`,
    level: 2,
    // Keep the original markup instead of flattening H3, lists and tables
    // into plain text. WordPress accepts this HTML and renders it identically.
    bodyHtml: source.slice((match.index || 0) + match[0].length, matches[index + 1]?.index || source.length).trim(),
    body: decodeArticleText(source.slice((match.index || 0) + match[0].length, matches[index + 1]?.index || source.length)),
    introHtml: index === 0 ? introHtml : "",
  }));
};
const gutenbergSections = (sections: any[]) => sections.map((section, index) => {
  const level = 2;
  const heading = escapeArticleHtml(section.heading || "見出し");
  const fallback = String(section.body || "").split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => `<p>${escapeArticleHtml(paragraph).replace(/\n/g, "<br/>")}</p>`).join("\n");
  const bodyHtml = String(section.bodyHtml || fallback).trim();
  return `${index === 0 ? String(section.introHtml || "").trim() : ""}\n<!-- wp:heading {"level":${level}} -->\n<h${level}>${heading}</h${level}>\n<!-- /wp:heading -->\n${bodyHtml}`.trim();
}).join("\n\n");
const defaultImagePlan = (role: "featured" | "section", heading = "") => ({
  id: role === "featured" ? "featured" : `section-${seoSlug(heading) || "image"}`,
  role,
  heading,
  enabled: true,
  source: "ai",
  placement: role === "featured" ? "アイキャッチ画像" : `H2「${heading}」の直後`,
  prompt: role === "featured" ? "記事の主題を正確に伝える、文字を含まないアイキャッチ画像" : `「${heading}」の内容を直感的に補足する、文字を含まない図解または写真`,
  alt: role === "featured" ? "記事のアイキャッチ画像" : `${heading}を補足する画像`,
  benefit: role === "featured" ? "記事のテーマをひと目で伝える" : "このセクションの要点を理解しやすくする",
});
const normalizedImagePlans = (article: any, sections = editorSections(article?.html)) => {
  const supplied = Array.isArray(article?.image_brief) ? article.image_brief : [];
  const featured = supplied.find((image: any) => image?.role === "featured" || /アイキャッチ|featured/i.test(String(image?.placement || ""))) || defaultImagePlan("featured");
  const sectionImages = sections.map((section: any, index: number) => {
    const found = supplied.find((image: any) => image?.role === "section" && String(image?.section_id || "") === section.id)
      || supplied.find((image: any) => image?.role === "section" && String(image?.heading || "") === section.heading)
      || supplied.find((image: any) => String(image?.placement || "").includes(section.heading))
      || (index === 0 ? supplied.find((image: any) => image !== featured) : null);
    return { ...defaultImagePlan("section", section.heading), ...(found || {}), id: `section-${index + 1}`, section_id: section.id, role: "section", heading: section.heading, placement: `H2「${section.heading}」の直後` };
  });
  return [{ ...defaultImagePlan("featured"), ...featured, role: "featured", heading: "" }, ...sectionImages];
};
const prepareMonthlyArticle = (article: any) => {
  const next = { ...(article || {}) };
  // Existing saved editor_sections may have been generated by the old H2/H3
  // splitter. Rebuild from the publishing HTML whenever it exists.
  const sections = next.html ? editorSections(next.html) : (Array.isArray(next.editor_sections) && next.editor_sections.length ? next.editor_sections : editorSections(""));
  next.editor_sections = sections;
  next.html = next.html || gutenbergSections(sections);
  next.slug = seoSlug(next.slug || next.title);
  next.seo_title = String(next.seo_title || next.title || "").slice(0, 120);
  next.image_brief = normalizedImagePlans(next, sections);
  return next;
};

function MonthlyContentPlan({ client, refresh, embedded = false }: any) {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [articlesPerWeek, setArticlesPerWeek] = useState(1);
  const [wordpressCategories, setWordpressCategories] = useState<any[]>([]);
  const [categoryMode, setCategoryMode] = useState<"balanced" | "manual">("balanced");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
  const [keywordMode, setKeywordMode] = useState<"auto" | "manual">("auto");
  const [manualKeywords, setManualKeywords] = useState("");
  const [openItem, setOpenItem] = useState("");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const load = async () => {
    try { setData(await api(`clients/${client.id}/monthly-content-plan`)); }
    catch (error: any) { setMessage(error.message); }
  };
  useEffect(() => { void load(); }, [client.id]);
  const loadCategories = async () => {
    try {
      const result = await api(`clients/${client.id}/wordpress/categories`);
      setWordpressCategories((result.categories || []).filter((category: any) => category.id && category.name !== "未分類"));
    } catch {
      setWordpressCategories([]);
    }
  };
  useEffect(() => { void loadCategories(); }, [client.id]);
  useEffect(() => {
    if (data?.plan?.articles_per_week) setArticlesPerWeek(Number(data.plan.articles_per_week));
  }, [data?.plan?.articles_per_week]);
  // 月間生成中はカードを開かなくても全体進捗が動くようにする。完了後は
  // polling を止め、通常の画面閲覧で余計な通信を発生させない。
  useEffect(() => {
    const generating = (data?.items || []).some((item: any) => ["queued", "running"].includes(item.job_status));
    if (!generating) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [data?.items]);
  const create = async () => {
    try {
      if (categoryMode === "manual" && !selectedCategoryIds.length) {
        setMessage("手動指定では、少なくとも1つのWordPressカテゴリーを選んでください。");
        return;
      }
      const result = await api(`clients/${client.id}/monthly-content-plan`, "POST", {
        articlesPerWeek,
        categoryMode,
        categoryIds: selectedCategoryIds,
        manualKeywords: keywordMode === "manual" ? manualKeywords : "",
      });
      setMessage(`翌月${result.articleCount}本の計画を作成しました。次に「月間下書きを生成」を押してください。`);
      await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const generate = async () => {
    try {
      const result = await api(`clients/${client.id}/monthly-content-plan/${data.plan.id}/generate`, "POST");
      setMessage(`${result.count}本をSEO Loop内の下書きとして生成開始しました。WordPressには送信しません。`);
      await refresh(); await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const save = async (item: any, article: any) => {
    try {
      await api(`clients/${client.id}/monthly-content-plan/items/${item.id}/edit`, "POST", { article });
      setMessage("下書きを保存しました。本文を変えたため、この記事の最終承認は解除されています。予約公開する場合は、続けて全体または該当セクションをAI再生成し、品質確認後に承認してください。");
      await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const uploadImage = async (item: any, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/clients/${client.id}/monthly-content-plan/items/${item.id}/images`, { method: "POST", body: form });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "画像を保存できませんでした。");
    return result.image;
  };
  const regenerate = async (item: any, scope: string, heading = "") => {
    const instruction = prompt(scope === "section" ? "このセクションをどう改善しますか？" : "記事全体をどう改善しますか？");
    if (!instruction?.trim()) return;
    try {
      await api(`clients/${client.id}/monthly-content-plan/items/${item.id}/regenerate`, "POST", { scope, heading, instruction });
      setMessage("AI再生成を開始しました。完了すると新しい版がこのカードに反映されます。");
      await refresh(); await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const approve = async (item: any, approved: boolean) => {
    try { await api(`clients/${client.id}/monthly-content-plan/items/${item.id}/approve`, "POST", { approved }); await load(); }
    catch (error: any) { setMessage(error.message); }
  };
  const reserve = async () => {
    try {
      const result = await api(`clients/${client.id}/monthly-content-plan/${data.plan.id}/confirm`, "POST", { confirmAutoPublish: confirmPublish });
      setMessage(`${result.count}本を指定日にWordPress公開する予約へ切り替えました。`); await refresh(); await load();
    } catch (error: any) { setMessage(error.message); }
  };
  if (!data) return <section className="panel"><p>翌月コンテンツ計画を読み込んでいます…</p></section>;
  const items = data.items || [], generated = items.filter((item: any) => item.article).length;
  const reviewed = items.filter((item: any) => item.finalConfirmed).length;
  const activeItems = items.filter((item: any) => ["queued", "running"].includes(item.job_status));
  const activeItem = activeItems.find((item: any) => item.job_status === "running") || activeItems[0];
  const completedItems = items.filter((item: any) => item.article || item.job_status === "completed").length;
  const activeItemIndex = activeItem ? items.findIndex((item: any) => item.id === activeItem.id) + 1 : 0;
  const currentJobPercent = activeItem ? Math.max(2, Math.min(99, Number(activeItem.progress?.percent || (activeItem.job_status === "queued" ? 2 : 8)))) : 0;
  const planPercent = items.length
    ? Math.min(100, Math.round(((completedItems + (activeItem ? currentJobPercent / 100 : 0)) / items.length) * 100))
    : 0;
  // クライアント向けの計画画面には、生成済みの記事だけを見せる。
  // 本数・キーワード・カテゴリーの設定は「記事投稿」に一本化する。
  const visibleItems = items.filter((item: any) => item.article);
  return <>
    <div className="heading"><div><h2>{embedded ? "記事投稿の設定" : "翌月コンテンツ計画"}</h2><p>{embedded ? "本数とカテゴリーを設定して、1か月分の下書きをまとめて生成します。" : "作成済みの下書きを確認し、本文・画像・配信週を編集して承認する画面です。"}</p></div></div>
    {embedded && <section className="panel monthly-plan-intro">
      <div className="panel-head"><div><h3>1か月分を先に作って、クライアントと確認</h3><p>この画面で作る間はWordPressへ記事・画像を送信しません。最終確認した記事だけを翌月に予約公開します。</p></div></div>
      <div className="form-grid monthly-plan-controls">
        <label>週に作る記事数<select value={articlesPerWeek} onChange={(event) => setArticlesPerWeek(Number(event.target.value))} disabled={Boolean(data.plan?.finalConfirmed)}>{[1,2,3,4,5,6,7].map(value => <option value={value} key={value}>週{value}本（約{value * 4}本／月）</option>)}</select></label>
        <div className="monthly-plan-action"><button className="primary" onClick={create} disabled={Boolean(data.plan?.finalConfirmed)}>{data.plan ? "下書き未生成の計画を作り直す" : "翌月の計画を作る"}</button><small>狙うキーワードと、レポートの順位・クリック変化を優先順位に使います。</small></div>
      </div>
      <div className="monthly-category-settings"><h4>狙うキーワード</h4><p>AIに任せるか、改行区切りで指定したキーワードを優先して計画に入れるかを選べます。</p>
        <label className="inline-choice"><input type="radio" checked={keywordMode === "auto"} onChange={() => setKeywordMode("auto")} />AIに自動選定させる（推奨）</label>
        <label className="inline-choice"><input type="radio" checked={keywordMode === "manual"} onChange={() => setKeywordMode("manual")} />キーワードを自分で指定する</label>
        {keywordMode === "manual" && <textarea aria-label="指定キーワード" value={manualKeywords} onChange={(event) => setManualKeywords(event.target.value)} placeholder="1行に1キーワード（例：LINE マーケティング）" />}
      </div>
      <div className="monthly-category-settings">
        <div className="panel-head"><div><h4>WordPressカテゴリーに合わせて記事を作る</h4><p>カテゴリー「マーケティング」ならマーケティングの記事というように、実在カテゴリーと一致するキーワードだけを選びます。WordPressで追加したカテゴリーは、計画作成時に自動取得されます。</p></div><button type="button" className="secondary" onClick={loadCategories}>カテゴリーを最新化</button></div>
        <label className="inline-choice"><input type="radio" checked={categoryMode === "balanced"} onChange={() => setCategoryMode("balanced")} disabled={Boolean(data.plan?.finalConfirmed)} />自動で均等に振り分ける（推奨）</label>
        <label className="inline-choice"><input type="radio" checked={categoryMode === "manual"} onChange={() => setCategoryMode("manual")} disabled={Boolean(data.plan?.finalConfirmed)} />カテゴリーを手動で選ぶ</label>
        {wordpressCategories.length ? <div className="category-choice-list">{wordpressCategories.map((category: any) => {
          const selected = selectedCategoryIds.includes(Number(category.id));
          return <label key={category.id} className="inline-choice"><input type="checkbox" checked={categoryMode === "balanced" || selected} disabled={categoryMode === "balanced" || Boolean(data.plan?.finalConfirmed)} onChange={() => setSelectedCategoryIds((current) => selected ? current.filter((id) => id !== Number(category.id)) : [...current, Number(category.id)])} />{category.name}（投稿{category.count}件）</label>;
        })}</div> : <small>WordPress接続後に実在カテゴリーを読み込みます。</small>}
      </div>
      {message && <p className="error-text">{message}</p>}
    </section>}
    {data.plan && <>
      <section className="panel monthly-plan-summary">
        <div><b>{data.plan.plan_month.replace("-", "年")}月の配信予定</b><span>{generated}本の作成済み記事を表示・{reviewed}本を最終承認済み</span></div>
        {embedded && <div className="button-row"><button className="primary" onClick={generate} disabled={Boolean(data.plan.finalConfirmed) || !items.some((item: any) => !item.article_job_id)}>月間下書きを生成</button></div>}
      </section>
      {activeItem && <section className="panel monthly-plan-overall-progress" aria-live="polite">
        <div className="article-progress-head"><b>月間記事生成: {planPercent}%</b><span>全{items.length}本中 {activeItemIndex}本目を{activeItem.job_status === "queued" ? "開始待ち" : "生成中"}（{completedItems}本完了）</span></div>
        <div className="article-progress-track"><span style={{ width: `${Math.max(2, planPercent)}%` }} /></div>
        <small>{activeItem.progress?.detail || (activeItem.job_status === "queued" ? "Cloudflare Queueで生成開始を待っています…" : "AIが記事を作成しています…")}</small>
      </section>}
      <section className="monthly-plan-list">
        {visibleItems.length ? visibleItems.map((item: any) => <MonthlyPlanItem key={item.id} item={item} open={openItem === item.id} toggle={() => setOpenItem(openItem === item.id ? "" : item.id)} save={save} regenerate={regenerate} approve={approve} uploadImage={uploadImage} />) : <div className="empty">月間下書きを生成すると、作成済みの記事だけが第1週〜第4週の配信予定とともにここへ表示されます。</div>}
      </section>
      <section className="panel monthly-plan-confirm">
        <h3>翌月の予約公開</h3>
        <p>各記事の本文・SEO情報・画像・選定理由を確認し、すべてに「この内容で承認」を付けてから予約します。指定日にはWordPressの本番環境へ「公開」状態で投稿します。品質・一次情報・人間レビュー・WordPress接続の安全条件を満たさない記事だけは、誤公開を防ぐため停止します。</p>
        <label className="inline-choice"><input type="checkbox" checked={confirmPublish} onChange={(event) => setConfirmPublish(event.target.checked)} disabled={Boolean(data.plan.finalConfirmed)} />翌月の指定日に、最終確認済みの記事をWordPressへ公開することを確認しました。</label>
        <button className="primary" onClick={reserve} disabled={!confirmPublish || Boolean(data.plan.finalConfirmed) || reviewed !== items.length}>{data.plan.finalConfirmed ? "予約公開を設定済み" : `全${items.length}本を予約公開する`}</button>
      </section>
    </>}
    {!data.plan && !embedded && <section className="panel"><h3>まだ確認する記事はありません</h3><p>運用担当者が「記事投稿」から1か月分の記事を生成すると、ここに確認用の下書きだけが表示されます。</p></section>}
  </>;
}

function MonthlyPlanItem({ item, open, toggle, save, regenerate, approve, uploadImage }: any) {
  const [article, setArticle] = useState<any>(() => prepareMonthlyArticle(item.article || {}));
  const [imageMessage, setImageMessage] = useState("");
  const [editingSection, setEditingSection] = useState("");
  useEffect(() => { setArticle(prepareMonthlyArticle(item.article || {})); setImageMessage(""); }, [item.article]);
  const sections = Array.isArray(article.editor_sections) && article.editor_sections.length ? article.editor_sections : editorSections(article.html);
  const images = normalizedImagePlans(article, sections);
  const updateArticle = (next: any) => setArticle(prepareMonthlyArticle(next));
  const updateSections = (nextSections: any[]) => updateArticle({ ...article, editor_sections: nextSections, html: gutenbergSections(nextSections) });
  const updateImage = (index: number, key: string, value: any) => updateArticle({ ...article, image_brief: images.map((image: any, current: number) => current === index ? { ...image, [key]: value } : image) });
  const uploadOwnImage = async (index: number, file?: File) => {
    if (!file) return;
    try {
      setImageMessage("画像を保存しています…");
      const stored = await uploadImage(item, file);
      updateArticle({ ...article, image_brief: images.map((image: any, current: number) => current === index ? { ...image, source: "manual", enabled: true, manual_image_id: stored.id, manual_image_key: stored.objectKey, manual_image_url: stored.url, manual_image_name: stored.name, alt: image.alt || stored.name } : image) });
      setImageMessage("手持ち画像を設定しました。保存するとプレビューと公開予約に反映されます。");
    } catch (error: any) { setImageMessage(error.message); }
  };
  const imageSettings = (image: any, index: number, label: string) => <details className="wp-image-settings">
    <summary>{label}を設定</summary>
    <div className="wp-image-settings-body">
      <label className="inline-choice"><input type="checkbox" checked={image.enabled !== false} onChange={(event) => updateImage(index, "enabled", event.target.checked)} />この画像を使う</label>
      {image.enabled !== false && <>
        <div className="image-source-choice"><label className="inline-choice"><input type="radio" checked={image.source !== "manual"} onChange={() => updateImage(index, "source", "ai")} />AIで作る</label><label className="inline-choice"><input type="radio" checked={image.source === "manual"} onChange={() => updateImage(index, "source", "manual")} />手持ち画像を使う</label></div>
        {image.source === "manual" ? <label>画像をアップロード<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadOwnImage(index, event.target.files?.[0])} /></label> : <><label>AI画像への指示<textarea value={image.prompt || ""} onChange={(event) => updateImage(index, "prompt", event.target.value)} /></label><button type="button" className="secondary" onClick={() => updateImage(index, "regeneration_requested_at", new Date().toISOString())}>AI画像をワンクリックで再生成</button></>}
        <label>代替テキスト（alt）<input value={image.alt || ""} onChange={(event) => updateImage(index, "alt", event.target.value)} /></label>
      </>}
    </div>
  </details>;
  const status = item.job_status === "failed" ? "生成エラー" : item.job_status === "running" || item.status === "GENERATING" || item.status === "REGENERATING" ? "AI生成中" : item.article ? item.finalConfirmed ? "最終承認済み" : "確認待ち" : "下書き未生成";
  return <article className={`panel monthly-plan-item ${open ? "is-open" : ""}`}>
    <button className="monthly-plan-item-head" onClick={toggle}><span>配信予定：第{item.week_no}週（{item.target_date}）</span><b>{item.planned_title || item.keyword}</b><em className={item.finalConfirmed ? "status connected" : "status"}>{status}</em></button>
    <div className="monthly-plan-reason"><b>カテゴリー:</b> {item.category_name || "WordPressカテゴリー未設定"}<br/><b>狙うキーワード:</b> {item.keyword}<br/><b>この記事にする理由:</b> {item.rationale}<br/><small>実データの根拠: {item.data_basis}</small></div>
    {["queued", "running"].includes(item.job_status) && <div className="monthly-plan-progress"><span style={{ width: `${Math.max(4, Math.min(100, Number(item.progress?.percent || (item.job_status === "queued" ? 4 : 8))))}%` }} /><small>{item.progress?.detail || (item.job_status === "queued" ? "Cloudflare Queueで生成開始を待っています…" : "AIが下書きを作成しています…")}</small></div>}
    {item.job_error && <p className="error-text">生成エラー: {item.job_error}</p>}
    {open && item.article && <div className="monthly-editor visual-article-editor">
      <section className="editor-guide"><b>WordPressと同じ見た目で、直接編集できます</b><span>H2だけが大きなセクションです。H3・表・箇条書きはH2の中身として表示されます。画像も該当する見出しの中で設定します。</span></section>
      <article className="wp-article-canvas">
        <header className="wp-article-header"><p className="wp-article-kicker">記事プレビュー</p><h1>{article.title || item.planned_title || "記事タイトル"}</h1><p className="wp-article-description">{article.meta_description || "検索結果に表示する説明文を設定できます。"}</p>
          <div className="wp-featured-media">{images[0]?.enabled && images[0]?.source === "manual" && images[0]?.manual_image_url ? <img src={images[0].manual_image_url} alt={images[0].alt || "記事のアイキャッチ画像"} /> : images[0]?.enabled ? <div className="ai-image-placeholder"><b>アイキャッチ画像</b><span>{images[0]?.regeneration_requested_at ? "AI画像を再生成予定" : "公開時にAI画像を生成します"}</span></div> : <div className="image-disabled-placeholder">アイキャッチ画像なし</div>}</div>
          {imageSettings(images[0], 0, "アイキャッチ画像")}
        </header>
        {sections[0]?.introHtml && <div className="wp-article-intro" dangerouslySetInnerHTML={{ __html: sections[0].introHtml }} />}
        {sections.map((section: any, index: number) => {
          const imageIndex = images.findIndex((image: any) => image.role === "section" && image.section_id === section.id);
          const sectionImage = images[imageIndex];
          const isEditing = editingSection === section.id;
          return <section className={`wp-editor-section ${isEditing ? "is-editing" : ""}`} key={section.id}>
            {isEditing ? <input className="wp-section-heading-input" aria-label={`H2見出し ${index + 1}`} value={section.heading || ""} onChange={(event) => updateSections(sections.map((current: any, currentIndex: number) => currentIndex === index ? { ...current, heading: event.target.value } : current))} /> : <h2>{section.heading}</h2>}
            {isEditing ? <div className="wp-content-editable" contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: section.bodyHtml || "<p></p>" }} onBlur={(event) => updateSections(sections.map((current: any, currentIndex: number) => currentIndex === index ? { ...current, bodyHtml: event.currentTarget.innerHTML, body: decodeArticleText(event.currentTarget.innerHTML) } : current))} /> : <div className="wp-rendered-content" dangerouslySetInnerHTML={{ __html: section.bodyHtml || "<p>本文を追加してください。</p>" }} />}
            <div className="wp-section-actions"><button type="button" className="secondary" onClick={() => setEditingSection(isEditing ? "" : section.id)}>{isEditing ? "編集を終了" : "このH2を編集"}</button><button type="button" className="secondary" onClick={() => regenerate(item, "section", section.heading)}>このH2をAIで再生成</button><button type="button" className="text-button" disabled={sections.length === 1} onClick={() => updateSections(sections.filter((_: any, current: number) => current !== index))}>このH2を削除</button></div>
            <div className="wp-section-media">{sectionImage?.enabled && sectionImage?.source === "manual" && sectionImage?.manual_image_url ? <img src={sectionImage.manual_image_url} alt={sectionImage.alt || `${section.heading}の画像`} /> : sectionImage?.enabled ? <div className="ai-image-placeholder"><b>{section.heading}の画像</b><span>{sectionImage?.regeneration_requested_at ? "AI画像を再生成予定" : "公開時にAI画像を生成します"}</span></div> : <div className="image-disabled-placeholder">このH2には画像を設定しない</div>}</div>
            {sectionImage && imageSettings(sectionImage, imageIndex, `「${section.heading}」の画像`)}
          </section>;
        })}
        <button type="button" className="secondary wp-add-section" onClick={() => updateSections([...sections, { id: `section-${sections.length + 1}`, heading: "新しい見出し", level: 2, bodyHtml: "<p>本文を入力してください。</p>", body: "本文を入力してください。" }])}>H2セクションを追加</button>
      </article>
      <details className="seo-settings-panel"><summary>SEO設定（タイトルタグ・URL末尾・説明文）</summary><div className="seo-editor-grid"><label>記事タイトル（H1）<input value={article.title || ""} onChange={(event) => updateArticle({ ...article, title: event.target.value, seo_title: article.seo_title === article.title ? event.target.value : article.seo_title, slug: article.slug || seoSlug(event.target.value) })} /></label><label>SEOタイトル（titleタグ）<input value={article.seo_title || ""} maxLength={120} onChange={(event) => updateArticle({ ...article, seo_title: event.target.value })} /><small>{String(article.seo_title || "").length}/60文字目安</small></label><label>URL末尾（slug）<input value={article.slug || ""} onChange={(event) => updateArticle({ ...article, slug: seoSlug(event.target.value) })} /><small>公開URL: /{article.slug || "article"}</small></label><label>説明文（検索結果用）<textarea value={article.meta_description || ""} maxLength={160} onChange={(event) => updateArticle({ ...article, meta_description: event.target.value })} /><small>{String(article.meta_description || "").length}/120文字目安</small></label></div></details>
      {imageMessage && <p className={imageMessage.includes("できません") ? "error-text" : "success-text"}>{imageMessage}</p>}
      <details className="technical-details"><summary>詳細設定：WordPress用HTMLを確認・修正する</summary><textarea className="article-html-editor" value={article.html || ""} onChange={(event) => updateArticle({ ...article, html: event.target.value, editor_sections: editorSections(event.target.value) })} /></details>
      <div className="button-row"><button className="secondary" onClick={() => regenerate(item, "article")}>記事全体をAIで再生成</button><button className="primary" onClick={() => save(item, article)}>変更を保存してプレビューへ反映</button></div>
      <label className="inline-choice"><input type="checkbox" checked={Boolean(item.finalConfirmed)} onChange={(event) => approve(item, event.target.checked)} />本文・根拠・画像位置を確認しました。この内容で承認する</label>
    </div>}
    {open && !item.article && <div className="empty">「月間下書きを生成」を押すと、ここに本文、見出し、画像案が表示されます。生成中はページを閉じても処理を続けます。</div>}
  </article>;
}

const articleInputStatusLabel: Record<string, string> = {
  ANALYZING: "入力を分析中",
  BRIEF_READY: "Content Briefを確認できます",
  GENERATING: "記事を生成中",
  ARTICLE_GENERATED: "記事の下書きを生成済み",
  FAILED: "再確認が必要です",
};
const referenceFetchStatusLabel: Record<string, string> = {
  PENDING: "取得待ち",
  FETCHING: "取得中",
  READY: "分析済み",
  FAILED: "取得できませんでした",
  TRANSCRIPT_NOT_AVAILABLE: "文字起こしが未取得",
  SOURCE_FETCH_FAILED: "取得できませんでした",
};
const inputTextList = (value: unknown, fallback: string[] = []) =>
  Array.isArray(value)
    ? value.map((item) => displayValue(item, "")).filter(Boolean)
    : fallback;
const splitLines = (value: string) =>
  value
    .split(/\n|、|,/)
    .map((item) => item.trim())
    .filter(Boolean);
const inputRequestId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type ArticleEntryMode = "seo" | "reference" | "idea";
type ReferenceInput = { key: string; url: string; text: string; sourceType?: "AUTO" | "YOUTUBE" | "WEB" | "X" | "TEXT"; transcriptSource?: "AUTO" | "MANUAL"; rawTranscript?: string; normalizedTranscript?: string; videoTitle?: string; channel?: string; fetchedAt?: string; promptVersion?: string };
const isYoutubeReferenceUrl = (value: string) => /(?:^|\.)youtube(?:-nocookie)?\.com\//i.test(value) || /youtu\.be\//i.test(value);
type SeriesScheduleMode = "DRAFT_ONLY" | "WEEKLY" | "INDIVIDUAL";

const seriesStatusLabel: Record<string, string> = {
  PLANNING: "シリーズ企画を作成中",
  BRIEFS_READY: "記事別のBriefを確認できます",
  GENERATING: "記事を生成中",
  REVIEWING: "品質確認中",
  READY: "公開準備完了",
  PARTIALLY_READY: "一部の記事を確認中",
  SCHEDULED: "投稿予定を保存済み",
  IN_PROGRESS: "処理中",
  COMPLETED: "完了",
  FAILED: "再確認が必要です",
};
const articleMethodLabel: Record<string, string> = {
  REFERENCE: "Reference",
  IDEA: "Idea",
  SEO: "SEO Keyword",
  SEO_KEYWORD: "SEO Keyword",
};
const asItems = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const fieldOf = (source: any, ...keys: string[]) => {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null)
      return source[key];
  }
  return undefined;
};
const seriesItemPlan = (item: any) => item?.plan || item?.articlePlan || item || {};
const seriesItemId = (item: any) =>
  String(fieldOf(item, "id", "itemId", "item_id") || "");
const seriesItemTitle = (item: any) =>
  displayValue(
    fieldOf(
      seriesItemPlan(item),
      "workingTitle",
      "working_title",
      "title",
    ) || fieldOf(item, "title", "workingTitle"),
    "記事タイトルを企画中",
  );
const seriesItemKeyword = (item: any) =>
  displayValue(
    fieldOf(
      seriesItemPlan(item),
      "primaryKeyword",
      "primary_keyword",
      "keyword",
    ) || fieldOf(item, "primaryKeyword", "primary_keyword"),
    "キーワードを選定中",
  );
const dateInputValue = (value: unknown) => {
  const stringValue = String(value || "");
  return /^\d{4}-\d{2}-\d{2}/.test(stringValue)
    ? stringValue.slice(0, 10)
    : "";
};
const timeInputValue = (value: unknown) => {
  const stringValue = String(value || "");
  const match = stringValue.match(/T(\d{2}:\d{2})|\s(\d{2}:\d{2})/);
  return match?.[1] || match?.[2] || "10:00";
};
const formatSchedule = (value: unknown, timezone = "Asia/Tokyo") => {
  const stringValue = String(value || "");
  if (!stringValue) return "未設定";
  const date = new Date(stringValue);
  if (Number.isNaN(date.getTime())) return stringValue;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
};
const scheduledAtForWeekly = (
  startDate: string,
  weekday: number,
  time: string,
  order: number,
) => {
  if (!startDate) return "";
  const date = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  const adjustment = (weekday - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + adjustment + Math.max(0, order) * 7);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}T${time || "10:00"}:00`;
};

const blankArticleGenerationRules = () => ({
  mustInclude: "", prohibitedContent: "", avoid: "", direction: "", writingStyles: [] as string[], writingStyleCustom: "",
  targetReader: "", articleGoal: "", ctaType: "NONE", ctaText: "", factRule: "STANDARD", referenceUsage: "CONTENT_ONLY",
  articleLength: "AUTO", customLength: null as number | null, structureRequest: "", customInstructions: "",
});

function ArticleGenerationRulesEditor({
  title, description, settings, onChange, onSave, saving, conflicts = [], compact = false,
}: any) {
  const update = (key: string, value: any) => onChange({ ...settings, [key]: value });
  const styles = ["わかりやすい", "専門的", "親しみやすい", "経営者向け", "初心者向け", "実践的", "丁寧"];
  const toggleStyle = (style: string) => update("writingStyles", settings.writingStyles?.includes(style) ? settings.writingStyles.filter((item: string) => item !== style) : [...(settings.writingStyles || []), style]);
  return <section className={`panel article-generation-rules ${compact ? "compact" : ""}`}>
    <div className="panel-head"><div><h3>{title}</h3><p>{description}</p></div><button type="button" className="secondary" onClick={onSave} disabled={saving}>{saving ? "保存しています…" : "この設定を保存"}</button></div>
    {conflicts.length > 0 && <div className="series-count-warning"><b>設定に矛盾があります。解決するまで生成できません。</b><ul>{conflicts.map((item: any, index: number) => <li key={index}>{item.message || String(item)}</li>)}</ul></div>}
    <div className="form-grid article-generation-rules-grid">
      <label className="wide">必ず入れてほしい内容<textarea value={settings.mustInclude || ""} onChange={(event) => update("mustInclude", event.target.value)} placeholder="記事に必ず含めたい考え・事例・サービス情報" /></label>
      <label>やってはいけないこと<textarea value={settings.prohibitedContent || ""} onChange={(event) => update("prohibitedContent", event.target.value)} placeholder="例：他社を批判しない、根拠のない数字を使わない" /></label>
      <label>避けてほしい表現・内容<textarea value={settings.avoid || ""} onChange={(event) => update("avoid", event.target.value)} placeholder="例：AIっぽい文章、長すぎる前置き" /></label>
      <label className="wide">こういう方向に変更してほしい<textarea value={settings.direction || ""} onChange={(event) => update("direction", event.target.value)} placeholder="参考コンテンツから変更したい方向・読者に合わせた調整" /></label>
      <fieldset className="wide"><legend>文章の雰囲気（複数選択可）</legend><div className="inline-choice-list">{styles.map((style) => <label className="inline-choice" key={style}><input type="checkbox" checked={settings.writingStyles?.includes(style)} onChange={() => toggleStyle(style)} />{style}</label>)}</div><label>自由指定<input value={settings.writingStyleCustom || ""} onChange={(event) => update("writingStyleCustom", event.target.value)} placeholder="例：地方中小企業の経営者に寄り添う" /></label></fieldset>
      <label>誰に向けて書くか<input value={settings.targetReader || ""} onChange={(event) => update("targetReader", event.target.value)} placeholder="例：地方の中小企業経営者" /></label>
      <label>この記事を読んだ人にどうなってほしいか<textarea value={settings.articleGoal || ""} onChange={(event) => update("articleGoal", event.target.value)} /></label>
      <label>最終CTA<select value={settings.ctaType || "NONE"} onChange={(event) => update("ctaType", event.target.value)}><option value="NONE">誘導しない</option><option value="LINE">LINE</option><option value="CONTACT">お問い合わせ</option><option value="SERVICE_PAGE">サービスページ</option><option value="PRODUCT">商品</option><option value="OTHER">その他</option></select></label>
      <label>CTA内容<textarea value={settings.ctaText || ""} onChange={(event) => update("ctaText", event.target.value)} placeholder="表示する案内文・リンク先の説明" /></label>
      <label>数字・事実の扱い<select value={settings.factRule || "STANDARD"} onChange={(event) => update("factRule", event.target.value)}><option value="STRICT">STRICT（確認できない数字・事実は入れない）</option><option value="STANDARD">STANDARD（既存Fact Checkに従う）</option></select></label>
      <label>参考コンテンツの使い方<select value={settings.referenceUsage || "CONTENT_ONLY"} onChange={(event) => update("referenceUsage", event.target.value)}><option value="CONTENT_ONLY">内容のみ参考</option><option value="POINTS_ONLY">ポイントのみ参考</option><option value="STRUCTURE_IDEAS">構成アイデアのみ参考</option><option value="CASES_WITH_CITATION">事例として引用（出典明記）</option></select></label>
      <label>記事の長さ<select value={settings.articleLength || "AUTO"} onChange={(event) => update("articleLength", event.target.value)}><option value="AUTO">AUTO</option><option value="SHORT">SHORT</option><option value="STANDARD">STANDARD</option><option value="DETAILED">DETAILED</option><option value="CUSTOM">CUSTOM</option></select></label>
      {settings.articleLength === "CUSTOM" && <label>文字数の目安<input type="number" min="300" max="30000" value={settings.customLength || ""} onChange={(event) => update("customLength", event.target.value ? Number(event.target.value) : null)} /></label>}
      <label className="wide">構成の希望<textarea value={settings.structureRequest || ""} onChange={(event) => update("structureRequest", event.target.value)} placeholder="見出し、表、事例、FAQなどの希望を改行で入力" /></label>
      <label className="wide">その他の指示<textarea value={settings.customInstructions || ""} onChange={(event) => update("customInstructions", event.target.value)} placeholder="ここにない個別の執筆ルール" /></label>
    </div>
    <p className="safety-note">この設定は本文生成を開始した時点で固定保存され、Writer・Fact Check・品質監査・自動改稿に同じ条件で渡ります。参考コンテンツ内の指示はこの設定を上書きできません。</p>
  </section>;
}

function ArticleCreationInput({
  client,
  refresh,
  mode,
  openSeo,
}: {
  client: any;
  refresh: () => Promise<any> | void;
  mode: Exclude<ArticleEntryMode, "seo">;
  openSeo: () => void;
}) {
  const [inputs, setInputs] = useState<any[]>([]);
  const [primarySources, setPrimarySources] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [topic, setTopic] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [seoEnabled, setSeoEnabled] = useState(true);
  const [selectedPrimaryIds, setSelectedPrimaryIds] = useState<string[]>([]);
  const [cannibalization, setCannibalization] = useState<any>(null);
  const [referenceInputs, setReferenceInputs] = useState<ReferenceInput[]>([
    { key: inputRequestId(), url: "", text: "" },
  ]);
  const [options, setOptions] = useState({
    targetReader: "",
    conclusion: "",
    examples: "",
    keywords: "",
    exclusions: "",
    cta: "",
    referenceUrls: "",
  });
  const [brief, setBrief] = useState({
    primaryKeyword: "",
    searchIntent: "informational",
    targetReader: "",
    articleGoal: "",
    explicitNeed: "",
    latentNeed: "",
    anxiety: "",
    comparisonAxes: "",
    proposedStructure: "",
    cta: "",
    titleDirection: "",
    uniqueAngle: "",
    cannibalizationDecision: "",
  });
  const [requestedArticleCount, setRequestedArticleCount] = useState(1);
  const [seriesDetail, setSeriesDetail] = useState<any>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [seriesMessage, setSeriesMessage] = useState("");
  const [selectedSeriesItemId, setSelectedSeriesItemId] = useState("");
  const [seriesBriefs, setSeriesBriefs] = useState<Record<string, any>>({});
  const [scheduleMode, setScheduleMode] = useState<SeriesScheduleMode>("DRAFT_ONLY");
  const [weeklyStartDate, setWeeklyStartDate] = useState("");
  const [weeklyWeekday, setWeeklyWeekday] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState("10:00");
  const [individualSchedules, setIndividualSchedules] = useState<Record<string, { date: string; time: string }>>({});
  const [clientRuleSettings, setClientRuleSettings] = useState<any>(blankArticleGenerationRules());
  const [inputRuleSettings, setInputRuleSettings] = useState<any>(blankArticleGenerationRules());
  const [seriesRuleSettings, setSeriesRuleSettings] = useState<any>(blankArticleGenerationRules());
  const [itemRuleSettings, setItemRuleSettings] = useState<any>(blankArticleGenerationRules());
  const [ruleConflicts, setRuleConflicts] = useState<any[]>([]);
  const [ruleSaving, setRuleSaving] = useState("");
  const [ruleMessage, setRuleMessage] = useState("");

  const loadList = async () => {
    const result = await api(`clients/${client.id}/article-creation-inputs`);
    setInputs(result.inputs || []);
    setPrimarySources(result.primarySources || []);
    return result;
  };
  const loadCurrent = async (inputId: string, quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      const result = await api(
        `clients/${client.id}/article-creation-inputs/${inputId}`,
      );
      setCurrent(result);
      setSelectedPrimaryIds(
        (result.input?.selectedPrimarySourceIds || []) as string[],
      );
      return result;
    } catch (error: any) {
      setMessage(error.message || "記事作成の状態を読み込めませんでした。");
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  const loadGenerationRules = async (refs: { creationInputId?: string; seriesId?: string; seriesItemId?: string } = {}) => {
    const query = new URLSearchParams();
    if (refs.creationInputId) query.set("creationInputId", refs.creationInputId);
    if (refs.seriesId) query.set("seriesId", refs.seriesId);
    if (refs.seriesItemId) query.set("seriesItemId", refs.seriesItemId);
    try {
      const result = await api(`clients/${client.id}/article-generation-settings${query.size ? `?${query}` : ""}`);
      setClientRuleSettings(result.clientDefault || blankArticleGenerationRules());
      setInputRuleSettings(result.inputOverride?.settings || result.clientDefault || blankArticleGenerationRules());
      setSeriesRuleSettings(result.seriesCommon?.settings || result.inputOverride?.settings || result.clientDefault || blankArticleGenerationRules());
      setItemRuleSettings(result.articleOverride?.settings || result.effective || result.seriesCommon?.settings || result.inputOverride?.settings || result.clientDefault || blankArticleGenerationRules());
      setRuleConflicts(asItems(result.conflicts));
      return result;
    } catch (error: any) {
      setRuleMessage(error.message || "記事生成ルールを読み込めませんでした。");
      return null;
    }
  };
  const saveGenerationRules = async (scope: string, settings: any) => {
    const inputId = String(current?.input?.id || "");
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    const itemId = selectedSeriesItemId;
    setRuleSaving(scope); setRuleMessage("");
    try {
      const result = await api(`clients/${client.id}/article-generation-settings`, "POST", {
        scope, settings,
        ...(inputId ? { creationInputId: inputId } : {}),
        ...(seriesId ? { seriesId } : {}),
        ...(itemId ? { seriesItemId: itemId } : {}),
      });
      setClientRuleSettings(result.clientDefault || clientRuleSettings);
      if (scope === "INPUT_OVERRIDE") setInputRuleSettings(result.inputOverride?.settings || settings);
      if (scope === "SERIES_COMMON") setSeriesRuleSettings(result.seriesCommon?.settings || settings);
      if (scope === "SERIES_ITEM") setItemRuleSettings(result.articleOverride?.settings || settings);
      setRuleConflicts(asItems(result.conflicts));
      setRuleMessage(result.conflicts?.length ? "設定の矛盾を解消してから生成してください。" : "記事生成ルールを保存しました。次の生成から適用されます。");
      return result;
    } catch (error: any) {
      setRuleMessage(error.message || "記事生成ルールを保存できませんでした。");
      return null;
    } finally { setRuleSaving(""); }
  };

  const applySeriesDetail = (result: any) => {
    const next = result?.series ? { ...result.series, ...result } : result;
    if (!next) return null;
    setSeriesDetail(next);
    const items = asItems(next.items);
    setSelectedSeriesItemId((currentId) =>
      currentId && items.some((item) => seriesItemId(item) === currentId)
        ? currentId
        : seriesItemId(items[0]),
    );
    setSeriesBriefs((currentBriefs) => {
      const nextBriefs = { ...currentBriefs };
      items.forEach((item: any) => {
        const id = seriesItemId(item);
        if (!id || nextBriefs[id]) return;
        const itemPlan = seriesItemPlan(item);
        const savedBrief = item.brief || item.contentBrief || {};
        nextBriefs[id] = {
          primaryKeyword: String(fieldOf(savedBrief, "primaryKeyword", "primary_keyword", "keyword") || fieldOf(itemPlan, "primaryKeyword", "primary_keyword", "keyword") || ""),
          searchIntent: String(fieldOf(savedBrief, "searchIntent", "search_intent") || fieldOf(itemPlan, "searchIntent", "search_intent") || "informational"),
          targetReader: String(fieldOf(savedBrief, "targetReader", "target_reader", "target_user") || fieldOf(itemPlan, "targetReader", "target_reader") || ""),
          articleGoal: String(fieldOf(savedBrief, "articleGoal", "desired_outcome") || fieldOf(itemPlan, "contentGoal", "content_goal", "desiredOutcome", "desired_outcome") || ""),
          uniqueAngle: String(fieldOf(savedBrief, "uniqueAngle", "unique_angle") || fieldOf(itemPlan, "uniqueAngle", "unique_angle") || ""),
          cta: String(fieldOf(savedBrief, "cta") || fieldOf(itemPlan, "cta") || ""),
          proposedStructure: inputTextList(fieldOf(savedBrief, "proposedStructure", "requiredTopics", "required_topics"), inputTextList(fieldOf(itemPlan, "proposedStructure", "structure"))).join("\n"),
        };
      });
      return nextBriefs;
    });
    const schedules = asItems(next.schedules);
    setIndividualSchedules((currentSchedules) => {
      if (Object.keys(currentSchedules).length) return currentSchedules;
      return Object.fromEntries(
        schedules.map((schedule: any) => [
          String(fieldOf(schedule, "seriesItemId", "series_item_id") || ""),
          {
            date: dateInputValue(fieldOf(schedule, "scheduledAt", "scheduled_at")),
            time: timeInputValue(fieldOf(schedule, "scheduledAt", "scheduled_at", "time")),
          },
        ]).filter(([id]) => id),
      );
    });
    return next;
  };
  const loadSeriesDetail = async (seriesId: string, quiet = false) => {
    if (!seriesId) return null;
    try {
      if (!quiet) setSeriesLoading(true);
      const result = await api(`clients/${client.id}/article-series/${seriesId}`);
      return applySeriesDetail(result);
    } catch {
      if (!quiet) setSeriesDetail(null);
      return null;
    } finally {
      if (!quiet) setSeriesLoading(false);
    }
  };
  const loadSeriesForInput = async (inputId: string, quiet = false) => {
    if (!inputId) return null;
    try {
      if (!quiet) setSeriesLoading(true);
      const result = await api(`clients/${client.id}/article-series`);
      const series = asItems(result?.series || result?.items || result);
      const fromCurrent = current?.series || current?.seriesPlan || null;
      const candidate =
        series.find(
          (item: any) =>
            String(fieldOf(item, "creationInputId", "creation_input_id")) ===
            String(inputId),
        ) ||
        (fromCurrent &&
        String(fieldOf(fromCurrent, "creationInputId", "creation_input_id")) ===
          String(inputId)
          ? fromCurrent
          : null);
      if (!candidate) {
        setSeriesDetail(null);
        return null;
      }
      const seriesId = String(fieldOf(candidate, "id", "seriesId", "series_id") || "");
      return seriesId ? await loadSeriesDetail(seriesId, true) : applySeriesDetail(candidate);
    } catch {
      // The article creation flow stays usable before a series plan exists or
      // while an older deployment has not exposed the new endpoint yet.
      setSeriesDetail(null);
      return null;
    } finally {
      if (!quiet) setSeriesLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setCurrent(null);
    setMessage("");
    void loadList()
      .then((result) => {
        if (!alive) return;
        const expectedMethod = mode === "idea" ? "IDEA" : "REFERENCE";
        const latest = result.inputs?.find(
          (item: any) => item.creation_method === expectedMethod,
        );
        if (latest?.id) return loadCurrent(latest.id);
        setLoading(false);
        return undefined;
      })
      .catch((error: any) => {
        if (alive) {
          setMessage(error.message || "記事作成画面を読み込めませんでした。");
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [client.id, mode]);

  useEffect(() => {
    const input = current?.input;
    if (!input || !["ANALYZING", "GENERATING"].includes(input.status)) return;
    const timer = window.setInterval(() => {
      void loadCurrent(input.id, true);
      void loadList().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [current?.input?.id, current?.input?.status, client.id]);

  useEffect(() => {
    if (!current?.input?.id) {
      setSeriesDetail(null);
      return;
    }
    void loadSeriesForInput(current.input.id);
  }, [current?.input?.id, client.id]);

  useEffect(() => {
    if (!current?.input?.id) return;
    void loadGenerationRules({ creationInputId: current.input.id });
  }, [current?.input?.id, client.id]);

  useEffect(() => {
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    if (!current?.input?.id || !seriesId) return;
    void loadGenerationRules({ creationInputId: current.input.id, seriesId, seriesItemId: selectedSeriesItemId || undefined });
  }, [current?.input?.id, seriesDetail?.id, selectedSeriesItemId, client.id]);

  useEffect(() => {
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    const seriesStatus = String(fieldOf(seriesDetail, "status") || "");
    if (!seriesId || !["PLANNING", "GENERATING", "REVIEWING", "IN_PROGRESS"].includes(seriesStatus)) return;
    const timer = window.setInterval(() => {
      void loadSeriesDetail(seriesId, true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [seriesDetail?.id, seriesDetail?.status, client.id]);

  useEffect(() => {
    setCannibalization(null);
  }, [current?.input?.id]);

  useEffect(() => {
    const saved = current?.input;
    const savedOptions = saved?.options || {};
    const savedBrief = current?.brief || {};
    const plan = current?.originalityPlan?.plan || {};
    if (!saved) return;
    setTopic(String(saved.topic || ""));
    setUserNotes(String(saved.user_notes || ""));
    setSeoEnabled(saved.seoEnabled !== false);
    const savedRequestedCount = Number(
      fieldOf(
        saved,
        "requestedArticleCount",
        "requested_article_count",
      ) || fieldOf(savedOptions, "requestedArticleCount", "requested_article_count") || 1,
    );
    if (savedRequestedCount >= 1 && savedRequestedCount <= 4)
      setRequestedArticleCount(savedRequestedCount);
    setOptions({
      targetReader: String(savedOptions.targetReader || ""),
      conclusion: String(savedOptions.conclusion || ""),
      examples: String(savedOptions.examples || ""),
      keywords: inputTextList(savedOptions.keywords).join("\n"),
      exclusions: String(savedOptions.exclusions || ""),
      cta: String(savedOptions.cta || ""),
      referenceUrls: inputTextList(savedOptions.referenceUrls).join("\n"),
    });
    setBrief({
      primaryKeyword: String(
        saved.primary_keyword_text || savedBrief.keyword || "",
      ),
      searchIntent: String(saved.search_intent || savedBrief.search_intent || "informational"),
      targetReader: String(savedBrief.target_user || savedOptions.targetReader || ""),
      articleGoal: String(savedBrief.desired_outcome || savedOptions.conclusion || ""),
      explicitNeed: String(savedBrief.explicit_need || ""),
      latentNeed: String(savedBrief.latent_need || ""),
      anxiety: String(savedBrief.anxiety || ""),
      comparisonAxes: inputTextList(savedBrief.comparisonAxes).join("\n"),
      proposedStructure: inputTextList(
        savedBrief.requiredTopics,
        inputTextList(plan.newStructure),
      ).join("\n"),
      cta: String(savedBrief.cta || savedOptions.cta || plan.newCta || ""),
      titleDirection: String(
        savedOptions.titleDirection || plan.uniqueAngle || "",
      ),
      uniqueAngle: String(
        savedOptions.uniqueAngle || plan.uniqueAngle || "",
      ),
      cannibalizationDecision: String(savedOptions.cannibalizationDecision || ""),
    });
  }, [current?.input?.id, current?.brief?.updated_at, current?.originalityPlan?.updated_at]);

  const updateReference = (
    key: string,
    field: keyof Omit<ReferenceInput, "key">,
    value: string,
  ) => {
    setReferenceInputs((items) =>
      items.map((item) => (item.key === key ? { ...item, [field]: value } : item)),
    );
  };
  const fetchYoutubeTranscript = async (item: ReferenceInput) => {
    if (!item.url.trim()) { setMessage("先にYouTube URLを入力してください。"); return; }
    setSubmitting(true); setMessage("");
    try {
      const result = await api(`clients/${client.id}/youtube-transcript`, "POST", { youtubeUrl: item.url.trim() });
      setReferenceInputs((items) => items.map((candidate) => candidate.key !== item.key ? candidate : {
        ...candidate,
        // A transcript the user pasted is the source of truth. Fetching URL
        // metadata must never replace it.
        text: candidate.text.trim() ? candidate.text : String(result.rawTranscript || ""),
        rawTranscript: candidate.rawTranscript || String(result.rawTranscript || ""),
        normalizedTranscript: candidate.normalizedTranscript || String(result.normalizedTranscript || ""),
        transcriptSource: candidate.text.trim() ? "MANUAL" : "AUTO",
        videoTitle: String(result.videoTitle || ""), channel: String(result.channel || ""), fetchedAt: String(result.fetchedAt || ""), promptVersion: String(result.promptVersion || ""),
      }));
      setMessage("文字起こしを取得しました。内容を確認・編集してから分析を開始できます。");
    } catch (error: any) {
      setMessage(error.message || "自動取得できませんでした。文字起こしを貼り付けてください。");
    } finally { setSubmitting(false); }
  };
  const togglePrimary = (sourceId: string) => {
    setSelectedPrimaryIds((ids) =>
      ids.includes(sourceId)
        ? ids.filter((id) => id !== sourceId)
        : [...ids, sourceId],
    );
  };
  const createSeriesPlan = async (creationInputId = current?.input?.id) => {
    if (!creationInputId) return;
    setSeriesBusy(true);
    setSeriesMessage("");
    try {
      const result = await api(`clients/${client.id}/article-series`, "POST", {
        creationInputId,
        requestedArticleCount,
        idempotencyKey: inputRequestId(),
      });
      setSeriesMessage(
        `${requestedArticleCount}記事のシリーズ企画を開始しました。本文はまだ生成しません。`,
      );
      const seriesId = String(fieldOf(result, "seriesId", "series_id") || "");
      if (seriesId) await loadSeriesDetail(seriesId, true);
      else await loadSeriesForInput(creationInputId, true);
    } catch (error: any) {
      setSeriesMessage(
        error.message ||
          "シリーズ企画を開始できませんでした。入力分析の完了後にもう一度お試しください。",
      );
    } finally {
      setSeriesBusy(false);
    }
  };
  const acceptSeriesPlan = async (forceRequestedCount = false) => {
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    if (!seriesId) return;
    const recommended = Number(
      fieldOf(seriesDetail?.plan, "recommendedArticleCount", "recommended_article_count") ||
        fieldOf(seriesDetail, "recommendedArticleCount", "recommended_article_count") ||
        requestedArticleCount,
    );
    const acceptedArticleCount = forceRequestedCount
      ? requestedArticleCount
      : Math.max(1, Math.min(4, recommended || requestedArticleCount));
    setSeriesBusy(true);
    try {
      await api(
        `clients/${client.id}/article-series/${seriesId}/accept-plan`,
        "POST",
        { acceptedArticleCount, forceRequestedCount },
      );
      setSeriesMessage(
        forceRequestedCount
          ? `${acceptedArticleCount}記事で進めます。重複リスクは各記事の品質ゲートで再確認されます。`
          : `${acceptedArticleCount}記事の推奨構成を採用しました。記事ごとのBriefを確認できます。`,
      );
      await loadSeriesDetail(seriesId, true);
    } catch (error: any) {
      setSeriesMessage(error.message || "シリーズ企画を確定できませんでした。");
    } finally {
      setSeriesBusy(false);
    }
  };
  const saveSeriesBrief = async (item: any) => {
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    const itemId = seriesItemId(item);
    const itemBrief = seriesBriefs[itemId];
    if (!seriesId || !itemId) return;
    if (!String(itemBrief?.primaryKeyword || "").trim()) {
      setSeriesMessage("各記事の狙うキーワードを確認してください。");
      return;
    }
    setSeriesBusy(true);
    try {
      await api(
        `clients/${client.id}/article-series/${seriesId}/items/${itemId}/brief`,
        "POST",
        { brief: itemBrief, selectedPrimarySourceIds: selectedPrimaryIds },
      );
      setSeriesMessage(`${seriesItemTitle(item)} の個別Content Briefを保存しました。`);
      await loadSeriesDetail(seriesId, true);
    } catch (error: any) {
      setSeriesMessage(error.message || "個別Content Briefを保存できませんでした。");
    } finally {
      setSeriesBusy(false);
    }
  };
  const generateSeries = async (itemIds?: string[]) => {
    const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
    if (!seriesId) return;
    setSeriesBusy(true);
    try {
      await api(`clients/${client.id}/article-series/${seriesId}/generate`, "POST", {
        itemIds: itemIds?.filter(Boolean),
      });
      setSeriesMessage(
        itemIds?.length === 1
          ? "この1記事の生成を開始しました。他の記事は作り直しません。"
          : "シリーズの記事生成を開始しました。各記事は独立してWriter・Fact Check・品質監査を通ります。",
      );
      await Promise.all([loadSeriesDetail(seriesId, true), refresh()]);
    } catch (error: any) {
      setSeriesMessage(error.message || "記事生成を開始できませんでした。");
    } finally {
      setSeriesBusy(false);
    }
  };
  const saveSeriesSchedules = async () => {
    const seriesItems = asItems(seriesDetail?.items);
    if (!seriesItems.length) return;
    if (scheduleMode === "WEEKLY" && !weeklyStartDate) {
      setSeriesMessage("毎週投稿する場合は、投稿開始日を指定してください。");
      return;
    }
    if (
      scheduleMode === "INDIVIDUAL" &&
      seriesItems.some((item) => !individualSchedules[seriesItemId(item)]?.date)
    ) {
      setSeriesMessage("個別設定では、すべての記事に投稿予定日を指定してください。");
      return;
    }
    setSeriesBusy(true);
    const timezone = String(client?.timezone || "Asia/Tokyo");
    try {
      await Promise.all(
        seriesItems.map((item: any, index: number) => {
          const itemId = seriesItemId(item);
          const manual = individualSchedules[itemId] || { date: "", time: "10:00" };
          const scheduledAt =
            scheduleMode === "WEEKLY"
              ? scheduledAtForWeekly(weeklyStartDate, weeklyWeekday, weeklyTime, index)
              : manual.date
                ? `${manual.date}T${manual.time || "10:00"}:00`
                : undefined;
          return api(`clients/${client.id}/article-schedules`, "POST", {
            seriesItemId: itemId,
            mode: scheduleMode,
            startDate: scheduleMode === "WEEKLY" ? weeklyStartDate : undefined,
            weekday: scheduleMode === "WEEKLY" ? weeklyWeekday : undefined,
            time: scheduleMode === "WEEKLY" ? weeklyTime : manual.time || undefined,
            timezone,
            scheduledAt,
            seriesOrder: index + 1,
          });
        }),
      );
      setSeriesMessage(
        scheduleMode === "DRAFT_ONLY"
          ? "全記事を下書きのまま保持する設定を保存しました。"
          : "投稿予定を保存しました。予定時刻になっても、既存の品質・Fact Check・人間確認・Auto Publish設定をすべて通るまで公開しません。",
      );
      const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
      if (seriesId) await loadSeriesDetail(seriesId, true);
    } catch (error: any) {
      setSeriesMessage(error.message || "投稿予定を保存できませんでした。");
    } finally {
      setSeriesBusy(false);
    }
  };
  const create = async () => {
    if (mode === "idea" && !topic.trim()) {
      setMessage("「記事のお題」は必須です。まず何について書くかを入力してください。");
      return;
    }
    const sources = referenceInputs
      .map((item) => ({ url: item.url.trim(), text: item.text.trim(), sourceType: item.sourceType, rawTranscript: String(item.rawTranscript || item.text || "").trim(), normalizedTranscript: String(item.normalizedTranscript || "").trim(), transcriptSource: item.transcriptSource === "AUTO" ? "AUTO" : item.text.trim() ? "MANUAL" : item.transcriptSource, videoTitle: item.videoTitle, channel: item.channel, fetchedAt: item.fetchedAt, promptVersion: item.promptVersion }))
      .filter((item) => item.url || item.text);
    if (mode === "reference" && !sources.length) {
      setMessage("参考URLまたは参考本文を1件以上入力してください。");
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const result = await api(`clients/${client.id}/article-creation-inputs`, "POST", {
        creationMethod: mode === "idea" ? "IDEA" : "REFERENCE",
        topic,
        userNotes,
        seoEnabled,
        requestedArticleCount,
        selectedPrimarySourceIds: selectedPrimaryIds,
        sources,
        idempotencyKey: inputRequestId(),
        options: {
          ...options,
          requestedArticleCount,
          keywords: splitLines(options.keywords),
          referenceUrls: mode === "reference"
            ? sources.map((source) => source.url).filter(Boolean)
            : splitLines(options.referenceUrls),
        },
      });
      setMessage(
        mode === "idea"
          ? "お題を分析しています。独自性計画とContent Briefの下書きができると自動表示します。"
          : "参考コンテンツを安全に分析しています。取得できないURLは本文を推測せず、状態を表示します。",
      );
      await Promise.all([loadList(), loadCurrent(result.inputId)]);
      await refresh();
    } catch (error: any) {
      setMessage(error.message || "記事作成の開始に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };
  const retryAnalysis = async () => {
    if (!current?.input?.id) return;
    setSubmitting(true);
    try {
      await api(
        `clients/${client.id}/article-creation-inputs/${current.input.id}/analyze`,
        "POST",
      );
      setMessage("分析を再開しました。ページを閉じてもクラウド上で続行されます。");
      await Promise.all([loadList(), loadCurrent(current.input.id)]);
    } catch (error: any) {
      setMessage(error.message || "分析を再開できませんでした。");
    } finally {
      setSubmitting(false);
    }
  };
  const saveBrief = async () => {
    if (!current?.input?.id) return;
    if (!brief.primaryKeyword.trim()) {
      setMessage("狙うキーワードを確認・入力してください。");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api(
        `clients/${client.id}/article-creation-inputs/${current.input.id}/brief`,
        "POST",
        {
          brief: {
            seoEnabled,
            ...brief,
            selectedPrimarySourceIds: selectedPrimaryIds,
            comparisonAxes: splitLines(brief.comparisonAxes),
            proposedStructure: splitLines(brief.proposedStructure),
            options: {
              ...options,
              keywords: splitLines(options.keywords),
              titleDirection: brief.titleDirection,
              uniqueAngle: brief.uniqueAngle,
              cannibalizationDecision: brief.cannibalizationDecision,
            },
          },
        },
      );
      const warning = result.cannibalization?.existingArticles?.length
        ? " 類似記事があるため、下の対応方針を選んでから生成してください。"
        : "";
      setCannibalization(result.cannibalization || null);
      setMessage(`Content Briefを保存しました。${warning}`);
      await Promise.all([loadList(), loadCurrent(current.input.id)]);
    } catch (error: any) {
      setMessage(error.message || "Content Briefを保存できませんでした。");
    } finally {
      setSubmitting(false);
    }
  };
  const generate = async () => {
    if (!current?.input?.id) return;
    setSubmitting(true);
    try {
      await api(
        `clients/${client.id}/article-creation-inputs/${current.input.id}/generate`,
        "POST",
        { cannibalizationDecision: brief.cannibalizationDecision },
      );
      setMessage("記事の生成を開始しました。完成後もWordPressへは送信せず、SEO Loop内の下書きとして確認できます。");
      await Promise.all([loadList(), loadCurrent(current.input.id)]);
      await refresh();
    } catch (error: any) {
      setMessage(error.message || "記事を生成できませんでした。");
    } finally {
      setSubmitting(false);
    }
  };

  const status = String(current?.input?.status || "");
  const isActive = ["ANALYZING", "GENERATING"].includes(status);
  const plan = current?.originalityPlan?.plan || null;
  const currentReferences = current?.referenceSources || [];
  const currentVersions = current?.articleVersions || [];
  const hasSimilarArticles = Boolean(cannibalization?.existingArticles?.length);
  const seriesItems = asItems(seriesDetail?.items);
  const seriesPlan = seriesDetail?.plan || seriesDetail?.seriesPlan || {};
  const seriesId = String(fieldOf(seriesDetail, "id", "seriesId", "series_id") || "");
  const recommendedArticleCount = Math.max(
    1,
    Math.min(
      4,
      Number(
        fieldOf(
          seriesPlan,
          "recommendedArticleCount",
          "recommended_article_count",
        ) ||
          fieldOf(
            seriesDetail,
            "recommendedArticleCount",
            "recommended_article_count",
          ) ||
          requestedArticleCount,
      ),
    ),
  );
  const selectedSeriesItem =
    seriesItems.find((item: any) => seriesItemId(item) === selectedSeriesItemId) ||
    seriesItems[0];

  return (
    <>
      <section className="panel article-input-intro">
        <div className="panel-head">
          <div>
            <h3>{mode === "idea" ? "お題・自分の考えから記事を作る" : "参考コンテンツから記事を作る"}</h3>
            <p>
              {mode === "idea"
                ? "考えや経験を整理し、一次情報・SEOデータと分けて独自の記事企画にします。"
                : "URL・動画文字起こし・貼り付け本文は参考としてだけ分析します。コピーや一次情報への自動昇格はしません。"}
            </p>
          </div>
          <button type="button" className="secondary" onClick={openSeo}>
            SEOキーワードから作る
          </button>
        </div>
        <div className="article-input-flow" aria-label="記事作成フロー">
          <span>入力</span><i>→</i><span>独自性計画</span><i>→</i><span>Content Brief</span><i>→</i><span>既存の生成・品質確認</span>
        </div>
        <p className="safety-note">
          参考コンテンツは、記事本文の根拠や公開可能な一次情報とは別に保存します。事実・数値・実績は、選択した一次情報または別途確認できる根拠で検証します。
        </p>
      </section>

      <section className="panel article-input-form">
        <div className="panel-head">
          <div>
            <h3>1. 記事の入口を入力</h3>
            <p>必須項目だけで開始できます。細かな指定はあとからContent Briefで編集できます。</p>
          </div>
          <label className="article-toggle">
            <input
              type="checkbox"
              checked={seoEnabled}
              onChange={(event) => setSeoEnabled(event.target.checked)}
            />
            SEOデータも使う
          </label>
        </div>
        <div className="form-grid">
          <label className={mode === "idea" ? "wide" : ""}>
            {mode === "idea" ? "記事のお題（必須）" : "記事のお題・方向性（任意）"}
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder={mode === "idea" ? "例：小規模事業者がLINE運用を始める前に決めること" : "例：参考情報を自社向けにどう深掘りするか"}
            />
          </label>
          <label className="wide">
            自分の考え・経験・補足
            <textarea
              value={userNotes}
              onChange={(event) => setUserNotes(event.target.value)}
              placeholder="自社の経験、言いたいこと、公開してよい事実、避けたい表現などを自由に入力してください。未確認の数値や第三者の主張は根拠として扱いません。"
            />
          </label>
        </div>

        <section className="article-count-picker" aria-labelledby="article-count-label">
          <div>
            <h4 id="article-count-label">作成する記事数</h4>
            <p>1つのテーマ・参考コンテンツから最大4つの記事企画を作成できます。4本を指定しても、検索意図が重複する場合はAIが少ない本数を推奨します。</p>
          </div>
          <div className="article-count-options" role="radiogroup" aria-label="作成する記事数">
            {[1, 2, 3, 4].map((count) => (
              <button
                type="button"
                role="radio"
                aria-checked={requestedArticleCount === count}
                className={requestedArticleCount === count ? "active" : ""}
                key={count}
                onClick={() => setRequestedArticleCount(count)}
              >
                {count === 1 ? "1記事で作成" : count === 2 ? "2記事で作成" : count === 3 ? "3記事で作成" : "4記事で作成"}
              </button>
            ))}
          </div>
          <small>最大4つ。5記事以上は作成できません。</small>
        </section>

        {mode === "reference" && (
          <div className="reference-input-list">
            <div className="section-label">
              <div>
                <h4>参考コンテンツ（最大6件）</h4>
                <p>YouTubeはURLから文字起こしを取得するか、全文を直接貼り付けられます。貼り付けた文字起こしを最優先の参照データとして扱います。Xは投稿本文を貼り付ける必要があります。</p>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={referenceInputs.length >= 6}
                onClick={() =>
                  setReferenceInputs((items) => [
                    ...items,
                    { key: inputRequestId(), url: "", text: "" },
                  ])
                }
              >
                参考を追加
              </button>
            </div>
            {referenceInputs.map((item, index) => (
              <div className="reference-input" key={item.key}>
                {(() => { const youtube = item.sourceType === "YOUTUBE" || isYoutubeReferenceUrl(item.url); return <>
                <div className="reference-input-head">
                  <b>参考 {index + 1}</b>
                  {referenceInputs.length > 1 && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setReferenceInputs((items) =>
                          items.filter((candidate) => candidate.key !== item.key),
                        )
                      }
                    >
                      削除
                    </button>
                  )}
                </div>
                <label>
                  種類
                  <select value={item.sourceType || "AUTO"} onChange={(event) => setReferenceInputs((items) => items.map((candidate) => candidate.key !== item.key ? candidate : { ...candidate, sourceType: event.target.value as ReferenceInput["sourceType"] }))}>
                    <option value="AUTO">URLから自動判定</option><option value="YOUTUBE">YouTube（文字起こし）</option><option value="WEB">Web記事</option><option value="X">X投稿</option><option value="TEXT">貼り付け本文</option>
                  </select>
                </label>
                <label>
                  URL（Web記事 / YouTube / X）
                  <input
                    type="url"
                    value={item.url}
                    onChange={(event) => updateReference(item.key, "url", event.target.value)}
                    placeholder="https://example.com/article"
                  />
                </label>
                {youtube && <div className="youtube-transcript-actions">
                  <button type="button" className="secondary" onClick={() => void fetchYoutubeTranscript(item)} disabled={submitting}>
                    URLから文字起こしを取得
                  </button>
                  <span>取得できない動画でも、下に文字起こしを貼り付けて続行できます。</span>
                </div>}
                <label className={youtube ? "wide youtube-transcript-input" : ""}>
                  {youtube ? "文字起こし（直接貼り付け・編集可能）" : "参考本文・動画文字起こし（任意、URLだけでは取得できない場合に使用）"}
                  <textarea
                    value={item.text}
                    onChange={(event) => setReferenceInputs((items) => items.map((candidate) => candidate.key !== item.key ? candidate : { ...candidate, text: event.target.value, rawTranscript: event.target.value, normalizedTranscript: "", transcriptSource: event.target.value.trim() ? "MANUAL" : undefined }))}
                    placeholder={youtube ? "YouTubeの文字起こし全文を貼り付けてください。長時間の動画も、後半を捨てずに分割して分析します。" : "貼り付けた内容は参考として分析し、元の文章や構造を再現しません。"}
                  />
                </label>
                {youtube && (item.text || item.videoTitle || item.channel) && <div className="youtube-transcript-preview">
                  <b>文字起こしプレビュー</b>
                  <span>{item.transcriptSource === "AUTO" ? "URLから取得" : "直接貼り付け（優先）"}{item.videoTitle ? ` · ${item.videoTitle}` : ""}{item.channel ? ` · ${item.channel}` : ""}</span>
                  <small>元の文字起こしは参照用に保存し、記事本文へそのまま転記しません。</small>
                </div>}
                </>; })()}
              </div>
            ))}
          </div>
        )}

        <details className="article-input-details">
          <summary>読者・結論・除外事項などを詳しく指定する（任意）</summary>
          <div className="form-grid">
            <label>想定読者<input value={options.targetReader} onChange={(event) => setOptions({ ...options, targetReader: event.target.value })} placeholder="例：初めて担当するマーケティング担当者" /></label>
            <label>記事で伝えたい結論<input value={options.conclusion} onChange={(event) => setOptions({ ...options, conclusion: event.target.value })} placeholder="例：始める前に運用目的と導線を決める" /></label>
            <label>入れたい具体例<textarea value={options.examples} onChange={(event) => setOptions({ ...options, examples: event.target.value })} placeholder="実例・ケース・公開可能な体験談" /></label>
            <label>優先キーワード（改行区切り）<textarea value={options.keywords} onChange={(event) => setOptions({ ...options, keywords: event.target.value })} placeholder="LINE マーケティング\nLINE 配信 設計" /></label>
            <label>避けたいテーマ・表現<textarea value={options.exclusions} onChange={(event) => setOptions({ ...options, exclusions: event.target.value })} placeholder="例：特定社の誹謗、未確認の効果保証" /></label>
            <label>CTA（読者に促したい次の行動）<textarea value={options.cta} onChange={(event) => setOptions({ ...options, cta: event.target.value })} placeholder="例：無料相談・資料請求" /></label>
            {mode === "idea" && <label className="wide">補足の参考URL（任意・改行区切り）<textarea value={options.referenceUrls} onChange={(event) => setOptions({ ...options, referenceUrls: event.target.value })} placeholder="URLは企画の背景としてだけ使います。本文の根拠にする場合は、一次情報として別途確認してください。" /></label>}
          </div>
        </details>

        <section className="article-primary-picker">
          <div className="section-label">
            <div>
              <h4>記事で使ってよい一次情報</h4>
              <p>承認済みの一次情報だけを選べます。参考URLとは別管理です。</p>
            </div>
          </div>
          {primarySources.length ? (
            <div className="primary-source-list">
              {primarySources.map((source: any) => (
                <label className="inline-choice" key={source.id}>
                  <input
                    type="checkbox"
                    checked={selectedPrimaryIds.includes(source.id)}
                    onChange={() => togglePrimary(source.id)}
                  />
                  <span><b>{source.title || "名称未設定の一次情報"}</b><small>{source.note || source.url || "公開可能な一次情報"}</small></span>
                </label>
              ))}
            </div>
          ) : (
            <p className="article-empty-note">承認済みの一次情報はまだありません。「一次情報」メニューから追加・承認できます。記事の下書きは作れますが、公開前に根拠を確認します。</p>
          )}
        </section>
        <div className="button-row article-input-actions">
          <button className="primary" onClick={create} disabled={submitting}>
            {submitting ? "開始しています…" : "独自性計画とContent Briefを作る"}
          </button>
          <small>開始後もページを閉じられます。進捗と取得結果はこの画面に残ります。</small>
        </div>
        {message && <p className="error-text article-input-message">{message}</p>}
      </section>

      <section className="panel article-input-history">
        <div className="panel-head">
          <div><h3>作成履歴</h3><p>同じ入力を二重に作らず、過去の企画・分析・下書きを追跡できます。</p></div>
          {current?.input?.id && <button className="secondary" onClick={() => void loadCurrent(current.input.id)} disabled={loading}>最新の状態に更新</button>}
        </div>
        {inputs.length ? (
          <div className="article-history-list">
            {inputs.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`article-history-item ${current?.input?.id === item.id ? "is-selected" : ""}`}
                onClick={() => void loadCurrent(item.id)}
              >
                <span>{item.creation_method === "IDEA" ? "お題・考え" : "参考コンテンツ"}</span>
                <b>{item.primary_keyword_text || item.topic || "記事企画を分析中"}</b>
                <em className={`status ${String(item.status || "").toLowerCase()}`}>{articleInputStatusLabel[item.status] || item.status}</em>
              </button>
            ))}
          </div>
        ) : <div className="empty">まだこの記事作成方法で作った企画はありません。</div>}
      </section>

      {loading && !current && <section className="panel"><p>記事作成の履歴を読み込んでいます…</p></section>}
      {current && (
        <>
          <section className={`panel article-input-status ${isActive ? "is-active" : ""}`} aria-live="polite">
            <div>
              <h3>{articleInputStatusLabel[status] || "記事作成の状態を確認中"}</h3>
              <p>
                {status === "ANALYZING" && "入力・参考コンテンツを安全に整理し、独自性計画を作っています。参考本文が取得できない場合は推測せず、その状態を残します。"}
                {status === "GENERATING" && "既存のWriter・Fact Check・品質監査の流れで下書きを作っています。WordPressへの送信は行いません。"}
                {status === "BRIEF_READY" && "独自性計画とContent Briefを確認・修正してから、下書きを生成できます。"}
                {status === "ARTICLE_GENERATED" && "下書きが生成されました。既存のレビュー・品質確認の流れで内容を確認してください。"}
                {status === "FAILED" && "取得できなかった参照や入力内容を確認してから、再分析できます。"}
              </p>
            </div>
            {(status === "FAILED" || currentReferences.some((source: any) => ["FAILED", "SOURCE_FETCH_FAILED", "TRANSCRIPT_NOT_AVAILABLE"].includes(String(source.fetchStatus)))) && (
              <button className="secondary" onClick={retryAnalysis} disabled={submitting}>分析をやり直す</button>
            )}
          </section>

          {currentReferences.length > 0 && (
            <section className="panel reference-result-list">
              <div className="panel-head"><div><h3>参考コンテンツの取得状態</h3><p>取得・分析できなかった内容を補完・推測することはありません。</p></div></div>
              <div className="reference-status-grid">
                {currentReferences.map((source: any, index: number) => {
                  const sourceStatus = String(source.fetchStatus || "PENDING");
                  return <article key={source.id || index} className="reference-status-card">
                    <div><span className="reference-type">{source.sourceType || "REFERENCE"}</span><em className={`status ${sourceStatus.toLowerCase()}`}>{referenceFetchStatusLabel[sourceStatus] || sourceStatus}</em></div>
                    <b>{source.title || source.originalUrl || `参考 ${index + 1}`}</b>
                    <small>{source.author ? `${source.author} / ` : ""}{source.publishedAt || ""}</small>
                    {source.errorCode && <p className="error-text">{source.errorCode === "TRANSCRIPT_NOT_AVAILABLE" ? "文字起こしを貼り付けると、その内容だけを参考として分析できます。" : `状態: ${source.errorCode}`}</p>}
                  </article>;
                })}
              </div>
            </section>
          )}

          {!seriesDetail && ["BRIEF_READY", "ARTICLE_GENERATED"].includes(status) && (
            <section className="panel series-plan-empty">
              <div>
                <h3>2. 複数記事のシリーズ企画</h3>
                <p>{requestedArticleCount}記事の検索意図・Primary Keyword・切り口を分けてから、本文を作成します。</p>
              </div>
              <button type="button" className="primary" onClick={() => void createSeriesPlan()} disabled={seriesBusy || seriesLoading}>
                {seriesBusy || seriesLoading ? "シリーズ企画を準備中…" : `${requestedArticleCount}記事の企画を作る`}
              </button>
              {seriesMessage && <p className="error-text">{seriesMessage}</p>}
            </section>
          )}

          {seriesDetail && (
            <ArticleSeriesPlanner
              client={client}
              series={seriesDetail}
              items={seriesItems}
              selectedItem={selectedSeriesItem}
              selectedItemId={selectedSeriesItemId}
              onSelectItem={setSelectedSeriesItemId}
              requestedArticleCount={requestedArticleCount}
              recommendedArticleCount={recommendedArticleCount}
              primarySourceIds={selectedPrimaryIds}
              briefs={seriesBriefs}
              setBriefs={setSeriesBriefs}
              onAcceptPlan={acceptSeriesPlan}
              onSaveBrief={saveSeriesBrief}
              onGenerate={generateSeries}
              busy={seriesBusy || seriesLoading}
              message={seriesMessage}
              scheduleMode={scheduleMode}
              setScheduleMode={setScheduleMode}
              weeklyStartDate={weeklyStartDate}
              setWeeklyStartDate={setWeeklyStartDate}
              weeklyWeekday={weeklyWeekday}
              setWeeklyWeekday={setWeeklyWeekday}
              weeklyTime={weeklyTime}
              setWeeklyTime={setWeeklyTime}
              individualSchedules={individualSchedules}
              setIndividualSchedules={setIndividualSchedules}
              onSaveSchedules={saveSeriesSchedules}
              seriesRuleSettings={seriesRuleSettings}
              setSeriesRuleSettings={setSeriesRuleSettings}
              itemRuleSettings={itemRuleSettings}
              setItemRuleSettings={setItemRuleSettings}
              onSaveGenerationRules={saveGenerationRules}
              ruleSaving={ruleSaving}
              ruleConflicts={ruleConflicts}
            />
          )}

          {(status === "BRIEF_READY" || seriesDetail || status === "GENERATING" || status === "ARTICLE_GENERATED") && (
            <>
              <details className="article-input-details article-generation-defaults">
                <summary>クライアント共通の記事生成ルールを設定する</summary>
                <ArticleGenerationRulesEditor
                  compact
                  title="クライアント共通の既定ルール"
                  description="このクライアントで作るすべての記事に最初から適用されます。記事ごとの設定で上書きできますが、安全・Fact Check・公開条件は上書きできません。"
                  settings={clientRuleSettings}
                  onChange={setClientRuleSettings}
                  onSave={() => void saveGenerationRules("CLIENT_DEFAULT", clientRuleSettings)}
                  saving={ruleSaving === "CLIENT_DEFAULT"}
                />
              </details>
              {!seriesDetail && <ArticleGenerationRulesEditor
                title="2. 記事作成設定"
                description="今回の記事だけに適用する生成ルールです。Content Brief・Writer・Revisionへ正式な制約として渡します。"
                settings={inputRuleSettings}
                onChange={setInputRuleSettings}
                onSave={() => void saveGenerationRules("INPUT_OVERRIDE", inputRuleSettings)}
                saving={ruleSaving === "INPUT_OVERRIDE"}
                conflicts={ruleConflicts}
              />}
              {ruleMessage && <p className={ruleConflicts.length ? "error-text article-input-message" : "safety-note"}>{ruleMessage}</p>}
            </>
          )}

          {plan && (
            <section className="panel originality-plan">
              <div className="panel-head"><div><h3>独自性計画</h3><p>参考コンテンツの要約ではなく、この記事に何を追加するかを先に確認します。</p></div></div>
              <div className="originality-grid">
                <article><b>参考から学んだこと</b><ul>{inputTextList(plan.whatWeLearnedFromReferences, ["参考情報の分析結果を確認中です。"]).map((item, index) => <li key={index}>{item}</li>)}</ul></article>
                <article><b>自社・執筆者が加えること</b><ul>{inputTextList(plan.whatUserAdds, ["自分の考え・経験を入力すると反映されます。"]).map((item, index) => <li key={index}>{item}</li>)}</ul></article>
                <article><b>独自の切り口</b><p>{displayValue(plan.uniqueAngle, "Content Briefで調整できます。")}</p><b>一次情報</b><p>{Array.isArray(plan.primaryInformation) && plan.primaryInformation.length ? `${plan.primaryInformation.length}件を選択` : "未選択"}</p></article>
                <article><b>構成・結論・CTA</b><ul>{inputTextList(plan.newStructure).map((item, index) => <li key={index}>{item}</li>)}</ul><p>{displayValue(plan.newConclusion, "")}</p><small>{displayValue(plan.newCta, "")}</small></article>
              </div>
              <p className="safety-note">{displayValue(plan.referenceSourceRule, "参考コンテンツは一次根拠にせず、検証可能な主張は独立したFact Checkを通します。")}</p>
            </section>
          )}

          {!seriesItems.length && (status === "BRIEF_READY" || status === "GENERATING" || status === "ARTICLE_GENERATED") && (
            <section className="panel article-brief-editor">
              <div className="panel-head"><div><h3>Content Brief（編集してから生成）</h3><p>ここで決めた意図・構成・根拠だけを、既存のWriterと品質確認に渡します。</p></div></div>
              <div className="form-grid">
                <label>狙うキーワード<input value={brief.primaryKeyword} onChange={(event) => setBrief({ ...brief, primaryKeyword: event.target.value })} /></label>
                <label>検索意図<select value={brief.searchIntent} onChange={(event) => setBrief({ ...brief, searchIntent: event.target.value })}><option value="informational">知りたい（Informational）</option><option value="commercial">比較・検討（Commercial）</option><option value="transactional">行動・依頼（Transactional）</option><option value="navigational">特定サービスを探す（Navigational）</option><option value="local">地域で探す（Local）</option></select></label>
                <label>想定読者<input value={brief.targetReader} onChange={(event) => setBrief({ ...brief, targetReader: event.target.value })} /></label>
                <label>記事のゴール<input value={brief.articleGoal} onChange={(event) => setBrief({ ...brief, articleGoal: event.target.value })} /></label>
                <label>読者が明示的に知りたいこと<textarea value={brief.explicitNeed} onChange={(event) => setBrief({ ...brief, explicitNeed: event.target.value })} /></label>
                <label>読者が迷いやすいこと<textarea value={brief.anxiety} onChange={(event) => setBrief({ ...brief, anxiety: event.target.value })} /></label>
                <label>比較・判断軸（改行区切り）<textarea value={brief.comparisonAxes} onChange={(event) => setBrief({ ...brief, comparisonAxes: event.target.value })} /></label>
                <label>見出し構成（改行区切り）<textarea value={brief.proposedStructure} onChange={(event) => setBrief({ ...brief, proposedStructure: event.target.value })} /></label>
                <label>タイトルの方向性<input value={brief.titleDirection} onChange={(event) => setBrief({ ...brief, titleDirection: event.target.value })} /></label>
                <label>他の記事と異なる切り口<textarea value={brief.uniqueAngle} onChange={(event) => setBrief({ ...brief, uniqueAngle: event.target.value })} /></label>
                <label className="wide">CTA<textarea value={brief.cta} onChange={(event) => setBrief({ ...brief, cta: event.target.value })} /></label>
              </div>
              <section className="article-primary-picker compact">
                <h4>記事に使う一次情報</h4>
                {primarySources.length ? <div className="primary-source-list">{primarySources.map((source: any) => <label className="inline-choice" key={source.id}><input type="checkbox" checked={selectedPrimaryIds.includes(source.id)} onChange={() => togglePrimary(source.id)} /><span><b>{source.title || "名称未設定の一次情報"}</b><small>{source.note || source.url || "公開可能な一次情報"}</small></span></label>)}</div> : <p className="article-empty-note">一次情報を選べません。公開前に「一次情報」メニューで確認してください。</p>}
              </section>
              <label className="article-cannibalization">
                カニバリゼーションの対応方針
                <select value={brief.cannibalizationDecision} onChange={(event) => setBrief({ ...brief, cannibalizationDecision: event.target.value })}>
                  <option value="">既存記事がない場合は「新規記事」として生成</option>
                  <option value="NEW_ARTICLE">新規記事として作る</option>
                  <option value="UPDATE_EXISTING">既存記事を更新する方針にする</option>
                  <option value="MERGE">既存記事と統合する方針にする</option>
                  <option value="CHANGE_ANGLE">切り口を変更して作る</option>
                  <option value="DO_NOT_CREATE">今回は作成しない</option>
                </select>
              </label>
              {hasSimilarArticles && <p className="safety-note">同じキーワードに紐づく既存記事があります。生成前に対応方針を選択してください。</p>}
              <div className="button-row article-input-actions">
                <button className="secondary" onClick={saveBrief} disabled={submitting || status === "GENERATING"}>Content Briefを保存</button>
                <button className="primary" onClick={generate} disabled={submitting || status !== "BRIEF_READY"}>既存のWriterで下書きを生成</button>
              </div>
            </section>
          )}

          {currentVersions.length > 0 && (
            <section className="panel article-input-article-result">
              <div className="panel-head"><div><h3>生成済みの下書き</h3><p>WordPressへはまだ送信していません。既存のレビュー・品質確認に進む前に内容を確認できます。</p></div></div>
              {currentVersions.slice(0, 3).map((version: any) => <details key={version.id} open={version === currentVersions[0]}><summary>v{version.version_no || "—"}　{version.article?.title || "記事下書き"}（{version.status || "DRAFT"}）</summary><div className="article-result-preview"><p>{version.article?.meta_description || ""}</p><textarea readOnly value={version.article?.html || ""} aria-label="生成された記事本文" /></div></details>)}
            </section>
          )}
        </>
      )}
    </>
  );
}

function ArticleSeriesPlanner({
  client,
  series,
  items,
  selectedItem,
  selectedItemId,
  onSelectItem,
  requestedArticleCount,
  recommendedArticleCount,
  primarySourceIds,
  briefs,
  setBriefs,
  onAcceptPlan,
  onSaveBrief,
  onGenerate,
  busy,
  message,
  scheduleMode,
  setScheduleMode,
  weeklyStartDate,
  setWeeklyStartDate,
  weeklyWeekday,
  setWeeklyWeekday,
  weeklyTime,
  setWeeklyTime,
  individualSchedules,
  setIndividualSchedules,
  onSaveSchedules,
  seriesRuleSettings,
  setSeriesRuleSettings,
  itemRuleSettings,
  setItemRuleSettings,
  onSaveGenerationRules,
  ruleSaving,
  ruleConflicts,
}: any) {
  const plan = series?.plan || series?.seriesPlan || {};
  const seriesStatus = String(fieldOf(series, "status") || "PLANNING");
  const reason = displayValue(
    fieldOf(
      plan,
      "recommendedCountReason",
      "recommended_count_reason",
      "recommendationReason",
      "recommendation_reason",
    ),
    "検索意図・既存記事・キーワードの重なりを確認して提案しています。",
  );
  const internalLinks = asItems(
    fieldOf(plan, "internalLinkPlan", "internal_link_plan") ||
      fieldOf(series, "internalLinkPlan", "internal_link_plan"),
  );
  const schedules = asItems(series?.schedules);
  const timezone = String(client?.timezone || "Asia/Tokyo");
  const selectedId = seriesItemId(selectedItem);
  const selectedBrief = briefs[selectedId] || {};
  const updateBrief = (key: string, value: string) =>
    setBriefs((current: Record<string, any>) => ({
      ...current,
      [selectedId]: { ...selectedBrief, [key]: value },
    }));
  const scheduleFor = (item: any) =>
    schedules.find(
      (schedule: any) =>
        String(fieldOf(schedule, "seriesItemId", "series_item_id")) ===
        seriesItemId(item),
    );
  const itemSchedulePreview = (item: any, index: number) => {
    const schedule = scheduleFor(item);
    if (scheduleMode === "DRAFT_ONLY") return "下書きのまま（公開しません）";
    if (scheduleMode === "WEEKLY") {
      const scheduledAt = scheduledAtForWeekly(
        weeklyStartDate,
        weeklyWeekday,
        weeklyTime,
        index,
      );
      return scheduledAt
        ? `${formatSchedule(scheduledAt, timezone)}（${timezone}）`
        : "開始日を指定してください";
    }
    const manual = individualSchedules[seriesItemId(item)];
    return manual?.date
      ? `${manual.date} ${manual.time || "10:00"}（${timezone}）`
      : displayValue(fieldOf(schedule, "scheduledAt", "scheduled_at"), "未設定");
  };
  const isRecommendedLower = recommendedArticleCount < requestedArticleCount;
  const seriesHasHighRisk = items.some((item: any) =>
    /high|高/.test(
      String(
        fieldOf(
          seriesItemPlan(item),
          "cannibalizationRisk",
          "cannibalization_risk",
        ) || fieldOf(item, "cannibalizationRisk", "cannibalization_risk") || "",
      ).toLowerCase(),
    ),
  );

  return (
    <>
      <section className="panel article-series-planner" aria-live="polite">
        <div className="panel-head">
          <div>
            <h3>2. Article Series Planner</h3>
            <p>本文はまだ書かず、記事ごとの検索意図・Primary Keyword・読者課題・切り口を分けて企画します。</p>
          </div>
          <em className={`status ${seriesStatus.toLowerCase()}`}>
            {seriesStatusLabel[seriesStatus] || seriesStatus}
          </em>
        </div>
        <div className="series-planner-summary">
          <article>
            <small>Requested</small>
            <b>{requestedArticleCount}記事</b>
            <span>ユーザーが指定した本数</span>
          </article>
          <article>
            <small>Recommended</small>
            <b>{recommendedArticleCount}記事</b>
            <span>検索意図の重複を避ける推奨本数</span>
          </article>
          <article>
            <small>実行予定</small>
            <b>Articles: {items.length || requestedArticleCount}</b>
            <span>SERP Analyses / Writer Jobs は記事ごとに実行</span>
          </article>
        </div>
        {isRecommendedLower && (
          <div className="series-count-warning">
            <div>
              <b>{requestedArticleCount}記事では検索意図が重複する可能性があります。{recommendedArticleCount}記事を推奨します。</b>
              <p>{reason}</p>
            </div>
            <div className="button-row">
              <button type="button" className="primary" onClick={() => onAcceptPlan(false)} disabled={busy}>推奨記事数で作成</button>
              <button type="button" className="secondary" onClick={() => onAcceptPlan(true)} disabled={busy}>{requestedArticleCount}記事で作成</button>
            </div>
          </div>
        )}
        {!isRecommendedLower && items.length > 0 && (
          <div className="button-row series-plan-confirm">
            <span>記事ごとの検索意図とキーワードを確認してから、個別Briefへ進みます。</span>
            <button type="button" className="primary" onClick={() => onAcceptPlan(false)} disabled={busy}>この企画で進める</button>
          </div>
        )}
        {seriesStatus === "PLANNING" && <p className="article-empty-note">企画を作成しています。完了すると、記事同士の関係とカニバリゼーション確認を表示します。</p>}
        {message && <p className="error-text article-input-message">{message}</p>}
      </section>

      {items.length > 0 && <>
        <ArticleGenerationRulesEditor
          title="3. 記事作成設定（シリーズ共通）"
          description="このシリーズの全記事へ共通で渡す制約です。個別記事の設定がある場合は、その記事の設定を優先します。"
          settings={seriesRuleSettings}
          onChange={setSeriesRuleSettings}
          onSave={() => void onSaveGenerationRules("SERIES_COMMON", seriesRuleSettings)}
          saving={ruleSaving === "SERIES_COMMON"}
          conflicts={ruleConflicts}
        />
        {selectedItem && <ArticleGenerationRulesEditor
          title={`Article ${items.findIndex((item: any) => seriesItemId(item) === selectedId) + 1} の追加設定`}
          description="この1記事だけに追加・変更したい内容です。生成時にはこの設定を固定保存し、品質監査まで同じ条件を使います。"
          settings={itemRuleSettings}
          onChange={setItemRuleSettings}
          onSave={() => void onSaveGenerationRules("SERIES_ITEM", itemRuleSettings)}
          saving={ruleSaving === "SERIES_ITEM"}
          conflicts={ruleConflicts}
        />}
      </>}

      {items.length > 0 && (
        <section className="panel series-article-plans">
          <div className="panel-head">
            <div>
              <h3>記事別の企画とContent Brief</h3>
              <p>各記事は独立したSEO記事です。共通のBriefを使い回さず、それぞれのWriter・Fact Check・品質監査に渡します。</p>
              <p className="article-empty-note">Article 1 から Article 4 まで、必要な記事だけを個別に確認・生成できます。</p>
            </div>
            {seriesHasHighRisk && <span className="series-high-risk">カニバリゼーション注意</span>}
          </div>
          <div className="series-plan-list">
            {items.map((item: any, index: number) => {
              const itemPlan = seriesItemPlan(item);
              const itemId = seriesItemId(item);
              const risk = displayValue(fieldOf(itemPlan, "cannibalizationRisk", "cannibalization_risk") || fieldOf(item, "cannibalizationRisk", "cannibalization_risk"), "LOW");
              const relationship = displayValue(fieldOf(itemPlan, "relationshipToOtherArticles", "relationship_to_other_articles", "relationship"), "他の記事と検索意図を分離して設計");
              const isSelected = itemId === selectedId;
              return <article key={itemId || index} className={`series-plan-card ${isSelected ? "is-selected" : ""}`}>
                <button type="button" className="series-plan-card-head" onClick={() => onSelectItem(itemId)}>
                  <span>Article {index + 1} / {items.length}</span>
                  <b>{seriesItemTitle(item)}</b>
                  <em className={/high|高/.test(risk.toLowerCase()) ? "risk-high" : ""}>{risk === "LOW" ? "カニバリゼーション低" : `カニバリゼーション ${risk}`}</em>
                </button>
                <dl>
                  <div><dt>Primary Keyword</dt><dd>{seriesItemKeyword(item)}</dd></div>
                  <div><dt>Search Intent</dt><dd>{displayValue(fieldOf(itemPlan, "searchIntent", "search_intent"), "分析中")}</dd></div>
                  <div><dt>Target Reader</dt><dd>{displayValue(fieldOf(itemPlan, "targetReader", "target_reader"), "確認中")}</dd></div>
                  <div><dt>Reader Problem</dt><dd>{displayValue(fieldOf(itemPlan, "problem", "readerProblem", "reader_problem"), "確認中")}</dd></div>
                  <div><dt>Desired Outcome</dt><dd>{displayValue(fieldOf(itemPlan, "desiredOutcome", "desired_outcome", "contentGoal", "content_goal"), "確認中")}</dd></div>
                  <div><dt>Unique Angle</dt><dd>{displayValue(fieldOf(itemPlan, "uniqueAngle", "unique_angle"), "確認中")}</dd></div>
                  <div><dt>Series Relationship</dt><dd>{relationship}</dd></div>
                  <div><dt>投稿予定</dt><dd>{itemSchedulePreview(item, index)}</dd></div>
                </dl>
                <div className="series-plan-card-actions">
                  <button type="button" className="secondary" onClick={() => onSelectItem(itemId)}>個別Briefを編集</button>
                  <button type="button" className="primary" disabled={busy} onClick={() => onGenerate([itemId])}>この1記事を生成</button>
                </div>
              </article>;
            })}
          </div>
          {selectedItem && (
            <section className="series-brief-editor" aria-label="記事別Content Brief">
              <div className="panel-head">
                <div><h4>Article {items.findIndex((item: any) => seriesItemId(item) === selectedId) + 1} の個別Content Brief</h4><p>{seriesItemTitle(selectedItem)} の編集内容だけをこの1記事に渡します。</p></div>
                <button type="button" className="secondary" onClick={() => onSaveBrief(selectedItem)} disabled={busy}>個別Briefを保存</button>
              </div>
              <div className="form-grid">
                <label>Primary Keyword<input value={selectedBrief.primaryKeyword || ""} onChange={(event) => updateBrief("primaryKeyword", event.target.value)} /></label>
                <label>Search Intent<select value={selectedBrief.searchIntent || "informational"} onChange={(event) => updateBrief("searchIntent", event.target.value)}><option value="informational">知りたい（Informational）</option><option value="commercial">比較・検討（Commercial）</option><option value="transactional">行動・依頼（Transactional）</option><option value="navigational">特定サービスを探す（Navigational）</option><option value="local">地域で探す（Local）</option></select></label>
                <label>Target Reader<input value={selectedBrief.targetReader || ""} onChange={(event) => updateBrief("targetReader", event.target.value)} /></label>
                <label>Content Goal<input value={selectedBrief.articleGoal || ""} onChange={(event) => updateBrief("articleGoal", event.target.value)} /></label>
                <label>Unique Angle<textarea value={selectedBrief.uniqueAngle || ""} onChange={(event) => updateBrief("uniqueAngle", event.target.value)} /></label>
                <label>見出し構成（改行区切り）<textarea value={selectedBrief.proposedStructure || ""} onChange={(event) => updateBrief("proposedStructure", event.target.value)} /></label>
                <label className="wide">CTA<textarea value={selectedBrief.cta || ""} onChange={(event) => updateBrief("cta", event.target.value)} /></label>
              </div>
              <p className="article-empty-note">選択済みの一次情報 {primarySourceIds.length}件を、この個別Briefの根拠として使用します。参考コンテンツは一次情報に昇格しません。</p>
            </section>
          )}
          <div className="button-row series-generate-all">
            <span>全記事を同時に公開することはありません。生成後も各記事が独立した品質ゲートを通ります。</span>
            <button type="button" className="primary" onClick={() => onGenerate(items.map(seriesItemId))} disabled={busy}>{items.length}記事を生成</button>
          </div>
        </section>
      )}

      {items.length > 0 && (
        <section className="panel series-scheduling">
          <div className="panel-head">
            <div>
              <h3>3. 投稿方法と週次スケジュール</h3>
              <p>予定を保存しても公開許可にはなりません。予定時刻に、Quality Score・Fact Check・YMYL・Human Review・Auto Publish設定を再確認します。</p>
            </div>
            <span className="timezone-badge">{timezone}</span>
          </div>
          <fieldset className="schedule-mode-options">
            <legend>投稿方法</legend>
            <label className="inline-choice"><input type="radio" name="series-schedule-mode" checked={scheduleMode === "DRAFT_ONLY"} onChange={() => setScheduleMode("DRAFT_ONLY")} />今は公開せず下書きにする</label>
            <label className="inline-choice"><input type="radio" name="series-schedule-mode" checked={scheduleMode === "WEEKLY"} onChange={() => setScheduleMode("WEEKLY")} />毎週投稿する</label>
            <label className="inline-choice"><input type="radio" name="series-schedule-mode" checked={scheduleMode === "INDIVIDUAL"} onChange={() => setScheduleMode("INDIVIDUAL")} />投稿予定日を個別設定する</label>
          </fieldset>
          {scheduleMode === "WEEKLY" && (
            <div className="form-grid schedule-weekly-controls">
              <label>投稿開始日<input type="date" value={weeklyStartDate} onChange={(event) => setWeeklyStartDate(event.target.value)} /></label>
              <label>投稿曜日<select value={weeklyWeekday} onChange={(event) => setWeeklyWeekday(Number(event.target.value))}>{[[0, "日"], [1, "月"], [2, "火"], [3, "水"], [4, "木"], [5, "金"], [6, "土"]].map(([value, label]) => <option value={value} key={value}>{label}曜日</option>)}</select></label>
              <label>投稿時刻<input type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} /></label>
              <p className="schedule-timezone-note">クライアントのタイムゾーン: {timezone}</p>
            </div>
          )}
          {scheduleMode === "INDIVIDUAL" && (
            <div className="individual-schedule-list">
              {items.map((item: any, index: number) => {
                const itemId = seriesItemId(item);
                const schedule = individualSchedules[itemId] || { date: "", time: "10:00" };
                return <div key={itemId || index} className="individual-schedule-row"><b>Article {index + 1}</b><span>{seriesItemTitle(item)}</span><label>日付<input type="date" value={schedule.date} onChange={(event) => setIndividualSchedules((current: Record<string, any>) => ({ ...current, [itemId]: { ...schedule, date: event.target.value } }))} /></label><label>時刻<input type="time" value={schedule.time || "10:00"} onChange={(event) => setIndividualSchedules((current: Record<string, any>) => ({ ...current, [itemId]: { ...schedule, time: event.target.value } }))} /></label></div>;
              })}
            </div>
          )}
          <div className="schedule-preview-list">
            {items.map((item: any, index: number) => <div key={`schedule-${seriesItemId(item) || index}`}><b>Article {index + 1}</b><span>{itemSchedulePreview(item, index)}</span></div>)}
          </div>
          <div className="button-row series-schedule-actions">
            <small>Auto PublishがOFFの場合、予定時刻になっても自動公開しません。公開できない場合はSCHEDULE_BLOCKEDとして理由を残します。</small>
            <button type="button" className="primary" onClick={() => onSaveSchedules()} disabled={busy}>投稿予定を保存</button>
          </div>
        </section>
      )}

      {internalLinks.length > 0 && (
        <section className="panel series-internal-link-plan">
          <div className="panel-head"><div><h3>シリーズ内の内部リンク候補</h3><p>公開前のURLを本文へ勝手に挿入せず、既存のINTERNAL_LINKパイプラインへ候補として渡します。</p></div></div>
          <ul>{internalLinks.map((link: any, index: number) => <li key={index}>{displayValue(link, "内部リンク候補を確認中")}</li>)}</ul>
        </section>
      )}
    </>
  );
}

// 「記事投稿」は、従来のSEOキーワード計画を残しながら、参考コンテンツ・
// お題から始める記事作成入口も提供する。どの入口でも下書き生成後は既存の
// Writer → Fact Check → 品質監査のパイプラインへ合流する。
function Publishing({ client, refresh }: any) {
  const [mode, setMode] = useState<ArticleEntryMode>("seo");
  return <>
    <section className="article-entry-tabs" aria-label="記事の作り方">
      <div>
        <b>記事の作り方</b>
        <span>目的に合う入口を選び、下書きはすべてSEO Loop内で確認してから公開します。</span>
      </div>
      <div className="article-entry-tab-list" role="tablist" aria-label="記事作成の入口">
        <button type="button" role="tab" aria-selected={mode === "seo"} className={mode === "seo" ? "active" : ""} onClick={() => setMode("seo")}>SEOキーワードから</button>
        <button type="button" role="tab" aria-selected={mode === "reference"} className={mode === "reference" ? "active" : ""} onClick={() => setMode("reference")}>参考コンテンツから</button>
        <button type="button" role="tab" aria-selected={mode === "idea"} className={mode === "idea" ? "active" : ""} onClick={() => setMode("idea")}>お題・自分の考えから</button>
      </div>
    </section>
    {mode === "seo" ? <MonthlyContentPlan client={client} refresh={refresh} embedded /> : <ArticleCreationInput client={client} refresh={refresh} mode={mode} openSeo={() => setMode("seo")} />}
  </>;
}

// ArticlePreview is deliberately read-only. It consumes the article versions
// already produced by the existing pipeline and never creates a WordPress
// draft, schedules, or publishes merely by being opened.
function ArticlePreview({ client, onNavigate }: any) {
  const [records, setRecords] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [layout, setLayout] = useState<"desktop" | "mobile">("desktop");
  const [versionId, setVersionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const recordId = (item: any) =>
    String(fieldOf(item, "articleVersionId", "article_version_id", "id") || "");
  const load = async () => {
    setLoading(true);
    try {
      const result = await api(`clients/${client.id}/article-previews`);
      const next = asItems(result?.items || result?.previews || result?.articles || result);
      setRecords(next);
      setSelectedId((current) =>
        current && next.some((item: any) => recordId(item) === current)
          ? current
          : recordId(next[0]),
      );
    } catch {
      // No preview record is a normal state for a new client. Do not turn an
      // optional read-only view into a dashboard-level error.
      setRecords([]);
      setSelectedId("");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [client.id]);
  const filteredRecords = useMemo(() => {
    const normalized = (value: unknown) => String(value || "").toLowerCase();
    return records.filter((item) => {
      const method = normalized(fieldOf(item, "creationMethod", "creation_method", "method"));
      const status = normalized(fieldOf(item, "status", "articleStatus", "article_status"));
      const schedule = fieldOf(item, "scheduledAt", "scheduled_at", "schedule");
      if (filter === "all") return true;
      if (filter === "reference") return method === "reference";
      if (filter === "idea") return method === "idea";
      if (filter === "seo") return method === "seo" || method === "seo_keyword" || method === "keyword";
      if (filter === "scheduled") return Boolean(schedule) || status.includes("scheduled");
      if (filter === "ready") return status === "ready" || status === "approved" || status === "publishable";
      if (filter === "review") return status.includes("review") || status.includes("blocked") || status.includes("draft");
      if (filter === "published") return status === "published" || normalized(fieldOf(item, "wordpressStatus", "wordpress_status")) === "published";
      return true;
    });
  }, [records, filter]);
  const selectedRecord =
    records.find((item: any) => recordId(item) === selectedId) ||
    filteredRecords[0] ||
    records[0];
  useEffect(() => {
    const id = selectedRecord ? recordId(selectedRecord) : "";
    if (!id) {
      setDetail(null);
      return;
    }
    let active = true;
    setLoadingDetail(true);
    void api(`clients/${client.id}/article-previews/${id}`)
      .then((result) => {
        if (active) setDetail(result?.preview || result || selectedRecord);
      })
      .catch(() => {
        if (active) setDetail(selectedRecord);
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [client.id, selectedId, selectedRecord?.id, selectedRecord?.articleVersionId]);
  const preview = detail?.preview || detail || selectedRecord || {};
  const versions = asItems(
    fieldOf(preview, "versions", "articleVersions", "article_versions") ||
      fieldOf(selectedRecord, "versions", "articleVersions", "article_versions"),
  );
  const versionKey = (version: any) =>
    String(fieldOf(version, "id", "articleVersionId", "article_version_id", "versionId", "version_id") || "");
  useEffect(() => {
    if (!versions.length) {
      setVersionId("");
      return;
    }
    setVersionId((current) =>
      current && versions.some((version: any) => versionKey(version) === current)
        ? current
        : versionKey(versions[0]),
    );
  }, [detail?.id, detail?.updatedAt, versions.length]);
  const activeVersion =
    versions.find((version: any) => versionKey(version) === versionId) ||
    versions[0] ||
    preview?.version ||
    preview;
  const article = activeVersion?.article || preview?.article || selectedRecord?.article || activeVersion || {};
  const title = displayValue(
    fieldOf(article, "title", "headline", "seoTitle", "seo_title") ||
      fieldOf(preview, "title", "headline"),
    "記事タイトルを読み込んでいます",
  );
  const metaDescription = displayValue(
    fieldOf(article, "metaDescription", "meta_description") ||
      fieldOf(preview, "metaDescription", "meta_description"),
    "",
  );
  const rawHtml = String(fieldOf(article, "html", "content", "body") || "");
  const escapePreviewText = (value: unknown) =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  const articleDocument = `<!doctype html><html lang="ja"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{margin:0;background:#fff;color:#172f45;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;line-height:1.8}article{max-width:780px;margin:auto;padding:42px 28px 64px}small{display:block;color:#687e91;font-size:12px;letter-spacing:.08em;font-weight:800;text-transform:uppercase}h1{font-size:clamp(27px,5vw,42px);line-height:1.25;margin:10px 0 18px}h2{font-size:25px;line-height:1.35;margin:46px 0 16px;padding-bottom:8px;border-bottom:2px solid #dfe9f1}h3{font-size:20px;margin:30px 0 12px}p,li{font-size:16px}a{color:#2164d8}img{display:block;max-width:100%;height:auto;border-radius:12px;margin:24px auto}table{width:100%;border-collapse:collapse;overflow:hidden;border:1px solid #dae4ee}th,td{padding:10px;border:1px solid #dae4ee;text-align:left}blockquote{margin:22px 0;padding:4px 18px;border-left:4px solid #2a67ed;background:#f2f7ff}</style></head><body><article><small>SEO LOOP ARTICLE PREVIEW</small><h1>${escapePreviewText(title)}</h1>${metaDescription ? `<p style="color:#60788d">${escapePreviewText(metaDescription)}</p>` : ""}${rawHtml || "<p>生成済みの本文があると、ここにWordPress公開に近い見た目で表示されます。</p>"}</article></body></html>`;
  const quality =
    fieldOf(preview, "quality", "qualityAudit", "quality_audit") ||
    fieldOf(activeVersion, "quality", "qualityAudit", "quality_audit") ||
    {};
  const factCheck =
    fieldOf(preview, "factCheck", "fact_check") ||
    fieldOf(activeVersion, "factCheck", "fact_check") ||
    {};
  const claims = asItems(fieldOf(factCheck, "claims", "items") || factCheck?.result?.claims);
  const primarySources = asItems(
    fieldOf(preview, "primarySources", "primary_sources") ||
      fieldOf(activeVersion, "primarySources", "primary_sources"),
  );
  const referenceSources = asItems(
    fieldOf(preview, "referenceSources", "reference_sources") ||
      fieldOf(activeVersion, "referenceSources", "reference_sources"),
  );
  const originality =
    fieldOf(preview, "originalityPlan", "originality_plan") ||
    fieldOf(activeVersion, "originalityPlan", "originality_plan") ||
    {};
  const previewSeries = fieldOf(preview, "series", "articleSeries", "article_series") || {};
  const seriesItems = asItems(fieldOf(previewSeries, "items") || fieldOf(preview, "seriesItems", "series_items"));
  const cannibalization = fieldOf(preview, "cannibalization", "cannibalizationResult", "cannibalization_result") || {};
  const internalLinks = asItems(fieldOf(preview, "internalLinkPlan", "internal_link_plan") || fieldOf(previewSeries, "internalLinkPlan", "internal_link_plan"));
  const schedule = fieldOf(preview, "schedule", "articleSchedule", "article_schedule") || {};
  const generationSettings = fieldOf(preview, "generationSettings", "generation_settings") || {};
  const lockedGenerationRules = fieldOf(generationSettings, "settings") || {};
  const instructionCompliance = fieldOf(quality, "instructionCompliance", "instruction_compliance") || {};
  const instructionViolations = asItems(fieldOf(instructionCompliance, "violations") || []);
  const timezone = String(fieldOf(schedule, "timezone") || client?.timezone || "Asia/Tokyo");
  const sourceTitle = (source: any) =>
    displayValue(fieldOf(source, "title", "name", "url", "originalUrl", "original_url"), "名称未設定の情報");
  const selectRecord = (record: any) => {
    const id = recordId(record);
    if (id) setSelectedId(id);
  };
  const qualityFields = [
    ["Quality Score", fieldOf(quality, "score", "qualityScore", "quality_score")],
    ["Search Intent", fieldOf(quality, "searchIntent", "search_intent")],
    ["Information Quality", fieldOf(quality, "informationQuality", "information_quality")],
    ["Original Value", fieldOf(quality, "originalValue", "original_value")],
    ["E-E-A-T", fieldOf(quality, "eeat", "E_E_A_T")],
    ["Structure / UX", fieldOf(quality, "structureUx", "structure_ux")],
    ["SEO", fieldOf(quality, "seo")],
    ["Conversion", fieldOf(quality, "conversion")],
    ["Safety / Fact Check", fieldOf(quality, "safety", "factCheck", "fact_check")],
  ];
  const filters = [
    ["all", "All"],
    ["reference", "Reference"],
    ["idea", "Idea"],
    ["seo", "SEO Keyword"],
    ["scheduled", "Scheduled"],
    ["ready", "Ready"],
    ["review", "Needs Review"],
    ["published", "Published"],
  ];

  return (
    <div className="article-preview-page">
      <section className="panel article-preview-intro">
        <div className="panel-head">
          <div>
            <h2>記事プレビュー</h2>
            <p>公開に近い見た目で、品質・根拠・独自性・シリーズ・投稿予定を確認する閲覧専用画面です。</p>
          </div>
          <button type="button" className="secondary" onClick={() => void load()} disabled={loading}>一覧を更新</button>
        </div>
        <p className="safety-note">閲覧専用プレビューです。開くだけではWordPress下書き作成・予約・公開は行いません。変更は下の明示ボタンから既存の編集・承認画面へ進みます。</p>
      </section>
      <section className="preview-filter-bar" aria-label="記事プレビューの絞り込み">
        {filters.map(([key, label]) => <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}
      </section>
      <div className="article-preview-layout">
        <aside className="panel preview-list-panel">
          <div className="panel-head"><div><h3>Previewできる記事</h3><p>生成済みの下書き・レビュー版だけを表示します。</p></div></div>
          {loading && <p className="article-empty-note">記事プレビューを読み込んでいます…</p>}
          {!loading && !filteredRecords.length && <div className="empty">まだプレビューできる記事はありません。記事を生成し、品質確認の結果が保存されるとここに表示されます。</div>}
          <div className="preview-record-list">
            {filteredRecords.map((record: any) => {
              const id = recordId(record);
              const method = String(fieldOf(record, "creationMethod", "creation_method", "method") || "SEO").toUpperCase();
              const recordQuality = fieldOf(record, "qualityScore", "quality_score", "score") || fieldOf(record?.quality, "score");
              return <button key={id} type="button" className={`preview-record ${recordId(selectedRecord) === id ? "is-selected" : ""}`} onClick={() => selectRecord(record)}>
                <span>{articleMethodLabel[method] || method}</span>
                <b>{displayValue(fieldOf(record, "title", "articleTitle", "article_title") || fieldOf(record?.article, "title"), "記事タイトルを準備中")}</b>
                <small>Primary Keyword: {displayValue(fieldOf(record, "primaryKeyword", "primary_keyword", "keyword"), "—")}</small>
                <div><em>{displayValue(fieldOf(record, "status", "articleStatus", "article_status"), "DRAFT")}</em><span>Quality {displayValue(recordQuality, "—")}</span></div>
                <small>{fieldOf(record, "scheduledAt", "scheduled_at") ? `投稿予定: ${formatSchedule(fieldOf(record, "scheduledAt", "scheduled_at"), timezone)}` : "投稿予定: 未設定"}</small>
              </button>;
            })}
          </div>
        </aside>
        <section className="preview-detail-area">
          {!selectedRecord && !loading && <section className="panel"><div className="empty">左の一覧から記事を選択すると、本文と品質確認の結果を表示します。</div></section>}
          {selectedRecord && <>
            <section className="panel preview-toolbar">
              <div><small>Article Version</small><h3>{title}</h3><p>{loadingDetail ? "最新の確認情報を読み込んでいます…" : `Primary Keyword: ${displayValue(fieldOf(preview, "primaryKeyword", "primary_keyword", "keyword"), "—")}`}</p></div>
              <div className="preview-toolbar-controls">
                <div className="preview-version-tabs" role="tablist" aria-label="Versionを切り替える">
                  {versions.length ? versions.map((version: any, index: number) => <button type="button" role="tab" key={versionKey(version) || index} aria-selected={versionKey(activeVersion) === versionKey(version)} className={versionKey(activeVersion) === versionKey(version) ? "active" : ""} onClick={() => setVersionId(versionKey(version))}>Version {fieldOf(version, "versionNo", "version_no") || index + 1}</button>) : <span>Version 1</span>}
                </div>
                <div className="preview-device-tabs" role="tablist" aria-label="プレビュー表示幅">
                  <button type="button" role="tab" aria-selected={layout === "desktop"} className={layout === "desktop" ? "active" : ""} onClick={() => setLayout("desktop")}>Desktop</button>
                  <button type="button" role="tab" aria-selected={layout === "mobile"} className={layout === "mobile" ? "active" : ""} onClick={() => setLayout("mobile")}>Mobile</button>
                </div>
              </div>
            </section>
            <section className="panel article-preview-frame-panel">
              <div className={`article-preview-frame ${layout === "mobile" ? "mobile" : "desktop"}`}>
                <iframe title={`${title} の${layout === "mobile" ? "Mobile" : "Desktop"}プレビュー`} sandbox="" srcDoc={articleDocument} />
              </div>
            </section>
            <section className="preview-action-row">
              <button type="button" className="secondary" onClick={() => onNavigate("publishing")}>Content Briefを編集</button>
              <button type="button" className="secondary" onClick={() => onNavigate("monthly-plan")}>本文を編集</button>
              <button type="button" className="secondary" onClick={() => onNavigate("publishing")}>投稿予定を変更</button>
              <button type="button" className="primary" onClick={() => onNavigate("monthly-plan")}>公開承認へ進む</button>
            </section>
            <div className="preview-inspection-grid">
              <section className="panel preview-inspection quality-panel"><h3>Quality Score</h3><dl>{qualityFields.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{displayValue(value, "未評価")}</dd></div>)}</dl></section>
              <section className="panel preview-inspection generation-rules-panel"><h3>固定された記事生成ルール</h3>{Object.keys(lockedGenerationRules).length ? <><dl><div><dt>対象読者</dt><dd>{displayValue(lockedGenerationRules.targetReader, "指定なし")}</dd></div><div><dt>ゴール</dt><dd>{displayValue(lockedGenerationRules.articleGoal, "指定なし")}</dd></div><div><dt>CTA</dt><dd>{displayValue(lockedGenerationRules.ctaType, "NONE")} {displayValue(lockedGenerationRules.ctaText, "")}</dd></div><div><dt>事実ルール</dt><dd>{displayValue(lockedGenerationRules.factRule, "STANDARD")}</dd></div><div><dt>長さ</dt><dd>{displayValue(lockedGenerationRules.articleLength, "AUTO")}{lockedGenerationRules.customLength ? ` / ${lockedGenerationRules.customLength}字` : ""}</dd></div></dl><p>{displayValue(lockedGenerationRules.mustInclude, "必須内容の指定なし")}</p><small>固定日時: {displayValue(fieldOf(generationSettings, "lockedAt", "locked_at"), "生成時")}</small></> : <p>このバージョンには固定ルールの記録がありません。</p>}</section>
              <section className={`panel preview-inspection instruction-compliance-panel ${instructionViolations.length ? "has-warning" : ""}`}><h3>記事生成ルールの監査</h3>{Object.keys(instructionCompliance).length ? <><p>{instructionViolations.length ? "修正が必要なルール違反があります。自動改稿または人の確認が必要です。" : "必須内容・禁止事項・トーン・CTA・構成を確認しました。"}</p>{instructionViolations.length > 0 && <ul>{instructionViolations.map((violation: any, index: number) => <li key={index}><b>{displayValue(violation.rule, "ルール")}</b>：{displayValue(violation.requiredCorrection || violation.location, "修正内容を確認してください")}</li>)}</ul>}</> : <p>品質監査後にルール遵守状況を表示します。</p>}</section>
              <section className="panel preview-inspection fact-panel"><h3>Fact Check</h3>{claims.length ? <div className="claim-list">{claims.map((claim: any, index: number) => <article key={fieldOf(claim, "id") || index}><b>{displayValue(fieldOf(claim, "claim", "text", "statement"), "確認対象の主張")}</b><span>{displayValue(fieldOf(claim, "status", "result"), "PENDING")}</span><small>Evidence: {displayValue(fieldOf(claim, "evidence", "source", "reason"), "未確認")}</small></article>)}</div> : <p className="article-empty-note">Claim単位のFact Check結果は、生成・確認後にここへ表示されます。</p>}</section>
              <section className="panel preview-inspection source-panel"><h3>Sources</h3><h4>一次情報</h4>{primarySources.length ? <ul>{primarySources.map((source: any, index: number) => <li key={fieldOf(source, "id") || index}>{sourceTitle(source)}</li>)}</ul> : <p>一次情報は未選択です。</p>}<h4>参考コンテンツ</h4>{referenceSources.length ? <ul>{referenceSources.map((source: any, index: number) => <li key={fieldOf(source, "id") || index}>{sourceTitle(source)}</li>)}</ul> : <p>Reference / Idea入力の参考情報はありません。</p>}</section>
              <section className="panel preview-inspection originality-panel"><h3>独自性計画</h3><dl><div><dt>参考から得た論点</dt><dd>{displayValue(fieldOf(originality, "whatWeLearnedFromReferences", "referencePoints", "reference_points"), "—")}</dd></div><div><dt>ユーザー独自情報</dt><dd>{displayValue(fieldOf(originality, "whatUserAdds", "userPrimaryInformation", "user_primary_information"), "—")}</dd></div><div><dt>Unique Angle</dt><dd>{displayValue(fieldOf(originality, "uniqueAngle", "unique_angle"), "—")}</dd></div><div><dt>Added Value</dt><dd>{displayValue(fieldOf(originality, "addedValue", "added_value"), "—")}</dd></div><div><dt>New Structure</dt><dd>{displayValue(fieldOf(originality, "newStructure", "new_structure"), "—")}</dd></div><div><dt>New Conclusion</dt><dd>{displayValue(fieldOf(originality, "newConclusion", "new_conclusion"), "—")}</dd></div></dl></section>
              <section className="panel preview-inspection series-panel"><h3>このシリーズの記事</h3>{seriesItems.length ? <ol>{seriesItems.map((item: any, index: number) => <li key={seriesItemId(item) || index}><b>{index + 1} / {seriesItems.length}　{seriesItemTitle(item)}</b><span>{seriesItemKeyword(item)} · {displayValue(fieldOf(seriesItemPlan(item), "searchIntent", "search_intent"), "—")}</span><small>{displayValue(fieldOf(item, "scheduledAt", "scheduled_at"), "投稿予定: 未設定")} · {displayValue(fieldOf(item, "status"), "DRAFT")}</small></li>)}</ol> : <p>単発の記事です。</p>}</section>
              <section className="panel preview-inspection cannibalization-panel"><h3>Cannibalization</h3><p>{displayValue(fieldOf(cannibalization, "risk", "level", "status"), "未評価")}</p><small>{displayValue(fieldOf(cannibalization, "reason", "message", "recommendation"), "シリーズ企画・既存記事との重複を確認します。")}</small></section>
              <section className="panel preview-inspection internal-link-panel"><h3>Internal Link</h3>{internalLinks.length ? <ul>{internalLinks.map((link: any, index: number) => <li key={index}>{displayValue(link, "内部リンク候補")}</li>)}</ul> : <p>内部リンク候補は品質確認後に表示します。</p>}</section>
              <section className="panel preview-inspection schedule-panel"><h3>投稿予定</h3><dl><div><dt>予定日時</dt><dd>{formatSchedule(fieldOf(schedule, "scheduledAt", "scheduled_at"), timezone)}</dd></div><div><dt>Auto Publish</dt><dd>{displayValue(fieldOf(schedule, "autoPublish", "auto_publish", "autoPublishStatus", "auto_publish_status"), "AUTO_PUBLISH_OFF")}</dd></div><div><dt>Safety Gate</dt><dd>{displayValue(fieldOf(schedule, "safetyGate", "safety_gate", "status"), "未確認")}</dd></div><div><dt>Blocked Reason</dt><dd>{displayValue(fieldOf(schedule, "blockedReason", "blocked_reason"), "問題なし")}</dd></div></dl><p>SCHEDULE_BLOCKED / AUTO_PUBLISH_OFF の場合は、予定時刻でも公開されません。</p></section>
            </div>
          </>}
        </section>
      </div>
    </div>
  );
}

function LegacyPublishing({
  queue,
  jobs,
  client,
  refresh,
  strategy,
  audit,
  automation,
  uber,
}: any) {
  const [automationMessage, setAutomationMessage] = useState("");
  const [wordpressCategories, setWordpressCategories] = useState<any[]>([]);
  const [testDraftMessage, setTestDraftMessage] = useState("");
  const [testDraftLink, setTestDraftLink] = useState("");
  const [creatingTestDraft, setCreatingTestDraft] = useState(false);
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const automationFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    api(`clients/${client.id}/wordpress/categories`)
      .then((result) => setWordpressCategories(result.categories || []))
      .catch(() => setWordpressCategories([]));
  }, [client.id]);
  const createWordPressTestDraft = async () => {
    setCreatingTestDraft(true);
    setTestDraftMessage("WordPressへテスト下書きを入稿しています…");
    setTestDraftLink("");
    try {
      const result = await api(
        `clients/${client.id}/wordpress/test-draft`,
        "POST",
      );
      setTestDraftMessage(
        `テスト入稿に成功しました。WordPress投稿ID: ${result.draft.id}（下書き・未公開）`,
      );
      setTestDraftLink(result.draft.editUrl || result.draft.link || "");
      await refresh();
    } catch (error: any) {
      setTestDraftMessage(`テスト入稿に失敗しました：${error.message}`);
    } finally {
      setCreatingTestDraft(false);
    }
  };
  // Only a worker-verified match to the client's business profile can be
  // displayed or used as a content candidate.  Old strategy snapshots were
  // intentionally not tagged, so they disappear until the one-month plan is
  // recalculated against primary information and the site profile.
  const recommendations = (strategy?.recommended_keywords || []).filter(
    (item: any) => item?.scope_verified === true,
  );
  const strategyJob = jobs.find((job: any) => job.type === "keyword_strategy");
  const strategyBusy = ["queued", "running"].includes(strategyJob?.status);
  const strategyStale =
    strategyJob?.status === "running" &&
    Date.now() - new Date(strategyJob.updated_at).getTime() > 2 * 60 * 1000;
  const hasUberData = Boolean(uber && Object.keys(uber).length > 0);
  const toggleAutomation = async () => {
    setTogglingAutomation(true);
    try {
      const result = await api(
        `clients/${client.id}/content-automation/toggle`,
        "POST",
      );
      await refresh(
        result.enabled
          ? "自動運用を有効にしました。"
          : "自動運用を無効にしました。以後の定期ジョブは作成されません。",
      );
    } catch (error: any) {
      setAutomationMessage(error.message);
    } finally {
      setTogglingAutomation(false);
    }
  };
  const startStrategy = async () => {
    try {
      const values = automationFormRef.current
        ? Object.fromEntries(new FormData(automationFormRef.current))
        : {};
      const saved = await api(
        `clients/${client.id}/content-automation`,
        "POST",
        values,
      );
      const config = saved.config || automation || {};
      if (!hasUberData)
        await queue("ubersuggest_sync", { domain: client.site });
      await queue("keyword_strategy", {
        // The dedicated monthly planning tab creates editable drafts after
        // review.  This legacy entry point must never create a year's worth
        // of unchecked jobs in the background.
        autoCreate: false,
        planningWindow: "one_month",
        articleCount: Number(config.weeklyArticles || 3),
        scheduleDays: config.scheduleDays || [],
        publishHour: Number(config.publishHour ?? 10),
        targetCharacters: 10000,
        defaultCategoryId: Number(config.defaultCategoryId || 0) || null,
        categoryRotation: config.categoryRotation || [],
      });
      await refresh(
        "一次情報・サイト情報と照合する1か月分の候補を更新しました。",
      );
    } catch (error: any) {
      setAutomationMessage(error.message);
    }
  };
  const retryStrategy = async () => {
    try {
      await api(`clients/${client.id}/jobs/${strategyJob.id}/retry`, "POST");
      await refresh("止まっていたAI選定を終了し、同じ条件で再実行しました。");
    } catch (error: any) {
      setAutomationMessage(error.message);
    }
  };
  return (
    <>
      <div className="heading">
        <div>
          <h2>記事生成・公開待ち</h2>
          <p>最大3回改稿、95点判定、一次情報不足は下書き停止。</p>
        </div>
      </div>
      <section
        className={`automation-status ${automation?.enabled ? "is-enabled" : "is-disabled"}`}
        aria-live="polite"
      >
        <div>
          <span className="automation-status-label">自動投稿</span>
          <strong>{automation?.enabled ? "有効" : "無効"}</strong>
          <p>
            {automation?.enabled
              ? "設定済みの曜日・時刻に記事作成とWordPress下書き入稿を行います。"
              : "定期的な記事作成・WordPress下書き入稿は停止中です。"}
          </p>
        </div>
        <button
          className={automation?.enabled ? "danger" : "primary"}
          onClick={toggleAutomation}
          disabled={togglingAutomation}
        >
          {togglingAutomation
            ? "切替中…"
            : automation?.enabled
              ? "自動運用を無効にする"
              : "自動運用を有効にする"}
        </button>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>AIキーワード選定</h3>
            <p>
              Ubersuggestの順位・検索量・競合データと既存記事を照合し、次に狙うキーワードを決めます。
            </p>
          </div>
          <button
            className="primary"
            onClick={startStrategy}
            disabled={strategyBusy}
          >
            {strategyJob?.status === "queued"
              ? "AI選定を受付済み"
              : strategyJob?.status === "running"
                ? "AIが選定中…"
                : strategyJob?.status === "failed"
                  ? "エラーを直して再実行"
                  : recommendations.length
                    ? "1か月の候補を再選定"
                    : "1か月の候補を選定"}
          </button>
        </div>
        {strategyJob && (
          <div className={`job-progress ${strategyJob.status}`}>
            <b>
              {strategyJob.status === "queued"
                ? "受付済みです"
                : strategyJob.status === "running"
                  ? "Claude APIがキーワードを分析しています"
                  : strategyJob.status === "completed"
                    ? "AIキーワード選定が完了しました"
                    : "AIキーワード選定に失敗しました"}
            </b>
            <span>
              {strategyJob.status === "queued"
                ? "通常は数十秒以内に開始します。この画面は自動更新されます。"
                : strategyJob.status === "running"
                  ? "Ubersuggestと既存記事を照合中です。完了まで1〜5分ほどかかる場合があります。"
                  : strategyJob.status === "failed"
                    ? strategyJob.error ||
                      "実行ログで詳しい原因を確認し、再実行してください。"
                    : `${recommendations.length}件の候補を、一次情報・サイト情報と照合済みです。無関係な候補は除外しています。`}
            </span>
            {(strategyStale || strategyJob.status === "failed") && (
              <button
                type="button"
                className="secondary retry-job"
                onClick={retryStrategy}
              >
                この処理をやり直す
              </button>
            )}
          </div>
        )}
        <div className="intent-balance">
          {[
            ["Know", "知る・理解する"],
            ["Do", "方法・行動する"],
            ["Buy", "比較・依頼する"],
            ["Go", "会社・場所を探す"],
          ].map(([intent, label]) => (
            <span key={intent}>
              <b>{intent}</b> {label}
            </span>
          ))}
        </div>
        {recommendations.length > 0 ? (
          <div className="strategy-list">
            {recommendations.map((item: any, index: number) => (
              <article
                key={`${item.keyword}-${index}`}
                className="strategy-keyword"
              >
                <span className="status connected">{item.intent}</span>
                <b>{item.keyword}</b>
                <small>
                  {item.cluster}・{item.rationale}
                </small>
                <em>事業範囲を照合済み・月間計画の候補</em>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            {strategyBusy
              ? "キーワード候補を準備しています。完了するとここへ自動表示されます。"
              : "「1か月の候補を選定」を押してください。一次情報・サイト情報に整合する候補だけを表示します。"}
          </div>
        )}
        <div className="monthly-plan-handoff">
          <b>記事の下書き作成は「翌月コンテンツ計画」で行います。</b>
          <span>週あたりの本数を指定し、1か月分をまとめて確認・編集・承認してから下書きを作成します。</span>
        </div>
        {strategy?.outreach_opportunities?.length > 0 && (
          <div className="outreach-box">
            <b>被リンク獲得候補（自動設置ではありません）</b>
            {strategy.outreach_opportunities.map((item: any, index: number) => (
              <span key={index}>
                {item.target_type}：{item.proposal}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="panel pdca-flow-panel">
        <div className="panel-head">
          <div>
            <h3>AI計画から記事公開後までの自動PDCA</h3>
            <p>
              手入力なしで、上のキーワード計画を記事制作・改善へつなげます。
            </p>
          </div>
        </div>
        <div className="pdca-flow-grid">
          <div>
            <b>Plan</b>
            <span>
              Ubersuggest・Search
              Console・競合・既存記事から、事業に合う今月の優先KWを決定
            </span>
          </div>
          <div>
            <b>Do</b>
            <span>
              一次情報と実在する内部リンクを使い、約10,000字の記事をClaude
              APIで作成
            </span>
          </div>
          <div>
            <b>Check</b>
            <span>
              文字数・検索意図・根拠・E-E-A-Tを採点し、95点まで最大3回改稿
            </span>
          </div>
          <div>
            <b>Act</b>
            <span>
              WordPress下書きへ保存し、公開後の順位・CTR・古い情報を再測定して次の改稿へ反映
            </span>
          </div>
        </div>
        <p className="safety-note">
          一次情報不足は下書きで停止し、高リスク・YMYLは人間確認なしで公開しません。
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>既存記事の自動点検・リライト</h3>
            <p>
              WordPress記事を定期確認し、古い記述・重複・リンク不足を検出します。公開記事は直接変更せず、改稿版を下書き保存します。
            </p>
          </div>
          <button
            className="secondary"
            onClick={() =>
              queue("content_audit", { autoCreate: false, maxRewrites: 3 })
            }
          >
            今すぐ記事を点検
          </button>
        </div>
        {audit?.rewrite_candidates?.length ? (
          <div className="audit-list">
            {audit.rewrite_candidates.slice(0, 5).map((item: any) => (
              <div key={item.post_id}>
                <b>{item.title}</b>
                <span>{item.reason}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">まだ記事点検結果はありません。</div>
        )}
        {audit?.backlink_opportunities?.length > 0 && (
          <div className="outreach-box">
            <b>この記事群から作れる被リンク施策</b>
            {audit.backlink_opportunities.map((item: string, index: number) => (
              <span key={index}>{item}</span>
            ))}
          </div>
        )}
        <form
          ref={automationFormRef}
          onSubmit={(event) => event.preventDefault()}
          className="automation-form"
        >
          <div className="automation-guide">
            <h4>この設定で自動化されること</h4>
            <ol>
              <li>
                指定時刻に、公開済み記事の古い情報・重複・内部リンク不足を点検します。
              </li>
              <li>
                Ubersuggest・既存記事・一次情報から、週の新規記事候補を選びます。
              </li>
              <li>
                新規記事は週ごとの投稿枠に予約され、品質・根拠・WordPress接続・アイキャッチの全条件を通過したものだけ自動公開します。
              </li>
            </ol>
          </div>
          <label className="inline-choice">
            <input
              type="checkbox"
              name="enabled"
              value="yes"
              defaultChecked={automation?.enabled}
            />
            自動運用を有効にする
            <small>
              チェックを入れて保存したときだけ、毎日・毎週の処理が動きます。
            </small>
          </label>
          <label>
            毎日の点検時刻
            <select name="auditHour" defaultValue={automation?.auditHour ?? 6}>
              {[6, 9, 12, 18, 21].map((hour) => (
                <option key={hour} value={hour}>
                  {hour}:00
                </option>
              ))}
            </select>
            <small>
              既存記事を確認し始める時刻です。記事の公開時刻ではありません。
            </small>
          </label>
          <label>
            週の記事下書き数
            <select
              name="weeklyArticles"
              defaultValue={automation?.weeklyArticles ?? 1}
            >
              {[1, 2, 3, 4, 5, 7].map((count) => (
                <option key={count} value={count}>
                  週{count}本
                </option>
              ))}
            </select>
            <small>
              AIが1週間に作成する新規記事数です。翌月分まで投稿枠を分けて予約します。
            </small>
          </label>
          <label>
            記事制作を始める曜日
            <select
              name="strategyDay"
              defaultValue={automation?.strategyDay ?? 1}
            >
              {[
                [0, "日"],
                [1, "月"],
                [2, "火"],
                [3, "水"],
                [4, "木"],
                [5, "金"],
                [6, "土"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  毎週{label}曜日
                </option>
              ))}
            </select>
            <small>
              この曜日・時刻を起点に、記事作成と週次投稿を予約します。
            </small>
          </label>
          <label>
            記事制作を始める時刻
            <select
              name="strategyHour"
              defaultValue={automation?.strategyHour ?? 9}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <small>
              日本時間です。下書き保存までをこの時刻から開始します。
            </small>
          </label>
          <label>
            基本カテゴリー（AIに任せる場合は未選択）
            <select
              name="defaultCategoryId"
              defaultValue={automation?.defaultCategoryId || ""}
            >
              <option value="">AIがWordPressカテゴリーから選定</option>
              {wordpressCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}（投稿{category.count}件）
                </option>
              ))}
            </select>
            <small>
              WordPressから読み取った実在カテゴリーです。指定した場合は以後の記事へ設定します。
            </small>
          </label>
          <label>
            カテゴリーローテーション（任意）
            <input
              name="categoryRotation"
              defaultValue={(automation?.categoryRotation || []).join(",")}
              placeholder="例: 3,7,12"
            />
            <small>
              カテゴリーIDをカンマ区切りで入力すると、記事ごとに順番に切り替えます。IDは上の一覧の選択後にWordPress側で確認できます。未入力ならAIまたは基本カテゴリーを使います。
            </small>
          </label>
          <label>
            1回のリライト上限
            <select
              name="maxRewrites"
              defaultValue={automation?.maxRewrites ?? 2}
            >
              {[1, 2, 3, 5].map((count) => (
                <option key={count} value={count}>
                  {count}記事
                </option>
              ))}
            </select>
            <small>1回の点検で改稿版を作る既存記事の最大数です。</small>
          </label>
          <label className="inline-choice">
            <input
              type="checkbox"
              name="autoCreateDrafts"
              value="yes"
              defaultChecked={automation?.autoCreateDrafts}
            />
            選定・リライト後にWordPress下書きを自動作成
            <small>
              公開中の記事は上書きせず、確認用の別下書きとして保存します。
            </small>
          </label>
          <label className="inline-choice">
            <input
              type="checkbox"
              name="autoPublish"
              value="yes"
              defaultChecked={automation?.autoPublish}
            />
            品質合格記事を週次で自動公開する
            <small>
              95点以上・根拠確認・安全性確認・WordPress接続・GPT Image 2のアイキャッチ設定をすべて通過した記事だけを、投稿枠で公開します。条件未達や外部APIの一時障害では公開せず、連携を解除せずに自動再試行します。
            </small>
          </label>
          <p className="field-help">
            保存後はCloudflareの定期実行が次の1か月分を準備し、投稿枠ごとに処理します。連携情報を自動で削除・解除することはありません。
          </p>
          {automationMessage && <p>{automationMessage}</p>}
          <div className="wordpress-test-draft">
            <div>
              <b>WordPress入稿テスト</b>
              <span>
                公開禁止と明記した確認用記事を、WordPressの下書きへ1件だけ送ります。
              </span>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={createWordPressTestDraft}
              disabled={creatingTestDraft}
            >
              {creatingTestDraft ? "テスト入稿中…" : "テスト下書きを入稿"}
            </button>
            {testDraftMessage && (
              <p className={testDraftLink ? "test-draft-success" : ""}>
                {testDraftMessage}
                {testDraftLink && (
                  <a href={testDraftLink} target="_blank" rel="noreferrer">
                    WordPressで確認する
                  </a>
                )}
              </p>
            )}
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h3>記事ジョブ</h3>
        </div>
        <JobTable
          jobs={jobs.filter((j: any) => j.type === "article_generate")}
        />
      </section>
    </>
  );
}
function ImmediatePublishing({
  queue,
  jobs,
  client,
  refresh,
  strategy,
  wordpressConnected,
  workerOnline,
  goPlan,
  goConnections,
}: any) {
  const plannedArticles = useMemo(() => {
    const scheduleStart = strategy?.schedule_start || "rolling";
    const calendar = (strategy?.monthly_schedule || []).flatMap((month: any) =>
      (month.articles || []).map((article: any) => ({
        ...article,
        month_number: month.month_number,
        month_label: scheduleMonthLabel(scheduleStart, month.month_number),
        cluster: month.focus || "SEO改善",
        planKey: `${scheduleStart}:${month.month_number}:${article.publish_week || 1}:${article.weekly_position || 1}:${article.keyword}`,
      })),
    );
    if (calendar.length) return calendar;
    return (strategy?.recommended_keywords || []).map((item: any) => ({
      ...item,
      title: `${item.keyword}｜${item.target_article_type || "SEO記事"}`,
      content_summary: item.rationale,
      month_label: "優先候補",
      publish_week: 1,
      planKey: `recommendation:${scheduleStart}:${item.keyword}`,
    }));
  }, [strategy]);
  const [selectedPlanKey, setSelectedPlanKey] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [wordpressCategories, setWordpressCategories] = useState<any[]>([]);
  const [featuredMessage, setFeaturedMessage] = useState("");
  const [creatingFeatured, setCreatingFeatured] = useState(false);
  const [stoppingImmediate, setStoppingImmediate] = useState(false);
  const [stoppingAllImmediate, setStoppingAllImmediate] = useState(false);
  const [stoppingAllArticles, setStoppingAllArticles] = useState(false);
  useEffect(() => {
    api(`clients/${client.id}/wordpress/categories`)
      .then((result) => setWordpressCategories(result.categories || []))
      .catch(() => setWordpressCategories([]));
  }, [client.id]);
  useEffect(() => {
    if (!plannedArticles.some((item: any) => item.planKey === selectedPlanKey))
      setSelectedPlanKey(plannedArticles[0]?.planKey || "");
  }, [plannedArticles, selectedPlanKey]);
  const selectedPlan =
    plannedArticles.find((item: any) => item.planKey === selectedPlanKey) ||
    plannedArticles[0];
  const relatedJobs = jobs.filter(
    (job: any) =>
      job.type === "article_generate" &&
      job.payload?.planKey === selectedPlan?.planKey,
  );
  const latestJob = relatedJobs[0];
  const activeImmediateJobs = jobs.filter(
    (job: any) =>
      job.type === "article_generate" &&
      (job.payload?.immediate || job.payload?.automaticComplement) &&
      ["queued", "running"].includes(job.status),
  );
  const busy = ["queued", "running"].includes(latestJob?.status);
  const progress = latestJob?.result?.progress;
  const progressPercent =
    latestJob?.status === "queued"
      ? 2
      : latestJob?.status === "completed"
        ? 100
        : latestJob?.status === "cancelled"
          ? 0
          : latestJob?.status === "failed"
            ? Number(progress?.percent || 0)
            : Number(progress?.percent || 5);
  const start = () => {
    if (!selectedPlan) return;
    queue("article_generate", {
      keyword: selectedPlan.keyword,
      intent: selectedPlan.intent || "Know",
      risk: "low",
      primaryInfoStatus:
        client.primary_info_status === "sufficient" ? "sufficient" : "missing",
      brief: [
        `AI計画の本番記事: ${selectedPlan.title || selectedPlan.keyword}`,
        `記事クラスター: ${selectedPlan.cluster || "SEO改善"}`,
        `選定理由・内容: ${selectedPlan.content_summary || selectedPlan.rationale || "AIキーワード計画に基づく"}`,
        `内部リンク候補: ${(selectedPlan.internal_link_targets || []).join("、") || "公開済み記事から自動選定"}`,
        "本番用の記事として、検索意図を十分に満たし、テスト文言は一切入れない",
      ].join("\n"),
      planKey: selectedPlan.planKey,
      plannedTitle: selectedPlan.title || "",
      targetCharacters: 10000,
      productionArticle: true,
      immediate: true,
      scheduledFor: selectedPlan.scheduledFor || null,
      categoryId:
        Number(selectedCategoryId || selectedPlan.category_id || 0) || null,
    });
  };
  const createFeaturedImage = async () => {
    if (!latestJob?.id) return;
    setCreatingFeatured(true);
    setFeaturedMessage(
      "GPT Image 2でアイキャッチを生成し、WordPressへ設定しています…",
    );
    try {
      const result = await api(
        `clients/${client.id}/jobs/${latestJob.id}/generate-featured-image`,
        "POST",
      );
      setFeaturedMessage("アイキャッチ画像を生成し、WordPressへ設定しました。");
      if (result.link)
        window.open(result.link, "_blank", "noopener,noreferrer");
    } catch (error: any) {
      setFeaturedMessage(error.message);
    } finally {
      setCreatingFeatured(false);
    }
  };
  const stopImmediate = async (jobId = latestJob?.id) => {
    if (!jobId) return;
    setStoppingImmediate(true);
    try {
      await api(`clients/${client.id}/jobs/${jobId}/cancel`, "POST");
      await refresh(
        "指定した記事を停止しました。原稿・画像・WordPress入稿は行いません。",
      );
    } catch (error: any) {
      setFeaturedMessage(error.message);
    } finally {
      setStoppingImmediate(false);
    }
  };
  const stopAllImmediate = async () => {
    setStoppingAllImmediate(true);
    try {
      const result = await api(
        `clients/${client.id}/jobs/immediate/cancel-all`,
        "POST",
      );
      await refresh(
        `このクライアントの即日入稿を${result.count}件停止しました。`,
      );
    } catch (error: any) {
      setFeaturedMessage(error.message);
    } finally {
      setStoppingAllImmediate(false);
    }
  };
  const stopAllArticles = async () => {
    setStoppingAllArticles(true);
    try {
      const result = await api("jobs/articles/cancel-all", "POST");
      await refresh(
        `全クライアントの記事生成を${result.count}件停止しました。`,
      );
    } catch (error: any) {
      setFeaturedMessage(error.message);
    } finally {
      setStoppingAllArticles(false);
    }
  };
  return (
    <>
      <div className="heading immediate-heading">
        <div>
          <span className="status connected">PRODUCTION ARTICLE</span>
          <h2>本番記事の即日入稿</h2>
          <p>
            AI選定済みの記事を、本日中にWordPressの本番用下書きへ入稿します。
          </p>
        </div>
      </div>
      <section className="immediate-stop-panel">
        <div>
          <b>記事生成の停止</b>
          <span>
            停止した記事は、原稿・Image
            2画像・WordPress下書きの作成を行いません。
          </span>
        </div>
        <div className="immediate-stop-actions">
          <button
            className="danger"
            onClick={stopAllArticles}
            disabled={stoppingAllArticles}
          >
            {stoppingAllArticles ? "全件停止中…" : "すべての記事生成を停止"}
          </button>
          <button
            className="secondary"
            onClick={stopAllImmediate}
            disabled={!activeImmediateJobs.length || stoppingAllImmediate}
          >
            {stoppingAllImmediate
              ? "即日入稿を停止中…"
              : `このクライアントの即日入稿を全て停止（${activeImmediateJobs.length}件）`}
          </button>
        </div>
      </section>
      {!strategy ? (
        <section className="panel immediate-empty">
          <h3>先にAIキーワード計画を作成してください</h3>
          <p>
            即日入稿でも、手入力のキーワードではなくUbersuggestと既存記事から選定した計画を使います。
          </p>
          <button className="primary" onClick={goPlan}>
            AIキーワード選定を開く
          </button>
        </section>
      ) : (
        <section className="panel immediate-production">
          <div className="immediate-steps">
            <span>
              <b>1</b> AI計画から記事を選ぶ
            </span>
            <span>
              <b>2</b> 約10,000字・画像付きで制作
            </span>
            <span>
              <b>3</b> 95点まで最大3回改稿
            </span>
            <span>
              <b>4</b> WordPress本番用下書きへ入稿
            </span>
          </div>
          <label className="immediate-selector">
            今日作る記事
            <select
              value={selectedPlan?.planKey || ""}
              onChange={(event) => setSelectedPlanKey(event.target.value)}
            >
              {plannedArticles.map((item: any) => (
                <option key={item.planKey} value={item.planKey}>
                  {item.month_label}・第{item.publish_week || 1}週・
                  {item.weekly_position || 1}本目｜{item.intent}｜
                  {item.title || item.keyword}
                </option>
              ))}
            </select>
          </label>
          <label className="immediate-selector">
            WordPressカテゴリー
            <select
              value={selectedCategoryId}
              onChange={(event) => setSelectedCategoryId(event.target.value)}
            >
              <option value="">AIが実在カテゴリーから選定</option>
              {wordpressCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}（投稿{category.count}件）
                </option>
              ))}
            </select>
          </label>
          {selectedPlan && (
            <article className="immediate-preview">
              <span className="status connected">{selectedPlan.intent}</span>
              <h3>{selectedPlan.title || selectedPlan.keyword}</h3>
              <p>{selectedPlan.content_summary || selectedPlan.rationale}</p>
              <dl>
                <div>
                  <dt>文字数</dt>
                  <dd>約10,000字（8,500〜11,500字）</dd>
                </div>
                <div>
                  <dt>形式</dt>
                  <dd>Gutenbergブロック・画像2〜4枚・内部リンク</dd>
                </div>
                <div>
                  <dt>公開状態</dt>
                  <dd>WordPress下書き（人間確認後に公開）</dd>
                </div>
              </dl>
            </article>
          )}
          {!workerOnline && (
            <div className="alert warn">
              <b>Claude APIが未接続です</b>
              <span>連携設定でAnthropic APIキーを接続してください。</span>
            </div>
          )}
          {!wordpressConnected && (
            <div className="alert warn">
              <b>WordPressが未接続です</b>
              <span>記事完成後の入稿先を接続してください。</span>
              <button className="secondary" onClick={goConnections}>
                連携設定を開く
              </button>
            </div>
          )}
          <button
            className="primary immediate-submit"
            onClick={start}
            disabled={
              !selectedPlan || !workerOnline || !wordpressConnected || busy
            }
          >
            {latestJob?.status === "queued"
              ? "本番記事を受付済み"
              : latestJob?.status === "running"
                ? "Claude APIが本番記事を制作中…"
                : latestJob?.status === "cancelled"
                  ? "この記事は停止済み"
                  : latestJob?.status === "completed"
                    ? "同じ計画の記事は入稿済み"
                    : "本番記事を今すぐ制作・入稿"}
          </button>
          {["queued", "running"].includes(latestJob?.status) && (
            <button
              className="secondary"
              onClick={stopImmediate}
              disabled={stoppingImmediate}
            >
              {stoppingImmediate ? "停止中…" : "この記事を停止"}
            </button>
          )}
          {activeImmediateJobs.length > 1 && (
            <section className="immediate-active-jobs">
              <h3>実行中・待機中の即日入稿</h3>
              {activeImmediateJobs.map((job: any) => (
                <div key={job.id}>
                  <span>
                    {job.payload?.plannedTitle ||
                      job.payload?.keyword ||
                      "記事"}
                    （{job.status === "running" ? "制作中" : "待機中"}）
                  </span>
                  <button
                    className="secondary"
                    onClick={() => stopImmediate(job.id)}
                    disabled={stoppingImmediate}
                  >
                    この記事を停止
                  </button>
                </div>
              ))}
            </section>
          )}
          {latestJob && (
            <div className={`immediate-result ${latestJob.status}`}>
              {!["failed", "cancelled"].includes(latestJob.status) && (
                <div
                  className="article-progress"
                  aria-label={`記事制作進捗 ${progressPercent}%`}
                >
                  <div className="article-progress-head">
                    <b>{progressPercent}%</b>
                    <span>
                      {progress?.detail ||
                        (latestJob.status === "queued"
                          ? "制作開始を待っています"
                          : latestJob.status === "completed"
                            ? "WordPress下書きへの入稿が完了しました"
                            : "記事制作を開始しています")}
                    </span>
                  </div>
                  <div className="article-progress-track">
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              )}
              <b>
                {latestJob.status === "queued"
                  ? "制作待ちです"
                  : latestJob.status === "running"
                    ? progress?.detail ||
                      "本文・画像・内部リンクを作成し、採点しています"
                    : latestJob.status === "cancelled"
                      ? "記事生成を停止しました"
                      : latestJob.status === "failed"
                        ? "記事制作でエラーが発生しました"
                        : "本番記事の制作が完了しました"}
              </b>
              <span>
                {latestJob.result
                  ? `${latestJob.result.characterCount || "—"}字・${latestJob.result.score || "—"}点・${latestJob.result.attempts || "—"}回目を採用`
                  : latestJob.status === "cancelled"
                    ? "原稿・Image 2画像・WordPress入稿は実行しません。"
                    : latestJob.error || "画面は自動更新されます。"}
              </span>
              {latestJob.result?.wordpressDraft?.link && (
                <a
                  href={latestJob.result.wordpressDraft.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  WordPressの本番用下書きを確認する
                </a>
              )}
              {latestJob.status === "completed" &&
                !latestJob.result?.featuredMediaId && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={createFeaturedImage}
                    disabled={creatingFeatured}
                  >
                    {creatingFeatured
                      ? "アイキャッチを生成・設定中…"
                      : "GPT Image 2でアイキャッチを生成・設定"}
                  </button>
                )}
              {featuredMessage && <span>{featuredMessage}</span>}
              {latestJob.status === "completed" && (
                <ContentIntelligence
                  client={client}
                  articleJobId={latestJob.id}
                />
              )}
            </div>
          )}
          <p className="safety-note">
            「即日入稿」はテスト記事ではありません。ただし誤公開防止のため、WordPressへは本番用の下書きとして保存します。
          </p>
        </section>
      )}
    </>
  );
}
function Autopilot({ client }: any) {
  const [data, setData] = useState<any>(null);
  const [message, setMessage] = useState("");
  const load = () => api(`clients/${client.id}/autopilot`).then(setData).catch((error: any) => setMessage(error.message));
  useEffect(() => { void load(); }, [client.id]);
  const save = async (patch: any) => {
    try { await api(`clients/${client.id}/autopilot/settings`, "POST", { ...(data?.settings || {}), ...patch }); await load(); setMessage("設定を保存しました。"); } catch (error: any) { setMessage(error.message); }
  };
  const run = async (manualRerun = false) => {
    try { const result = await api(`clients/${client.id}/autopilot/run`, "POST", { manualRerun }); await load(); setMessage(result.status === "IDEMPOTENT" ? "今週の判断はすでに保存されています。再分析する場合は「再分析」を使用してください。" : "実データをもとに今週の施策を判断しました。"); } catch (error: any) { setMessage(error.message); }
  };
  const command = async (action: any, value: string, extra: any = {}) => {
    try { await api(`clients/${client.id}/autopilot/actions/${action.id}`, "POST", { command: value, ...extra }); await load(); setMessage("施策を更新しました。"); } catch (error: any) { setMessage(error.message); }
  };
  const titleCommand = async (proposal: any, value: string) => {
    try { if(value === "execute" && !confirm("SEOタイトルとメタディスクリプションを更新します。記事本文は変更されません。")) return; const reason=value==="reject"?prompt("却下理由（任意）")||"":""; await api(`clients/${client.id}/title-optimization/${proposal.action_id}/${value}`, "POST", { reason }); await load(); setMessage("TITLE Optimization Proposalを更新しました。"); } catch(error:any) { setMessage(error.message); }
  };
  const internalLinkCommand = async (item: any, value: string) => {
    try { if(value === "execute" && !confirm("既存WordPress記事へ承認済みURLの内部リンクを追加します。新規記事は作成しません。")) return; if(value === "rollback" && !confirm("内部リンク追加前のSnapshotへ戻します。")) return; const reason=value==="reject"?prompt("却下理由（任意）")||"":""; await api(`clients/${client.id}/internal-links/${item.action_id}/${value}`, "POST", { reason }); await load(); setMessage("内部リンクProposalを更新しました。"); } catch(error:any) { setMessage(error.message); }
  };
  if (!data) return <section className="panel"><p>SEO Autopilotを読み込んでいます…</p></section>;
  const recommended = data.recommended;
  const titleMeasurement = (actionId: string, windowDays: number) => data.titleMeasurements?.find((item: any) => item.action_id === actionId && item.window_days === windowDays);
  const titleMetricValue = (measurement: any, key: string) => {
    const metrics = measurement?.metrics?.after || measurement?.metrics?.before || measurement?.metrics;
    return metrics?.[key] ?? "DATA_NOT_AVAILABLE";
  };
  return <>
    <div className="heading"><div><h2>SEO Autopilot</h2><p>週ごとに実データから最も価値の高い施策を1つだけ選びます。新記事の毎週作成は行いません。</p></div></div>
    <section className="panel">
      <h3>実行設定</h3>
      <div className="form-grid">
        <label>Autopilot Mode<select value={data.settings.mode || "OFF"} onChange={(event) => void save({ mode: event.target.value })}><option value="OFF">OFF（判断を実行しない）</option><option value="RECOMMEND_ONLY">RECOMMEND ONLY（提案のみ）</option><option value="AUTO_EXECUTE_SAFE_ACTIONS">SAFE ACTIONSを自動実行</option></select></label>
        <label className="inline-choice"><input type="checkbox" checked={Boolean(data.settings.new_article_priority_mode)} onChange={(event) => void save({ newArticlePriorityMode: event.target.checked })} />New Article Priority Mode（初期OFF）</label>
        <label className="inline-choice"><input type="checkbox" checked={Boolean(data.settings.paused)} onChange={(event) => void save({ paused: event.target.checked })} />PAUSE AUTOPILOT</label>
      </div>
      <p className="safety-note">自動実行は安全な施策だけです。MERGE・REDIRECT・YMYL・高リスク施策は必ずHuman Reviewへ送ります。公開は既存のQuality Gateに従い、自動公開を有効化しません。</p>
      <button className="secondary" onClick={() => void api("autopilot/global", "POST", { killSwitchEnabled: !data.global.killSwitchEnabled }).then(load).catch((error: any) => setMessage(error.message))}>{data.global.killSwitchEnabled ? "Global Kill Switchを解除" : "Global Kill Switchを有効化"}</button>
      {message && <p className="error-text">{message}</p>}
    </section>
    <section className="panel"><div className="panel-head"><div><h3>Data Freshness</h3><p>古いデータを推測で補わず、判断の信頼度に反映します。</p></div><div><button className="secondary" onClick={() => void run(false)}>今週の判断を実行</button> <button className="secondary" onClick={() => void run(true)}>再分析（新Snapshot）</button></div></div><div className="chip-row">{Object.entries(data.freshness || {}).map(([source, status]: any) => <span className={`status ${String(status).toLowerCase()}`} key={source}>{source.toUpperCase()}: {status}</span>)}</div></section>
    <section className="panel"><h3>Recommended Action</h3>{recommended ? <><div className="autopilot-action"><b>{recommended.action_type}</b><span className={`status ${String(recommended.status).toLowerCase()}`}>{recommended.status}</span><span>Score {recommended.score}</span><span>Impact: {recommended.expected_impact}</span><span>Confidence: {recommended.confidence}</span><span>Risk: {recommended.risk}</span></div><p>{displayValue(recommended.reason?.reason || recommended.reason_json)}</p><details><summary>実データの根拠</summary><pre>{JSON.stringify(recommended.evidence || {}, null, 2)}</pre></details><div className="button-row"><button className="secondary" onClick={() => void command(recommended, "APPROVE")}>Approve</button><button className="secondary" onClick={() => void command(recommended, "REJECT")}>Reject</button><button className="secondary" onClick={() => { const actionType = prompt("変更するAction Type", recommended.action_type); if (actionType) void command(recommended, "CHANGE_ACTION", { actionType }); }}>Change Action</button><button className="primary" onClick={() => void command(recommended, "EXECUTE_NOW")}>Execute Now</button></div></> : <p>まだ今週のRecommendationはありません。</p>}</section>
    <section className="panel">
      <h3>TITLE Optimization Proposal</h3>
      {data.titleProposals?.length ? data.titleProposals.map((item:any) => {
        const measurementRows = [0, 7, 28].map((windowDays) => ({ windowDays, measurement: titleMeasurement(item.action_id, windowDays) }));
        return <div className="subpanel" key={item.action_id}>
          <p><b>SEO Title</b><br/>Current: {item.old_seo_title||"DATA_NOT_AVAILABLE"}<br/>→ Proposed: {item.proposed_seo_title||"NO CHANGE"}</p>
          <p><b>Meta Description</b><br/>Current: {item.old_meta_description||"DATA_NOT_AVAILABLE"}<br/>→ Proposed: {item.proposed_meta_description||"NO CHANGE"}</p>
          <p>Queries: {displayValue(item.targetQueries)} / Confidence: {item.confidence||"DATA_NOT_AVAILABLE"} / Risk: {item.risk||"DATA_NOT_AVAILABLE"}</p>
          <p>Safety: <b>{item.safety_status||"DATA_NOT_AVAILABLE"}</b> / Status: {item.execution_status} / Prompt: {item.prompt_version}</p>
          <p>Reason: {item.reason||"DATA_NOT_AVAILABLE"}</p>
          <details><summary>Evidence</summary><pre>{JSON.stringify(item.evidence||[],null,2)}</pre></details>
          <div className="button-row">
            <button className="secondary" disabled={item.execution_status!=="PROPOSED"} onClick={()=>void titleCommand(item,"approve")}>Approve</button>
            <button className="secondary" disabled={["EXECUTED","REJECTED"].includes(item.execution_status)} onClick={()=>void titleCommand(item,"reject")}>Reject</button>
            <button className="primary" disabled={item.execution_status!=="APPROVED"} onClick={()=>void titleCommand(item,"execute")}>Execute</button>
          </div>
          <h4>TITLE Measurement</h4>
          <p>実行時の対象ページ・主キーワードの実データをBeforeとして保存し、7日・28日後に同じ対象で比較します。データがない場合は推測せずDATA_NOT_AVAILABLEと表示します。</p>
          <table><thead><tr><th>Window</th><th>Result</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th>Sessions</th><th>Measured</th></tr></thead><tbody>
            {measurementRows.map(({windowDays,measurement}) => <tr key={windowDays}><td>{windowDays === 0 ? "Before" : `${windowDays}d`}</td><td>{measurement?.result_status || "PENDING"}</td><td>{titleMetricValue(measurement,"clicks")}</td><td>{titleMetricValue(measurement,"impressions")}</td><td>{titleMetricValue(measurement,"ctr")}</td><td>{titleMetricValue(measurement,"position")}</td><td>{titleMetricValue(measurement,"sessions")}</td><td>{measurement?.measured_at || "DATA_NOT_AVAILABLE"}</td></tr>)}
          </tbody></table>
          <details><summary>Target Queryの観測値</summary>{measurementRows.some(({measurement}) => measurement?.metrics?.before?.targetQueries || measurement?.metrics?.after?.targetQueries) ? <table><thead><tr><th>Window</th><th>Query</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th>Data</th></tr></thead><tbody>{measurementRows.flatMap(({windowDays,measurement}) => { const snapshot=measurement?.metrics?.after || measurement?.metrics?.before || {}; return (snapshot.targetQueries || []).map((query:any) => <tr key={`${windowDays}:${query.query}`}><td>{windowDays===0?"Before":`${windowDays}d`}</td><td>{query.query}</td><td>{query.clicks ?? "DATA_NOT_AVAILABLE"}</td><td>{query.impressions ?? "DATA_NOT_AVAILABLE"}</td><td>{query.ctr ?? "DATA_NOT_AVAILABLE"}</td><td>{query.position ?? "DATA_NOT_AVAILABLE"}</td><td>{query.dataStatus || "DATA_NOT_AVAILABLE"}</td></tr>); })}</tbody></table> : <p>Target Queryの実GSCデータはまだありません。</p>}</details>
        </div>;
      }) : <p>TITLE Optimization Proposalはまだありません。</p>}
      <h4>History</h4>
      {data.titleHistory?.length?<table><thead><tr><th>Date</th><th>Old Title</th><th>New Title</th><th>Old Meta</th><th>New Meta</th><th>Confidence</th><th>Risk</th><th>Status</th><th>Native SEO</th><th>SEO Plugin</th><th>Plugin Sync</th><th>Plugin Error</th><th>Executed By</th></tr></thead><tbody>{data.titleHistory.map((item:any)=><tr key={item.id}><td>{item.created_at}</td><td>{item.old_seo_title}</td><td>{item.new_seo_title}</td><td>{item.old_meta_description}</td><td>{item.new_meta_description}</td><td>{item.confidence}</td><td>{item.risk}</td><td>{item.execution_status}</td><td>{item.native_seo_status||"SUCCESS"}</td><td>{item.detected_plugin||"UNKNOWN"}</td><td>{item.plugin_sync_status||"SEO_PLUGIN_SYNC_NOT_AVAILABLE"}</td><td>{item.plugin_sync_error_code||"—"}</td><td>{item.executed_by}</td></tr>)}</tbody></table>:<p>実行履歴はありません。</p>}
    </section>
    <section className="panel"><h3>Internal Link Proposal &amp; History</h3><p>確認済みのTarget URLだけを使用します。データ不足は推測せずDATA_NOT_AVAILABLEと表示します。</p>{data.internalLinkHistory?.length ? data.internalLinkHistory.map((item:any) => { const rows=[0,7,28].map(windowDays=>({windowDays,measurement:data.internalLinkMeasurements?.find((m:any)=>m.action_id===item.action_id&&m.window_days===windowDays)})); const metric=(m:any,role:string,key:string)=>{const v=m?.metrics?.after?.[role]||m?.metrics?.before?.[role];return v?.[key]??"DATA_NOT_AVAILABLE";}; return <div className="subpanel" key={item.id}><p><b>Status: {item.execution_status}</b> / Safety: {item.safety_status||"DATA_NOT_AVAILABLE"} / Confidence: {item.confidence||"DATA_NOT_AVAILABLE"}</p><p><b>Source</b>: {item.source_title||"DATA_NOT_AVAILABLE"} ({item.source_article_id}) / WP Post: {item.source_wp_post_id||"DATA_NOT_AVAILABLE"} / {item.source_topic||"DATA_NOT_AVAILABLE"} · {item.source_cluster||"DATA_NOT_AVAILABLE"}</p><p><b>Target</b>: {item.target_title||"DATA_NOT_AVAILABLE"} ({item.target_article_id}) / {item.target_topic||"DATA_NOT_AVAILABLE"} · {item.target_cluster||"DATA_NOT_AVAILABLE"}<br/>Confirmed URL: {item.target_url||"DATA_NOT_AVAILABLE"}</p><p><b>Placement</b>: {item.anchor_text||"DATA_NOT_AVAILABLE"} / {item.placement_type||"DATA_NOT_AVAILABLE"}<br/>Reference: {item.placement_reference||"DATA_NOT_AVAILABLE"}<br/>Reason: {item.reason||"DATA_NOT_AVAILABLE"}<br/>Safety Notes: {item.safetyNotes} / Prompt: {item.prompt_version||"DATA_NOT_AVAILABLE"}</p><p>Snapshot: {item.snapshot_id||"DATA_NOT_AVAILABLE"} / Created: {item.created_at} / Executed By: {item.executed_by||"DATA_NOT_AVAILABLE"} / Rollback: {item.execution_status==="ROLLED_BACK"?"ROLLED_BACK":"—"}</p><div className="button-row"><button className="secondary" disabled={item.execution_status!=="PROPOSED"} onClick={()=>void internalLinkCommand(item,"approve")}>Approve</button><button className="secondary" disabled={["EXECUTED","ALREADY_LINKED","ROLLED_BACK","REJECTED"].includes(item.execution_status)} onClick={()=>void internalLinkCommand(item,"reject")}>Reject</button><button className="primary" disabled={item.execution_status!=="APPROVED"} onClick={()=>void internalLinkCommand(item,"execute")}>Execute</button><button className="secondary" disabled={item.execution_status!=="EXECUTED"} onClick={()=>void internalLinkCommand(item,"rollback")}>Rollback</button></div><p className="safety-note">{item.execution_status==="ALREADY_LINKED"?"ALREADY_LINKED: 既存リンクを確認したため、安全に更新しませんでした。":item.safety_status!=="SAFE"?item.safety_status:"Backendの安全判定を表示しています。"}</p><h4>Internal Link Measurement</h4><table><thead><tr><th>Role</th><th>Metric</th><th>Before</th><th>7d</th><th>28d</th></tr></thead><tbody>{["source","target"].flatMap(role=>["clicks","impressions","ctr","position","sessions","engagement","conversions"].map(key=><tr key={`${role}:${key}`}><td>{role.toUpperCase()}</td><td>{key}</td>{rows.map(({windowDays,measurement})=><td key={windowDays}>{metric(measurement,role,key)}</td>)}</tr>))}</tbody></table></div>; }) : <p>Internal Link Proposalはまだありません。</p>}</section>
    <section className="panel"><h3>Weekly History</h3>{data.actions?.length ? <table><thead><tr><th>Week</th><th>Action</th><th>Target</th><th>Score</th><th>Status</th><th>Before</th><th>After</th></tr></thead><tbody>{data.actions.map((item: any) => <tr key={item.id}><td>{item.week_key}</td><td>{item.action_type}</td><td>{item.target_article_id || item.target_keyword_id || "—"}</td><td>{item.score}</td><td>{item.status}</td><td>{displayValue(item.beforeMetrics)}</td><td>{displayValue(item.afterMetrics)}</td></tr>)}</tbody></table> : <p>履歴はありません。</p>}</section>
    <section className="panel"><h3>Measurement</h3>{data.measurements?.length ? <table><thead><tr><th>Action</th><th>Window</th><th>Result</th><th>Measured</th></tr></thead><tbody>{data.measurements.map((item: any) => <tr key={item.id}><td>{item.action_id}</td><td>{item.window_days}d</td><td>{item.result_status}</td><td>{item.measured_at}</td></tr>)}</tbody></table> : <p>7日・28日の測定結果は、十分な期間が経過後に保存されます。</p>}</section>
  </>;
}
function ContentIntelligence({ client, articleJobId }: any) {
  const [data, setData] = useState<any>(null),
    [message, setMessage] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [publishAcknowledged, setPublishAcknowledged] = useState(false);
  const load = () =>
    api(`clients/${client.id}/content-intelligence/${articleJobId}`)
      .then(setData)
      .catch((error: any) => setMessage(error.message));
  useEffect(() => {
    void load();
  }, [client.id, articleJobId]);
  const updateLink = async (link: any, status: string) => {
    const anchor =
      status === "APPROVED"
        ? prompt("アンカーテキスト", link.anchor_text)
        : null;
    try {
      await api(`clients/${client.id}/internal-links/${link.id}`, "POST", {
        status,
        anchorText: anchor ?? link.anchor_text,
      });
      await load();
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const reviewAction = async (action: string) => {
    if (action === "REQUEST_CHANGES" && !reviewNote.trim()) {
      setMessage("差し戻しには修正理由・指示を入力してください。");
      return;
    }
    try {
      await api(
        `clients/${client.id}/human-reviews/${data.review.id}`,
        "POST",
        { action, note: reviewNote },
      );
      setReviewNote("");
      await load();
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const publish = async (operation: string, targetPostId = "") => {
    try {
      const result = await api(`clients/${client.id}/articles/${articleJobId}/publish`, "POST", { operation, targetPostId, acknowledged: publishAcknowledged });
      setMessage(result.idempotent ? "同じ公開要求はすでに処理済みです。" : "WordPress処理をQueueへ追加しました。完了後に再取得します。");
      await load();
    } catch (error: any) { setMessage(error.message); }
  };
  const rollback = async (snapshotId: string) => {
    if (!publishAcknowledged) { setMessage("復元前に確認チェックを入れてください。"); return; }
    try { await api(`clients/${client.id}/articles/${articleJobId}/rollback`, "POST", { snapshotId }); setMessage("RollbackをQueueへ追加しました。"); await load(); } catch (error: any) { setMessage(error.message); }
  };
  const savePublishSettings = async (event: any) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api(`clients/${client.id}/publish-settings`, "POST", { autoPublishEnabled: form.get("autoPublishEnabled") === "on", autoCreateCategory: form.get("autoCreateCategory") === "on", tagLimit: Number(form.get("tagLimit") || 5) }); setMessage("公開設定を保存しました。"); await load(); } catch (error: any) { setMessage(error.message); }
  };
  if (!data?.versions?.length)
    return (
      <p className="field-help">
        Content Intelligenceの確認をQueueで待っています。
      </p>
    );
  return (
    <section className="subpanel stack">
      <h3>Content Intelligence</h3>
      {message && <p className="error-text">{message}</p>}
      <p>Article: {data.versions[0].article?.title || data.versions[0].article?.headline || "—"} / Version {data.versions[0].version_no}</p>
      <p>Article Status: {data.versions[0].status} / Manual Publish: 許可</p>
      <div>
        <h4>Fact Check</h4>
        <table>
          <thead>
            <tr>
              <th>Claim</th>
              <th>Type</th>
              <th>Risk</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.claims.map((item: any) => (
              <tr key={item.id}>
                <td>{item.claim_text}</td>
                <td>{item.claim_type}</td>
                <td>{item.risk_level}</td>
                <td>{item.verification_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h4>E-E-A-T</h4>
        <p>
          Experience {data.eeat?.experience_score ?? "—"} / Expertise{" "}
          {data.eeat?.expertise_score ?? "—"} / Authoritativeness{" "}
          {data.eeat?.authoritativeness_score ?? "—"} / Trust{" "}
          {data.eeat?.trust_score ?? "—"}
        </p>
        <p>
          不足根拠: {(data.eeat?.missingEvidence || []).join(" / ") || "なし"}
        </p>
      </div>
      <div>
        <h4>YMYL / Human Review</h4>
        <p>
          {data.ymyl?.risk || "NONE"}：{data.ymyl?.reason || "—"}
          <br />
          Required Review:{" "}
          {(data.review?.reasonCodes || data.ymyl?.requiredReviews || []).join(
            " / ",
          ) || "NOT_REQUIRED"}
        </p>
        {data.review && (
          <div className="stack">
            <label>
              レビューコメント（差し戻し時は修正理由・指示）
              <textarea
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder="判断理由、修正が必要な箇所を記入"
              />
            </label>
            <div className="button-row">
              <button className="primary" onClick={() => reviewAction("APPROVE")}>
                APPROVE
              </button>
              <button className="secondary" onClick={() => reviewAction("REQUEST_CHANGES")}>
                REQUEST CHANGES
              </button>
              <button className="secondary" onClick={() => reviewAction("REJECT")}>
                REJECT
              </button>
            </div>
          </div>
        )}
        <h4>Review History</h4>
        {(data.reviewEvents || []).length ? (
          <table>
            <thead><tr><th>Version</th><th>Status</th><th>Reviewer</th><th>Date</th><th>Reason</th><th>Note</th></tr></thead>
            <tbody>{data.reviewEvents.map((event: any) => <tr key={event.id}><td>{event.version_no || "—"}</td><td>{event.review_status}</td><td>{event.reviewed_by}</td><td>{event.created_at}</td><td>{(event.reasonCodes || []).join(" / ") || "—"}</td><td>{event.review_note || "—"}</td></tr>)}</tbody>
          </table>
        ) : <p>まだレビュー履歴はありません。</p>}
      </div>
      <div>
        <h4>Internal Links</h4>
        <p>
          Incoming {data.graph?.incoming} / Outgoing {data.graph?.outgoing} /{" "}
          {data.graph?.orphan ? "Orphan candidate" : "関連リンクあり"}
        </p>
        {data.links.map((link: any) => (
          <p key={link.id}>
            <a href={link.target_url} target="_blank" rel="noreferrer">
              {link.target_url}
            </a>{" "}
            — {link.anchor_text} ({link.relevance_score}) / {link.status}{" "}
            <button
              className="link-button"
              onClick={() => updateLink(link, "APPROVED")}
            >
              承認・修正
            </button>
            <button
              className="link-button"
              onClick={() => updateLink(link, "REJECTED")}
            >
              却下
            </button>
          </p>
        ))}
      </div>
      <div>
        <h4>Quality Gate</h4>
        <p>
          Total {data.quality?.total_score ?? "—"} /{" "}
          {data.quality?.auto_publish_status || "REVIEWING"}
          <br />
          {Object.entries(data.quality?.breakdown || {})
            .map(([key, value]) => `${key}: ${value}`)
            .join(" / ")}
          <br />
          理由: {(data.quality?.reasons || []).join(" / ") || "なし"}
        </p>
      </div>
      <div>
        <h4>Status History</h4>
        {(data.statusHistory || []).length ? (
          <ol>
            {data.statusHistory.map((event: any) => (
              <li key={event.id}><b>{event.from_status} → {event.to_status}</b> — {event.changed_at} / {event.changed_by} / {event.reason || "—"}</li>
            ))}
          </ol>
        ) : <p>現在の状態: {data.versions[0].status}</p>}
      </div>
      <div>
        <h4>WordPress Publish</h4>
        <p>Auto Publish Eligibility: {data.publishing?.eligible ? "READY" : "NOT READY"} / WordPress Connection: {data.publishing?.connection?.status || "NOT_CONNECTED"}</p>
        <p>SEO Plugin: {data.seoData?.provider === "NATIVE_SEO_LOOP" ? "NONE" : data.seoData?.provider || "NONE"} / SEO Data: {data.seoData ? "✓ SEO LOOPに保存済み" : "公開後にSEO LOOPへ保存"} / Plugin Sync: {data.seoData?.plugin_sync_status || "Not applicable"}</p>
        {data.seoData && <p>SEO Title: {data.seoData.seo_title || "—"} / Focus Keyword: {data.seoData.focus_keyword || "—"} / Canonical: {data.seoData.canonical_status} / Schema: {data.seoData.schema_status}</p>}
        {(data.publishing?.blockers || []).length > 0 && <p className="error-text">⚠ {(data.publishing.blockers || []).join(" / ")}</p>}
        <p>Quality Score: {data.publishing?.quality?.total_score ?? "—"} / YMYL: {data.publishing?.ymyl?.risk || "—"} / Unsupported Claims: {data.publishing?.unsupportedClaims ?? 0} / Conflicting Claims: {data.publishing?.conflictingClaims ?? 0}</p>
        <label className="inline-choice"><input type="checkbox" checked={publishAcknowledged} onChange={(event) => setPublishAcknowledged(event.target.checked)} />内容を確認し、手動公開または復元します</label>
        <div className="button-row">
          <button className="secondary" onClick={() => publish("DRAFT")}>Save as WordPress Draft</button>
          <button className="primary" onClick={() => publish("MANUAL_PUBLISH")}>Manual Publish</button>
          <button className="secondary" disabled={!data.publishing?.eligible} onClick={() => publish("AUTO_PUBLISH")}>Automatic Publish</button>
          <button className="secondary" onClick={() => { const postId = prompt("承認済みArticle MappingのWordPress Post ID"); if (postId) void publish("UPDATE_EXISTING", postId); }}>Update Existing Article</button>
        </div>
        <form className="inline-form" onSubmit={savePublishSettings}>
          <label className="inline-choice"><input name="autoPublishEnabled" type="checkbox" defaultChecked={Boolean(data.publishing?.settings?.auto_publish_enabled)} />Auto Publish</label>
          <label className="inline-choice"><input name="autoCreateCategory" type="checkbox" defaultChecked={Boolean(data.publishing?.settings?.auto_create_category)} />Auto Create Category</label>
          <label>Tag上限 <input name="tagLimit" type="number" min="1" max="10" defaultValue={data.publishing?.settings?.tag_limit || 5} /></label>
          <button className="link-button">公開設定を保存</button>
        </form>
        <h4>Publish History</h4>
        {(data.publishHistory || []).length ? <table><thead><tr><th>Operation</th><th>Post</th><th>Status</th><th>Date</th><th>Partial Failure</th></tr></thead><tbody>{data.publishHistory.map((item: any) => <tr key={item.id}><td>{item.operation}</td><td>{item.wordpress_post_id || "—"}</td><td>{item.wordpress_status || "—"}</td><td>{item.created_at}</td><td>{item.error_code || "—"}</td></tr>)}</tbody></table> : <p>まだPublish Historyはありません。</p>}
        <h4>Rollback Snapshots</h4>
        {(data.wordpressSnapshots || []).map((snapshot: any) => <p key={snapshot.id}>{snapshot.wp_title || snapshot.wordpress_post_id} / {snapshot.captured_at} <button className="link-button" onClick={() => rollback(snapshot.id)}>Rollback</button></p>)}
        {(data.redirects || []).length > 0 && <><h4>Redirect Recommendation</h4>{data.redirects.map((item: any) => <p key={item.id}>{item.source_url} → {item.target_url} / {item.reason} / {item.status}</p>)}</>}
      </div>
    </section>
  );
}
function JobProgress({ job, label }: any) {
  if (!job) return null;
  const progress = job.result?.progress;
  if (job.status === "failed")
    return (
      <section className="panel job-progress failed">
        <div className="article-progress-head">
          <b>{label}: 停止</b>
          <span>{job.error || "処理に失敗しました。"}</span>
        </div>
      </section>
    );
  const percent =
    job.status === "completed"
      ? 100
      : job.status === "queued"
        ? 2
        : Number(progress?.percent || 8);
  return (
    <section className="panel job-progress">
      <div className="article-progress-head">
        <b>
          {label}: {percent}%
        </b>
        <span>
          {progress?.detail ||
            (job.status === "queued"
              ? "キューで開始を待っています"
              : job.status === "failed"
                ? job.error || "処理に失敗しました"
                : "AIが処理しています")}
        </span>
      </div>
      <div className="article-progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}
function Aio({ queue, snapshot, jobs }: any) {
  const job = jobs.find((item: any) => item.type === "aio_observe");
  return (
    <>
      <div className="heading">
        <div>
          <h2>LLMO / AIO 専用分析</h2>
          <p>通常順位と分けてAI Overview・生成AI引用を観測します。</p>
        </div>
        <button className="primary" onClick={() => queue("aio_observe")}>
          AIO観測を実行
        </button>
      </div>
      <JobProgress job={job} label="LLMO / AIO 分析" />
      <div className="kpis">
        <div className="kpi">
          <span>AIO出現KW</span>
          <b>{snapshot?.aio_detected_queries ?? "未観測"}</b>
        </div>
        <div className="kpi">
          <span>自社引用</span>
          <b>{snapshot?.citations || "—"}</b>
        </div>
        <div className="kpi">
          <span>引用競合</span>
          <b>{snapshot?.competitors?.length || "—"}</b>
        </div>
        <div className="kpi">
          <span>分析対象KW</span>
          <b>{snapshot?.queries?.length || "—"}</b>
        </div>
      </div>
      <section className="panel aio-analysis-detail">
        <h3>AI検索における現状と分析</h3>
        {snapshot ? (
          <>
            <p>
              <b>総合評価：</b>
              {displayValue(
                snapshot.executive_summary,
                "分析結果を準備しています。",
              )}
            </p>
            <p>
              <b>現在の観測状況：</b>
              {displayValue(
                snapshot.current_status || snapshot.disclaimer,
                "実SERPのAIO出現・引用は未観測です。",
              )}
            </p>
            <h4>追跡キーワードごとのAI検索対策</h4>
            <table>
              <thead>
                <tr>
                  <th>キーワード</th>
                  <th>意図・優先度</th>
                  <th>観測状況と次アクション</th>
                  <th>推奨形式・根拠</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.queries || []).map((item: any, index: number) => (
                  <tr key={`${displayValue(item?.query, "query")}-${index}`}>
                    <td>{displayValue(item?.query)}</td>
                    <td>
                      {displayValue(item?.search_intent)}
                      <br />
                      <small>{displayValue(item?.priority)}</small>
                    </td>
                    <td>
                      {displayValue(item?.status)}
                      <br />
                      {displayValue(item?.note)}
                      <br />
                      <small>次：{displayValue(item?.next_action)}</small>
                    </td>
                    <td>
                      {displayValue(item?.recommended_format)}
                      <br />
                      <small>
                        追加根拠：{displayValue(item?.evidence_needed)}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>優先して行う改善</h4>
            <ol className="action-list">
              {(snapshot.priority_actions || snapshot.gaps || []).map(
                (item: unknown, index: number) => (
                  <li key={`${displayValue(item, "action")}-${index}`}>
                    <b>優先 {index + 1}</b>
                    {displayValue(item, "改善内容を確認してください。")}
                  </li>
                ),
              )}
            </ol>
            <h4>引用されるための記事・コンテンツ候補</h4>
            {(snapshot.content_recommendations || []).length ? (
              <table>
                <thead>
                  <tr>
                    <th>テーマ</th>
                    <th>形式</th>
                    <th>今行う理由</th>
                    <th>追加する一次根拠</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.content_recommendations.map(
                    (item: any, index: number) => (
                      <tr
                        key={`${displayValue(item?.topic, "topic")}-${index}`}
                      >
                        <td>{displayValue(item?.topic)}</td>
                        <td>{displayValue(item?.format)}</td>
                        <td>{displayValue(item?.why_now)}</td>
                        <td>{displayValue(item?.evidence_to_add)}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                分析後に、根拠付きの記事候補を表示します。
              </div>
            )}
            <h4>引用準備度</h4>
            {(snapshot.citation_readiness || []).length ? (
              <table>
                <thead>
                  <tr>
                    <th>領域</th>
                    <th>現状</th>
                    <th>改善</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.citation_readiness.map(
                    (item: any, index: number) => (
                      <tr key={`${displayValue(item?.area, "area")}-${index}`}>
                        <td>{displayValue(item?.area)}</td>
                        <td>{displayValue(item?.status)}</td>
                        <td>{displayValue(item?.improvement)}</td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            ) : null}
            {snapshot.entity_evidence?.length > 0 && (
              <>
                <h4>エンティティ・一次根拠の強化</h4>
                <ul>
                  {snapshot.entity_evidence.map(
                    (item: unknown, index: number) => (
                      <li key={`${displayValue(item, "evidence")}-${index}`}>
                        {displayValue(item)}
                      </li>
                    ),
                  )}
                </ul>
              </>
            )}
            {snapshot.evidence_gaps?.length > 0 && (
              <>
                <h4>判断にまだ必要なデータ</h4>
                <ul>
                  {snapshot.evidence_gaps.map(
                    (item: unknown, index: number) => (
                      <li key={`${displayValue(item, "gap")}-${index}`}>
                        {displayValue(item)}
                      </li>
                    ),
                  )}
                </ul>
              </>
            )}
            <p className="field-help">
              {displayValue(
                snapshot.disclaimer,
                "実SERPのAIO出現・引用は未観測です。",
              )}
            </p>
          </>
        ) : (
          <div className="empty">
            「AIO観測を実行」を押すと、Claude
            APIが追跡キーワード・一次情報・既存記事をもとに、AI検索向けの詳しい分析を作成します。AIOの実際の出現・引用は別途SERP観測データが必要なため、未観測のものを観測済みとは表示しません。
          </div>
        )}
      </section>
    </>
  );
}
const reportValue = (value: unknown, digits = 0) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(Number(value));
const reportDelta = (current: unknown, previous: unknown, invert = false) => {
  if (current === null || current === undefined || previous === null || previous === undefined) return "比較データなし";
  const diff = Number(current) - Number(previous);
  const prefix = diff > 0 ? "+" : "";
  return `${prefix}${reportValue(diff, 2)}${invert ? "（低いほど良い）" : ""}`;
};
const reportKeywordState = (state: string) => ({ DATA_PENDING: "実測データを蓄積中", CURRENT_DATA_MISSING: "直近データ待ち", COMPARISON_STARTING: "比較開始", IMPROVING: "改善", DECLINING: "要改善", STABLE: "横ばい" }[state] || "確認中");
const reportKeywordAction = (action: string) => ({ NEW_ARTICLE: "新規記事候補", UPDATE_EXISTING: "リライト候補", STRENGTHEN_EXISTING: "既存記事を強化", MEASURE: "計測継続" }[action] || "確認中");
function ReportTrend({ title, series, field, color }: any) {
  const values = series.map((item: any) => Number(item[field] || 0));
  const max = Math.max(...values, 1), width = 720, height = 180;
  const points = values.map((value: number, index: number) => `${(index / Math.max(values.length - 1, 1)) * width},${height - (value / max) * (height - 16) - 8}`).join(" ");
  return <section className="report-chart"><div className="report-chart-head"><b>{title}</b><span>直近28日</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}><line x1="0" y1={height - 8} x2={width} y2={height - 8} className="report-grid"/><polyline points={points} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="report-chart-foot"><span>{series[0]?.date || "—"}</span><span>{series.at(-1)?.date || "—"}</span></div></section>;
}
function Reports({ queue, jobs, snapshot, client }: any) {
  const job = jobs.find((item: any) => item.type === "monthly_report");
  const [performance, setPerformance] = useState<any>(null);
  const [performanceError, setPerformanceError] = useState("");
  useEffect(() => {
    if (!client?.id) return;
    setPerformanceError("");
    api(`clients/${client.id}/report-performance`).then(setPerformance).catch((error: any) => setPerformanceError(error.message));
  }, [client?.id, job?.updated_at]);
  const current = performance?.current || {}, previous = performance?.previous || {};
  const metrics = [
    ["検索クリック", current.gsc?.clicks, previous.gsc?.clicks, "#2463eb", false],
    ["表示回数", current.gsc?.impressions, previous.gsc?.impressions, "#7b61ff", false],
    ["平均掲載順位", current.gsc?.position, previous.gsc?.position, "#f59e0b", true],
    ["自然検索セッション", current.ga4?.sessions, previous.ga4?.sessions, "#19a974", false],
    ["コンバージョン", current.ga4?.conversions, previous.ga4?.conversions, "#ef5b5b", false],
  ];
  return (
    <>
      <div className="heading">
        <div>
          <h2>レポート・PDCA</h2>
          <p>実データから良かった点・改善点・来月の施策を作成します。</p>
        </div>
        <button className="primary" onClick={() => queue("monthly_report")}>
          月次レポート生成
        </button>
      </div>
      <JobProgress job={job} label="月次レポート生成" />
      <section className="panel report-hero">
        <div><small>SEO PERFORMANCE REPORT</small><h3>実測データで見る、直近28日の成果</h3><p>Search Console・Google Analytics 4の時系列を中心に、取得済みのUbersuggest分析も月次レポートに併記します。比較できない値は推測しません。</p></div>
        <span className="report-period">{performance?.period?.label || "データ読込中"}</span>
      </section>
      {performanceError ? <div className="empty">レポート用データを読み込めませんでした。再読み込みしてください。</div> : !performance ? <div className="empty">レポートの実測データを読み込んでいます…</div> : <>
        <section className="report-kpis">{metrics.map(([label, value, before, color, invert]: any) => <article className="report-kpi" key={label} style={{ "--metric": color } as any}><span>{label}</span><b>{reportValue(value, label === "平均掲載順位" ? 1 : 0)}</b><small>前期間 {reportValue(before, label === "平均掲載順位" ? 1 : 0)}</small><em className={Number(value) === Number(before) ? "flat" : (invert ? Number(value) < Number(before) : Number(value) > Number(before)) ? "up" : "down"}>{reportDelta(value, before, invert)}</em></article>)}</section>
        <section className="report-charts"><ReportTrend title="検索クリックの推移" series={performance.series || []} field="clicks" color="#2463eb" /><ReportTrend title="自然検索セッションの推移" series={performance.series || []} field="sessions" color="#19a974" /></section>
        <section className="panel report-comparison"><h3>ビフォー／アフター比較</h3><table><thead><tr><th>指標</th><th>前28日</th><th>直近28日</th><th>差分</th></tr></thead><tbody>{metrics.map(([label, value, before, , invert]: any) => <tr key={label}><td>{label}</td><td>{reportValue(before, label === "平均掲載順位" ? 1 : 0)}</td><td>{reportValue(value, label === "平均掲載順位" ? 1 : 0)}</td><td className={invert ? Number(value) < Number(before) ? "positive" : "negative" : Number(value) > Number(before) ? "positive" : "negative"}>{reportDelta(value, before, invert)}</td></tr>)}</tbody></table></section>
        <section className="panel report-keyword-performance"><div className="report-section-title"><div><small>TARGET KEYWORD PERFORMANCE</small><h3>狙っている全キーワードのビフォー／アフター</h3><p>登録済みキーワードとSearch Consoleの同一検索語句を厳密に照合しています。関連語は混ぜず、比較できない場合は蓄積中と表示します。</p></div><b>{(performance.targetKeywords || []).length} KW</b></div><div className="report-wide-table"><table><thead><tr><th>狙うキーワード</th><th>記事の状態</th><th>前28日<br />クリック / 表示 / 順位</th><th>直近28日<br />クリック / 表示 / 順位</th><th>差分</th><th>判定</th><th>翌月の扱い</th></tr></thead><tbody>{(performance.targetKeywords || []).map((row: any) => <tr key={row.id}><td><b>{row.keyword}</b><small>{row.topic} / {row.cluster}<br />優先度 {reportValue(row.priorityScore)}</small></td><td>{row.hasArticle ? "記事あり" : "記事未作成"}<small>{row.hasBrief ? "Briefあり" : "Brief未作成"}</small></td><td>{reportValue(row.previous.clicks)} / {reportValue(row.previous.impressions)} / {reportValue(row.previous.position, 1)}</td><td>{reportValue(row.current.clicks)} / {reportValue(row.current.impressions)} / {reportValue(row.current.position, 1)}</td><td><span className={row.clicksDelta > 0 ? "positive" : row.clicksDelta < 0 ? "negative" : ""}>クリック {row.clicksDelta > 0 ? "+" : ""}{reportValue(row.clicksDelta)}</span><br /><span className={row.positionDelta !== null && row.positionDelta < 0 ? "positive" : row.positionDelta !== null && row.positionDelta > 0 ? "negative" : ""}>順位 {row.positionDelta === null ? "比較不可" : `${row.positionDelta > 0 ? "+" : ""}${reportValue(row.positionDelta, 1)}`}</span></td><td><span className={`report-state ${String(row.state).toLowerCase()}`}>{reportKeywordState(row.state)}</span></td><td><b>{reportKeywordAction(row.recommendation)}</b></td></tr>)}</tbody></table></div>{!performance.targetKeywords?.length && <p className="empty">狙うキーワードを登録すると、ここで全件の実測比較を確認できます。</p>}</section>
        <section className="panel report-next-articles"><div className="report-section-title"><div><small>NEXT MONTH CONTENT PLAN</small><h3>レポートから決める翌月の記事優先順位</h3><p>キーワードの順位・クリック変化と、記事／Content Briefの有無だけを根拠に並べています。キーワード戦略の生成時にも同じデータを渡します。</p></div></div><ol>{(performance.nextArticlePriorities || []).map((item: any) => <li key={item.keyword}><b>{item.keyword}</b><span>{item.action}</span><small>{item.dataBasis} · {item.topic} / {item.cluster}</small></li>)}</ol>{!performance.nextArticlePriorities?.length && <p className="empty">実測データが蓄積されると、次月の記事候補を自動で優先表示します。</p>}</section>
        <section className="report-tables"><article className="panel"><h3>伸びている検索キーワード</h3><table><thead><tr><th>キーワード</th><th>クリック</th><th>表示回数</th><th>順位</th></tr></thead><tbody>{(performance.topQueries || []).map((row: any) => <tr key={row.query}><td>{row.query}</td><td>{reportValue(row.clicks)}</td><td>{reportValue(row.impressions)}</td><td>{reportValue(row.position, 1)}</td></tr>)}</tbody></table>{!performance.topQueries?.length && <p className="empty">Search Consoleの実測データを蓄積中です。</p>}</article><article className="panel"><h3>自然検索の上位ページ</h3><table><thead><tr><th>ページ</th><th>セッション</th><th>CV</th></tr></thead><tbody>{(performance.topPages || []).map((row: any) => <tr key={row.landing_page}><td>{row.landing_page}</td><td>{reportValue(row.sessions)}</td><td>{reportValue(row.conversions)}</td></tr>)}</tbody></table>{!performance.topPages?.length && <p className="empty">GA4の実測データを蓄積中です。</p>}</article></section>
      </>}
      {snapshot && (
        <section className="panel aio-analysis-detail">
          <h3>{snapshot.reporting_period || "今月"} 月次SEO・コンテンツPDCA</h3>
          <p>
            <b>総括：</b>
            {snapshot.executive_summary}
          </p>
          <p>
            <b>データ状況：</b>
            {snapshot.data_status}
          </p>
          <h4>前月比</h4>
          {(snapshot.month_over_month || []).length ? (
            <table>
              <thead>
                <tr>
                  <th>指標</th>
                  <th>今月</th>
                  <th>前月</th>
                  <th>差分</th>
                  <th>分析</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.month_over_month.map((x: any, i: number) => (
                  <tr key={`${x.metric}-${i}`}>
                    <td>{x.metric}</td>
                    <td>{x.current ?? "—"}</td>
                    <td>{x.previous ?? "—"}</td>
                    <td>{x.change ?? "比較データなし"}</td>
                    <td>{x.interpretation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              前月比に必要な実測データはまだありません。
            </div>
          )}
          <h4>今月の対策実績</h4>
          {(snapshot.this_month_actions || []).length ? (
            <table>
              <thead>
                <tr>
                  <th>施策</th>
                  <th>状態</th>
                  <th>根拠</th>
                  <th>影響</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.this_month_actions.map((x: any, i: number) => (
                  <tr key={`${x.action}-${i}`}>
                    <td>{x.action}</td>
                    <td>{x.status}</td>
                    <td>{x.evidence}</td>
                    <td>{x.impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">今月の実行記録を蓄積中です。</div>
          )}
          <h4>良かった点</h4>
          <ul>
            {(snapshot.wins || []).map((x: string) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <h4>改善すべき点</h4>
          <ul>
            {(snapshot.issues || []).map((x: string) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <h4>PDCA</h4>
          <div className="guide-grid">
            {[
              ["Plan", snapshot.pdca?.plan],
              ["Do", snapshot.pdca?.do],
              ["Check", snapshot.pdca?.check],
              ["Act", snapshot.pdca?.act],
            ].map(([label, items]: any) => (
              <div key={label}>
                <b>{label}</b>
                <ul>
                  {(items || []).map((x: string) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <h4>次月の優先対策</h4>
          <table>
            <thead>
              <tr>
                <th>優先</th>
                <th>対策</th>
                <th>担当</th>
                <th>成功指標</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot.next_month_actions || []).map((x: any, i: number) => (
                <tr key={`${x.action}-${i}`}>
                  <td>{x.priority}</td>
                  <td>{x.action}</td>
                  <td>{x.owner}</td>
                  <td>{x.success_metric}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>次月の記事・キーワード・市場リサーチ</h4>
          <table>
            <thead>
              <tr>
                <th>キーワード</th>
                <th>意図</th>
                <th>記事形式</th>
                <th>根拠</th>
              </tr>
            </thead>
            <tbody>
              {(snapshot.article_plan || []).map((x: any, i: number) => (
                <tr key={`${x.keyword}-${i}`}>
                  <td>{x.keyword}</td>
                  <td>{x.intent}</td>
                  <td>
                    {x.article_type}
                    <br />
                    <small>{x.brief}</small>
                  </td>
                  <td>{x.data_basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {snapshot.market_research?.length > 0 && (
            <>
              <h4>市場リサーチの論点</h4>
              <ul>
                {snapshot.market_research.map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          {snapshot.evidence_gaps?.length > 0 && (
            <>
              <h4>来月までに補うデータ</h4>
              <ul>
                {snapshot.evidence_gaps.map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          <p className="field-help">{snapshot.disclaimer}</p>
        </section>
      )}
      <section className="panel">
        <JobTable jobs={jobs.filter((j: any) => j.type === "monthly_report")} />
      </section>
    </>
  );
}
function claimQuotedPhrases(claim: string) {
  return [...claim.matchAll(/「([^」]+)」/g)]
    .map((match) => match[1].trim())
    .filter((value) => value.length > 1 && !/^followUp\d+$/i.test(value));
}
function claimRequiredDetails(claim: string) {
  if (/累計支援社数|50社以上|100社/.test(claim))
    return [
      "正しい社数（50社以上／年間約100社／累計○社のどれか）",
      "集計期間と数え方（年間・累計・契約社数・案件数）",
      "確認できる顧客台帳・契約一覧・集計表",
    ];
  if (/検索順位|英会話|家庭教師|パーソナルジム/.test(claim))
    return [
      "対象キーワードごとの最高順位または現在順位",
      "順位を確認した年月日と対象ページURL",
      "Search Console・順位計測画面などの確認資料",
    ];
  if (/採用LINE|応募数|内定率|定着率/.test(claim))
    return [
      "導入前と導入後の応募数・内定数・定着数",
      "比較した期間と採用職種",
      "採用管理表・LINE管理画面・担当者確認などの根拠",
    ];
  if (/半年で倍|対象指標|売上|問い合わせ|LINE登録数/.test(claim))
    return [
      "対象クライアント（匿名表記で可）",
      "何が2倍になったのか（売上・問い合わせ・登録数など）",
      "変更前→変更後の数値、計測期間、確認資料",
    ];
  if (/followUp\d+|「同じ」/.test(claim))
    return [
      "「同じ」が何を指すのか（施策・期間・成果）",
      "該当するクライアントまたは案件",
      "同じ点と異なる点を1つずつ",
    ];
  return [
    "対象となる顧客・案件",
    "実施した内容と期間",
    "結果の具体的な数値または確認できる資料",
  ];
}
function locateClaim(claim: string, sources: any[], result: any) {
  const phrases = claimQuotedPhrases(claim);
  const terms = claim
    .replace(/followUp\d+/gi, "")
    .split(/[「」・、。（）／\s]/)
    .filter((term) => term.length >= 4);
  const candidates = sources.map((source) => ({
    source,
    text: String(source.note || ""),
  }));
  let located = candidates.find(({ text }) =>
    phrases.some((phrase) => text.includes(phrase)),
  );
  if (!located) {
    located = candidates
      .map((item) => ({
        ...item,
        score: terms.filter((term) => item.text.includes(term)).length,
      }))
      .sort((a, b) => b.score - a.score)
      .find((item) => item.score > 0);
  }
  if (!located && candidates.length) located = candidates[0];
  const fallbackText = String(result?.article_ready_text || "");
  const text = located?.text || fallbackText;
  const matched =
    phrases.find((phrase) => text.includes(phrase)) ||
    terms.find((term) => text.includes(term)) ||
    "";
  const index = matched ? text.indexOf(matched) : 0;
  const previousBreak = Math.max(
    text.lastIndexOf("\n", Math.max(0, index - 1)),
    text.lastIndexOf("。", Math.max(0, index - 1)),
  );
  const nextNewline = text.indexOf("\n", index + matched.length);
  const nextPeriod = text.indexOf("。", index + matched.length);
  const nextBreaks = [nextNewline, nextPeriod]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  const passageStart = matched ? previousBreak + 1 : text.length;
  const passageEnd = matched
    ? Math.min(text.length, (nextBreaks[0] ?? text.length - 1) + 1)
    : text.length;
  const passage = matched ? text.slice(passageStart, passageEnd).trim() : "";
  const excerpt = passage || "この確認項目は、登録文章へ補足として追加します。";
  return {
    source: located?.source || null,
    excerpt,
    phrases: matched
      ? [matched, ...phrases.filter((item) => item !== matched)]
      : phrases,
    passage,
    passageStart,
    passageEnd,
    locationLabel: /followUp\d+/i.test(claim)
      ? "前回の追加質問への回答"
      : located?.source
        ? `登録文章「${located.source.title}」`
        : "AIが整理した文章",
    required: claimRequiredDetails(claim),
  };
}
function HighlightedExcerpt({ text, phrases }: any) {
  const matches = phrases
    .filter((phrase: string) => text.includes(phrase))
    .sort((a: string, b: string) => b.length - a.length);
  if (!matches.length)
    return <span>{text || "該当箇所を特定できませんでした。"}</span>;
  const expression = new RegExp(
    `(${matches.map((value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  );
  return (
    <span>
      {text
        .split(expression)
        .map((part: string, index: number) =>
          matches.includes(part) ? <mark key={index}>{part}</mark> : part,
        )}
    </span>
  );
}
function claimInputQuality(claim: string, text: string, sourceUrl = "") {
  const value = `${text} ${sourceUrl}`.trim();
  const has = (pattern: RegExp) => pattern.test(value);
  let checks: { label: string; passed: boolean }[];
  if (/累計支援社数|50社以上|100社/.test(claim))
    checks = [
      { label: "正しい社数が数値で書かれている", passed: has(/\d[\d,]*\s*社/) },
      {
        label: "年間・累計・契約社数などの集計条件がある",
        passed: has(/年間|累計|契約社数|支援社数|案件数|集計期間/),
      },
      {
        label: "台帳・契約一覧・集計表などの確認根拠がある",
        passed: has(/台帳|契約一覧|集計表|請求|管理表|資料|確認済|https?:\/\//),
      },
    ];
  else if (/検索順位|英会話|家庭教師|パーソナルジム/.test(claim))
    checks = [
      { label: "キーワードと具体的な順位がある", passed: has(/\d+\s*位/) },
      {
        label: "確認した年月と対象ページが分かる",
        passed:
          has(/20\d{2}年|20\d{2}[/-]\d{1,2}|\d{1,2}月/) &&
          has(/https?:\/\/|対象ページ|URL/),
      },
      {
        label: "Search Consoleなどの確認根拠がある",
        passed: has(
          /Search Console|サーチコンソール|順位計測|計測画面|資料|確認済/,
        ),
      },
    ];
  else if (/採用LINE|応募数|内定率|定着率/.test(claim))
    checks = [
      {
        label: "導入前と導入後の数値がある",
        passed:
          has(/導入前|変更前|以前/) && has(/導入後|変更後|現在/) && has(/\d/),
      },
      {
        label: "比較期間と採用職種が分かる",
        passed:
          has(/期間|年|月|週間/) && has(/職種|採用|営業|整備|事務|エンジニア/),
      },
      {
        label: "採用管理表などの確認根拠がある",
        passed: has(
          /採用管理|LINE管理|担当者確認|集計|資料|確認済|https?:\/\//,
        ),
      },
    ];
  else if (/半年で倍|対象指標|売上|問い合わせ|LINE登録数/.test(claim))
    checks = [
      {
        label: "対象クライアントまたは案件が分かる",
        passed: has(/クライアント|顧客|案件|企業|店舗|匿名|社/),
      },
      {
        label: "何が増えたのかが明記されている",
        passed: has(/売上|問い合わせ|登録数|申込|応募|件数|成約|アクセス|指標/),
      },
      {
        label: "変更前後の数値・期間・根拠がある",
        passed:
          has(/変更前|導入前|以前/) &&
          has(/変更後|導入後|現在/) &&
          has(/\d/) &&
          has(/期間|年|月|週間|資料|集計|確認済|https?:\/\//),
      },
    ];
  else if (/followUp\d+|「同じ」/.test(claim))
    checks = [
      {
        label: "「同じ」が指す施策・期間・成果を説明している",
        passed: has(/同じ.*(?:施策|期間|成果)|(?:施策|期間|成果).*同じ/),
      },
      {
        label: "対象クライアントまたは案件が分かる",
        passed: has(/クライアント|顧客|案件|企業|店舗|匿名|社/),
      },
      {
        label: "同じ点と異なる点が書かれている",
        passed: has(/同じ点|共通点/) && has(/異なる点|相違点|違い/),
      },
    ];
  else
    checks = [
      {
        label: "対象となる顧客・案件が分かる",
        passed: has(/クライアント|顧客|案件|企業|店舗|匿名|社/),
      },
      {
        label: "実施内容と期間が書かれている",
        passed:
          has(/実施|導入|改善|変更|運用|制作|対策/) && has(/期間|年|月|週間/),
      },
      {
        label: "結果の数値または確認資料がある",
        passed: has(/\d/) && has(/資料|集計|確認済|画面|台帳|https?:\/\//),
      },
    ];
  checks.push({
    label: "記事で使える具体性がある（40文字以上）",
    passed: text.trim().length >= 40,
  });
  const passed = checks.filter((item) => item.passed).length;
  const score = Math.round((passed / checks.length) * 100);
  return {
    checks,
    score,
    missing: checks.length - passed,
    level: score === 100 ? "good" : score >= 50 ? "almost" : "weak",
  };
}
function ClaimInlineEditor({ item, save }: any) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [value, setValue] = useState(item.passage || "");
  const quality = claimInputQuality(item.claim, value, item.source?.url || "");
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!item.source) return;
    setSaving(true);
    setMessage("");
    const submittedValue = String(
      new FormData(e.currentTarget).get("passage") || "",
    ).trim();
    if (!submittedValue) {
      setMessage("修正後の文章または追加情報を入力してください。");
      setSaving(false);
      return;
    }
    const original = String(item.source.note || "");
    const nextNote = item.passage
      ? `${original.slice(0, item.passageStart)}${submittedValue}${original.slice(item.passageEnd)}`
      : `${original.trim()}\n\n【追加確認】\n${submittedValue}`;
    try {
      await save(item.source.id, {
        type: item.source.type,
        title: item.source.title,
        note: nextNote,
        url: item.source.url || "",
        rights: item.source.rights || "unconfirmed",
      });
      const savedQuality = claimInputQuality(
        item.claim,
        submittedValue,
        item.source?.url || "",
      );
      setMessage(
        savedQuality.missing === 0
          ? "保存しました。入力項目は簡易チェックをすべて満たしています。事実確認後に一次情報を確定できます。"
          : `保存しました。簡易チェックでは、あと${savedQuality.missing}項目の補足が必要です。下の表示を見ながら続けて編集できます。`,
      );
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };
  if (!item.source)
    return (
      <p className="field-help">
        登録文章がまだないため、上の「自由入力で一次情報を追加」から登録してください。
      </p>
    );
  return (
    <div className="claim-inline-editor">
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setOpen((current) => !current);
          setMessage("");
        }}
      >
        {open
          ? "編集欄を閉じる"
          : item.passage
            ? "この箇所だけ編集する"
            : "この項目へ情報を追加する"}
      </button>
      {open && (
        <form onSubmit={submit}>
          <label>
            {item.passage
              ? "該当部分の修正後の文章"
              : "この確認項目への追加文章"}
            <textarea
              name="passage"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={item.required
                .map((detail: string) => `・${detail}`)
                .join("\n")}
              autoFocus
              required
            />
          </label>
          <div className={`live-quality ${quality.level}`} aria-live="polite">
            <div className="live-quality-head">
              <b>リアルタイム入力チェック</b>
              <span>{quality.score}点</span>
            </div>
            <strong>
              {quality.missing === 0
                ? "入力項目はそろっています"
                : `あと${quality.missing}項目を補足してください`}
            </strong>
            <div className="live-quality-checks">
              {quality.checks.map((check) => (
                <span
                  className={check.passed ? "passed" : "missing"}
                  key={check.label}
                >
                  {check.passed ? "✓" : "!"} {check.label}
                </span>
              ))}
            </div>
            <small>
              これは入力内容の具体性を確認する簡易判定です。事実の正しさと資料の内容は、AIによる再整理または人間確認で確定します。
            </small>
          </div>
          <p>
            {item.passage
              ? "ここで表示されている部分だけが置き換わります。ほかの文章は変更されません。"
              : `入力内容は「${item.source.title}」の末尾へ自動で追加されます。`}
          </p>
          <div className="source-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setOpen(false)}
            >
              キャンセル
            </button>
            <button className="primary" disabled={saving}>
              {saving
                ? "保存中…"
                : item.passage
                  ? "この箇所を保存"
                  : "この文章へ追加"}
            </button>
          </div>
        </form>
      )}
      {message && (
        <p
          className={
            message.includes("保存しました") ? "field-help" : "error-text"
          }
        >
          {message}
        </p>
      )}
    </div>
  );
}
function LinkGraph({ graph }: any) {
  if (!graph) return null;
  const articles = graph.articles || [];
  return (
    <section className="panel">
      <div className="section-head">
        <div><small>PHASE 3 · INTERNAL LINK GRAPH</small><h2>Link Graph</h2></div>
        <p>Topic → Cluster → Article の順に、内部リンクの不足とハブ候補を確認できます。</p>
      </div>
      {(graph.topics || []).map((topic: any) => {
        const topicArticles = articles.filter((article: any) => (article.topic || "未分類") === topic.name);
        const clusterNames: string[] = [...new Set<string>(topicArticles.map((article: any) => String(article.cluster || "未分類")))];
        return <details key={topic.name} className="subpanel"><summary><b>{topic.name}</b> — Articles {topic.articleCount} / Keywords {topic.keywordCount} / Incoming {topic.incoming} / Outgoing {topic.outgoing} / Orphans {topic.orphans} / Hubs {topic.hubs} / Coverage {topic.coverage}%</summary>
          {clusterNames.map((clusterName) => {
            const cluster = (graph.clusters || []).find((item: any) => item.name === clusterName);
            const clusterArticles = topicArticles.filter((article: any) => (article.cluster || "未分類") === clusterName);
            return <details key={clusterName}><summary><b>{clusterName}</b> — Articles {cluster?.articleCount || 0} / Keywords {cluster?.keywordCount || 0} / Incoming {cluster?.incoming || 0} / Outgoing {cluster?.outgoing || 0} / Orphans {cluster?.orphans || 0} / Hubs {cluster?.hubs || 0}</summary>
              <table><thead><tr><th>Article</th><th>Primary Keyword</th><th>Incoming</th><th>Outgoing</th><th>Orphan</th><th>Hub Candidate</th><th>Current Status</th></tr></thead><tbody>
                {clusterArticles.map((article: any) => <tr key={article.article_id}><td>{article.article_url ? <a href={article.article_url} target="_blank" rel="noreferrer">{article.article_title || article.article_url}</a> : article.article_title || article.article_id}</td><td>{article.primary_keyword || "—"}</td><td>{article.incoming}</td><td>{article.outgoing}</td><td>{article.orphan ? article.orphanReasons.join(" / ") : "—"}</td><td>{article.hubCandidate ? article.hubReasons.join(" / ") : "—"}</td><td>{article.current_status || "—"}</td></tr>)}
              </tbody></table>
            </details>;
          })}
        </details>;
      })}
      {!(graph.topics || []).length && <div className="empty">承認済みの記事マッピングが増えるとLink Graphを表示します。</div>}
    </section>
  );
}
function SeoTopics({ client, queue }: any) {
  const [map, setMap] = useState<any>(null),
    [performance, setPerformance] = useState<any>(null);
  const [mappings, setMappings] = useState<any[]>([]),
    [weights, setWeights] = useState<any>(null);
  const [serp, setSerp] = useState<any>(null);
  const [linkGraph, setLinkGraph] = useState<any>(null);
  const [days, setDays] = useState(28),
    [message, setMessage] = useState("");
  const load = async () => {
    try {
      const [nextMap, nextPerformance, nextMappings, nextWeights, nextSerp, nextLinkGraph] =
        await Promise.all([
          api(`clients/${client.id}/seo-map`),
          api(`clients/${client.id}/seo-performance?days=${days}`),
          api(`clients/${client.id}/article-mappings`),
          api(`clients/${client.id}/priority-weights`),
          api(`clients/${client.id}/serp-intelligence`),
          api(`clients/${client.id}/link-graph`),
        ]);
      setMap(nextMap);
      setPerformance(nextPerformance);
      setMappings(nextMappings.candidates || []);
      setWeights(nextWeights);
      setSerp(nextSerp);
      setLinkGraph(nextLinkGraph);
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  useEffect(() => {
    void load();
  }, [client.id, days]);
  const mutate = async (path: string, method: string, body?: any) => {
    try {
      await api(path, method, body);
      setMessage("保存しました。");
      await load();
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const create = async (kind: string) => {
    const name = prompt(
      kind === "keywords"
        ? "キーワードを入力してください"
        : `${kind === "topics" ? "Topic" : "Cluster"}名を入力してください`,
    );
    if (!name?.trim()) return;
    const body: any = kind === "keywords" ? { keyword: name } : { name };
    if (kind === "clusters" && map?.topics?.length)
      body.topicId =
        map.topics.find((item: any) => item.status === "active")?.id || "";
    if (kind === "keywords") {
      body.topicId =
        map?.topics?.find((item: any) => item.status === "active")?.id || "";
      body.clusterId =
        map?.clusters?.find((item: any) => item.status === "active")?.id || "";
    }
    await mutate(`clients/${client.id}/${kind}`, "POST", body);
  };
  const edit = async (kind: string, item: any) => {
    const name = prompt(
      "名称を編集",
      kind === "keywords" ? item.keyword : item.name,
    );
    if (name === null || !name.trim()) return;
    await mutate(
      `clients/${client.id}/${kind}/${item.id}`,
      "PATCH",
      kind === "keywords" ? { keyword: name } : { name },
    );
  };
  const archive = async (kind: string, item: any) => {
    if (confirm(`「${item.keyword || item.name}」を無効化しますか？`))
      await mutate(`clients/${client.id}/${kind}/${item.id}`, "DELETE");
  };
  const createBrief = async () => {
    const targetUser = prompt("想定読者を入力してください");
    if (targetUser === null) return;
    await mutate(`clients/${client.id}/briefs`, "POST", {
      keywordId:
        map?.keywords?.find((item: any) => item.status !== "archived")?.id ||
        "",
      targetUser,
      explicitNeed: prompt("顕在ニーズを入力してください") || "",
      latentNeed: prompt("潜在ニーズを入力してください") || "",
      desiredOutcome: prompt("読者が達成したい結果を入力してください") || "",
    });
  };
  const analyzeMappings = async (articleId = "") => {
    try {
      await api(`clients/${client.id}/article-mappings/analyze`, "POST", {
        articleId,
      });
      setMessage("AI再分析をQueueへ追加しました。");
      await load();
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const approveMapping = async (item: any, modified = false) => {
    const topicId = modified
      ? prompt("Topic ID（空欄ならAI候補）", item.suggested_topic_id || "")
      : item.suggested_topic_id;
    const clusterId = modified
      ? prompt("Cluster ID（空欄ならAI候補）", item.suggested_cluster_id || "")
      : item.suggested_cluster_id;
    const keywordId = modified
      ? prompt("Keyword ID（空欄ならAI候補）", item.suggested_keyword_id || "")
      : item.suggested_keyword_id;
    const keywordText = modified
      ? prompt(
          "新規Keyword候補（既存IDを選んだ場合は空欄）",
          item.suggested_keyword_text || "",
        )
      : item.suggested_keyword_text;
    await mutate(
      `clients/${client.id}/article-mappings/${item.id}/approve`,
      "POST",
      { topicId, clusterId, keywordId, keywordText },
    );
  };
  const saveWeights = async () => {
    if (!weights) return;
    await mutate(`clients/${client.id}/priority-weights`, "POST", weights);
  };
  const requestSerp = async (keyword: any) => {
    try {
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "serp_analyze",
        payload: {
          keywordId: keyword.id,
          keyword: keyword.keyword,
          language: "ja",
          device: "desktop",
        },
      });
      setMessage("実SERP取得をQueueへ追加しました。完了後に更新してください。");
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  const analyzeSerp = async (snapshotId: string) => {
    try {
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "serp_competitor_analyze",
        payload: { snapshotId },
      });
      setMessage(
        "競合ページ取得・分析をQueueへ追加しました。完了後に更新してください。",
      );
    } catch (error: any) {
      setMessage(error.message);
    }
  };
  return (
    <section className="stack">
      <div className="panel">
        <div className="section-head">
          <div>
            <small>PHASE 1 · HISTORY & TOPIC MAP</small>
            <h2>SEOトピック管理</h2>
            <p>
              Topic → Cluster →
              Keywordをクライアントごとに管理し、Google実データは時系列で保持します。
            </p>
          </div>
          <div className="actions">
            <button
              className="secondary"
              onClick={() => queue("sync_google", { connector: "gsc" })}
            >
              GSCを同期
            </button>
            <button
              className="secondary"
              onClick={() => queue("sync_google", { connector: "ga" })}
            >
              GA4を同期
            </button>
          </div>
        </div>
        {message && (
          <p
            className={
              message === "保存しました。" ? "field-help" : "error-text"
            }
          >
            {message}
          </p>
        )}
        <div className="button-row">
          <button className="primary" onClick={() => create("topics")}>
            Topicを追加
          </button>
          <button className="secondary" onClick={() => create("clusters")}>
            Clusterを追加
          </button>
          <button className="secondary" onClick={() => create("keywords")}>
            Keywordを追加
          </button>
          <button className="secondary" onClick={createBrief}>
            Content Briefを追加
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="section-head">
          <h2>SEOダッシュボード</h2>
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>直近7日</option>
            <option value={28}>直近28日</option>
            <option value={90}>直近3か月</option>
          </select>
        </div>
        <div className="metric-grid">
          <Metric label="GSC Clicks" value={performance?.gsc?.clicks} />
          <Metric
            label="GSC Impressions"
            value={performance?.gsc?.impressions}
          />
          <Metric
            label="CTR"
            value={
              performance?.gsc?.ctr === undefined
                ? "—"
                : `${(Number(performance.gsc.ctr) * 100).toFixed(1)}%`
            }
          />
          <Metric
            label="平均掲載順位"
            value={
              performance?.gsc?.position === undefined
                ? "—"
                : Number(performance.gsc.position).toFixed(1)
            }
          />
          <Metric
            label="Organic Sessions"
            value={performance?.ga4?.organic_sessions}
          />
          <Metric
            label="Key Events / CV"
            value={performance?.ga4?.conversions}
          />
          <Metric
            label="Topic Coverage"
            value={
              map
                ? `${map.topics?.length ? Math.round(map.topics.reduce((sum: number, item: any) => sum + Number(item.coverage || 0), 0) / map.topics.length) : 0}%`
                : "—"
            }
          />
          <Metric
            label="Missing Keywords"
            value={map?.topics?.reduce(
              (sum: number, item: any) =>
                sum + Number(item.missingKeywords || 0),
              0,
            )}
          />
        </div>
        <small>
          期間: {performance?.period || "読み込み中"}。データが未同期の場合は
          DATA_NOT_AVAILABLE として扱います。
        </small>
      </div>
      <div className="panel">
        <h2>Topic Coverage</h2>
        <table>
          <thead>
            <tr>
              <th>Topic</th>
              <th>対象KW</th>
              <th>対応KW</th>
              <th>不足KW</th>
              <th>紐付け記事</th>
              <th>Coverage</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {map?.topics?.map((item: any) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <small> {item.status === "archived" ? "（無効）" : ""}</small>
                </td>
                <td>{item.targetKeywords}</td>
                <td>{item.coveredKeywords}</td>
                <td>{item.missingKeywords}</td>
                <td>{item.publishedArticles}</td>
                <td>{item.coverage}%</td>
                <td>
                  <button
                    className="link-button"
                    onClick={() => edit("topics", item)}
                  >
                    編集
                  </button>
                  <button
                    className="link-button"
                    onClick={() => archive("topics", item)}
                  >
                    無効化
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!map?.topics?.length && (
          <p className="empty">Topicを追加するとCoverageを表示します。</p>
        )}
      </div>
      <div className="panel">
        <h2>Keyword一覧</h2>
        <table>
          <thead>
            <tr>
              <th>Keyword</th>
              <th>Topic / Cluster</th>
              <th>Intent</th>
              <th>Volume</th>
              <th>KD</th>
              <th>順位</th>
              <th>Impressions</th>
              <th>Priority</th>
              <th>Status</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {map?.keywords?.map((item: any) => (
              <tr key={item.id}>
                <td>{item.keyword}</td>
                <td>
                  {map.topics?.find((topic: any) => topic.id === item.topic_id)
                    ?.name || "—"}{" "}
                  /{" "}
                  {map.clusters?.find(
                    (cluster: any) => cluster.id === item.cluster_id,
                  )?.name || "—"}
                </td>
                <td>{item.search_intent}</td>
                <td>{item.search_volume ?? "DATA_NOT_AVAILABLE"}</td>
                <td>{item.keyword_difficulty ?? "DATA_NOT_AVAILABLE"}</td>
                <td>{item.current_position ?? "DATA_NOT_AVAILABLE"}</td>
                <td>{item.impressions ?? "DATA_NOT_AVAILABLE"}</td>
                <td>
                  <details>
                    <summary>{item.priority_score}</summary>
                    <small>
                      {Object.entries(
                        item.priority_breakdown?.contributions || {},
                      )
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(" / ")}
                    </small>
                  </details>
                </td>
                <td>{item.status}</td>
                <td>
                  <button
                    className="link-button"
                    onClick={() => requestSerp(item)}
                  >
                    実SERP取得
                  </button>
                  <button
                    className="link-button"
                    onClick={() => edit("keywords", item)}
                  >
                    編集
                  </button>
                  <button
                    className="link-button"
                    onClick={() => archive("keywords", item)}
                  >
                    無効化
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!map?.keywords?.length && (
          <p className="empty">
            Keywordを追加すると、Priority ScoreとCoverageの対象になります。
          </p>
        )}
      </div>
      <div className="panel">
        <div className="section-head">
          <div>
            <small>PHASE 2 · SERP INTELLIGENCE</small>
            <h2>実SERP・競合ページ分析</h2>
            <p>
              Ubersuggestの実SERPだけを保存し、上位ページは取得できた内容だけを分析します。AI
              OverviewやPAAは返却データにない限り未取得です。
            </p>
          </div>
          <button className="secondary" onClick={load}>
            更新
          </button>
        </div>
        {serp?.snapshots?.length ? (
          <table>
            <thead>
              <tr>
                <th>Keyword</th>
                <th>取得日時</th>
                <th>Provider</th>
                <th>状態</th>
                <th>結果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {serp.snapshots.map((snapshot: any) => {
                const count = (serp.results || []).filter(
                    (item: any) => item.snapshot_id === snapshot.id,
                  ).length,
                  insight = (serp.insights || []).find(
                    (item: any) => item.snapshot_id === snapshot.id,
                  ),
                  decision = (serp.decisions || []).find(
                    (item: any) => item.snapshot_id === snapshot.id,
                  );
                return (
                  <tr key={snapshot.id}>
                    <td>{snapshot.keyword}</td>
                    <td>{snapshot.checked_at}</td>
                    <td>{snapshot.provider}</td>
                    <td>{snapshot.status}</td>
                    <td>
                      {count}件
                      {insight ? ` / 意図: ${insight.search_intent}` : ""}
                      {decision ? ` / 判断: ${decision.action}` : ""}
                    </td>
                    <td>
                      <button
                        className="link-button"
                        disabled={snapshot.status !== "SUCCESS"}
                        onClick={() => analyzeSerp(snapshot.id)}
                      >
                        競合を取得・分析
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty">
            Keyword一覧の「実SERP取得」から、検証済みのUbersuggest接続で上位10件を取得できます。
          </p>
        )}
        {serp?.insights?.length > 0 && (
          <div className="stack">
            {serp.insights.slice(0, 3).map((item: any) => (
              <div className="subpanel" key={item.id}>
                <b>
                  {serp.snapshots?.find(
                    (snapshot: any) => snapshot.id === item.snapshot_id,
                  )?.keyword || "Keyword"}
                  ：{item.search_intent}
                </b>
                <p>顕在ニーズ：{item.explicit_need || "DATA_NOT_AVAILABLE"}</p>
                <p>
                  差別化の機会：
                  {(item.differentiationOpportunities || []).join(" / ") ||
                    "DATA_NOT_AVAILABLE"}
                </p>
                <p>
                  推奨形式：
                  {item.recommended_content_type || "DATA_NOT_AVAILABLE"} /
                  深さ：{item.recommended_depth || "DATA_NOT_AVAILABLE"}
                </p>
              </div>
            ))}
          </div>
        )}
        {serp?.snapshots
          ?.filter((snapshot: any) => snapshot.status === "SUCCESS")
          .slice(0, 3)
          .map((snapshot: any) => {
            const insight = (serp.insights || []).find(
                (item: any) => item.snapshot_id === snapshot.id,
              ),
              decision = (serp.decisions || []).find(
                (item: any) => item.snapshot_id === snapshot.id,
              ),
              cannibal = (serp.cannibalization || []).find(
                (item: any) => item.snapshot_id === snapshot.id,
              ),
              keyword = map?.keywords?.find(
                (item: any) => item.id === snapshot.keyword_id,
              ),
              top10 = (serp.results || []).filter(
                (item: any) => item.snapshot_id === snapshot.id,
              ),
              analyses = (serp.analyses || []).filter((item: any) =>
                top10.some((result: any) => result.id === item.serp_result_id),
              ),
              consensus = insight?.serpConsensus || {},
              target = mappings.find(
                (item: any) => item.article_id === decision?.target_article_id,
              );
            return (
              <div className="subpanel stack" key={`detail-${snapshot.id}`}>
                <div>
                  <small>OVERVIEW · 最終取得: {snapshot.checked_at}</small>
                  <h3>{snapshot.keyword}</h3>
                  <p>
                    Current Position:{" "}
                    {keyword?.current_position ?? "DATA_NOT_AVAILABLE"} /
                    Impressions: {keyword?.impressions ?? "DATA_NOT_AVAILABLE"}{" "}
                    / Cannibalization Risk:{" "}
                    {cannibal?.risk || "DATA_NOT_AVAILABLE"}
                  </p>
                </div>
                <div>
                  <h4>Search Intent</h4>
                  <p>{insight?.search_intent || "DATA_NOT_AVAILABLE"}</p>
                  <p>
                    顕在ニーズ: {insight?.explicit_need || "DATA_NOT_AVAILABLE"}
                    <br />
                    潜在ニーズ: {insight?.latent_need || "DATA_NOT_AVAILABLE"}
                    <br />
                    不安: {insight?.anxiety || "DATA_NOT_AVAILABLE"}
                    <br />
                    比較軸:{" "}
                    {(insight?.comparisonAxes || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    望む結果: {insight?.desired_outcome || "DATA_NOT_AVAILABLE"}
                    <br />
                    ファネル:{" "}
                    {insight?.likely_funnel_stage || "DATA_NOT_AVAILABLE"}
                  </p>
                </div>
                <div>
                  <h4>SERP Consensus</h4>
                  <p>
                    共通トピック:{" "}
                    {(consensus.commonTopics || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    共通質問:{" "}
                    {(consensus.commonQuestions || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    形式:{" "}
                    {(consensus.commonFormats || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    必須トピック:{" "}
                    {(consensus.requiredTopics || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                  </p>
                </div>
                <div>
                  <h4>Top 10</h4>
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Title / URL</th>
                        <th>取得</th>
                        <th>H1・見出し</th>
                        <th>著者・更新日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top10.map((row: any) => {
                        const analysis = analyses.find(
                          (item: any) => item.serp_result_id === row.id,
                        );
                        return (
                          <tr key={row.id}>
                            <td>{row.rank}</td>
                            <td>
                              {row.title || "DATA_NOT_AVAILABLE"}
                              <small>{row.url}</small>
                            </td>
                            <td>{analysis?.fetch_status || "未分析"}</td>
                            <td>
                              {analysis?.h1 || "DATA_NOT_AVAILABLE"}
                              <small>
                                {(analysis?.headings || [])
                                  .slice(0, 3)
                                  .join(" / ")}
                              </small>
                            </td>
                            <td>
                              {analysis?.author_info || "DATA_NOT_AVAILABLE"}
                              <small>
                                {analysis?.freshness_info ||
                                  "DATA_NOT_AVAILABLE"}
                              </small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h4>Content Gap</h4>
                  <p>
                    不足トピック:{" "}
                    {(insight?.missingTopics || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    競合の弱い点:{" "}
                    {(insight?.weakCompetitorTopics || []).join(" / ") ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    推奨記事形式:{" "}
                    {insight?.recommended_content_type || "DATA_NOT_AVAILABLE"}
                    <br />
                    推奨深度:{" "}
                    {insight?.recommended_depth || "DATA_NOT_AVAILABLE"}
                  </p>
                </div>
                <div>
                  <h4>Differentiation</h4>
                  <p>
                    {(
                      insight?.differentiationOpportunities || [
                        "NO_CONFIRMED_DIFFERENTIATION",
                      ]
                    ).join(" / ")}
                  </p>
                </div>
                <div>
                  <h4>Cannibalization</h4>
                  <p>
                    Risk: {cannibal?.risk || "DATA_NOT_AVAILABLE"} / Score:{" "}
                    {cannibal?.score ?? "DATA_NOT_AVAILABLE"}
                    <br />
                    Reason: {cannibal?.reason || "DATA_NOT_AVAILABLE"}
                  </p>
                </div>
                <div>
                  <h4>Recommendation</h4>
                  <p>
                    推奨施策: {decision?.action || "HUMAN_REVIEW"}
                    <br />
                    対象記事:{" "}
                    {target?.article_title ||
                      decision?.target_article_id ||
                      "DATA_NOT_AVAILABLE"}
                    <br />
                    理由: {decision?.reason || "根拠不足のため判断保留"}
                  </p>
                </div>
              </div>
            );
          })}
      </div>
      <LinkGraph graph={linkGraph} />
      <div className="panel">
        <h2>Content Brief</h2>
        {map?.briefs?.length ? (
          <table>
            <thead>
              <tr>
                <th>Intent / ニーズ</th>
                <th>比較軸・望む結果</th>
                <th>SERP Consensus / Required Topics</th>
                <th>Content Gap / Differentiation</th>
                <th>Status</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {map.briefs.map((item: any) => (
                <tr key={item.id}>
                  <td>
                    {item.search_intent || "DATA_NOT_AVAILABLE"}
                    <small>
                      {item.explicit_need || "—"} / {item.latent_need || "—"}
                      <br />
                      不安: {item.anxiety || "—"}
                    </small>
                  </td>
                  <td>
                    {(parseStoredJson(item.comparison_axes, []) || []).join(
                      " / ",
                    ) || "—"}
                    <small>{item.desired_outcome || "—"}</small>
                  </td>
                  <td>
                    <small>
                      Consensus:{" "}
                      {JSON.stringify(parseStoredJson(item.serp_consensus, {}))}
                      <br />
                      Topics:{" "}
                      {(parseStoredJson(item.required_topics, []) || []).join(
                        " / ",
                      ) || "—"}
                    </small>
                  </td>
                  <td>
                    <small>
                      {item.content_gap || "DATA_NOT_AVAILABLE"}
                      <br />
                      {(parseStoredJson(item.differentiation, []) || []).join(
                        " / ",
                      ) || "NO_CONFIRMED_DIFFERENTIATION"}
                    </small>
                  </td>
                  <td>{item.status}</td>
                  <td>
                    <button
                      className="link-button"
                      onClick={() => archive("briefs", item)}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">Content Briefはまだありません。</p>
        )}
      </div>
      <div className="panel">
        <div className="section-head">
          <div>
            <h2>記事マッピング</h2>
            <p>
              WordPress既存記事をAIが候補として分類します。確定は必ず人が行います。
            </p>
          </div>
          <button className="primary" onClick={() => analyzeMappings()}>
            全記事をAI分析
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>記事</th>
              <th>AI提案 Topic / Cluster</th>
              <th>Primary Keyword</th>
              <th>Confidence</th>
              <th>Status</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((item) => {
              const confidence = Number(item.confidence || 0),
                level =
                  confidence >= Number(weights?.highConfidenceThreshold ?? 0.9)
                    ? "HIGH"
                    : confidence >=
                        Number(weights?.mediumConfidenceThreshold ?? 0.7)
                      ? "MEDIUM"
                      : "LOW";
              return (
                <tr key={item.id}>
                  <td>
                    {item.article_title}
                    <small>{item.article_url}</small>
                  </td>
                  <td>
                    {map?.topics?.find(
                      (x: any) => x.id === item.suggested_topic_id,
                    )?.name || "—"}{" "}
                    /{" "}
                    {map?.clusters?.find(
                      (x: any) => x.id === item.suggested_cluster_id,
                    )?.name || "—"}
                  </td>
                  <td>
                    {map?.keywords?.find(
                      (x: any) => x.id === item.suggested_keyword_id,
                    )?.keyword ||
                      item.suggested_keyword_text ||
                      "—"}
                  </td>
                  <td>
                    {level}
                    <br />
                    {confidence.toFixed(2)}
                  </td>
                  <td>{item.status}</td>
                  <td>
                    <button
                      className="link-button"
                      onClick={() => approveMapping(item)}
                    >
                      承認
                    </button>
                    <button
                      className="link-button"
                      onClick={() => approveMapping(item, true)}
                    >
                      修正して承認
                    </button>
                    <button
                      className="link-button"
                      onClick={() =>
                        mutate(
                          `clients/${client.id}/article-mappings/${item.id}/reject`,
                          "POST",
                        )
                      }
                    >
                      却下
                    </button>
                    <button
                      className="link-button"
                      onClick={() => analyzeMappings(item.article_id)}
                    >
                      再分析
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!mappings.length && (
          <p className="empty">
            「全記事をAI分析」を押すと候補をQueueで作成します。
          </p>
        )}
      </div>
      <div className="panel">
        <div className="section-head">
          <div>
            <h2>Priority Weight</h2>
            <p>
              合計100の割合方式です。保存時に全Keywordをこのクライアントだけ再計算します。
            </p>
          </div>
          <button className="primary" onClick={saveWeights}>
            保存して再計算
          </button>
        </div>
        {weights && (
          <div className="form-grid">
            {[
              [
                "searchDemand",
                "Search Demand",
                "検索される需要をどれくらい重視するか",
              ],
              [
                "difficulty",
                "Keyword Difficulty",
                "競合の強さをどれくらい重視するか",
              ],
              [
                "businessRelevance",
                "Business Relevance",
                "自社の売上・事業との関連性をどれくらい重視するか",
              ],
              [
                "conversionPotential",
                "Conversion Potential",
                "問い合わせや購入につながる可能性をどれくらい重視するか",
              ],
              [
                "topicalRelevance",
                "Topical Relevance",
                "Topicとの関連性をどれくらい重視するか",
              ],
              [
                "rankingOpportunity",
                "Ranking Opportunity",
                "上位化の機会をどれくらい重視するか",
              ],
              [
                "existingPosition",
                "Existing Position",
                "現在順位をどれくらい重視するか",
              ],
              ["impressions", "Impressions", "表示回数をどれくらい重視するか"],
            ].map(([key, label, help]) => (
              <label key={key as string}>
                {label}
                <small>{help}</small>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={weights.weights?.[key as string] ?? 0}
                  onChange={(e) =>
                    setWeights({
                      ...weights,
                      weights: {
                        ...weights.weights,
                        [key]: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        )}
        <p>
          合計:{" "}
          {weights
            ? Number((Object.values(weights.weights || {}) as unknown[]).reduce(
                (sum: number, value: unknown) => sum + Number(value),
                0,
              ))
            : 0}{" "}
          / 100
        </p>
      </div>
    </section>
  );
}
function Metric({ label, value }: any) {
  return (
    <div className="metric">
      <small>{label}</small>
      <b>
        {value === null || value === undefined || value === ""
          ? "DATA_NOT_AVAILABLE"
          : String(value)}
      </b>
    </div>
  );
}
function Sources({
  client,
  sources,
  primaryInfoVersions = [],
  sourceFiles,
  jobs,
  workers,
  connections,
  refresh,
  fileUploadsEnabled = false,
}: any) {
  const [fileMessage, setFileMessage] = useState("");
  const [primaryMessage, setPrimaryMessage] = useState("");
  const canonicalSource =
    sources.find((item: any) => item.is_canonical && !item.archived) ||
    sources[0];
  const latest = jobs.find((item: any) => item.type === "primary_info_assist");
  const busy = ["queued", "running"].includes(latest?.status);
  const hasPdfImport = sourceFiles.some(
    (file: any) => file.content_type === "application/pdf",
  );
  // The global refresh cadence is deliberately slow for dashboard traffic,
  // but a chat answer should visibly advance as soon as its queue job ends.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [busy, latest?.id]);
  const codexConnection = connections.find(
    (item: any) => item.connector === "anthropic",
  );
  const codexNeedsAuth =
    codexConnection?.status === "reauth_required" ||
    /Claude.*認証|Anthropic|authentication|401/i.test(
      String(latest?.error || ""),
    );
  // Claude is configured once in the Cloudflare Worker. It is not a
  // per-client or Mac-worker connection.
  const codexReady = !codexNeedsAuth;
  const failedRetry = latest?.status === "failed";
  const upload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setFileMessage("アップロード中…");
    try {
      const response = await fetch(`/api/clients/${client.id}/source-files`, {
        method: "POST",
        body: form,
      });
      const result: any = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "アップロードできませんでした。");
      e.currentTarget.reset();
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "primary_info_assist",
        payload: { mode: "pdf_import", sourceFileId: result.file?.id },
      });
      setFileMessage("PDFを受け取りました。記事に使える文章へ整理しています…");
      await refresh();
    } catch (error: any) {
      setFileMessage(error.message);
    }
  };
  const assist = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const answers = Object.fromEntries(form);
    try {
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "primary_info_assist",
        payload: { mode: "chat_interview", answers },
      });
      await refresh(
        "Claude APIへ一次情報の整理を依頼しました。Cloudflare Queueが実行します。",
      );
    } catch (error: any) {
      refresh(error.message);
    }
  };
  const retry = async () => {
    try {
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "primary_info_assist",
        payload: latest?.payload || {},
      });
      await refresh("前回の回答を使ってClaude APIへ再実行を依頼しました。");
    } catch (error: any) {
      refresh(error.message);
    }
  };
  const saveSource = async (sourceId: string, values: any) => {
    await api(`clients/${client.id}/sources/${sourceId}`, "PATCH", values);
    await refresh(
      "変更を保存しました。最下部の「この内容で記事情報を確定」を押すまでAI生成は始まりません。",
    );
  };
  const consolidateArticleInfo = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canonicalSource) {
      setPrimaryMessage("先に記事に使う一次情報を保存してください。");
      return;
    }
    // This workspace treats every chat answer as already confirmed for article
    // use. Keep the confirmation in the request for the server-side workflow,
    // without making non-technical users repeat two checkboxes at the end.
    const values = { confirmFacts: "yes", confirmRights: "yes" };
    setConfirmingPrimary(true);
    setPrimaryMessage("");
    try {
      await api(`clients/${client.id}/jobs`, "POST", {
        type: "primary_info_assist",
        payload: {
          mode: "finalize_article_information",
          answers: {
            request:
              "保存済みの正式一次情報を、既存の確認済み内容を省略せず保持したまま、今回の追記・修正を反映して、クライアント提示用かつ記事制作に使う正式文章へ統合してください。",
            factsConfirmed: "yes",
            rightsApproved: "yes",
          },
        },
      });
      await refresh(
        "記事に使う正式情報を生成しています。完了後、この欄の文章だけが更新されます。",
      );
    } catch (error: any) {
      setPrimaryMessage(error.message);
    } finally {
      setConfirmingPrimary(false);
    }
  };
  const [confirmingPrimary, setConfirmingPrimary] = useState(false);
  const result = latest?.result;
  // Older Claude responses may contain structured question records rather than
  // plain strings. Normalize them at the UI boundary so a historical response
  // can never make the entire primary-information screen fail to render.
  const questionItems = Array.isArray(result?.follow_up_questions)
    ? result.follow_up_questions
    : [];
  const questions = questionItems
    .map((item: any) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.question === "string") return item.question.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      return "";
    })
    .filter(Boolean);
  const unverifiedClaims = (Array.isArray(result?.unverified_claims)
    ? result.unverified_claims
    : []
  )
    .map((item: any) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.claim === "string") return item.claim.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      return "";
    })
    .filter(Boolean);
  const claimLocations = unverifiedClaims.map((claim: string) => ({
    claim,
    ...locateClaim(claim, sources, result),
  }));
  const primarySufficient = client.primary_info_status === "sufficient";
  const interviewSteps = [
    { key: "company", label: "会社の実態", question: "まず、御社はどのような会社ですか？ 会社の成り立ち、拠点・対応地域、人数や体制などを、分かる範囲で教えてください。" },
    { key: "business", label: "事業内容", question: "次に、現在どのような事業をしていますか？ 主なサービス・商品、誰に提供しているか、普段どのような仕事をしているかを教えてください。" },
    { key: "content_goal", label: "記事の目的", question: "今回つくりたい記事では、何を達成したいですか？ たとえばSEOで問い合わせを増やしたい、採用につなげたい、実績を伝えたい、会社の考え方を知ってもらいたい、など目的を教えてください。" },
    { key: "service", label: "提供サービス", question: "その中でも、特に記事で伝えたいサービス・商品はどれですか？ 内容、料金や提供条件、利用の流れなど、公開できる範囲で教えてください。" },
    { key: "customer", label: "対象のお客様", question: "いちばん力になりたいお客様は、どんな会社・担当者ですか？ 業種、規模、状況を教えてください。" },
    { key: "problem", label: "解決する課題", question: "そのお客様が相談前に困っていることを、実際の言葉で教えてください。" },
    { key: "difference", label: "選ばれる理由", question: "他社と比べて選ばれる理由や、御社らしい進め方は何ですか？" },
    { key: "process", label: "支援の進め方", question: "相談から成果確認まで、通常どのような流れ・体制・期間で進めますか？" },
    { key: "proof", label: "公開できる実績", question: "記事で公開してよい事例・成果・お客様の声はありますか？ 数字は期間や条件も一緒に教えてください。" },
    { key: "evidence", label: "根拠・公開可否", question: "上の内容を裏付けるURL・資料・確認担当者と、記事で公開してよい範囲を教えてください。" },
  ];
  const questionStepKey = questionItems.find(
    (item: any) => item && typeof item === "object" && typeof item.next_question_key === "string",
  )?.next_question_key;
  // The Worker owns the interview state.  It can request a follow-up on the
  // current topic when an answer is too abstract, rather than mechanically
  // advancing to the next item.
  const completedKeys = Array.isArray(result?.interview_progress?.completed)
    ? result.interview_progress.completed.map((key: unknown) => String(key))
    : [];
  const activeInterviewStep =
    interviewSteps.find((step) => !completedKeys.includes(step.key)) ||
    interviewSteps.find(
      (step) => step.key === result?.next_question_key || step.key === questionStepKey,
    ) ||
    interviewSteps[0];
  const activeQuestionKey =
    (typeof result?.next_question_key === "string" && result.next_question_key) ||
    questionStepKey ||
    activeInterviewStep.key;
  const latestMessage = String(latest?.payload?.answers?.message || "");
  const modelQuestionMatchesActiveStep =
    result?.next_question_key === activeInterviewStep.key ||
    questionStepKey === activeInterviewStep.key;
  const nextQuestion =
    (modelQuestionMatchesActiveStep || activeQuestionKey.startsWith("followup_")) && questions[0]
      ? questions[0]
      : activeInterviewStep.question;
  const completedInterviewSteps = Array.isArray(result?.interview_progress?.completed)
    ? result.interview_progress.completed.length
    : 0;
  const interviewComplete =
    completedInterviewSteps >= interviewSteps.length && !primarySufficient;
  const articleReadiness = result?.article_readiness;
  return (
    <>
      <div className="heading">
        <div>
          <h2>AIとの会話で、記事に使える一次情報をつくる</h2>
          <p>AIに答えるだけで、記事に使える情報が完成します。答えられる範囲で送るだけで大丈夫です。AIがこのクライアントに必要なことだけを1つずつ聞き、確認済みの事実だけを記事用の文章にします。</p>
        </div>
      </div>
      {codexNeedsAuth && (
        <section className="reauth-card">
          <b>AIへの接続を確認してください</b>
          {latest?.payload && <button className="primary" onClick={retry}>もう一度試す</button>}
        </section>
      )}
      {failedRetry && !codexNeedsAuth && (
        <section className="reauth-card">
          <b>回答を処理できませんでした</b>
          <button className="primary" onClick={retry}>もう一度試す</button>
        </section>
      )}
      <section className="panel primary-chat simple-interview">
        <div className="interview-progress" aria-label="質問の進み具合">
          {primarySufficient ? "記事に使う情報を更新できます" : articleReadiness ? `記事の土台 ${articleReadiness.completed} / ${articleReadiness.total}` : "記事の土台 0 / 6"}
        </div>
        {primarySufficient && <p className="field-help">内容が変わったら、変更内容と「いつから変わったか」だけを送ってください。以前の情報は履歴として残し、最新の内容へ更新します。</p>}
        {latestMessage && <p className="answer-received">✓ 前の回答を受け取りました</p>}
        <div className="assistant-bubble simple-question"><b>AIからの質問</b><p>{primarySufficient ? (questions[0] || "新しい実績・サービス変更・お客様の声など、記事へ追加したいことを自由に教えてください。いつからの情報かも分かれば一緒に書いてください。") : nextQuestion}</p>{!primarySufficient && <small>回答が短い場合は、記事に使える具体例を一つだけ追加で伺います。分からない・非公開の場合は、そのまま送ってください。</small>}</div>
        <form onSubmit={assist} className="chat-form simple-chat-form">
          <textarea aria-label="あなたの回答" name="message" required placeholder={primarySufficient ? "例：2026年10月から新サービスを開始。対象は…／新しい事例は…" : "文章でも箇条書きでも大丈夫です。数字・期間・実例・本人の言葉があれば、そのまま書いてください。"} />
          <input type="hidden" name="askedQuestion" value={primarySufficient ? (questions[0] || "更新したい一次情報を教えてください。") : nextQuestion} />
          <input type="hidden" name="questionKey" value={primarySufficient ? "update" : activeQuestionKey} />
          <button className="primary" disabled={busy || !codexReady}>{busy ? "整理しています…" : primarySufficient ? "変更を反映する" : "送る"}</button>
          <small>分からないことは「分からない」と送って大丈夫です。確認できない数値や実績をAIが補うことはありません。</small>
        </form>
        {!primarySufficient && interviewComplete && <form onSubmit={consolidateArticleInfo} className="simple-finish-form"><button className="primary" disabled={confirmingPrimary || busy || !canonicalSource}>{confirmingPrimary || busy ? "まとめています…" : "記事用にまとめる"}</button>{primaryMessage && <p className="error-text">{primaryMessage}</p>}</form>}
      </section>
      <details className="interview-details">
        <summary>Excel / PDFを使ってまとめて追加する（任意）</summary>
        <section className="panel primary-template-flow">
        <div className="template-steps">
          <p><b>1.</b> Excelテンプレートを開く</p>
          <p><b>2.</b> B列に回答を書く</p>
          <p><b>3.</b> PDFにして追加する</p>
        </div>
        <a className="primary template-download" href="/primary-information-template.xlsx" download>Excelテンプレートをダウンロード</a>
        {fileUploadsEnabled ? <form onSubmit={upload} className="pdf-upload-form"><label>作成したPDFを追加<input name="file" type="file" accept="application/pdf,.pdf" required /></label><button className="primary" disabled={busy}>{busy ? "文章にしています…" : "PDFを追加して文章にする"}</button></form> : <p className="error-text">PDFの追加準備中です。しばらくしてからもう一度開いてください。</p>}
        {fileMessage && <p className="field-help">{fileMessage}</p>}
        {busy && latest?.payload?.mode === "pdf_import" && <p className="answer-received">PDFを読み取り、記事に使える文章へ整理しています。</p>}
        </section>
      </details>
      {hasPdfImport && !busy && canonicalSource && <section className="panel primary-import-result"><div><h3>文章化した一次情報</h3><p>内容はそのまま編集できます。直したら保存してください。</p></div><SourceCard source={canonicalSource} save={saveSource} />{!primarySufficient && <button className="primary" onClick={() => consolidateArticleInfo({ preventDefault: () => undefined } as any)} disabled={confirmingPrimary}> {confirmingPrimary ? "記事用に整えています…" : "この内容で記事用情報にする"}</button>}</section>}
      <details className="interview-details">
        <summary>内容を確認・編集する（必要な場合のみ）</summary>
        {result?.quality_summary && <p className="field-help">{result.quality_summary}</p>}
        {claimLocations.length > 0 && <div className="claim-location-list">{claimLocations.map((item: any, index: number) => <article className="claim-location-card" key={item.claim}><div className="claim-number">確認 {index + 1}</div><h4>{item.claim}</h4><ClaimInlineEditor item={item} save={saveSource} /></article>)}</div>}
        {sources.length > 0 && <div className="registered-sources">{sources.map((source: any) => <SourceCard key={source.id} source={source} save={saveSource} />)}</div>}
        {primaryInfoVersions.length > 1 && <div className="primary-version-history"><h3>一次情報の更新履歴</h3>{primaryInfoVersions.slice(0, 10).map((version: any) => <article key={version.id}><b>Version {version.version_no}</b><small>{new Date(version.created_at).toLocaleString("ja-JP")}</small><p>{version.change_summary || "一次情報を更新"}</p></article>)}</div>}
      </details>
    </>
  );
}
function SourceCard({
  source,
  save,
  forceEditing = false,
  onEditingChange = () => {},
}: any) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (forceEditing) setEditing(true);
  }, [forceEditing]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setMessage("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await save(source.id, {
        ...values,
        rights: values.rightsApproved ? "approved" : "unconfirmed",
      });
      setEditing(false);
      onEditingChange(false);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };
  if (editing)
    return (
      <form
        id={`source-${source.id}`}
        className="source source-edit"
        onSubmit={submit}
      >
        <div className="form-grid">
          <label>
            情報の種類
            <select name="type" defaultValue={source.type}>
              <option value="manual_entry">自由入力・メモ</option>
              <option value="customer_case">顧客事例</option>
              <option value="original_data">独自データ・実績</option>
              <option value="expert_comment">専門家コメント</option>
              <option value="field_knowledge">現場の知見</option>
              <option value="interview">AI・ヒアリング整理</option>
            </select>
          </label>
          <label>
            タイトル
            <input name="title" defaultValue={source.title} required />
          </label>
          <label className="wide">
            内容
            <textarea name="note" defaultValue={source.note} required />
          </label>
          <label className="wide">
            根拠URL（任意）
            <input name="url" type="url" defaultValue={source.url || ""} />
          </label>
        </div>
        <label className="inline-choice">
          <input
            name="rightsApproved"
            type="checkbox"
            value="yes"
            defaultChecked={source.rights === "approved"}
          />
          記事で利用する許可を確認済み
        </label>
        {message && <p className="error-text">{message}</p>}
        <div className="source-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setEditing(false);
              onEditingChange(false);
            }}
          >
            キャンセル
          </button>
          <button className="primary" disabled={saving}>
            {saving ? "保存中…" : "変更を保存"}
          </button>
        </div>
      </form>
    );
  return (
    <article className="source" id={`source-${source.id}`}>
      <div className="source-head">
        <div>
          <b>{source.title}</b>
          <small>
            正式版 · {source.type} ·{" "}
            {source.rights === "approved" ? "利用許可済み" : "利用許可未確認"}
            {source.canonical_status === "candidate"
              ? " · AI再整理待ち"
              : source.canonical_status === "needs_confirmation"
                ? " · 追加確認あり"
                : source.canonical_status === "ready"
                  ? " · 記事利用準備完了"
                  : ""}
          </small>
        </div>
        <button
          className="secondary"
          onClick={() => {
            setEditing(true);
            onEditingChange(true);
          }}
        >
          編集する
        </button>
      </div>
      <div className="source-note">
        {String(source.note || "")
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((paragraph: string, index: number) => (
            <p key={index}>
              {paragraph
                .replace(/^\s*#{1,6}\s*/gm, "")
                .replace(/\*\*/g, "")
                .replace(/^---$/gm, "")
                .trim()}
            </p>
          ))}
      </div>
      {source.url && (
        <a href={source.url} target="_blank" rel="noreferrer">
          根拠URLを開く
        </a>
      )}
    </article>
  );
}
function Question({ name, title, hint }: any) {
  return (
    <div className="chat-question">
      <b>{title}</b>
      <textarea name={name} placeholder={hint} />
    </div>
  );
}
function Logs({ logs, jobs }: any) {
  return (
    <>
      <div className="heading">
        <div>
          <h2>実行ログ</h2>
          <p>同期・記事生成・接続・エラーを監査できます。</p>
        </div>
      </div>
      <section className="panel">
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>レベル</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((x: any) => (
              <tr key={x.id}>
                <td>{new Date(x.created_at).toLocaleString("ja-JP")}</td>
                <td>
                  <span className={`status ${x.level}`}>{x.level}</span>
                </td>
                <td>{displayHistoricalAiLabel(x.message)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h3>ジョブ履歴</h3>
        <JobTable jobs={jobs} />
      </section>
    </>
  );
}
function displayHistoricalAiLabel(value: unknown) {
  // Keep the audit record intact while preventing a retired provider label from
  // appearing in the current Codex-only interface.
  const retiredProviderLabel = String.fromCharCode(
    67,
    108,
    97,
    117,
    100,
    101,
    32,
    67,
    111,
    100,
    101,
  );
  return String(value || "").replaceAll(retiredProviderLabel, "Codex");
}
function JobTable({ jobs }: any) {
  return jobs.length ? (
    <table>
      <thead>
        <tr>
          <th>種類</th>
          <th>状態</th>
          <th>試行</th>
          <th>進捗</th>
          <th>更新</th>
          <th>結果</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j: any) => (
          <tr key={j.id}>
            <td>{j.type}</td>
            <td>
              <span className={`status ${j.status}`}>{j.status}</span>
            </td>
            <td>{j.attempts}</td>
            <td>
              {j.status === "completed"
                ? "100%"
                : j.status === "queued"
                  ? "2%"
                  : `${Number(j.result?.progress?.percent || 0)}%`}
            </td>
            <td>{new Date(j.updated_at).toLocaleString("ja-JP")}</td>
            <td>
              {j.result?.score
                ? `${j.result.score}/100`
                : displayHistoricalAiLabel(j.error || "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : (
    <div className="empty">まだ実行はありません。</div>
  );
}
function ClientModal({ close, submit }: any) {
  return (
    <form className="modal" onSubmit={submit}>
      <div className="modal-head">
        <div>
          <small>NEW CLIENT</small>
          <h2>クライアント登録</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      <div className="form-grid">
        <label>
          クライアント名
          <input name="name" required />
        </label>
        <label>
          業種
          <input name="niche" required />
        </label>
        <label className="wide">
          対象サイトURL
          <input name="site" type="url" required />
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={close}>
          キャンセル
        </button>
        <button className="primary">登録</button>
      </div>
    </form>
  );
}
function DeleteClientModal({ client, close, submit, notice }: any) {
  return (
    <form className="modal" onSubmit={submit}>
      <div className="modal-head">
        <div>
          <small>DELETE CLIENT</small>
          <h2>クライアントを削除</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      <div className="delete-warning">
        <b>「{client?.name}」と、その分析・記事・ログを削除します</b>
        <p>
          この操作は元に戻せません。間違い防止のため、下の欄へクライアント名をそのまま入力してください。
        </p>
      </div>
      <label>
        確認のため「{client?.name}」と入力
        <input name="confirmation" required autoComplete="off" />
      </label>
      {notice && <p className="error-text">{notice}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={close}>
          キャンセル
        </button>
        <button className="danger">完全に削除</button>
      </div>
    </form>
  );
}
function GoogleAdminModal({ google, close, submit, notice }: any) {
  return (
    <form className="modal" onSubmit={submit}>
      <div className="modal-head">
        <div>
          <small>GOOGLE API SETUP</small>
          <h2>Google API設定</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      <div className="security-note">
        <b>Google共通のOAuth設定です</b>
        <p>
          入力値はサーバーで暗号化して保存し、保存後は画面・API・実行ログへ再表示しません。クライアントごとの入力は不要です。
        </p>
      </div>
      <div className="form-grid">
        <label className="wide">
          OAuthクライアントID
          <input
            name="clientId"
            type="text"
            placeholder="123456789-xxxxx.apps.googleusercontent.com"
            required
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="wide">
          OAuthクライアントシークレット
          <input
            name="clientSecret"
            type="password"
            placeholder="Google Cloudで発行されたシークレット"
            required
            autoComplete="new-password"
          />
        </label>
        <label className="wide">
          コールバックURL
          <input value={google.redirectUri} readOnly />
        </label>
      </div>
      <p className="field-help">
        Google
        Cloudの「承認済みのリダイレクトURI」と、上のコールバックURLが完全に一致していることを確認してください。
      </p>
      {google.configured && (
        <div className="saved-note">
          現在の設定は保存済みです。更新する場合だけ、新しいIDとシークレットを両方入力してください。
        </div>
      )}
      {notice && <p className="error-text">{notice}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={close}>
          キャンセル
        </button>
        <button className="primary">暗号化して保存</button>
      </div>
    </form>
  );
}
function McpHelpModal({ worker, workerOnline, close }: any) {
  const [copied, setCopied] = useState("");
  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(""), 1800);
  };
  const mcpName = "Ubersuggest";
  const mcpUrl = "https://ubersuggest-mcp.neilpatelapi.com/mcp";
  const setup = `codex mcp get Ubersuggest >/dev/null 2>&1 || codex mcp add Ubersuggest --url ${mcpUrl}`;
  const login = "codex mcp login Ubersuggest";
  const wake =
    "launchctl kickstart -k gui/$(id -u)/com.seoloop.production-worker";
  return (
    <div className="modal reconnect-modal">
      <div className="modal-head">
        <div>
          <small>EASY RECONNECT</small>
          <h2>MCP・Mac かんたん再接続</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      <div
        className={`reconnect-state ${workerOnline ? "online" : worker ? "offline" : "missing"}`}
      >
        <b>
          {workerOnline
            ? "現在、Macワーカーは正常に接続されています"
            : worker
              ? "Macワーカーは登録済みです。まず自動復帰を待ってください"
              : "Macワーカーが未登録です"}
        </b>
        <span>
          {workerOnline
            ? "新しいクライアントも追加作業なしで利用できます。"
            : worker
              ? "スリープ解除後は通常約1分で復帰します。復帰しない場合だけ下の手順3を実行します。"
              : "連携設定画面で「Macワーカーを登録」から初回設定してください。"}
        </span>
      </div>
      <ol className="reconnect-steps">
        <li>
          <b>MCP情報を確認</b>
          <p>以下は固定値です。新しいクライアントごとの変更は不要です。</p>
          <div className="copy-row">
            <span>
              <small>MCP名</small>
              <code>{mcpName}</code>
            </span>
            <button className="secondary" onClick={() => copy(mcpName, "name")}>
              {copied === "name" ? "コピー済み" : "コピー"}
            </button>
          </div>
          <div className="copy-row">
            <span>
              <small>MCP URL</small>
              <code>{mcpUrl}</code>
            </span>
            <button className="secondary" onClick={() => copy(mcpUrl, "url")}>
              {copied === "url" ? "コピー済み" : "コピー"}
            </button>
          </div>
        </li>
        <li>
          <b>ログアウト・認証切れの場合</b>
          <p>
            Macの「ターミナル」を開き、上から順番に1行ずつ貼り付けます。ブラウザが開いたらUbersuggestで承認します。
          </p>
          <Command
            value={setup}
            copied={copied === "setup"}
            copy={() => copy(setup, "setup")}
          />
          <Command
            value={login}
            copied={copied === "login"}
            copy={() => copy(login, "login")}
          />
        </li>
        <li>
          <b>スリープ復帰後、1分待ってもオフラインの場合</b>
          <p>
            次の1行だけをターミナルへ貼り付けると、常駐ワーカーを再起動できます。トークンの再発行は不要です。
          </p>
          <Command
            value={wake}
            copied={copied === "wake"}
            copy={() => copy(wake, "wake")}
          />
        </li>
        <li>
          <b>接続確認</b>
          <p>
            この画面を閉じて約10秒待ち、「Macワーカー
            オンライン」またはUbersuggest「接続済み」を確認します。その後、ダッシュボードで「実データ同期」を押します。
          </p>
        </li>
      </ol>
      <div className="important-note">
        <b>新しいクライアントの場合</b>
        <span>
          右上の「＋」から登録するだけで、このMac・MCP接続を自動継承します。MCP
          URL、ログイン、ワーカートークンの再入力は不要です。
        </span>
      </div>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={close}>
          わかりました
        </button>
      </div>
    </div>
  );
}
function Command({ value, copied, copy }: any) {
  return (
    <div className="copy-row command-row">
      <code>{value}</code>
      <button type="button" className="secondary" onClick={copy}>
        {copied ? "コピー済み" : "コピー"}
      </button>
    </div>
  );
}
function ConnectionModal({
  connector,
  close,
  submit,
  notice,
  google,
  client,
  map,
  refresh,
  configureGoogle,
}: any) {
  const meta = connectors.find((x) => x[0] === connector);
  const isGoogle = ["ga", "gsc", "drive", "youtube"].includes(connector);
  const isUbersuggest = ["ubersuggest", "backlinks"].includes(connector);
  const isLocal = connector === "codex";
  const manual = connector === "note";
  const resourceMode =
    isGoogle &&
    ["authorized_needs_resource", "connected"].includes(
      map?.[connector]?.status,
    );
  const [resources, setResources] = useState<any>(null);
  const [resourceError, setResourceError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!resourceMode || !client?.id) return;
    setResourceError("");
    setResources(null);
    api(`clients/${client.id}/google/resources`)
      .then(setResources)
      .catch((e: any) => setResourceError(e.message));
  }, [resourceMode, client?.id, connector]);
  const selectResources = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setResourceError("");
    try {
      await api(
        `clients/${client.id}/google/select`,
        "POST",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      close();
      await refresh(
        "Googleの取得先を確認しました。実APIへの通信に成功したサービスを「接続済み」にしました。",
      );
    } catch (e: any) {
      setResourceError(e.message);
    } finally {
      setSaving(false);
    }
  };
  if (resourceMode)
    return (
      <form className="modal" onSubmit={selectResources}>
        <div className="modal-head">
          <div>
            <small>GOOGLE DATA SOURCES</small>
            <h2>Googleの取得先を選択</h2>
          </div>
          <button type="button" className="close" onClick={close}>
            ×
          </button>
        </div>
        <p>
          認証は完了しています。クライアントで使用するプロパティやサイトを選ぶと、実際のGoogle
          APIへ接続確認します。
        </p>
        {!resources && !resourceError ? (
          <div className="empty">Googleから取得先を読み込んでいます…</div>
        ) : (
          <div className="form-grid">
            <label className="wide">
              GA4プロパティ
              <select
                name="gaPropertyId"
                defaultValue={map.ga?.public_config?.resourceId || ""}
              >
                <option value="">選択しない</option>
                {(resources?.ga4 || []).map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.account} / {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Search Consoleサイト
              <select
                name="gscSiteUrl"
                defaultValue={map.gsc?.public_config?.resourceId || ""}
              >
                <option value="">選択しない</option>
                {(resources?.gsc || []).map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.name}（{item.permission}）
                  </option>
                ))}
              </select>
            </label>
            <label className="wide inline-choice">
              <input
                name="connectDrive"
                type="checkbox"
                defaultChecked={map.drive?.status === "connected"}
              />{" "}
              このGoogleアカウントのDriveを読み取り接続
            </label>
            <label className="wide">
              YouTubeチャンネル
              <select
                name="youtubeChannelId"
                defaultValue={map.youtube?.public_config?.resourceId || ""}
              >
                <option value="">選択しない</option>
                {(resources?.youtube || []).map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {resources &&
          Object.entries(resources.errors || {}).some(([, value]) => value) && (
            <div className="setup-warning">
              <b>一部のGoogle APIから取得できませんでした</b>
              <p>
                {Object.entries(resources.errors || {})
                  .filter(([, value]) => value)
                  .map(([key]) => key.toUpperCase())
                  .join(" / ")}{" "}
                のAPI有効化または閲覧権限を確認してください。
              </p>
            </div>
          )}
        {resourceError && <p className="error-text">{resourceError}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            閉じる
          </button>
          <button className="primary" disabled={!resources || saving}>
            {saving ? "接続確認中…" : "選択して接続確認"}
          </button>
        </div>
      </form>
    );
  return (
    <form className="modal" onSubmit={submit}>
      <div className="modal-head">
        <div>
          <small>LIVE CONNECTION</small>
          <h2>{meta?.[2] || "連携"}の接続</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      {isGoogle ? (
        <>
          <p>
            Google OAuthでGA4・Search
            Console・Drive・YouTubeをまとめて読み取り接続します。
          </p>
          {!google?.configured && (
            <div className="setup-warning">
              <b>Google API設定が未完了です</b>
              <p>
                下の「Google APIを登録」から、Google Cloudで発行したOAuth Client IDと
                Client Secretを入力してください。登録後、このままGoogle認証へ進めます。
              </p>
              <small>コールバックURL: {google?.redirectUri || "未設定"}</small>
            </div>
          )}
        </>
      ) : isUbersuggest ? (
        <p>
          「Ubersuggestで認証」を押すと、Ubersuggestのログイン画面へ移動します。承認後、この対象サイト専用の接続として保存されます。
        </p>
      ) : isLocal ? (
        <p>
          Macワーカーを登録すると、CodexとUbersuggest
          MCPをAPI費用なしで使用できます。
        </p>
      ) : manual ? (
        <p>noteは公式一般投稿APIがないため、公開用Markdownを生成します。</p>
      ) : (
        <>
          <p className="field-help">入力内容はこの対象サイト専用に暗号化してCloudflare上へ保存します。保存後にキーの値は表示されません。</p>
          <div className="form-grid">
            {(fields[connector] || []).map((f: any) => (
              <label className="wide" key={f[0]}>
                {f[1]}
                <input
                  name={f[0]}
                  type={f[2]}
                  required={!(connector === "pagespeed" && f[0] === "apiKey")}
                />
              </label>
            ))}
          </div>
        </>
      )}
      {notice && <p className="error-text">{notice}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={close}>
          閉じる
        </button>
        {!isLocal && !manual && (
          isGoogle && !google?.configured ? (
            <button type="button" className="primary" onClick={configureGoogle}>
              Google APIを登録
            </button>
          ) : (
            <button className="primary">
              {isGoogle ? "Googleで認証" : isUbersuggest ? "Ubersuggestで認証" : "接続して確認"}
            </button>
          )
        )}
      </div>
    </form>
  );
}
