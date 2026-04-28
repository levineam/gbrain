# Security

## Reporting Vulnerabilities

If you discover a security issue in GBrain, please report it privately:

- **Email:** security@garrytan.com
- **GitHub:** Open a [private security advisory](https://github.com/garrytan/gbrain/security/advisories/new)

Do not open a public issue for security vulnerabilities.

## Remote MCP Security

### ⚠️ Do NOT use open OAuth client registration for remote MCP

If you deploy GBrain's MCP server behind an HTTP wrapper with OAuth 2.1
support, **never allow unauthenticated client registration**. An attacker
who discovers your server URL can:

1. Register a new OAuth client via `POST /register`
2. Use `client_credentials` grant to obtain a bearer token
3. Access all brain data via the MCP tools

### Recommended: `gbrain serve --http`

As of v0.22.5, GBrain ships a built-in HTTP transport that uses the
existing `access_tokens` table for authentication:

```bash
# Create a token
gbrain auth create "my-client"

# Start the HTTP server
gbrain serve --http --port 8787

# Connect via ngrok, Tailscale, or any tunnel
ngrok http 8787 --url your-brain.ngrok.app
```

This is the recommended way to expose GBrain remotely. No OAuth, no
registration endpoint, no self-service tokens. Tokens are managed
exclusively via `gbrain auth create/list/revoke`.

### If you must use a custom HTTP wrapper

1. **Require a secret for client registration** — check a header or body
   parameter before creating new OAuth clients
2. **Disable `client_credentials` grant** — only allow `authorization_code`
   with browser-based approval
3. **Restrict scopes** — never issue tokens with unlimited scope
4. **Log all token issuance** — alert on unexpected registrations
5. **Rate-limit registration and token endpoints**

### Token Management

```bash
gbrain auth create "claude-desktop"   # Create a new token
gbrain auth list                       # List all tokens
gbrain auth revoke "claude-desktop"    # Revoke a token
gbrain auth test <url> --token <tok>   # Smoke-test a remote server
```

Tokens are stored as SHA-256 hashes in the `access_tokens` table. The
plaintext token is shown once at creation and never stored.

## `gbrain serve --http` hardening (v0.22.5+)

The built-in HTTP transport ships with several layers of hardening on by
default. All env vars below are optional; the defaults are intentionally
conservative.

### Postgres-only

`gbrain serve --http` requires a Postgres engine. PGLite is local-only by
design and the `access_tokens` / `mcp_request_log` tables don't exist in
the PGLite schema. Local agents continue to use stdio (`gbrain serve`).
Running `--http` against a PGLite-backed install fails fast with a clear
error message at startup.

### CORS

Default-deny: no `Access-Control-Allow-Origin` header is sent unless an
allowlist is configured. To allow browser-based MCP clients:

```bash
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai gbrain serve --http --port 8787
# Multiple origins: comma-separated
GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai,https://your.app gbrain serve --http
```

When the request `Origin` matches the allowlist, the server echoes it
back in `Access-Control-Allow-Origin` (with `Vary: Origin`). Otherwise no
CORS header is sent and the browser blocks the request.

### Rate limiting

Two buckets, both stored in a bounded LRU map (default 10K keys, evicts
least-recently-used on overflow, prunes entries older than 2× the
window):

| Bucket | When it fires | Default | Env var |
|---|---|---|---|
| Pre-auth IP | Before the DB lookup, on every `/mcp` request | 30 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_IP` |
| Post-auth token | After a valid token is resolved | 60 req / 60s | `GBRAIN_HTTP_RATE_LIMIT_TOKEN` |
| LRU cap | Maximum distinct keys across both buckets | 10000 | `GBRAIN_HTTP_RATE_LIMIT_LRU` |

On exhaustion the server returns `429 Too Many Requests` with a
`Retry-After` header.

**Caveat for tunneled deployments (ngrok, Tailscale Funnel, Cloudflare
Tunnel):** all requests share one egress IP, so the pre-auth IP bucket
becomes effectively shared by all clients on that tunnel. The
post-auth token-id bucket is the load-bearing limiter for tunnel-fronted
deployments.

### Reverse-proxy trust

Disabled by default. To honor `X-Forwarded-For` (or `X-Real-IP`) when
gbrain runs behind a trusted reverse proxy:

```bash
GBRAIN_HTTP_TRUST_PROXY=1 gbrain serve --http --port 8787
```

Only set this when gbrain is behind a proxy you control. Without
the flag, gbrain ignores `X-Forwarded-For` and uses the socket peer
address as the rate-limit key, which prevents IP spoofing via header
injection.

### Body size cap

Default 1 MiB, stream-counted (chunked transfers without
`Content-Length` are still capped). Override:

```bash
GBRAIN_HTTP_MAX_BODY_BYTES=2097152 gbrain serve --http   # 2 MiB
```

Over-cap requests get `413 Payload Too Large` immediately, before any
body is materialized in memory.

### Audit log

Every `/mcp` request writes one row to `mcp_request_log`:

```bash
psql "$DATABASE_URL" -c \
  "SELECT created_at, token_name, operation, status, latency_ms
   FROM mcp_request_log
   ORDER BY created_at DESC LIMIT 100"
```

`status` is one of: `success`, `error`, `auth_failed`, `rate_limited`,
`body_too_large`, `parse_error`, `unknown_method`. Failed-auth rows have
`token_name = NULL`. Inserts are fire-and-forget so audit failures
never block requests.
