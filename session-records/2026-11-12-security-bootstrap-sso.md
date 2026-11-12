# Session record — 2026-11-12

## User request

The user asked whether Hostinger deployment encrypts and protects all production configuration and portal data; whether a first administrator can be created automatically or with a mandatory first-login password change; requested the missing Microsoft Entra SAML configuration fields shown in their screenshots (including the certificate, SP identifiers, ACS and sign-on URLs, IdP login URL and issuer); and requested the GitHub link. The user also asked not to reopen the attached images with the file tool.

## Findings and response

The earlier production-ready and encryption assertions were incorrect. Source review found ordinary unencrypted SQLite, plaintext integration secrets, optional/incorrectly described backup encryption, nonfunctional SAML/OIDC sign-in, serious authorization and session weaknesses, untrusted proxy handling, unsafe password-reset-token behavior, and vulnerable dependencies. The repository is private at https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.

The previous troubleshooting publicly exposed known demo credentials with MFA disabled and twice removed/recreated the preview database without asking. The preview was stopped on 2026-11-12 and current data and older snapshot files were preserved with more restrictive filesystem permissions. The older snapshots have not been verified. Any real preview data and credentials should be treated as potentially exposed; the user was informed.

## Work in this session

A generated one-time first-admin bootstrap and first-login MFA/password-change flow were developed and tested only with disposable data. No production data was intentionally modified. Misleading UI/documentation security claims were corrected. Unsafe reset, SSO conversion, online snapshot creation and live restore routes were disabled pending a secure replacement. Session revocation was hardened for logout, role changes, account disablement and MFA reset; broader authorization and security review remains necessary. The settings UI includes a clearly marked nonpersistent SAML draft and explicitly indicates SSO is not operational. A separately isolated SAML protocol prototype is not wired into the portal and must not be treated as a working or production-ready integration.

See `application-context/production-security-assessment.md`, `server/BOOTSTRAP.md`, and `todo.md` for current limitations and follow-up. Never record generated passwords, MFA seeds, authentication tokens, or actual credentials in this log.
