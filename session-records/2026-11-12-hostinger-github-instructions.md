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
