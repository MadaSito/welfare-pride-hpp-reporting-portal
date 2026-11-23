# Fresh private VPS installer delivery

- [x] Fresh-server-only native/Docker paths, validated inputs, external secret storage, HTTPS, non-root runtime, bootstrap before exposure, and preserved data.
- [x] Docker patches-before-install, allowlisted SQLite rebuild, source permissions for uid 10001, and correct health checks.
- [x] Atomic audited initial-admin provisioning, generated password, mandatory MFA, and required initial password change.
- [x] Configured mandatory local MFA across provisioning/login/admin updates, with explicit legacy-mode boundary.
- [x] Restore enrollment, one-time recovery-code acknowledgment, and password-change UI required for first login.
- [x] Bash syntax and bounded mock/static installer checks; TypeScript; 181 tests across 14 files; production build.
- [x] Context, session record, usage guide, public-repository secret boundary, and reproducible source pinning.
- [ ] Clean-VPS OS/package matrix, real Docker image/TTY bootstrap, systemd credentials and real ACME/HTTPS end-to-end test (not executed or authorized here).
- [ ] Remaining application production-security blockers and independent security/accessibility review (outside this installer scope).

No installer execution or changes to the attached existing server were performed. Do not reset its accounts, secrets, services, or data. ShellCheck was unavailable; its result is not represented as passed. GitHub publication status is verifiable in repository commit history rather than runtime files.
