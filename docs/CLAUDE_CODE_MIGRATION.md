# SEO LOOP を Claude Code へ引き継ぐ手順

## まず知っておくこと

Claude Codeへ「移す」対象は、主にこのリポジトリとCloudflareの運用権限です。SEO LOOPの本体データはCodexには保存されていません。

| 対象 | 保存先 | 引継ぎ方法 |
| --- | --- | --- |
| アプリ・Worker・テスト | このGitリポジトリ | Claude Codeで同じリポジトリを開く |
| クライアント、一次情報、記事計画、ジョブ、履歴 | Cloudflare D1 | 同じCloudflareアカウントなら継続利用。別アカウントならエクスポート／インポート |
| 一次情報PDF、画像、日次バックアップ | Cloudflare R2（`FILES` / `BACKUPS`） | 同じバケットを継続利用、またはオブジェクト単位で複製 |
| 非同期AIジョブ | Cloudflare Queue（`SEO_JOBS`） | 同じQueueを継続利用。未完了ジョブは移行前に一覧化 |
| APIキー・OAuth・WordPress認証 | Cloudflare Worker Secrets とD1の暗号化済みデータ | 値を表示せず、Secret管理から同じ値を安全に再設定 |
| WordPressの記事・カテゴリー・画像 | WordPress本番環境 | 移行対象ではない。接続確認だけ行い、書込みは承認後 |

同じCloudflareアカウントをClaude Codeから利用できるなら、D1/R2/Queueをコピーする必要はありません。リポジトリを開き、Cloudflareへ認証するだけで、既存のデータと運用をそのまま継続できます。

## Claude Codeへ渡すもの

1. このリポジトリのローカルパス、またはGitリモートURL
2. CloudflareアカウントへのCLI認証（値を共有するのではなく、移行する本人がログイン）
3. 現在のローカル専用設定ファイル `cloud-runner/dashboard-wrangler.jsonc`
4. Cloudflare Secretの**名前の一覧**と、安全なパスワードマネージャに保管した値
5. このファイルと [Claude Code用プロンプト](./CLAUDE_CODE_MIGRATION_PROMPT.md)

必要なSecretは環境により異なりますが、少なくとも次を確認します。

- `CREDENTIALS_ENCRYPTION_KEY`
- `SEO_LOOP_WORKER_TOKEN`
- `CLOUD_DISPATCH_TOKEN`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`（利用時）
- `UBERSUGGEST_MCP_TOKEN`（利用時）

> `CREDENTIALS_ENCRYPTION_KEY` は特に重要です。既存D1の暗号化済み連携情報を読むため、別環境へD1を複製する場合も同じ値を安全に設定します。値を失った場合、連携情報は再接続が必要になります。

## 移行前チェック（読み取り中心）

Claude Codeのターミナルで、プロジェクト直下から行います。

```bash
git status --short
git log --oneline -20
npm ci
npm run typecheck:workers
npm test
npm run build
npx wrangler deploy --dry-run --config cloud-runner/dashboard-wrangler.jsonc --keep-vars
npx wrangler secret list --config cloud-runner/dashboard-wrangler.jsonc
```

`secret list` はSecretの名前だけを返します。値を出力するコマンド、Gitへの書込み、スクリーンショット共有はしません。

## D1のバックアップ

新しいCloudflareアカウントへ移す場合、または念のための退避が必要な場合に実行します。出力先はGit管理外の安全なフォルダにしてください。以下は**読み取り専用のエクスポート**です。

```bash
npx wrangler d1 export seo-loop-strovisiono \
  --remote \
  --output /Users/<your-user>/SEO-LOOP-MIGRATION/d1-full.sql \
  --config cloud-runner/dashboard-wrangler.jsonc

npx wrangler d1 export seo-loop-strovisiono \
  --remote \
  --no-schema \
  --output /Users/<your-user>/SEO-LOOP-MIGRATION/d1-data.sql \
  --config cloud-runner/dashboard-wrangler.jsonc
```

エクスポート後、ファイルのハッシュとサイズを記録します。SQLには顧客情報や暗号化済み認証情報が入る可能性があるため、メール、チャット、Git、公開ストレージへ置かないでください。

## R2の退避

R2には一次情報PDF・アップロード画像・日次バックアップが入ります。D1の `source_files` レコードにある `objectKey` を一覧化し、`FILES` バケットの対応オブジェクトを漏れなく退避します。`BACKUPS` も同様に対象にします。

現行のWranglerはR2オブジェクトをキー単位で取得します。対象キーを確認してから、次の形式でコピーします。

```bash
npx wrangler r2 object get "seo-loop-strovisiono-files/<object-key>" \
  --file "/Users/<your-user>/SEO-LOOP-MIGRATION/files/<safe-file-name>" \
  --config cloud-runner/dashboard-wrangler.jsonc
```

削除・上書きコマンドは使用しません。オブジェクト数、サイズ、ハッシュを記録してから、新バケットへコピーします。

## 新しいCloudflareアカウントへ複製する場合

1. 新アカウントにD1、R2（`BACKUPS` / `FILES`）、Queue（`SEO_JOBS`）を新規作成する。
2. `cloud-runner/dashboard-wrangler.jsonc` をローカルで新しいリソースへ向ける。これはGitへコミットしない。
3. Worker Secretを安全なSecret管理から設定する。`CREDENTIALS_ENCRYPTION_KEY` は既存D1の連携情報を引き継ぐ場合に同一値を設定する。
4. D1を空の新DBへインポートし、D1のレコード数・重要テーブル・`source_files` 件数を旧環境と照合する。
5. R2のオブジェクトをコピーし、`source_files.objectKey` が実在することを抽出確認する。
6. `npm run typecheck:workers`、`npm test`、`npm run build`、Workerのdry-runを通す。
7. テスト用クライアントで、読み取りのみの画面表示・一次情報表示・記事計画表示・ジョブ進捗表示を確認する。
8. WordPressへの書込みを伴わない接続確認を実施する。投稿・更新・公開は、移行完了の承認後だけ行う。
9. カスタムドメインとOAuthコールバックURLを切り替える場合は、Google等のOAuthプロバイダにも新URLを登録する。既存トークンの再認証が必要になる可能性がある。
10. 旧環境はすぐに削除しない。最低7日間、D1/R2とWorkerログを照合してから、別途承認を得て廃止する。

## Claude Codeでの通常開発

```bash
npm run typecheck:workers
npm test
npm run build
npx wrangler deploy --dry-run --config cloud-runner/dashboard-wrangler.jsonc --keep-vars
```

本番デプロイは、差分・テスト結果・影響範囲を確認してから次を実行します。

```bash
npx wrangler deploy --config cloud-runner/dashboard-wrangler.jsonc --keep-vars
```

`--keep-vars` は既存のWorker Secretを維持するために必要です。デプロイ前に、未コミット変更と対象Worker名を必ず確認してください。

## 完了条件

- Claude Codeが同じリポジトリを開ける
- CloudflareのWorker、D1、R2、Queueのbindingを読み取り確認できる
- Secretの値を露出せずに必要な名前を確認できる
- 全検証コマンドが成功する
- D1/R2のバックアップまたは同一アカウント継続の判断が記録されている
- WordPressへ意図しない投稿・更新・公開をしていない

