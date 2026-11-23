# Installer reference notes — 2026-11-23

Official Docker Ubuntu installation: https://docs.docker.com/engine/install/ubuntu/

Use Docker's signed apt repository and docker-compose-plugin for a new host. Published Docker ports can bypass UFW; do not assume UFW alone protects exposed application ports. Do not automatically uninstall existing Docker/containerd packages or change an existing host's firewall. Prefer a new-server preflight and publish only the HTTPS proxy. Docker daemon access is effectively privileged access.

Official Caddy HTTPS prerequisites: https://caddyserver.com/docs/automatic-https

A public DNS hostname must resolve to the host, TCP 80 and 443 must be reachable for the standard ACME challenges, and Caddy certificate storage must be persistent and writable. Caddy renews certificates and redirects HTTP to HTTPS. Require a proper domain and verify HTTPS; do not claim completion merely because the local app responds. Do not overwrite an existing Caddy configuration or existing installation.

The current GitHub main branch is SQLite-based and differs from the earlier attached PostgreSQL test instance. The installer targets current GitHub source; it is not a migration/reset of the attached instance. Existing README and production-security-assessment document unresolved production blockers; this installer must be test-only and must not imply production readiness. Bootstrap must happen offline before making an empty database's setup wizard reachable. Generate credentials in the bootstrap process, show them once on /dev/tty, never place the admin password in command arguments/environment/files/logs, require local MFA and an initial password change, and preserve existing data by refusing reinstall paths.
