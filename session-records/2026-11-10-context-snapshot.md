# Welfare Pride HPP Reporting Portal — Session Context Snapshot (2026-11-10)

## Sources
- Attachment: `/home/ubuntu/upload/hppMaster_Prompt_Enterprise_Reporting_Portal.docx`
- Project shared files: `/home/ubuntu/projects/welfare-pride-hpp-reporting-dash-b32c1433/`
- Existing repo: `https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.git`

## Brand Guidelines
- Company: Welfare Pride (URL: www.welfarepride.org)
- Colors: Primary #5A92C9 (CMYK 75/30/2/0, RGB 90/146/201), Secondary #D58240 (CMYK 3/59/88/0, RGB 213/130/64), Black #000000, White #FFFFFF
- Fonts: Roboto (regular/medium/bold headings)
- Logos: welfare-pride-main-logo.webp (emblem + black text), Welfare Pride Icon.png/.jpg (emblem standalone)

## Master Prompt Summary (6 Modules)
1. RBAC & Identity: 4 tiers (Super Admin > Admin > Manager > View Only); Super Admin isolation; Local DB (Argon2id) + Microsoft Entra ID SAML 2.0/OIDC SSO with conversion engine; enforceable TOTP MFA (QR + manual key + recovery codes)
2. Audit & SIEM: correlation ID per request, real IP (CF-Connecting-IP), CF-IPCountry geo, action codes, severity, before/after states, ISO 8601 UTC; Audit Center UI with filters + CSV export; RFC 5424 Syslog (UDP) + HTTP REST webhook SIEM streaming with retry buffer
3. Dashboards & Publishing: 9 manual metrics + month + year; computed KPIs; trend charts; draft->preview->publish (to all, specific users, or View Users) workflow; hide reports; monthly history table
4. Resilient Email: primary MS Graph API OAuth2 mail / secondary SMTP; auto failover + circuit breaker; mandatory global BCC; mail log UI + one-click resend; test email
5. Backup & Portability: encrypted/standard full snapshot zip; CSV metrics import/export (formula-injection safe); CSV audit export; JSON config schema export/import; restore with validation
6. Branding: white-label engine (config + admin UI), light/dark/system themes (system default), logo upload, CSS tokens

## Runtime/Hosting
Hostinger Node.js Web Hosting (Passenger/PM2, single-port, process.env.PORT, Node 18/20 LTS, .env, SQLite embedded db); Cloudflare Full (Strict) SSL; zero Manus dependencies.
