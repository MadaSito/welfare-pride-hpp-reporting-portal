# Welfare Pride — HPP Enterprise Reporting Portal

A self-hosted, enterprise-grade reporting and outreach-intelligence portal built for Welfare Pride's Health Promotion & Outreach Program (HPP). Track manual monthly outreach metrics over time, author and publish reports to targeted audiences, and operate securely with local MFA authentication, four-tier role-based access control, and advanced audit logging with SIEM forwarding.

![Node](https://img.shields.io/badge/node-22%20LTS-brightgreen) ![React](https://img.shields.io/badge/react-19-blue) ![License](https://img.shields.io/badge/license-proprietary-lightgrey)

## Highlights

- **9 manual monthly metrics** with live computed KPIs (total calls across 3 rounds, ACA acceptance rate, calls per staff)
- **Monthly tracking over time** — 12 seeded 2026 months with trend charts, monthly comparison, and data table
- **Report workflow** — create drafts, publish to *everyone*, *view users*, or *specific users*, or hide reports
- **4-tier RBAC** — Super Admin (isolated), Admin, Manager, View Only (dedicated Viewer Portal)
- **Local auth + MFA TOTP** — enrollment wizard, QR + manual key, 8 recovery codes, lockout back-off
- **Microsoft Entra ID SSO** — SAML/OIDC ready configuration
- **Advanced audit log center** — 30+ action types, real-IP, geo country, JSON metadata search, CSV export
- **SIEM dual-stream forwarding** — RFC 5424 syslog over UDP (facility 16) + HTTPS webhook with retry queues
- **Email engine with failover** — MS Graph + SMTP, circuit breaker, mandatory BCC, mail logs, one-click resend
- **Backup & data portability** — encrypted snapshot .zip, SHA-256 checksums, restore dry-run validation, CSV/JSON portability with formula-injection protection
- **IP firewall & geo blocking** — Cloudflare CF-Connecting-IP aware, rule hit counters
- **White-label branding** — company name, logos, colors (applied via CSS variables at runtime), default theme
- **Light / dark / system theme** — **system mode default**, WCAG-contrast palettes
- **ADA compliant & 1000% responsive** — keyboard navigation, focus rings, reduced-motion support, mobile drawer nav

## Architecture

| Layer | Technology |
|---|---|
| Server | Express 5 on Node 22 LTS (single-process monolith) |
| Database | SQLite via `better-sqlite3` with WAL mode (PostgreSQL adapter ready) |
| Frontend | React 19 SPA served statically by Express |
| Styling | Tailwind CSS 4 with brand color tokens |
| Build | esbuild (server bundle, ~106 KB) + Vite (client) |

## Quick Start (local / VPS)

```bash
git clone https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.git
cd welfare-pride-hpp-reporting-portal
pnpm install          # or: npm install
cp .env.example .env  # fill in required secrets (see table below)
pnpm run build
pnpm start            # listens on http://localhost:3000
```

## Hostinger Node.js Hosting Deployment

Hostinger's **Cloud Startup/Professional/Enterprise** hosting plans and VPS plans support Node.js applications:

1. **Hostinger Panel → Advanced → Node.js** (or Application → Node.js):
   - **Node.js version:** `22.x` (LTS)
   - **Application mode:** `Production`
   - **Application root:** directory where you upload the project (e.g. `public_html/portal` or `domains/<domain>/public_html`)
   - **Application startup file:** `dist/index.js`
   - **Application URL:** your domain
2. **Upload** either via Git (Hostinger Git deployment) or SSH:
   ```bash
   ssh u123456789@your-hostinger-server -p 65002
   cd domains/yourdomain.com
   git clone https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.git portal
   cd portal
   npm install --production=false
   npm run build
   ```
3. **Environment variables** — create `.env` next to `dist/index.js`:
   ```bash
   APP_ORIGIN=https://yourdomain.com
   APP_SESSION_SECRET=<32+ random characters>
   APP_ENCRYPTION_KEY=<base64 32-byte key: openssl rand -base64 32>
   NODE_ENV=production
   DATA_DIR=/home/u123456789/portal-data   # keep OUTSIDE the web root so it persists across deploys
   PORT=3000                              # or $PORT set by Hostinger passenger
   ```
4. **Click "Start" / "Restart"** in the Hostinger Node.js panel. The app serves both the API and the SPA from a single port.
5. **Back up the `DATA_DIR` directory** (`portal.db`, `portal.db-wal`, `portal.db-shm`, `backups/`) with your Hostinger backup schedule, or use the portal's built-in **Backup → Create snapshot** which writes encrypted `.zip` snapshots.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APP_ORIGIN` | Yes (prod) | Public origin, e.g. `https://reporting.welfarepride.org` |
| `APP_SESSION_SECRET` | Yes | 32+ character session signing secret |
| `APP_ENCRYPTION_KEY` | Yes | 32-byte base64 key for AES-256-GCM secret encryption |
| `DATA_DIR` | No (default `data/`) | Directory for `portal.db` and backup snapshots |
| `PORT` | No (default `3000`) | HTTP listen port |
| `BOOTSTRAP_ADMIN_EMAIL` | No | Seeded admin email (default `admin@welfarepride.org`) |
| `BOOTSTRAP_ADMIN_PASSWORD` | No | Seeded admin password override |
| `GLOBAL_EMAIL_BCC` | No | Mandatory BCC for every outbound email (immutable compliance override) |
| `TRUST_PROXY` | No | Set `true` behind Hostinger passenger / Cloudflare |

## RBAC & Demo Accounts (first run)

| Role | Email | Password | Access |
|---|---|---|---|
| Super Admin | `superadmin@welfarepride.org` | `SuperAdmin2026!#W` | Everything; SIEM; email config; branding; security rules |
| Admin | `admin@welfarepride.org` | `AdminPass2026!#W` | Users; audit; backups; cannot see super admins |
| Manager | `manager@welfarepride.org` | `ManagerPass2026!#W` | Enter metrics; create & publish reports; hide reports |
| View Only | `viewer@welfarepride.org` | `ViewerPass2026!#W` | Dedicated read-only Viewer Portal (published reports) |

Accounts with `MFA: required` are guided through the enrollment wizard on first sign-in (QR code + manual secret). Rotate all demo credentials before production.

## 9 Manual Metrics

1. Calls completed in the 1st round
2. Calls completed in the 2nd round
3. Calls completed in the 3rd round
4. ACA YES
5. ACA No
6. Head of Household
7. Staff Members making calls
8. Calls referred to JHPP
9. Calls referred to WR
+ **Reporting Month** (Jan–Dec) and **Reporting Year**

Auto-computed: **Total Calls** (R1+R2+R3), **ACA Acceptance %** (`YES / (YES+NO)`), **Calls per Staff** (`Total / Staff`).

## Verification & SDLC

```bash
pnpm check           # TypeScript type check — 0 errors
pnpm test            # 17 vitest unit tests
pnpm run build       # production build
pnpm security:audit  # npm audit --prod
```

Unit tests cover: security (passwords, MFA secret crypto, session cookies, rate limit, CSRF, bounded role assignment, super admin isolation), repository (tenant isolation, metrics KPIs, report publish targets), and CSV ingestion validation.

## Security

- OWASP Top 10 mitigations: Helmet CSP, HSTS, secure cookies (`__Host-` style), bcrypt password hashing, parameterized SQL, CSV formula-injection escaping, strict rate limiting, real-IP extraction, geo-country blocking
- Zero-trust: least-privilege RBAC enforced per route; immutable audit log with actor attribution
- SIEM streaming: RFC 5424 syslog (local0, UDP 514) + HTTPS webhook with retry queues
- Confidential secrets encrypted at rest with AES-256-GCM

## Accessibility (ADA)

Skip link, semantic landmark regions, `aria-*` attributes, visible focus rings, 44px touch targets, reduced-motion respect, high-contrast palettes, and keyboard-operable drawers and dialogs.

## Project Structure

```
├── client/              # React 19 SPA
│   ├── src/pages/       # Dashboard, MetricsEntry, Reports, Users, Audit, SIEM, Email, Backup, Branding, Security, ViewerPortal, Login
│   ├── src/contexts/    # Auth (MFA), Theme, Branding
│   └── src/components/  # Layout, MetricCard, dialogs
├── server/              # Express 5 backend
│   ├── repository.ts    # SQLite models, migrations, demo seed
│   ├── security.ts      # Auth, MFA, RBAC, sessions, crypto
│   ├── audit.ts         # Audit recording & query
│   ├── siem.ts          # RFC 5424 syslog + webhook
│   ├── email.ts         # Failover engine + circuit breaker
│   ├── backup.ts        # Encrypted snapshots, CSV/JSON portability
│   └── cloudflare.ts    # Real-IP, rate limits, IP firewall
├── branding/            # Welfare Pride logo, icon, Roboto fonts
├── data/                # SQLite DB (runtime, git-ignored)
├── session-records/     # Prompts, responses, and results log
└── application-context/ # Implementation status & architecture notes
```

## License

Proprietary — © Welfare Pride. All rights reserved.
