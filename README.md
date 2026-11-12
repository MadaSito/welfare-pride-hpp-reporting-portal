# Welfare Pride HPP Reporting Portal

A Node.js/Express and React portal for manually entered HPP outreach metrics and reports. The current implementation is **not approved for production or real/sensitive data**. See the [production security assessment](application-context/production-security-assessment.md) before attempting a deployment.

## Important status

- The active data store is SQLite, not PostgreSQL or Redis. The application does not provide whole-database encryption; several integration credentials are stored as plaintext in SQLite. Password hashing and encrypted TOTP secrets do not encrypt the database.
- Previously generated backup files may be unencrypted. Backup creation and live restore are being disabled until encryption and recovery are corrected and tested. Keep any existing backups private and do not overwrite them.
- Microsoft Entra SAML and OIDC sign-in are not implemented or validated. Do not convert users to SSO. A configuration form alone does not enable SSO.
- Report authorization, session revocation, proxy trust, dependency advisories and several other issues need remediation and independent verification. A successful build or unit test does not establish production security.
- The previous publicly reachable preview used known demo credentials with MFA disabled. It was taken offline on 2026-11-12. Treat any real data or credentials entered into that preview as potentially exposed and follow your incident-response process.
- The previous preview database was recreated during troubleshooting on 2026-11-10 without explicit authorization. Older snapshot files are being preserved; their contents and recoverability are not yet verified.

## First administrator on a new database

The application no longer creates public demo accounts or a fixed default administrator. An operator with a private interactive terminal can run the [bootstrap command](server/BOOTSTRAP.md) against the same persistent data directory used by the server. It creates a super administrator only when no users exist, generates a random temporary password and shows it once on that terminal. The first sign-in requires MFA enrollment and a password change before portal access. Existing databases are not reset; accounts with the previously published demo passwords are quarantined on startup, and a recovery procedure for those accounts is not yet supplied.

This setup has been tested in a temporary local environment, not on the requested Hostinger plan. Confirm that the deployment provides terminal access, the project dependencies and a persistent data directory. It does not make the portal production-ready.

## Hostinger considerations

Hostinger supports Node.js deployments via GitHub and environment variables. Its documented deployment system creates versioned build directories and overwrites managed application files when deploying. The SQLite database and keys must not be placed in the web root or deployment build directory. Confirm that the selected plan has a private, durable, encrypted persistent storage location, reliable backups and the necessary Node.js support before planning any production installation.

Host-level access can bypass portal login. Host administrators, a compromised application process, or anyone holding encryption keys may be able to access data; server-side encryption is not zero-knowledge. Access controls, TLS, key separation and incident response are still necessary. Hostinger's specific storage encryption and access arrangements for the selected plan have not been verified.

- [Hostinger Node.js deployment](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
- [Hostinger environment variables](https://www.hostinger.com/support/how-to-add-environment-variables-during-node-js-application-deployment/)
- [Microsoft Entra SAML setup](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso)

## Repository and checks

The repository is [MadaSito/welfare-pride-hpp-reporting-portal](https://github.com/MadaSito/welfare-pride-hpp-reporting-portal); access requires permission to the private repository.

Use a disposable, separate `DATA_DIR` for development tests; do not point tests at existing data. Commands include `pnpm check`, `pnpm test`, `pnpm run build`, and `pnpm audit --prod --audit-level=high`. The test suite is incomplete and cannot certify access control, SSO, encryption, accessibility, or production readiness.
