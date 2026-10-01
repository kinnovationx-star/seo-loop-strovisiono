# Claude Code 引継ぎプロンプト — SEO LOOP

以下をそのまま Claude Code の最初のメッセージとして貼り付けてください。`<...>` だけを実際の値に置き換えます。APIキー、Application Password、OAuthの秘密値は**チャットやGitに貼り付けず**、Claude Codeを実行する端末のCloudflare認証・Secret管理から設定してください。

```text
あなたは SEO LOOP の移行・保守担当エンジニアです。

作業対象リポジトリ:
<ローカルのSEO LOOPリポジトリ絶対パス>

目的:
このリポジトリ、既存のCloudflare上のデータ、運用設定を安全に引き継ぎ、以後の改修・デプロイ・障害調査をClaude Codeで継続できる状態にしてください。既存の本番データやWordPress記事を失わないことが最優先です。

最重要の前提:
- 永続データはCodex内ではなくCloudflare D1/R2/Queueと外部連携先にあります。Claude Codeへ移すために、同一Cloudflareアカウントを利用するならデータのコピーは不要です。リポジトリとCloudflareへの安全なアクセスを引き継いでください。
- 新しいCloudflareアカウント・Worker・D1へ複製する場合は、必ず読み取り専用の棚卸しとバックアップを完了し、復元検証後にだけ切替してください。
- 認証情報、OAuthトークン、WordPress Application Password、AI APIキー、暗号化キーをGit・ログ・Markdown・チャットへ出力しないでください。
- D1内の暗号化済み接続情報を継続利用する場合、CREDENTIALS_ENCRYPTION_KEYは同一値を安全なSecret管理から移す必要があります。検証前にローテーションしないでください。
- `git reset --hard`、`git checkout --`、D1/R2の削除、Queueの削除、WordPressの投稿・公開・更新を行わないでください。これらは明示的なユーザー承認がある場合だけです。

アーキテクチャ:
- UI: `app/seo-loop-app.tsx`。ブラウザ画面・一次情報ヒアリング・記事計画・記事編集・進捗表示を担当。
- API: `app/api/[[...path]]/route.ts`。所有者境界、D1、ジョブ作成、WordPress連携の安全ゲートを担当。
- Cloudflare Worker: `cloud-runner/src/full.ts` が単一URLの入口。`cloud-runner/src/index.ts` がQueue、Cron、AI、画像、Ubersuggest、バックアップを担当。
- スキーマ: `drizzle/*.sql`。既存の番号付きマイグレーションは書換えず、追加変更は新しい番号のSQLにする。
- デプロイ設定: `cloud-runner/dashboard-wrangler.jsonc`（ローカル専用・Git管理外）。現在のD1、R2（BACKUPS/FILES）、Queue（SEO_JOBS）、cronを確認する。
- 検証: `npm run typecheck:workers`、`npm test`、`npm run build`、`npx wrangler deploy --dry-run --config cloud-runner/dashboard-wrangler.jsonc --keep-vars`。

機能上の重要ルール:
- AI作業はCloudflare Queueで実行し、UIには開始直後から処理段階・件数・百分率を表示する。停止・失敗・再試行を曖昧な「確認中」のまま残さない。
- 一次情報は確認済みの事実だけを記事へ使う。AIが数字、実績、お客様の声を創作しない。
- 一次情報ヒアリングは固定アンケートではない。回答済みの内容を再質問せず、短い回答は同じ論点で具体例・対象・期間・条件・根拠を一つだけ深掘りする。「不明・非公開」は繰り返し聞かない。
- 記事の自動公開は、最終確認・品質・一次情報・WordPress接続の安全条件を満たすものだけ。既存WordPressの更新や公開を推測で実行しない。
- 外部YouTube/URLの内容は参考情報であり、ユーザー本人の実績・意見として扱わない。

最初に行うこと（すべて読み取り・検証中心）:
1. `git status --short`、`git log --oneline -20`、README、`cloud-runner/README.md`、設定ファイルを確認し、未コミット変更を破棄せず一覧化する。
2. Cloudflareへのログイン先・Worker名・D1/R2/Queue bindingを確認する。Secretは名前だけ確認し、値を表示しない。
3. `docs/CLAUDE_CODE_MIGRATION.md` の「移行前チェック」を実行し、D1エクスポートとR2オブジェクトの退避が済んでいるか確認する。未実施なら、書込みや削除をせず、必要な正確なコマンドと保存先を提示して承認を待つ。
4. 上記の4つの検証コマンドを実行する。失敗は原因・影響範囲・安全な修正案を報告し、勝手に本番デプロイしない。
5. 本番との差異、停止中ジョブ、失敗ジョブ、期限切れ連携を読み取りで確認する。再実行・再認証・公開などの状態変更は、対象と影響を示してからユーザーの明示承認を得る。

この初回作業の完了報告は、次の形式にしてください。
- リポジトリ状態
- Cloudflareリソースの接続可否（Secretの値は伏せる）
- データバックアップの可否と保存場所
- 検証結果
- 未解決のリスク
- 次に必要なユーザー承認
```

