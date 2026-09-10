# SEO LOOP template

Client-specific SEO LOOP projects start from this repository. It contains the application, migrations, Cloud Runner implementation, and automated tests, but does not contain any client credentials, Cloudflare resource IDs, domains, or deployment configuration.

## Requirements

- Node.js `>=22.13.0`

## Local verification

```bash
npm ci
npm run build
npm test
```

For local development, create `.dev.vars` from `.dev.vars.example` and enter only the credentials for the client project. Never commit it.

## Client setup (when authorized)

1. Copy `cloud-runner/wrangler.example.jsonc` to `cloud-runner/wrangler.jsonc` and set client-specific resource names.
2. If the dashboard and Cloud Runner will share a Worker, copy `cloud-runner/dashboard-wrangler.example.jsonc` to `cloud-runner/dashboard-wrangler.jsonc`, then set the client's domain and Cloudflare resource IDs.
3. Create and apply D1 resources/migrations, configure secrets, and deploy only after explicit approval for that client.

The example configurations are deliberately not deploy-ready. This template does not publish to Cloudflare or change a WordPress site.
