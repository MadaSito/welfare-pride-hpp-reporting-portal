# Security status

**Not approved for production use.** The current portal has known access-control, session, data-at-rest, backup, secret-handling and SSO gaps. Do not expose it publicly or store real/sensitive information until they are fixed and independently tested.

See [the production security assessment](application-context/production-security-assessment.md) for the current findings, incident notes and deployment prerequisites. Historic descriptions of encryption, immutable audit logs, SSO, or production readiness must not be treated as security guarantees.

If real data or service credentials were entered in the former publicly accessible preview, treat them as potentially exposed, rotate the affected credentials, preserve the current database and existing backup files, and follow your organization's incident-response process. The prior preview has been stopped.
