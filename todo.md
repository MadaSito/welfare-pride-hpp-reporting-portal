# Production-readiness checklist

The application is not approved for production. See [the security assessment](application-context/production-security-assessment.md) for details and the preview incident.

- [x] Dashboard call-round card labels read “Calls Completed - 1st Round”, “Calls Completed - 2nd Round”, and “Calls Completed - 3rd Round”.

- [x] Redesign report previews using the Welfare Pride logo, color palette and Roboto typography, with responsive presentation and period-correct metrics.
- [x] Add permission-checked PDF downloads and recipient-restricted PDF email, with audited events and explicit accepted, simulated, failed and unknown statuses.
- [ ] Independently assess PDF accessibility and report-email confidentiality (attachments are not end-to-end encrypted); configure a provider and validate delivery in an approved environment.

- [ ] Review and test first-admin bootstrap, mandatory password change, MFA enrollment and session revocation end to end.
- [ ] Continue an independent review of authorization across all features. Report list, detail, PDF/export, publication and email now have tenant/assignment negative-path tests; legacy null-tenant records remain intentionally unavailable pending a reviewed migration.
- [ ] Encrypt persistent database, WAL, temporary files and integration credentials with independently managed keys; verify rotation and recovery.
- [ ] Replace snapshot and restore with tested consistent backups, authenticated encryption and safe offline/atomic recovery. Preserve existing snapshots until verified.
- [ ] Implement and test Microsoft Entra SAML SSO with trusted certificates, issuer/audience validation, request correlation, replay protection and authorized account mapping. Current SSO fields are a nonpersistent UI draft, not working SSO.
- [ ] Repair and secure password reset and invitation token handling without leaking bearer tokens in API responses, email logs or BCC.
- [ ] Limit reverse-proxy trust to verified proxies, enforce HTTPS and authenticate/encrypt log forwarding.
- [ ] Remediate dependency audit advisories and conduct a security review and accessibility testing.
- [ ] Confirm Hostinger plan-specific persistent storage, encryption, build and operational recovery requirements before deployment.
