# SEO LOOP — Claude Code Project Guide

このファイルはClaude Codeがリポジトリを開いた際のプロジェクト指示です。詳細な移行手順は [docs/CLAUDE_CODE_MIGRATION.md](docs/CLAUDE_CODE_MIGRATION.md)、初回引継ぎ用の貼り付けプロンプトは [docs/CLAUDE_CODE_MIGRATION_PROMPT.md](docs/CLAUDE_CODE_MIGRATION_PROMPT.md) にあります。

## プロダクト

SEO LOOPは、一次情報の収集、SEO分析、記事計画・生成・編集、画像生成、WordPress公開、効果測定をCloudflare上で運用するアプリです。

- UI: `app/seo-loop-app.tsx`
- API: `app/api/[[...path]]/route.ts`
- Cloudflare Worker/Queue/Cron: `cloud-runner/src/full.ts` / `cloud-runner/src/index.ts`
- D1 migration: `drizzle/*.sql`
- WordPress adapter: `lib/wordpress-adapter.mjs`

## 必ず守ること

- 永続データはCloudflare D1/R2/Queueにあり、CodexやClaude Codeにはありません。同じCloudflareアカウントを使うならデータコピーは不要です。
- Secret、OAuthトークン、WordPress Application Password、暗号化キーを表示・記録・コミットしない。
- `CREDENTIALS_ENCRYPTION_KEY` は既存の暗号化済み連携情報と対応する。確認前に変更しない。
- `git reset --hard`、既存マイグレーションの書換え、D1/R2/Queueの削除、WordPressの投稿・更新・公開は、明示承認なしに実行しない。
- AIの未確認な数値・実績・お客様の声を創作しない。外部URLやYouTubeは参考情報であり、顧客の一次情報とは扱わない。
- AI処理はQueueで実行し、UIで処理段階・件数・進捗率を表示する。停止・失敗を曖昧な進行状態のまま残さない。

## 一次情報ヒアリング

- 固定アンケートにせず、既回答を聞き直さない。
- 短い回答は同じ論点で、具体例・対象・期間・条件・根拠のいずれか一つだけを深掘りする。
- 「分からない」「非公開」は繰り返し聞かず、別の根拠へ進む。
- 記事化には確認済みの事実のみを使う。

## 検証とデプロイ

変更後は、最低限次を実行する。

```bash
npm run typecheck:workers
npm test
npm run build
npx wrangler deploy --dry-run --config cloud-runner/dashboard-wrangler.jsonc --keep-vars
```

本番デプロイは、ユーザーの意図・対象Worker・未コミット変更・テスト結果を確認してから実行する。

