# Session record — sign-in investigation and Hostinger GitHub installation, 2026-11-12

## User prompts

1. “I tried to login and i cant the password doesnt work”
2. “give me the instructions on how to install this on hostinger using the github repo install option”

## Findings and response

The preview service was healthy and its existing sample super-admin account was active, had MFA enrolled, and was not locked at the time of inspection. Recent preview logs did not show a matching failed password-login attempt, so the problem was not established. The user was asked whether the issue occurred in the preview or on Hostinger and what screen or error appeared; no password was requested. No account credentials or application records were intentionally changed, and no database was reset. An independent synthetic-browser test was interrupted by the user's subsequent message, so it was not counted as a passed test.

Prepared `application-context/hostinger-github-installation.md` using current Hostinger documentation and repository-specific settings. The guide covers connecting the private GitHub repository, Express/Node/pnpm build settings, required environment variables, verified private persistence, interactive first-admin bootstrap, MFA, updating, and security blockers. It explicitly warns that Hostinger compatibility and real-email delivery remain unverified, the application is not approved for production or sensitive data, no default admin exists, and preview data and credentials are not automatically transferred.

An isolated clean archive of commit `bf09c00` installed with pnpm 10.4.1, built with Node 22.23.4, and passed in-memory SQLite and password-hashing native-module smoke tests. No Hostinger deployment or real user-data test was performed. No credentials, secret values or access tokens are recorded here.
