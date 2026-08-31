# Application Context: Implementation Status

## Delivered Foundation

The repository now contains a self-hosted React/Express/PostgreSQL portal foundation styled with the supplied Welfare Pride assets. The server contains local identity endpoints, MFA TOTP enrollment and verification, signed short-lived session claims, password policy enforcement, server-side RBAC, tenant-scoped report catalogue authorization, governed CSV/XLSX structural validation, report draft/publication endpoints, structured logging, and immutable audit-event interfaces.

The operational configuration includes a container image, compose topology, PostgreSQL schema initialization, an initial Drizzle migration, a GitHub Actions quality gate, a security controls document, architecture notes, and this session history. The dependency audit was rerun after removal of unused template packages and the remaining high-severity finding threshold is clear.

## Deliberately Pending Before Production Data

| Capability | Current boundary | Required follow-up |
|---|---|---|
| Initial administrator | Authentication requires a user stored in PostgreSQL | Create a break-glass, MFA-enrolled bootstrap administrator through a controlled, one-time operations command. Do not seed credentials into source. |
| Invitations and password reset | Administrator user creation creates a one-time password | Implement an expiring, single-use invitation delivery channel and a separately audited reset flow. |
| Dataset normalization | Valid uploads are stored with a mapping contract | Add isolated parsing, malware scanning, normalized outreach-row persistence, and quarantine handling before loading PHI/PII. |
| Entra ID | UI is configuration-gated and deployment variables are documented | Implement OIDC discovery/issuer pinning, PKCE/state/nonce controls, claim mapping, and tested tenant registration before enabling. |
| SIEM/syslog transport | Endpoint allowlist validation is present | Add credential secret retrieval, TLS client configuration, buffering, retry/backoff, and delivery monitoring. |
| Audit centre | Structured event schema and read endpoint are present | Add indexed server-side filters, protected CSV export with formula-injection controls, retention jobs, and alert policies. |

## Verification Snapshot

The last local verification completed `pnpm check`, `pnpm test` with five passing tests, `pnpm run build`, and `pnpm run security:audit`. The high-severity production dependency audit completed with no known high-severity vulnerabilities. Desktop and 375-pixel mobile views were reviewed in the running portal preview.
