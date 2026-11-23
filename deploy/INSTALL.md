# New-server installer: private VPS, bare metal or Docker

**Recommended method: `--method=vps`. Do not run this installer on the attached/existing portal host.** It is for a dedicated, new Ubuntu 22.04/24.04 or Debian 12/13 server, on amd64 or arm64, booted with systemd. `vps` and `baremetal` both install a native, unprivileged systemd application with Caddy HTTPS. `docker` installs the same application behind a containerized Caddy proxy. If the method is omitted, select it on the private terminal.

## Read this before installing

This is **synthetic-data testing only**, not production approval. Installation requires `--acknowledge-testing-only`; that flag does not resolve the security blockers described in the [README](../README.md) and [production security assessment](../application-context/production-security-assessment.md). The active database is SQLite, **not PostgreSQL or Redis**. SQLite is not whole-database encrypted; integration credentials may be stored as plaintext. Backup/restore, Entra SSO, authorization, proxy trust, session revocation and dependency issues still need independent remediation and validation. Do not enter real/sensitive data or real SMTP/Graph/SSO credentials. This installer does not configure Manus authentication, runtime or branding.

A **privately administered VPS is not necessarily a private-network-only VPS**. This installer uses a real DNS hostname you control, Caddy automatic public HTTPS certificates, and strict certificate validation. Point all applicable A/AAAA records to this new server and arrange public ACME validation on TCP 80/443. Do not publish stale IPv6 records. Restrict SSH to authorized operator addresses. The installer does not change/reset UFW or provider firewall rules, open 3000, add swap or alter `/etc/fstab`.

For an entirely internal VPS that cannot receive public certificate challenges, stop here: obtain an organization-managed trusted certificate or approved DNS-challenge solution and a reviewed deployment procedure. This installer does **not** implement DNS-provider challenge plugins, organization-supplied certificates, HTTP fallback or unnoticed self-signed TLS. A real organization hostname resolving privately can pass input validation, but public ACME may fail; `--check` does not test DNS or certificate reachability.

Use a private, unrecorded SSH terminal with a controlling TTY (for example SSH `-t`). Do not use `bash -x`, `tee`, `script(1)`, session recording, screenshots or log collection during bootstrap. `/dev/tty` must not be group/world readable. The script cannot detect every terminal recorder or protect against privileged host administrators. Install from a reviewed script file, **not `curl | sudo bash`**. The shell never generates or handles the administrator password. The application helper generates it internally and prints it **once**, directly to your private terminal, before any application/proxy starts. Save it immediately in a password manager.

## Obtain and pin the installer

The repository is public; no GitHub token or credentials are required. The installer always clones the fixed HTTPS GitHub URL, disables Git credential prompting, never embeds tokens, and does not modify Git identity or global Git configuration. If source access fails, installation fails without starting the app. Do not put a token in a URL, command line, shell history or installer file.

Clone into an operator working directory, **not** `/opt/welfare-pride-portal`, inspect the installer and its compatible source, and choose a reviewed full commit SHA:

```bash
git clone https://github.com/MadaSito/welfare-pride-hpp-reporting-portal.git
cd welfare-pride-hpp-reporting-portal
# Review deploy/install.sh, this guide, security assessment and source changes.
git rev-parse HEAD
bash deploy/install.sh --help
```

When run from this checkout, the installer defaults to its checkout's commit. A standalone downloaded script defaults to resolving remote `main` once. Prefer explicit `--ref=FULL_40_HEX_COMMIT`; branches, tags and abbreviated SHAs are refused. The helper-compatible revision must include `server/install-admin.ts` and the local-MFA enforcement changes; older revisions are not a secure substitute. The application commit is recorded at `/etc/welfare-pride-portal/source-commit`. A resolved application SHA does not independently verify the provenance of the script you execute.

### Recommended native VPS command

Replace the example domain/email with **your actual domain and administrator email**. The reserved example domain shown here is deliberately refused; it must not be copied unchanged.

```bash
sudo bash deploy/install.sh \
  --method=vps \
  --domain=portal.example.org \
  --email=admin@example.org \
  --ref=FULL_40_HEX_COMMIT \
  --acknowledge-testing-only \
  --check
```

`--check` is a read-only preflight: it performs no package installation, file creation, source download, secrets generation, account bootstrap, service start or firewall change. It checks the OS/architecture, required diagnostic commands, existing paths/accounts/units, occupied ports and Docker conflicts where relevant. It still requires root and acknowledgement. With an explicit method it needs no TTY; if you omit the method, selecting it requires a TTY. It cannot establish Git access, available repository packages, sufficient build resources, DNS reachability, TLS issuance or application correctness. A failure on an existing host is expected: do not dismantle that host to force a pass.

After reviewing the result **on the new server**, repeat without `--check` from a private terminal:

```bash
sudo bash deploy/install.sh \
  --method=vps \
  --domain=portal.example.org \
  --email=admin@example.org \
  --ref=FULL_40_HEX_COMMIT \
  --acknowledge-testing-only
```

Use `--method=baremetal` for the identical native systemd installation on a new physical server, or replace the method with `--method=docker` for containers. Domain, email and acknowledgement remain mandatory; only the method is prompted. There are no password arguments, no skip-admin/no-Caddy options, and no reinstall/reset/overwrite options.

## What the installer creates

| Item | Native VPS / bare metal | Docker |
|---|---|---|
| Application source | `/opt/welfare-pride-portal`, root-owned, not app-writable | Same root-owned build context |
| Persistent SQLite/files | `/var/lib/welfare-pride-portal/data`, `portal:portal`, mode 700 | Same host path, `10001:10001`, mode 700; bind-mounted at `/app/data` |
| Private runtime | `/etc/welfare-pride-portal/runtime.env`, root:root, mode 600 | Same file supplied via Compose `env_file` |
| Service | `welfare-pride-portal.service`, unprivileged `portal` | Image built from the checked-out Dockerfile, UID/GID 10001 |
| HTTPS proxy | `welfare-pride-portal-caddy.service`, `caddy` account | Version-tagged `caddy:2.10.2-alpine` container |
| Proxy configuration/state | Private Caddyfile via systemd `LoadCredential`; certificate state `/var/lib/caddy` | Private Caddyfile and persistent `caddy-data`/`caddy-config` under `/etc/welfare-pride-portal` |
| Orchestration | systemd | Self-contained `/etc/welfare-pride-portal/compose.yaml`, root-private |
| Runtime logs | system journal, with per-unit rate limits | Docker `json-file`, maximum 10 MB × 5 files per service |

Native installs official Node **22 LTS**, resolving the latest available 22.x release from `nodejs.org`, verifying the tarball against the official SHA256 manifest, and installing into `/opt/welfare-pride-node` without replacing another global Node binary. HTTPS manifest integrity is not an independently verified release signature. Node and pnpm versions are recorded/validated; pnpm is 10.4.1. The frozen-lock native install disables lifecycle scripts, then explicitly allowlists and rebuilds only `better-sqlite3`, without rewriting the source workspace policy or patches/overrides. The reviewed Dockerfile supplies its own bounded build policy. Native builds need adequate RAM/disk; no swap is installed automatically.

Native Caddy is installed from the OS apt package if available; otherwise the signed official Caddy repository is used. Only preflight-absent packaged Caddy units are runtime-masked to prevent demo-server autostart; the package's default unit is disabled, and the dedicated portal proxy unit is used. Existing Caddy binaries, configuration or units are refused. Docker is installed from Docker's signed official apt repository only if absent. Existing Docker must already have working Compose v2, an accessible daemon and no containers/portal resources. Conflicting Docker/containerd/runc packages are refused, never uninstalled. The installer does not remove unused packages.

Runtime configuration includes `NODE_ENV=production`, port 3000, exact HTTPS `APP_ORIGIN`, native loopback / Docker wildcard `BIND_ADDRESS` (and matching `HOST`), a 48-byte random hex session secret, a base64 key decoding to exactly 32 bytes, a 32-byte random hex audit salt, durable `DATA_DIR`, `SESSION_COOKIE_NAME=__Host-wp_session`, and `REQUIRE_LOCAL_MFA=true`. Secrets are written privately outside the Git checkout; no `.env` file is written and no secret values are printed. Docker metadata/env inspection is privileged access and can expose runtime secrets; Docker daemon access is effectively root access.

The native helper runs as `portal` against the same data directory, with private TTY stdin/stdout/stderr and required-MFA mode. Docker runs a one-off `docker compose run --rm --no-deps --interactive app node --import tsx server/install-admin.ts --email ...` against the same persistent bind mount. Its separate `/etc/welfare-pride-portal/bootstrap.compose.yaml` explicitly sets `restart: "no"` and **logging driver `none`**; terminal redirection alone would not prevent Docker daemon logging. Neither app nor proxy is running at this stage. The helper transaction creates the administrator with required MFA, required initial password change and an audit event. A separate read-only SQLite check requires exactly one active local super administrator, a tenant, and both security flags before startup.

Native binds only `127.0.0.1:3000`. Docker app has **no published ports** and shares a user-defined private bridge with Caddy; only the proxy publishes TCP 80/443. The bridge is not `internal: true` because Caddy needs outbound ACME access; it is not an egress-isolation boundary. Docker published ports can bypass UFW: verify provider firewall and Docker host filtering, and never expose port 3000. Compose does not trust inbound forwarding headers. Caddy strips spoofable Cloudflare/client-IP headers and overwrites forwarded client/protocol/host fields using the actual request. This is **not** certification that the application's overall proxy trust and rate limiting are secure. Caddy request access logging is not enabled; only operational logs are used so sign-in-link query tokens are not deliberately placed in raw proxy request logs.

After offline bootstrap, only the app starts. The installer validates local `/api/v1/health` (`status=ok`, `database=sqlite`) and `/api/v1/auth/setup/status` (`setupNeeded=false`), then starts Caddy. Completion also requires the public hostname's trusted HTTPS health and closed setup-status responses. No `curl -k`, HTTP completion path, or password reprint exists. These checks establish installation availability, not production security or a full sign-in flow.

## First sign-in

Open the printed HTTPS URL and sign in with the email and temporary password already shown once on the private terminal. **Enroll authenticator MFA first**, store recovery codes privately, then change the temporary password. There is no public empty-database setup phase during normal installer startup. Additional local accounts must also use MFA in this installation mode. Do not enable real email integrations or enter sensitive data to test it.

## Status, logs and stopping

Native:

```bash
sudo systemctl status welfare-pride-portal.service welfare-pride-portal-caddy.service --no-pager
sudo journalctl -u welfare-pride-portal.service -u welfare-pride-portal-caddy.service -n 100 -f
sudo systemctl stop welfare-pride-portal-caddy.service welfare-pride-portal.service
```

Docker:

```bash
sudo docker compose -p welfare-pride-portal -f /etc/welfare-pride-portal/compose.yaml ps
sudo docker compose -p welfare-pride-portal -f /etc/welfare-pride-portal/compose.yaml logs --tail=100 -f app caddy
sudo docker compose -p welfare-pride-portal -f /etc/welfare-pride-portal/compose.yaml stop
```

Native uses the host journal's existing rotation/retention policy, not an unlimited installer log. Inspect `journalctl --disk-usage` and have your system administrator set bounded journal retention appropriate to the test VPS. The installer intentionally does not rewrite global journald configuration. Docker's 10 MB/5-file limits apply to operational app/proxy logs only. Do not dump Compose config, inspect container environments or copy `runtime.env` into support logs. Do not run bootstrap via journald, `docker compose exec` into the running app, redirected files or logging wrappers.

## Refusal and failure recovery

Existing application/data/config paths (including the whole `/var/lib/welfare-pride-portal` and `/etc/welfare-pride-portal`), existing `portal` user/group, Caddy config/state/units and either dedicated portal unit cause refusal. TCP/UDP 80, 443 or 3000 already occupied also causes refusal. The installer never pulls an existing deployment forward, overwrites data, resets accounts, reruns bootstrap against existing users or auto-migrates another installation. It does not support upgrades.

On a command error, failed bootstrap verification, health failure, HTTPS timeout, SIGINT or SIGTERM, the script returns failure and attempts to disable/stop **only its newly created portal app/proxy units or containers**. It never deletes data, secrets, source or installation files, and reports any cleanup failure. It leaves newly installed packages/Docker engine and certificate/download files intact. An abrupt kill, host crash or terminal disconnect cannot guarantee cleanup; restrict external exposure and inspect service state before proceeding. Docker restart policies require extra care after a crash/reboot.

**Do not rerun the installer, delete its refusal paths or reset the database to recover.** Preserve data, keys and installed source; have an authorized operator review the failure, DNS/TLS state and logs. If bootstrap failed before any user was committed, a reviewed manual private-TTY bootstrap against the verified existing runtime/data may be possible; this is not an automated retry option. If a user already exists or the password was lost, the installer cannot display it again and the helper refuses a second administrator. Use a separately reviewed, authorized recovery process; no automatic reset or unsafe SQL/password recipe is supplied. Keep proxy exposure disabled until administrator flags and closed setup status have been verified. Do not simply restart an empty database publicly.

For recoverable post-bootstrap TLS/service failures, an operator may correct DNS or a narrowly reviewed configuration problem, revalidate the existing administrator and startup order, and manually start only the existing units/containers. Preserve their original runtime keys. An installer failure is not permission to erase data or replace secrets.

Use encrypted off-host, access-controlled backups with a **tested** restore procedure before any future approved deployment. Built-in backup/live-restore mechanisms remain blocked/unapproved. A naive live copy of `portal.db` can omit SQLite WAL state; coherent filesystem/database backups and key recovery must be planned together. Root/private filesystem permissions and HTTPS are not database encryption or zero-knowledge protection.

## Safe repository validation

The delivered installer was not executed on a server. Its bounded test harness runs syntax/help checks, input validation, function mocks, static network/logging contracts, secret-format checks in a temporary directory and read-only verification of a synthetic temporary SQLite database:

```bash
bash -n deploy/install.sh
bash -n deploy/install.test.sh
bash deploy/install.sh --help
bash deploy/install.test.sh
# If already available:
shellcheck -S warning deploy/install.sh deploy/install.test.sh
```

No test service or public endpoint is started by these checks. OS/package matrix, real Docker build/bootstrap TTY behavior, systemd credential handling, public ACME issuance and real-VPS end-to-end operation still require an explicitly authorized disposable-new-server test; static/mock success is not evidence those deployments have been performed.
