# Session record — fresh private VPS installer — 2026-11-23

## User prompts

> give me the script to auto install app on a new server

> THis will run on a private VPS server

The standing project requirements call for independent self-hosting without hosted-platform OAuth/runtime dependencies, local MFA, advanced logging, modern SDLC/security safeguards, regular GitHub versioning, and separate application-context/session records. Saved installation preferences require a generated initial local administrator, password display once, no email dependency, and selectable native VPS/bare-metal/Docker installation.

## Responses and decisions

The assistant acknowledged the installer request and checked the actual GitHub code before choosing a deployment design. It explained that current GitHub main is SQLite-based, unlike the older attached PostgreSQL/Redis host. The README explicitly marks current code unsuitable for production or sensitive data. The installer therefore targets a fresh test/staging VPS and synthetic data, not a production certification or a migration of the existing server.

The assistant acknowledged the private-VPS clarification, retained HTTPS at the reverse proxy, and kept the direct application port private. An entirely internal-only server/hostname that cannot complete public ACME validation requires a separately reviewed private TLS or DNS-challenge arrangement; the installer does not silently use HTTP or an untrusted certificate.

A separate installation-only helper was added to create the first local administrator before network exposure, with mandatory MFA, required password change, a generated temporary password displayed only on a private interactive terminal, and an atomic credential-free database audit event. Mandatory deployment MFA was enforced across local provisioning, login, and administrative updates. The unsafe older README password-reset snippet was removed; no new recovery/reset command was invented.

During client-flow verification the assistant found that the existing login component had API/state helpers for enrollment and required password change but did not render those screens. It explicitly reported the blocker and initiated the missing UI screens as a necessary dependency of usable mandatory-MFA installation. Initial API-only checks alone were not presented as proof of successful browser login.

## Recorded verification before final UI integration

Frozen dependency installation and an explicit better-sqlite3 native rebuild succeeded. TypeScript checking and Vite/esbuild production build passed. Targeted bootstrap/setup/installation tests passed 23 tests. The complete suite passed 176 tests across 13 files on disposable temporary databases. Existing custom IPv6 rate-limiter warnings from cloudflare.ts, pnpm configuration warnings, and a frontend chunk-size warning remain visible; tests are not a production security certificate.

The installer was reviewed for new-server-only guards, external runtime secret storage, root-owned readable source and non-root runtime, private direct ports, bootstrap before application/proxy startup, and a separate Docker bootstrap configuration with its daemon log driver disabled. This last point prevents terminal-displayed credentials from also being retained in Docker container logs. Failure cleanup preserves files, data and keys while stopping only newly created portal services. No automatic swap, firewall reset, reinstall, database reset, skipped bootstrap, insecure-cookie flag, or key rotation is offered.

## Data/publication boundary

The current GitHub repository is public. No runtime environment file, actual initial password, actual MFA seed/recovery code, customer data, attached-host database or private log is included in publication. Passwords in regression fixtures are synthetic and generated installation credentials remain only in the test process memory/private temporary data.

No deployment or changes were performed on the attached existing host. Full clean-host package provisioning, real Caddy certificate issuance and Docker build/Compose runtime checks remain unperformed in this sandbox and require a clean VPS with real network prerequisites. Final installer/UI test and commit results are recorded below after integration.

## Final integration and response

The assistant reported that installer and missing login screens were complete and that it was running the final build before publishing. The final integrated check passed TypeScript, installer Bash syntax, the bounded installer harness, 181 tests across 14 files, and Vite/esbuild production compilation. Five of those tests use an isolated local Chromium mock-API harness for enrollment, recovery-code acknowledgment, required-password-change forms, failure/cancellation handling, and 320-pixel overflow. ShellCheck was unavailable. Full new-VPS package/systemd/Docker/ACME provisioning was not performed and is not claimed.

Delivery includes the downloadable `deploy/install.sh` and `deploy/INSTALL.md` guide, with GitHub version control. The recommended operator command uses a reviewed checkout, `--method=vps`, the operator's actual DNS domain and initial-admin email, optional pinned full commit SHA, and the mandatory `--acknowledge-testing-only`. The reserved example hostname must be replaced. An optional initial `--check` is read-only. Installation creates a generated local admin before exposure, displays its password once on the private terminal, and requires authenticator enrollment, recovery-code storage and a password change. The final response must prominently preserve the synthetic-data testing restriction, no-existing-server-change boundary, and automatic-public-HTTPS prerequisites for a private VPS.
