# Production-readiness checklist

The application is not approved for production. See [the security assessment](application-context/production-security-assessment.md) for details and the preview incident.

- [ ] Review and test first-admin bootstrap, mandatory password change, MFA enrollment and session revocation end to end.
- [ ] Fix report visibility, assignment and tenant authorization for lists, direct reads, exports and mutations; add negative-path tests.
- [ ] Encrypt persistent database, WAL, temporary files and integration credentials with independently managed keys; verify rotation and recovery.
- [ ] Replace snapshot and restore with tested consistent backups, authenticated encryption and safe offline/atomic recovery. Preserve existing snapshots until verified.
- [ ] Implement and test Microsoft Entra SAML SSO with trusted certificates, issuer/audience validation, request correlation, replay protection and authorized account mapping. Current SSO fields are a nonpersistent UI draft, not working SSO.
- [ ] Repair and secure password reset and invitation token handling without leaking bearer tokens in API responses, email logs or BCC.
- [ ] Limit reverse-proxy trust to verified proxies, enforce HTTPS and authenticate/encrypt log forwarding.
- [ ] Remediate dependency audit advisories and conduct a security review and accessibility testing.
- [ ] Confirm Hostinger plan-specific persistent storage, encryption, build and operational recovery requirements before deployment.
