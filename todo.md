# Welfare Pride HPP Reporting Portal — Task Tracking

## Completed (2026-11-10)

- [x] Extract and apply Welfare Pride branding (colors, Roboto fonts, logos)
- [x] Hostinger-ready Node.js architecture (Express 5 monolith, single port)
- [x] SQLite schema + migrations + demo dataset (12 months 2026 data, 4 seeded accounts)
- [x] 9 manual metrics with live computed KPIs (total calls, ACA %, calls/staff)
- [x] Monthly tracking over time (trends, comparison, table, CSV import/export)
- [x] Report draft/preview/publish workflow with publish targets (all, view_users, specific_users) and hide capability
- [x] Local auth + TOTP MFA (enrollment wizard, QR/manual key, 8 recovery codes, lockout back-off)
- [x] 4-tier RBAC (Super Admin, Admin, Manager, View Only) with super admin isolation
- [x] Dedicated Viewer Portal for View Only role
- [x] Microsoft Entra ID SSO configuration
- [x] Advanced audit log center (filters, JSON metadata search, CSV export)
- [x] SIEM dual-stream forwarding (RFC 5424 syslog + HTTPS webhook, queues)
- [x] Email engine with failover (MS Graph + SMTP + simulation, circuit breaker, BCC, mail logs)
- [x] Backup & data portability (encrypted snapshot .zip, SHA-256 checksums, restore dry-run validation, CSV/JSON portability, formula-safe escaping)
- [x] IP firewall & geo blocking
- [x] White-label branding editor with live CSS variable application
- [x] Light / dark / system theme with system mode default
- [x] ADA compliance features + 1000% responsive layout with mobile drawer
- [x] Zero-trust security + OWASP Top 10 mitigations
- [x] CI workflow, commit attribution, application-context folder, session-records folder
- [x] Full test suite (17/17 passing) + end-to-end API verification against live service

## Follow-up / Production Hardening

- [ ] Rotate all seeded demo passwords
- [ ] Fill real Entra ID credentials for SSO (if used)
- [ ] Configure real syslog receiver IP/port or webhook endpoint
- [ ] Configure real MS Graph / SMTP email credentials
- [ ] Set up automated backup cron (e.g. daily snapshot + off-site copy)
- [ ] Add monitoring / uptime alerts pointing to `/api/v1/health`
- [ ] Optional: migrate SQLite to managed PostgreSQL via the prepared Drizzle adapter when multi-instance horizontal scaling is needed
