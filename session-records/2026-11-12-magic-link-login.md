# Session record — login branding and magic links, 2026-11-12

## User request

“Change the subtitle from ‘Health Plan Outreach Reporting Portal’ to ‘Outreach Reporting Dashboard Portal’ in slightly larger font underneath the welfare pride company logo. Add the ability to have a magic links login capability and button that will email the local user with an MFA enabled to login using a emailed login link in addition to the option to use a password. Also add a button for Welfare Pride SSO - Single Sign On. the buttons for both of these alternative logins should be just as visible and colorful using the company colors as the standard login button just a different color than the original Sign In blue color.” The user asked not to reopen the supplied image with the file tool.

## Implementation and limitations

The login page displays the requested larger subtitle for the old default, while preserving custom tagline values, and new installations use the new default. Password login remains visible in blue; the email-link and SSO options use contrasting colors. The SSO button is visibly labeled unavailable because Entra SSO is not implemented.

The email-link option applies to active local users who have enrolled MFA and completed initial password change. Links expire after ten minutes, are single-use and bound to the requesting browser; the link opens a pending MFA challenge, not a full session. The flow uses token digests in SQLite, bounded persistent rate limiting, generic request responses, no credential mail-log content or BCC, no sensitive-message failover, TLS for SMTP submission, and no Graph sent-item saving. Existing links are preserved on repeated or unrelated requests. MFA now has a durable per-account attempt limit independent of spoofable forwarded IP headers. Email delivery requires an enabled real SMTP or Graph provider and exact HTTPS `APP_ORIGIN`; simulation sends nothing. Provider retention, link rewriting, targeted denial and reverse-proxy edge limits still require review. The portal remains unapproved for real or sensitive data and production use.

## Verification and data handling

Testing uses synthetic accounts, mocked transports and disposable SQLite data, not real emails. During an agent's preliminary full-suite run, an older test opened the default application database and changed SQLite WAL/SHM file timestamps; the database modification timestamp itself was unchanged. The agent reported that the test only read application records, but byte-for-byte file contents were not verified. The legacy test has since been changed to use a disposable database, and subsequent test runs explicitly set a temporary `DATA_DIR`; existing databases and snapshots must not be reset. Credentials, magic-link tokens, authentication cookies and MFA seeds are intentionally excluded from this session record.

The final isolated regression suite passed 161 tests. A real Chromium desktop/mobile test passed using a synthetic account and mocked SMTP: a link opened in an unrelated browser profile was rejected; the requesting browser reached MFA and completed sign-in only after a valid authenticator code. A previous browser harness run timed out and the cause was not established; a later instrumented run passed. No real email provider or Hostinger deployment was tested.
