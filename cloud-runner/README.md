# SEO LOOP Cloud Runner

Cloudflare Queue consumer for SEO LOOP jobs. This folder contains source code
only; it intentionally has no client deployment configuration or secrets.

When deployment is explicitly authorized for a client, copy the matching
`*.example.jsonc` configuration and supply that client's Cloudflare resource
names, IDs, domains, and Worker secrets locally. Do not commit the resulting
`wrangler.jsonc` files.

Expected secrets are configured per client and include the application service
token, AI provider keys, Google OAuth credentials, Ubersuggest OAuth token, and
the queue dispatch token. Keep every value out of Git and out of templates.
