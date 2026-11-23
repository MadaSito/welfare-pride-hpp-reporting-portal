# Fresh private VPS installer context — 2026-11-23

The user requested an automatic installation script and clarified that the target is a private VPS server. This delivery targets current GitHub SQLite code, not the earlier attached PostgreSQL/Redis deployment. No existing server was provisioned, reset, upgraded, or modified in this task.

The installer is for a fresh staging/test host and synthetic data only. Current README and production-security-assessment.md remain authoritative about unresolved production blockers. A privately operated VPS, mandatory MFA, successful tests, or HTTPS do not certify production security, whole-database encryption, zero-knowledge operation, accessibility compliance, Entra sign-in, or secure SIEM forwarding. The full test run still emits existing IPv6 custom rate-limit key warnings from server/cloudflare.ts; broad proxy trust also remains an application concern.

## Installation account and runtime boundaries

`server/install-admin.ts` validates private interactive stdin/stdout and an absolute persistent DATA_DIR before importing SQLite. It generates the password internally using cryptographic randomness. Its immediate transaction creates the first tenant/super administrator, sets `mfa_required=1` and `must_change_password=1`, and inserts `installation.admin.created` with role and policy metadata but no credentials. If the audit insertion fails, user creation rolls back. If any user exists, bootstrap is refused. Credential output follows a successful database commit and is directed only to the operator's private terminal, not systemd/Docker application logs. Operators must avoid terminal recording and save the temporary password privately.

`REQUIRE_LOCAL_MFA=true` is enabled by the new installer. The repository enforces MFA for newly created local users, including invitation/setup call sites that previously supplied false defaults. The admin API and repository reject disabling MFA for local users in this mode. Login upgrades a legacy local MFA-off flag only after successful password verification, and old MFA-off full cookies are rejected while the mode is enabled. Full sessions cannot bypass a required password change. In this mode new passwords must be at least 14 characters. Existing deployments that omit this flag retain their old MFA configuration; this task does not change their runtime environment or migrate their data.

The initial login proceeds through authenticator enrollment, saving eight MFA recovery codes, and a temporary-password change before report/metric access. Subsequent password logins require MFA verification. SMTP/email access is not required to bootstrap. The old bootstrap command retains its legacy behavior for existing workflows and is not the installer helper or a password reset.

## Packaging and version control

The standalone Dockerfile copies patches before frozen dependency installation, explicitly rebuilds better-sqlite3 with an allowlist, and runs as non-root uid 10001. The new .dockerignore excludes runtime secret files, data, private keys, Git history, logs, and developer artifacts. Native provisioning also uses an unprivileged runtime and a persistent data directory separated from root-owned source. Runtime keys remain outside the repository. The installer records the resolved Git commit and refuses reinstall paths instead of rotating keys.

The GitHub repository is currently public. Only installer-related source, tests, and non-sensitive documentation are included in this delivery. No actual admin credential, MFA secret, runtime config, database, customer file, or attached-host private log is published.

## Validation

Frozen dependency installation succeeded with pnpm 10.4.1, followed by an explicit allowlisted SQLite rebuild. An in-memory SQLite open/query/close succeeded. TypeScript checking and the production Vite/esbuild build passed. The targeted bootstrap/setup/installation suite passed 23 tests. The complete suite passed 176 tests across 13 files using isolated temporary data directories; new installation tests cover non-TTY refusal before data creation, one-time provisioning and duplicate refusal, credential-free audit, transactional rollback on audit failure, mandatory MFA enrollment, initial password-change access gating, local account provisioning, MFA-disable rejection, and subsequent MFA challenge.

The build reported a frontend chunk-size warning. Existing IPv6 limiter validation warnings and pnpm configuration warnings were not treated as evidence of production safety. Full VPS package provisioning, Caddy public certificate issuance, and a Docker image/Compose deployment have not been performed in this sandbox; they require a clean target host and actual DNS/network prerequisites. No attached host is used for these tests.

## Final integration results

The missing login UI screens were restored for MFA QR/manual-secret enrollment, verification, eight recovery codes, explicit saved-code acknowledgment and mandatory password change. AuthContext keeps recovery codes and the server-confirmed next stage in memory until acknowledgment and withholds user privileges during that screen. It cannot turn a server password-change stage into full access. New fields have labels/focus styles and alerts; this is not an ADA certification.

Five Chromium UI regressions passed on intercepted mock APIs at isolated loopback ports. They cover first-installation sequencing, code acknowledgment before either password-change or full stage, refresh preservation, enrollment initialization under StrictMode/CSRF updates, retry/network errors, manual-key fallback, password-policy feedback, cancellation/secret cleanup, lack of credential console/storage/URL leakage, and 320-pixel overflow. Chromium profiles and Vite cache use private temporary directories and are removed. Actual authentication behavior remains covered separately by disposable SQLite API tests.

Final integrated validation passed TypeScript checking, both Bash syntax checks, the bounded installer harness including 29 input cases and mock/static preservation/start-order/secret-format checks, all 181 tests across 14 files, and the production Vite/esbuild build. ShellCheck is unavailable and was not silently represented as passed. No clean-host apt/systemd/Docker/ACME deployment was executed. The Dockerfile also normalizes source readability for non-root runtime when the installer clones source under umask 077, while keeping app data writable only to the runtime identity.
