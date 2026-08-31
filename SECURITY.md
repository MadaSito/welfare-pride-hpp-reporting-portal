# Security Controls and Operational Boundaries

## Trust Boundaries

The browser, reverse proxy, application, PostgreSQL, Redis, object/file volume, identity provider, and SIEM are separate trust boundaries. Requests are treated as untrusted until the application verifies session validity, role, tenant scope, CSRF proof for state changes, schema input, and object-level authorization. Administrative access is never inferred from client-side state.

## Current Controls

| Area | Implemented control | Operational requirement |
|---|---|---|
| Authentication | Argon2id local passwords, TOTP MFA, signed short-lived session cookies, rate-limited sign-in | Bootstrap and rotate secrets in a dedicated secret manager. |
| Authorization | Server-side role middleware and tenant-scoped customer catalog query | Add database transaction tenant context and RLS policies before handling production data. |
| Uploads | CSV/XLSX allowlist, 12 MB cap, required-header validation, SHA-256 provenance, duplicate detection | Add magic-byte checks, malware scanning, and isolated object storage before general production use. |
| Auditability | Append-only schema trigger, request IDs, actor/resource/action context, safe structured logs | Forward only TLS-protected, allowlisted logs to SIEM after credentials are secret-managed. |
| HTTP protection | Production CSP, HSTS through Helmet, frame denial, object denial, referrer minimization, secure cookies | Terminate TLS 1.3 at the proxy, set an explicit `APP_ORIGIN`, and validate proxy configuration. |

## Security Events

Sign-in success/failure, MFA enrollment, user creation/disablement, upload validation/storage, report creation/publication, catalog access, SIEM configuration decisions, and unhandled server failures create audit records. The portal intentionally stores a salted IP hash rather than a raw client IP in its audit relation. Passwords, tokens, MFA seeds, backup codes, cookies, and authorization headers are redacted from application logs.

## Incident Response

When an alert indicates potential account compromise, disable the account, preserve the append-only audit records, revoke sessions through the deployment’s shared session-revocation control, rotate affected secrets, and notify the designated incident owner. Changes to SIEM forwarding, authentication configuration, and user permissions should require step-up MFA and a second-person review in the operational runbook.
