# Initial administrator bootstrap

The application does not create accounts, credentials, metrics, or reports automatically. Configure the server first, including a persistent **absolute** `DATA_DIR`, an exact `APP_ORIGIN`, `APP_SESSION_SECRET`, and `APP_ENCRYPTION_KEY`. If `SQLITE_PATH` is set on the server, set it to the same absolute path for the command below. Use the same operating-system user and volume as the server. Protect the data directory and its backups with filesystem permissions and backups; keep it outside the web root.

From a private, interactive terminal on the deployed machine (with the project's dependencies installed), run once:

```sh
export DATA_DIR=/absolute/persistent/portal-data
node --import tsx server/bootstrap-admin.ts --email administrator@example.org
```

For the provided Compose deployment, after `docker compose up -d`, use `docker compose exec -it app node --import tsx server/bootstrap-admin.ts --email administrator@example.org`. The container already sets `DATA_DIR=/app/data` and mounts its persistent volume. The command refuses non-terminal output and refuses any database containing users. It generates a random password and displays it **once** on that terminal. Never record the terminal session, redirect output, paste it into tickets, shell history, source control, or application logs. Transfer the credential only through a verified secure channel, then sign in, enroll and verify MFA, save the one-time recovery codes, and replace the temporary password. MFA and a different password are both mandatory before full access. If the password is lost before sign-in, contact an operator; no automated bootstrap reset of existing users is provided.

Existing databases are migrated additively and existing sessions are revoked. Accounts still using publicly exposed former demo passwords are disabled as a safety measure, without deleting users, hashes, or business records. Do not re-enable those accounts with their exposed credentials; an administrator must arrange a verified, out-of-band credential reset. The bootstrap command intentionally does not modify a non-empty user table. Self-service password reset, SSO conversion, online snapshot creation, and online restore are unavailable pending security work; do not assume they function. Establish a tested offline backup and recovery process.

Preview databases are not automatically safe for production. Review and remediate every existing account, especially accounts previously configured without MFA and any credentials exposed during evaluation, before exposing the service. Local sign-in now requires MFA even when an existing record says MFA was optional; whoever possesses that account's current password can initially enroll its authenticator. First reset any potentially exposed credentials through a verified offline process. Migrating preserves existing account records and does not silently reset their passwords or enroll MFA for them. No automated recovery tool is currently provided for quarantined accounts.
