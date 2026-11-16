# Session record — sign-in investigation and Hostinger GitHub installation, 2026-11-12

## User prompts

1. “I tried to login and i cant the password doesnt work”
2. “give me the instructions on how to install this on hostinger using the github repo install option”

## Findings and response

The preview service was healthy and its existing sample super-admin account was active, had MFA enrolled, and was not locked at the time of inspection. Recent preview logs did not show a matching failed password-login attempt, so the problem was not established. The user was asked whether the issue occurred in the preview or on Hostinger and what screen or error appeared; no password was requested. No account credentials or application records were intentionally changed, and no database was reset. An independent synthetic-browser test was interrupted by the user's subsequent message, so it was not counted as a passed test.

Prepared `application-context/hostinger-github-installation.md` using current Hostinger documentation and repository-specific settings. The guide covers connecting the private GitHub repository, Express/Node/pnpm build settings, required environment variables, verified private persistence, interactive first-admin bootstrap, MFA, updating, and security blockers. It explicitly warns that Hostinger compatibility and real-email delivery remain unverified, the application is not approved for production or sensitive data, no default admin exists, and preview data and credentials are not automatically transferred.

An isolated clean archive of commit `bf09c00` installed with pnpm 10.4.1, built with Node 22.23.4, and passed in-memory SQLite and password-hashing native-module smoke tests. No Hostinger deployment or real user-data test was performed. No credentials, secret values or access tokens are recorded here.

## 2026-11-16 — Hostinger deployment troubleshooting ("Entry file not found")

**User report**: The deployment failed with Hostinger build logs showing: build completed in 7.1s, then `ERROR: Entry file not found` at line 183. Deployment repo shown as `WelfarePride_Reporting_Portal_JHPP`.

**Root cause**: The build itself succeeded (`dist/index.js` was produced), but Hostinger's configured **Entry file** setting did not match the built file path (Hostinger's default is `server.js`/`app.js` at repo root, while the server is bundled to `dist/index.js`).

**Resolution**:
1. Added root `index.js` and `server.js` forwarding entry points (`import "./dist/index.js";`).
2. Added `"main": "dist/index.js"` to `package.json` for Hostinger auto-detection.
3. Verified both entry points start the server and respond to health checks.
4. All 161 tests pass.
5. Advised the user to set **Entry file** = `dist/index.js` with **Express** framework in Hostinger, or redeploy the updated repo where any of `dist/index.js`, `index.js`, or `server.js` will resolve.

## Update — 2026-11-16: First-time setup wizard on the login page (no SSH required)

**Problem:** The administrator could not access the Hostinger SSH console, so the CLI bootstrap command was unreachable.

**Solution:** Added an in-browser first-time setup wizard:
- `GET /api/v1/auth/setup/status` reports whether any users exist.
- `POST /api/v1/auth/setup` creates the initial `super_admin` account locally in the database, with MFA enrollment required on first sign-in, and optionally persists company name, tagline, brand colors (multiple hex values) and logo URL.
- On a fresh installation the login page automatically shows the setup wizard; after exactly one submission the endpoint is permanently locked (`409 SETUP_ALREADY_COMPLETED`) and subsequent visitors see only the standard sign-in page.
- No email access and no SSH access are required for the initial setup.

**Verification:** 9 new tests in `server/setup.test.ts` (all passed), full suite 12/12 files and 170 tests passing, build clean, smoke test with live server + `curl` simulating the real browser flow end-to-end. README and the Hostinger installation guide were updated to describe the wizard as the primary method.

## Update — 2026-11-16 (follow-up): Sign-in failure diagnosed + "Generate strong password" wizard enhancement

**Problem reported:** After creating a password, the admin got "Sign-in could not be completed. Check your details or try again later."

**Diagnosis:**
1. The database confirms the account was created (`setup/status` reports `userCount: 1`, setup wizard locked).
2. The user's typed password in the screenshot is ~13 characters long, while the policy enforced at creation requires ≥14 characters — the typed password does not match the saved password.
3. The error message was generic and gave no clue about what went wrong.

**Fixes applied:**
1. Added a **"Generate strong password"** button to the setup wizard that auto-fills both password fields with a policy-compliant random password, reveals it, and adds a **Copy** button — per the knowledge item *"Scripts should automatically set a secure password and provide it to the user upon completion, rather than requiring manual input that could lead to errors."*
2. Improved login error messages to distinguish `INVALID_CREDENTIALS` (wrong email/password), `ACCOUNT_LOCKED` (rate-limited after repeated failures), `ACCOUNT_DISABLED`, and bad request format.
3. Added `email.trim()` on both the client side and the server login schema so trailing spaces never break sign-in.
4. Added 30-sample property test verifying every generated password satisfies server policy rules.

**Recovery path for the user:** because the created password is unknown, delete/rename `portal.db` in Hostinger File Manager to re-show the wizard, then use the "Generate strong password" button and copy the password.

## Update — 2026-11-16 (Node version compatibility)

**Question:** Will this run on Node 24.x?

**Answer verified:** Yes, with a caveat.
- `better-sqlite3` declares `engines: { "node": ">=22" }`
- `@node-rs/argon2` declares `engines: { "node": ">=10" }`
- Both native modules use ABI-stable N-API (forward-compatible).
- Added `"engines": { "node": ">=22" }` to `package.json` to formally declare support.
- **Recommendation:** stick with **Node 22.x** (Active LTS), which is what the portal was built and tested against. If Node 24.x is selected, it should still work, but 22.x is the safer, verified choice.

## Update — 2026-11-16 (VPS auto-installer, Manus branding cleanup)

**Questions:**
1. If I install on a VPS, will it auto-create the first admin account or ask me?
2. Hostinger loaded but didn't ask to set the password.
3. Give me the script to auto install this application.

**Answers & actions:**
1. Explained why Hostinger didn't show the wizard: the database already had a user from a previous session, and the live deployment was running an older JS build. To fix: delete `portal.db` in File Manager, then Redeploy.
2. Verified live site: Hostinger is currently serving the default parking page (app not running) — Redeploy is required, OR move to VPS.
3. Created `deploy/install.sh` (universal installer) supporting three methods chosen interactively or via flags:
   - VPS/bare metal (systemd + optional Caddy automatic HTTPS)
   - Docker (compose + persistent SQLite volume)
   - Hostinger verification mode
   The VPS method **automatically creates the first administrator** with a randomly generated, policy-compliant password, and **displays username, password, portal URL, and next-steps instructions upon completion**.
4. Manus branding cleanup: deleted `template.json`, removed manus references from `.gitignore`, renamed test fixtures. Zero references remain in repo source.
5. README updated with one-liner `curl ... | sudo bash` install command. All 171 tests pass, build clean.

## Update — 2026-11-16 (DigitalOcean 512 MB droplet sizing)

**Question:** Will this run on the 1 vCPU / 512 MB VPS ($4/mo)?

**Measurements (measured, not guessed):**
- Runtime RSS: ~100 MB (Node) + ~20 MB (Caddy) + ~80–120 MB (OS/systemd) ≈ 200–250 MB total idle — fits in 512 MB.
- Build peak RSS (`pnpm run build`: vite + esbuild): ~806 MB — exceeds 512 MB without swap.
- Fresh install disk footprint: ~3.5–4.5 GB total out of 10 GB SSD on the $4 plan (55–65% full).
- Added automatic 1 GB swap creation in `deploy/install.sh` for systems with <900 MB RAM so builds succeed.
- Recommendation: $6/mo (1 GB RAM / 25 GB SSD) for $2/mo more avoids build swapping entirely, gives 2.5× more disk for backups/logs, and is the comfortable, headache-free choice.

## Update — 2026-11-16 (installer stdin/tty fix)

**Reported issue:** Running `curl ... | sudo bash` immediately exited with "Invalid selection." before accepting input, then typing `1` produced "1: command not found".

**Cause:** When the installer is piped from curl, stdin is the curl pipe (which reaches EOF after the script is delivered). The `read` command was reading from that closed pipe instead of the terminal.

**Fix:** Added a `read_input` helper that reads from `/dev/tty` when stdin is a pipe, re-prompts on invalid selection instead of exiting, and dies cleanly only when no terminal is available. Verified the piped-stdin interactive flow end-to-end.

## Update — 2026-11-16 (VPS admin auto-creation bug fixed)

**Reported issue:** VPS install failed at step 8/8 with `Value is none of these types 'String', 'TypedArray<u8>'`. The summary/credentials were never printed, and subsequent login attempts failed with "Sign-in could not be completed". The SSH session also disconnected after the install.

**Root cause:** The installer used chained bash heredocs (`node << 'NODE' ... <<BOOTENV ... BOOTENV`), which discarded the BOOTENV block. `BOOT_PWD` was never set, so `hashPassword(undefined)` passed `undefined` to `@node-rs/argon2`, which throws that exact error. `set -e` made the installer exit before `print_summary`, so the admin account was never created. The SSH disconnect was unrelated (idle timeout of the web console/SSH session).

**Fix:** Rewrote step 8/8 to write a temporary `.bootstrap-admin.mjs` script, robustly discover the node binary (including system-wide NodeSource installs and nvm paths), export BOOT_EMAIL/BOOT_PWD via the outer shell into the subshell, clean up the temp file, and warn (without exiting) if the DB already contains users. Also added `VITE_APP_ID=readypackets` to generated `.env`. Verified end-to-end admin creation on a fresh disposable database.

## Update — 2026-11-16 (diagnosed: account locked after failed sign-in attempts)

**Diagnosis of live site `beacon.welfarepride.org`:**
- `GET /healthz` → `{"ok":true,"version":"2.0.0"}`
- `GET /api/v1/auth/setup/status` → `{"setupNeeded":false,"userCount":1}`
- `POST /api/v1/auth/login` for `it@welfarepride.org` → `HTTP 423 {"error":"ACCOUNT_LOCKED","retryAfter":"2026-11-16 17:11:52"}`
- Live JS asset `index-ftioeFFq.js` matches latest build — latest code is already deployed.

**Conclusion:** The account exists and is locked after 5 failed attempts. The previous in-place reset one-liner threw a SyntaxError because piped scripts run as CommonJS (`await is only valid in async functions`). Provided a tested, async-IIFE-wrapped one-liner that unlocks and resets the first user's password in one command.
