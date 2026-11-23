#!/usr/bin/env bash
# Bounded syntax, validation, static configuration and mocked lifecycle tests only.
# Never runs main with real installation commands, binds a port or starts a service.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALLER=$ROOT/deploy/install.sh
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
bash -n "$INSTALLER"
bash -n "${BASH_SOURCE[0]}"
bash "$INSTALLER" --help > "$TMP/help"
grep -q 'SYNTHETIC DATA ONLY' "$TMP/help"
grep -q -- '--check' "$TMP/help"
if command -v shellcheck >/dev/null; then
  shellcheck -S warning "$INSTALLER" "${BASH_SOURCE[0]}"
else
  printf 'SKIP: shellcheck is not available; no packages installed for testing.\n'
fi
pass=0
expect_valid() {
  if bash -c 'source "$1"; parse_args "${@:2}"; validate_input' _ "$INSTALLER" "$@" > "$TMP/result" 2>&1; then
    pass=$((pass + 1))
  else
    cat "$TMP/result" >&2; printf 'Unexpected validation failure\n' >&2; exit 1
  fi
}
expect_invalid() {
  if bash -c 'source "$1"; parse_args "${@:2}"; validate_input' _ "$INSTALLER" "$@" > "$TMP/result" 2>&1; then
    printf 'Unexpected validation success: %s\n' "$*" >&2; exit 1
  fi
  pass=$((pass + 1))
}
BASE=(--method=vps --domain=portal.welfarepride.org --email=admin@welfarepride.org --acknowledge-testing-only)
expect_valid "${BASE[@]}"
expect_valid "${BASE[@]}" --method=baremetal --check
expect_valid "${BASE[@]}" --method=docker --ref=0123456789abcdef0123456789abcdef01234567
expect_valid "${BASE[@]}" --domain=PORTAL.WELFAREPRIDE.ORG
expect_invalid --method=vps --domain=portal.welfarepride.org --email=admin@welfarepride.org
expect_invalid "${BASE[@]}" --domain=
expect_invalid "${BASE[@]}" --domain=localhost
expect_invalid "${BASE[@]}" --domain=127.0.0.1
expect_invalid "${BASE[@]}" --domain=2001:db8::1
expect_invalid "${BASE[@]}" --domain=portal.example.org
expect_invalid "${BASE[@]}" --domain=portal.welfarepride.local
expect_invalid "${BASE[@]}" --domain=https://portal.welfarepride.org
expect_invalid "${BASE[@]}" --domain=portal.welfarepride.org:443
expect_invalid "${BASE[@]}" --domain='portal.welfarepride.org { log }'
expect_invalid "${BASE[@]}" --domain=portal..welfarepride.org
expect_invalid "${BASE[@]}" --domain=-portal.welfarepride.org
expect_invalid "${BASE[@]}" --domain=portal-.welfarepride.org
expect_invalid "${BASE[@]}" --email=
expect_invalid "${BASE[@]}" --email=not-an-email
expect_invalid "${BASE[@]}" --email=$'admin@welfarepride.org\nlog'
expect_invalid "${BASE[@]}" --email='admin{evil}@welfarepride.org'
expect_invalid "${BASE[@]}" --ref=main
expect_invalid "${BASE[@]}" --ref=
expect_invalid "${BASE[@]}" --ref=0123456789abcdef0123456789abcdef012345678
expect_invalid "${BASE[@]}" --method=hostinger-check
expect_invalid "${BASE[@]}" --skip-admin
expect_invalid "${BASE[@]}" --no-caddy
expect_invalid "${BASE[@]}" --reset
expect_invalid "${BASE[@]}" --reinstall
printf 'PASS: %d argument-validation cases\n' "$pass"

# Function-only mocks. No real ss/systemctl/docker/install calls in this process.
bash -s -- "$INSTALLER" "$TMP" <<'MOCK'
set -Eeuo pipefail
source "$1"
tmp=$2
json_health <<< '{"status":"ok","database":"sqlite"}'
if json_health <<< '{"status":"ok","database":"postgres"}'; then exit 1; fi
json_setup_closed <<< '{"setupNeeded":false,"userCount":1}'
if json_setup_closed <<< '{"setupNeeded":true,"userCount":0}'; then exit 1; fi
if json_setup_closed <<< '{"setupNeeded":"false","userCount":1}'; then exit 1; fi
if json_setup_closed <<< '{"setupNeeded":false}'; then exit 1; fi
path_absent "$tmp/absent"
if (path_absent "$tmp"); then exit 1; fi
ln -s "$tmp/missing" "$tmp/dangling"
if (path_absent "$tmp/dangling"); then exit 1; fi
ss() { printf 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n'; }
ports_free
ss() { printf 'tcp LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*\n'; }
if (ports_free); then exit 1; fi
ss() { printf 'udp UNCONN 0 0 [::]:443 [::]:*\n'; }
if (ports_free); then exit 1; fi
ss() { return 7; }
if bash -c "$(declare -f die ports_free ss); ports_free"; then exit 1; fi
systemctl() { printf 'not-found\n'; }
unit_absent hypothetical.service
systemctl() { printf 'masked\n'; }
if (unit_absent hypothetical.service); then exit 1; fi

# Verify native offline-first lifecycle using function mocks only.
EVENTS=
mark() { EVENTS+="$1|"; }
useradd() { mark useradd; }
install() { mark install; }
install_node() { mark node; }
build_native() { mark build; }
bootstrap_native() { mark bootstrap_verified; }
install_caddy() { mark caddy_package; }
write_caddyfile() { mark proxy_config; }
caddy() { mark caddy_validate; }
write_native_units() { mark units; }
ports_free() { mark ports; }
systemctl() { mark "systemctl:$*"; }
wait_native_health() { mark local_verified; }
install_native
[[ "$EVENTS" == 'useradd|install|node|build|bootstrap_verified|caddy_package|proxy_config|caddy_validate|units|ports|systemctl:enable --now welfare-pride-portal.service|local_verified|systemctl:enable --now welfare-pride-portal-caddy.service|' ]]
printf 'PASS: function mocks, fail-closed health/setup, preservation, port refusal, native offline-first order\n'
MOCK

# Exercise actual secret-writing and read-only DB verification functions in an
# isolated subprocess with local test variables, NEVER the fixed install paths.
bash -s -- "$INSTALLER" "$TMP" <<'ISOLATED'
set -Eeuo pipefail
source "$1"
{
  declare -f die path_absent write_runtime verify_offline_native
} > "$2/functions"
ISOLATED
bash -s -- "$TMP" <<'LOCAL'
set -Eeuo pipefail
umask 077
TMP=$1
source "$TMP/functions"
DATA_DIR=$TMP/data
mkdir "$DATA_DIR"
CONFIG_DIR=$TMP
RUNTIME_FILE=$TMP/runtime.env
DOMAIN=portal.welfarepride.org
ADMIN_EMAIL=admin@welfarepride.org
METHOD=vps
# Ownership requires root on an actual new server; mock it, never sudo tests.
chown() { [[ "$1" == root:root && "$2" == "$RUNTIME_FILE" ]]; }
write_runtime
python3 - "$RUNTIME_FILE" <<'PY'
import base64, os, re, stat, sys
p=sys.argv[1]
x=dict(line.rstrip('\n').split('=',1) for line in open(p))
assert stat.S_IMODE(os.stat(p).st_mode)==0o600
assert re.fullmatch('[a-f0-9]{96}',x['APP_SESSION_SECRET'])
assert len(base64.b64decode(x['APP_ENCRYPTION_KEY'],validate=True))==32
assert re.fullmatch('[a-f0-9]{64}',x['AUDIT_HASH_SALT'])
assert x['REQUIRE_LOCAL_MFA']=='true' and x['SESSION_COOKIE_NAME']=='__Host-wp_session'
assert x['BIND_ADDRESS']=='127.0.0.1' and x['APP_ORIGIN']=='https://portal.welfarepride.org'
assert not any('password' in k.lower() for k in x)
print('PASS: private runtime secrets, lengths, MFA and cookie mode (no values printed)')
PY
if (write_runtime) > /dev/null 2>&1; then printf 'Runtime overwrite unexpectedly allowed\n' >&2; exit 1; fi
python3 - "$DATA_DIR/portal.db" <<'PY'
import sqlite3, sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE users (email,role,status,mfa_required,must_change_password,auth_provider,tenant_id)')
c.execute("INSERT INTO users VALUES ('admin@welfarepride.org','super_admin','active',1,1,'local','tenant')")
c.commit(); c.close()
PY
verify_offline_native
python3 - "$DATA_DIR/portal.db" <<'PY'
import sqlite3, sys
c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE users SET mfa_required=0'); c.commit(); c.close()
PY
if (verify_offline_native) > /dev/null 2>&1; then printf 'Unsecured admin unexpectedly accepted\n' >&2; exit 1; fi
printf 'PASS: read-only synthetic administrator verification and refusal when MFA flag is missing\n'
LOCAL

python3 - "$INSTALLER" <<'STATIC'
import pathlib,re,sys
s=pathlib.Path(sys.argv[1]).read_text()
compose=s.split('write_compose() {',1)[1].split('\nwrite_bootstrap_compose()',1)[0]
app=compose.split('  app:',1)[1].split('  caddy:',1)[0]
assert 'ports:' not in app and 'network_mode:' not in app
assert 'user: "10001:10001"' in app and 'create_host_path: false' in app
assert 'max-size: "10m"' in app and 'max-file: "5"' in app
boot=s.split('write_bootstrap_compose() {',1)[1].split('\ninstall_docker()',1)[0]
assert 'driver: none' in boot and 'restart: "no"' in boot and 'ports:' not in boot
for line in s.splitlines():
 if 'server/install-admin.ts --email' in line:
  assert '< /dev/tty > /dev/tty 2> /dev/tty' in line
  assert '$(' not in line and 'tee ' not in line and '| ' not in line
assert 'BOOT_PWD' not in s and 'A_PWD' not in s and '--password' not in s
for h in ['CF-Connecting-IP','CF-IPCountry','CF-Ray','True-Client-IP','X-Real-IP','Forwarded']:
 assert 'header_up -'+h in s
assert 'header_up X-Forwarded-For {remote_host}' in s
assert 'header_up X-Forwarded-Proto {scheme}' in s
assert 'trusted_proxies' not in s and 'tls internal' not in s
assert 'curl -k' not in s and '--insecure' not in s and '| bash' not in s and '|| true' not in s
assert 'LoadCredential=Caddyfile:' in s and 'EnvironmentFile=$RUNTIME_FILE' in s
assert 'ProtectSystem=strict' in s and 'ReadWritePaths=$DATA_DIR' in s
assert 'pnpm' in s and '--frozen-lockfile' in s and '--ignore-scripts' in s
print('PASS: static Docker/private-bootstrap logging, TTY, proxy header, secrets and native hardening contracts')
STATIC
printf 'ALL BOUNDED INSTALLER TESTS PASSED. No installer run, service started or public port bound.\n'
