# SEO LOOP — 株式会社StrovisionO版

株式会社StrovisionO（`https://strovisiono.com/`）専用のSEO LOOPです。初回ログイン時にStrovisionOの運用先が自動作成され、検索データ、WordPress認証情報、一次情報、記事、ジョブ、ログをこのサイトだけで管理します。

このリポジトリには認証情報、CloudflareのリソースID、サブドメイン設定を含めません。

## Requirements

- Node.js `>=22.13.0`

## Local verification

```bash
npm ci
npm run build
npm test
npm run typecheck:workers
npm run worker:dry-run
```

For local development, create `.dev.vars` from `.dev.vars.example` and enter only the credentials for the client project. Never commit it.

## 公開前の設定

1. 使うサブドメインを決めます（例: `seo.example.com`）。DNSをCloudflare管理にし、Workerのカスタムドメインとしてそのサブドメインを割り当てます。
2. `cloud-runner/wrangler.example.jsonc` を `cloud-runner/wrangler.jsonc` に、`cloud-runner/dashboard-wrangler.example.jsonc` を `cloud-runner/dashboard-wrangler.jsonc` にコピーし、D1・R2・Queueとサブドメインの値を設定します。
3. Cloudflare Workerのシークレットとして、少なくとも暗号化キー、Worker間トークン、Google OAuth（利用する場合）を登録します。APIキーやWordPress Application PasswordはGitに保存しません。
4. 公開後、右上で各サイトを選び、[連携設定]からそのサイト固有のWordPress、Search Console、GA4、Ubersuggestを接続します。WordPressはテスト下書きで接続確認してから運用を開始します。

### workers.dev での仮公開

カスタムドメインを使わない間は、Cloudflare Workerが発行する `workers.dev` URLを利用できます。公開URLはログインなしで利用する構成です。

Cloudflare Secretとして以下を設定します。これらはリポジトリや `wrangler.jsonc` に書き込みません。

- `CREDENTIALS_ENCRYPTION_KEY`
- `SEO_LOOP_WORKER_TOKEN`
- `CLOUD_DISPATCH_TOKEN`

例示用の設定ファイルは意図的に公開可能な状態ではありません。このリポジトリはCloudflareへの公開も、WordPressの変更も行いません。

`worker:dry-run` uses the tracked `cloud-runner/wrangler.typecheck.jsonc` with
a non-production placeholder D1 ID. It compiles and validates the Worker
without uploading or contacting a client resource.
