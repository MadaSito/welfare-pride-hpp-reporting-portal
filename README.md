# Welfare Pride HPP Reporting Portal

Welfare Pride HPP Reporting Portal is a self-hosted, multi-tenant reporting application for governed outreach data ingestion, report publication, customer report access, and audit review. The source contains no managed-authentication, managed-storage, or managed-runtime dependency; it is designed to run behind an organization-controlled reverse proxy with PostgreSQL and Redis. The supplied Welfare Pride logo and Roboto typefaces are version-controlled in `branding/` and served locally by the application.

## Deployment

Deploy from a protected `main` branch to a Linux host running Docker Engine and Docker Compose. Create an untracked `.env` beside `compose.yaml`; it must contain strong, unique values for `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `AUDIT_HASH_SALT`, and the public HTTPS `APP_ORIGIN`. Generate `APP_ENCRYPTION_KEY` as base64-encoded random 32 bytes. Start the stack with `docker compose up --build -d` and terminate TLS at a reverse proxy that redirects HTTP to HTTPS and forwards only trusted headers.

| Variable | Requirement | Purpose |
|---|---|---|
| `APP_SESSION_SECRET` | At least 32 random characters | Signs short-lived local-auth sessions. |
| `APP_ENCRYPTION_KEY` | Base64 encoding of exactly 32 random bytes | Encrypts MFA seeds using AES-256-GCM. |
| `AUDIT_HASH_SALT` | Distinct random secret | Hashes client IP values before audit persistence. |
| `POSTGRES_PASSWORD` | Unique database password | Protects the PostgreSQL application role. |
| `REDIS_PASSWORD` | Unique cache password | Protects the Redis service boundary. |
| `SIEM_ALLOWED_HOSTS` | Comma-separated DNS allowlist | Constrains validated SIEM/syslog destinations. |

> The example compose file binds the application to loopback only. Expose it through a hardened reverse proxy, never directly on the public internet.

## Security Model

The portal is designed around explicit verification of every action. Server-side roles distinguish `platform_admin`, `tenant_admin`, `analyst`, and `customer`; sensitive routes check an authenticated session, role permission, CSRF token, tenant scope, and request context. Local passwords use Argon2id. MFA uses TOTP with an AES-256-GCM encrypted seed and short-lived pending-authentication challenges. Sessions are signed, audience-bound, HTTP-only, SameSite-Strict cookies.

The schema enables PostgreSQL Row Level Security and creates an append-only `audit_events` relation guarded by a trigger. Production deployment requires a non-owner database role and tenant context to be set per transaction before executing tenant-scoped queries. Audit events contain safe state diffs and hashed IP values, not password, token, or MFA data. Application logs are JSON structured, correlation-ID aware, and redact sensitive field names before output.

## Identity Providers

Local identity with MFA is the active implementation. Microsoft Entra ID is intentionally configuration-gated: set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, and `ENTRA_REDIRECT_URI` in the deployment secret store, then complete OIDC metadata validation, issuer pinning, callback-state protection, and group-claim mapping before enabling the Entra sign-in control. Do not expose client secrets in the browser or source repository.

## Data Ingestion and Reporting

Administrators submit CSV/XLSX files through the server-validated ingestion endpoint. The endpoint restricts extension and size, checks HPP-required columns, calculates a SHA-256 file hash, records the validation result, rejects duplicate datasets, and persists accepted bytes outside the database with restrictive permissions. The sample HPP columns map `Call ID`, `Member ID`, `Renewal Date`, `Reachable (Yes/No)`, call attempts, and `Call Status` into an explicitly governed dataset contract.

Reports are versioned as drafts and are published to one or more tenant IDs with authorized periods. Customer catalog requests are filtered by the report-publication tenant boundary. Export and SIEM-forwarding transport are intentionally not auto-enabled: export must add formula-injection protection and SIEM destinations must pass an administrative allowlist before a credential can be activated.

## SDLC Controls

The repository contains a GitHub Actions pipeline for TypeScript checks, tests, production build, and high-severity production dependency audit. Protect the `main` branch, require passing checks and code review, enable GitHub Dependabot and secret scanning, sign release tags, and retain build artifacts and audit exports according to the organization’s documented retention schedule.

## Local Commands

| Command | Purpose |
|---|---|
| `pnpm check` | TypeScript verification. |
| `pnpm test` | Security and ingestion unit tests. |
| `pnpm run build` | Builds the React client and Node server. |
| `pnpm run db:generate` | Regenerates Drizzle migration artifacts after schema changes. |
| `pnpm run security:audit` | Fails for high-severity production dependency findings. |

Further architecture and deployment decisions are recorded in [`application-context/`](application-context/), and build-session records are retained in [`session-records/`](session-records/).
