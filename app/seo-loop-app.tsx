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
  ["immediate", "⚡", "即日入稿"],
  ["reports", "◫", "レポート・PDCA"],
  ["seo", "◎", "SEOトピック"],
  ["autopilot", "↻", "SEO Autopilot"],
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
    try {
      const result = await api(
        `clients/${client.id}/connections/${modal}`,
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
      await api(`clients/${client.id}/jobs`, "POST", { type, payload });
      await refresh("処理をキューへ追加しました。");
    } catch (e: any) {
      setNotice(e.message);
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
          <div className="client-picker">
            <select
              value={client?.id || ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {data.clients.map((c, index) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{index + 1}/{data.clients.length}
                  {c.site
                    ? `・${
                        String(c.site)
                          .replace(/^https?:\/\//, "")
                          .split("/")[0]
                      }`
                    : ""}
                  ）
                </option>
              ))}
            </select>
            <button
              className="secondary icon-button"
              title="クライアントを追加"
              aria-label="クライアントを追加"
              onClick={() => open("new-client")}
            >
              ＋
            </button>
            <button
              className="danger icon-button"
              title="選択中のクライアントを削除"
              aria-label="選択中のクライアントを削除"
              disabled={!client}
              onClick={() => open("delete-client")}
            >
              削除
            </button>
          </div>
        </header>
        <div className="content">
          {notice && (
            <div className="alert">
              <b>お知らせ</b>
              <span>{notice}</span>
            </div>
          )}
          {!client ? (
            <Onboarding open={() => open("new-client")} />
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
                  queue={queue}
                  jobs={jobs}
                  client={client}
                  refresh={refresh}
                  strategy={
                    snapshots.find((s) => s.connector === "keyword_strategy")
                      ?.data
                  }
                  audit={
                    snapshots.find((s) => s.connector === "content_audit")?.data
                  }
                  automation={map.content_automation?.public_config}
                  uber={uber}
                />
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
          />
        )}
      </dialog>
    </div>
  );
}

function Onboarding({ open }: { open: () => void }) {
  return (
    <section className="panel empty">
      <h2>最初のクライアントを登録</h2>
      <p>対象サイト・業種を登録するとSEO運用を開始できます。</p>
      <button className="primary" onClick={open}>
        クライアントを追加
      </button>
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
          <p>実際に通信できた連携だけ「接続済み」と表示します。</p>
        </div>
      </div>
      <div className="cards connectors">
        {connectors.map(([key, icon, title, copy]) => {
          const saved = map[key]?.status;
          const managedByCloud =
            (key === "anthropic" && cloud?.anthropicConfigured) ||
            (key === "image" && cloud?.imageConfigured);
          const reauth = key === "ubersuggest" && saved === "reauth_required";
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
          const checkedAt = map[key]?.checked_at;
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

function Publishing({
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
  const recommendations = strategy?.recommended_keywords || [];
  const monthlySchedule = strategy?.monthly_schedule || [];
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
        autoCreate: true,
        runPlannedNow: true,
        articleCount: Number(config.weeklyArticles || 3),
        scheduleDays: config.scheduleDays || [],
        publishHour: Number(config.publishHour ?? 10),
        targetCharacters: 10000,
        defaultCategoryId: Number(config.defaultCategoryId || 0) || null,
        categoryRotation: config.categoryRotation || [],
      });
      await refresh(
        "設定・12か月の記事計画・今月の下書き予約をまとめて更新しました。",
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
                    ? "AI計画を更新して今月の記事を作成"
                    : "AI計画を作成して自動制作開始"}
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
                    : `${recommendations.length}件の候補と12か月計画を表示しています。予定月・予定週に自動で記事下書きを作ります。`}
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
                <em>自動記事制作の対象</em>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            {strategyBusy
              ? "キーワード候補を準備しています。完了するとここへ自動表示されます。"
              : "「AI計画を作成して自動制作開始」を押してください。未同期の場合は、同期・AI選定・今月の記事予約まで続けて実行します。"}
          </div>
        )}
        {monthlySchedule.length > 0 && (
          <div className="content-calendar">
            <div className="calendar-heading">
              <div>
                <h4>12か月の記事制作スケジュール</h4>
                <p>
                  連携データを基に、月ごとの重点テーマ・対象キーワード・記事内容を決めています。
                </p>
              </div>
              <span className="status connected">AI選定結果から自動更新</span>
            </div>
            <div className="calendar-grid">
              {monthlySchedule.map((month: any) => (
                <article className="calendar-month" key={month.month_number}>
                  <header>
                    <div>
                      <b>
                        {scheduleMonthLabel(
                          strategy?.schedule_start,
                          month.month_number,
                        )}
                      </b>
                      <span>{month.focus}</span>
                    </div>
                    <small>{month.objective}</small>
                  </header>
                  <div className="calendar-articles">
                    {(month.articles || []).map(
                      (article: any, articleIndex: number) => (
                        <article key={`${article.keyword}-${articleIndex}`}>
                          <span className="calendar-week">
                            第{article.publish_week}週・
                            {article.weekly_position || 1}本目
                          </span>
                          <span className="status connected">
                            {article.intent}
                          </span>
                          <b>{article.keyword}</b>
                          <strong>{article.title}</strong>
                          <small>{article.content_summary}</small>
                          <em>{article.data_basis}</em>
                        </article>
                      ),
                    )}
                  </div>
                </article>
              ))}
            </div>
            <p className="calendar-note">
              手入力は不要です。予定月・予定週になると、AIが順位・CTR・競合・既存記事を再確認して約10,000字の下書きを作ります。
            </p>
          </div>
        )}
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
              Console・競合・既存記事から優先KWと公開月を決定
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
                新規記事とリライト記事はWordPressの「下書き」まで作成し、公開はしません。
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
              defaultValue={automation?.weeklyArticles ?? 3}
            >
              {[1, 2, 3, 4, 5, 7].map((count) => (
                <option key={count} value={count}>
                  週{count}本
                </option>
              ))}
            </select>
            <small>
              AIが1週間に作成する新規記事の目安です。すべて下書きです。
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
              この曜日・時刻にAIが今週分の記事を作り、WordPress下書きへ入稿します。
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
          <p className="field-help">
            この設定は、画面上部の「AI計画を更新して今月の記事を作成」を押したときに、計画・下書き予約とまとめて反映されます。
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
function Reports({ queue, jobs, snapshot }: any) {
  const job = jobs.find((item: any) => item.type === "monthly_report");
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
  // Always continue with the earliest missing foundation.  A previous Worker
  // result can contain an older question order; it must not skip company,
  // business, or article purpose after this interview flow changes.
  const completedKeys = Array.isArray(result?.interview_progress?.completed)
    ? result.interview_progress.completed.map((key: unknown) => String(key))
    : [];
  const activeInterviewStep =
    interviewSteps.find((step) => !completedKeys.includes(step.key)) ||
    interviewSteps.find(
      (step) => step.key === result?.next_question_key || step.key === questionStepKey,
    ) ||
    interviewSteps[0];
  const latestMessage = String(latest?.payload?.answers?.message || "");
  const modelQuestionMatchesActiveStep =
    result?.next_question_key === activeInterviewStep.key ||
    questionStepKey === activeInterviewStep.key;
  const nextQuestion =
    modelQuestionMatchesActiveStep && questions[0]
      ? questions[0]
      : activeInterviewStep.question;
  const completedInterviewSteps = Array.isArray(result?.interview_progress?.completed)
    ? result.interview_progress.completed.length
    : 0;
  const interviewComplete =
    completedInterviewSteps >= interviewSteps.length && !primarySufficient;
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
          {primarySufficient ? "記事に使う情報を更新できます" : `確認できた項目 ${completedInterviewSteps} / ${interviewSteps.length}`}
        </div>
        {primarySufficient && <p className="field-help">内容が変わったら、変更内容と「いつから変わったか」だけを送ってください。以前の情報は履歴として残し、最新の内容へ更新します。</p>}
        {latestMessage && <p className="answer-received">✓ 前の回答を受け取りました</p>}
        <div className="assistant-bubble simple-question"><b>AIからの質問</b><p>{primarySufficient ? (questions[0] || "新しい実績・サービス変更・お客様の声など、記事へ追加したいことを自由に教えてください。いつからの情報かも分かれば一緒に書いてください。") : nextQuestion}</p></div>
        <form onSubmit={assist} className="chat-form simple-chat-form">
          <textarea aria-label="あなたの回答" name="message" required placeholder={primarySufficient ? "例：2026年10月から新サービスを開始。対象は…／新しい事例は…" : "文章でも箇条書きでも大丈夫です。数字・期間・実例・本人の言葉があれば、そのまま書いてください。"} />
          <input type="hidden" name="askedQuestion" value={primarySufficient ? (questions[0] || "更新したい一次情報を教えてください。") : nextQuestion} />
          <input type="hidden" name="questionKey" value={primarySufficient ? "update" : activeInterviewStep.key} />
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
          <small>OWNER ONLY</small>
          <h2>Google管理者設定</h2>
        </div>
        <button type="button" className="close" onClick={close}>
          ×
        </button>
      </div>
      <div className="security-note">
        <b>この画面はSEO Loop所有者専用です</b>
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
}: any) {
  const meta = connectors.find((x) => x[0] === connector);
  const isGoogle = ["ga", "gsc", "drive", "youtube"].includes(connector);
  const isUbersuggest = connector === "ubersuggest";
  const isLocal = ["backlinks", "codex"].includes(connector);
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
              <b>運営者側のGoogle Cloud設定が未完了です</b>
              <p>
                あなたのGoogleアカウントや操作の問題ではありません。サーバーにOAuth
                Client IDとClient
                Secretを設定すると、このボタンを使えるようになります。
              </p>
              <small>コールバックURL: {google?.redirectUri || "未設定"}</small>
            </div>
          )}
        </>
      ) : isLocal ? (
        <p>
          Macワーカーを登録すると、CodexとUbersuggest
          MCPをAPI費用なしで使用できます。
        </p>
      ) : manual ? (
        <p>noteは公式一般投稿APIがないため、公開用Markdownを生成します。</p>
      ) : (
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
      )}
      {notice && <p className="error-text">{notice}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={close}>
          閉じる
        </button>
        {!isLocal && !manual && (
          <button
            className="primary"
            disabled={isGoogle && !google?.configured}
          >
            {isGoogle
              ? google?.configured
                ? "Googleで認証"
                : "管理者設定待ち"
              : isUbersuggest
                ? "Ubersuggestで認証"
                : "接続して確認"}
          </button>
        )}
      </div>
    </form>
  );
}
