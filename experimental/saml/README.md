# Entra SAML candidate — not integrated

This isolated module is **not wired to routes, persistence, cookies, or session issuance**. It is not a claim of working or production-ready SSO. The current application remains unchanged by this module. Do not enable or advertise it without independent security review and real Entra end-to-end integration tests.

## Dependencies and validation

Tested with Node 22, `@node-saml/node-saml@5.2.0`, and `@xmldom/xmldom@0.9.12` as direct runtime dependencies. The fixture additionally needs `xml-crypto@6.4.0`, `tsx`, and `openssl`. The implementation relies on the node-saml 5.2.0 `rejectReplayedAssertions`, `consumeAsync`, and `saveIfAbsentAsync` behavior; older versions are not supported. Pin and security-review dependencies before integration. No dependency manifest or lockfile was changed here.

To run tests without modifying the repo or its data:

```sh
work="$(mktemp -d)"
cp experimental/saml/service.ts experimental/saml/service.fixture.mjs "$work"/
cd "$work"
npm init -y
npm install --no-audit --no-fund @node-saml/node-saml@5.2.0 @xmldom/xmldom@0.9.12 xml-crypto@6.4.0 tsx
node --import tsx --test service.fixture.mjs
cd / && rm -rf "$work"
```

Tests create synthetic keys in a temporary directory, sign synthetic assertions/responses, and perform no external network calls or application data changes. They do **not** demonstrate browser, Entra, database, or clustered-cache interoperability.

## Configuration and Entra registration

`getConfig()` must return the current enabled status and fully populated configuration on **every operation**, not a stale snapshot. `appOrigin` must be the exact canonical HTTPS origin (for example `https://portal.example.com`, with no trailing slash). It must come from trusted deployment configuration, never `Host`, `X-Forwarded-Host`, or a request parameter. The fixed derived identifiers are:

- SP entity ID / metadata: `<APP_ORIGIN>/api/v1/auth/saml/metadata`
- ACS: `<APP_ORIGIN>/api/v1/auth/saml/acs`
- SP-initiated sign-on: `<APP_ORIGIN>/api/v1/auth/saml/login`

Register the entity ID and ACS with the Entra enterprise app. Configure the tenant-specific IdP login URL and exact issuer, pin the PEM signing certificate, and configure Entra to sign **both the response and assertion** using RSA-SHA256 or RSA-SHA512 with SHA-256 or SHA-512 digest. This deliberately strict profile may reject other valid SAML deployments. Unencrypted assertions only; SLO and IdP-initiated login are not supported. Supply both Microsoft Entra SAML claims `http://schemas.microsoft.com/identity/claims/tenantid` and `http://schemas.microsoft.com/identity/claims/objectidentifier` as single GUID values, and set `tenantId` to the expected tenant GUID. Neither NameID, email, display name, role claims nor groups identify or provision users. Certificate rollover currently requires an explicit config change; old in-flight requests fail closed.

The response and assertion must each be signed with the pinned certificate. The module enforces a signed success response, exact response issuer, destination and request ID; exact assertion issuer, audience, bearer recipient and request ID; finite condition and bearer expiry; a five-minute maximum assertion age; 60-second clock tolerance; and one-use assertion IDs. It also matches a random RelayState to a browser-held nonce and consumes an outstanding request exactly once. Signature verification and validated assertion extraction are delegated to node-saml; explicit algorithm, destination and bearer-profile checks fill gaps in its 5.2.0 behavior. The pre-verification XML checks are rejection-only, not a substitute for cryptographic verification.

## Mandatory adapter requirements

1. Build a shared, dedicated cache implementation satisfying `AtomicSamlCache`. `consumeAsync` must be atomic get-and-delete and `saveIfAbsentAsync` an atomic insert-if-absent with the supplied absolute expiration. `saveAsync` must preserve request IDs for at least five minutes. Cache data must remain available across every application process/restart for its intended lifetime, including assertion replay retention until the supplied expiry. All cache outages must reject authentication. Do not use an in-process cache in a multi-process or restart-sensitive deployment. Namespace it separately per deployment and do not allow eviction of live security records. The module adds a configuration fingerprint namespace.
2. On the login route, call `beginLogin()`, set `browserToken` in a **host-only**, HttpOnly, Secure, `SameSite=None` cookie with the returned ACS path and max age, and only then redirect to `redirectUrl`. `SameSite=None` is needed for the cross-site POST. Reject duplicate cookie names. Do not expose the token through script or logs. The current one-cookie design permits one pending login per browser; concurrent starts invalidate the earlier browser binding.
3. On the ACS route, accept only bounded `application/x-www-form-urlencoded` POSTs; reject duplicate, array, missing, or extra protocol fields as appropriate. Pass the exact SAMLResponse, RelayState, and browser cookie to `completeLogin()`. Clear the cookie on both success and failure with identical path and attributes. Return generic errors, prevent caching, redact SAML/cookies/claims from access logs, rate-limit the endpoint, and use a fixed local success redirect; never trust a return URL supplied by the caller.
4. `findUserByEntraId` must search a database-enforced unique `(tenantId, objectId)` pair and return only an explicitly pre-provisioned record, or null for absent/ambiguous records. The module additionally checks `active`, `authProvider === 'sso'`, and both IDs. Do not provision, convert, link, or grant any role based on a SAML response or email. Keep local authorization and roles in the existing trusted database.
5. `issueSession` must atomically re-read and enforce current user status, SSO provider and immutable mapping before issuing, because account deactivation can race the lookup. It must rotate/invalidate any existing session and use the app's securely configured, revocable server-side session mechanism. Return only a session to the adapter, never attach SAML-provided roles. It must not issue a session if any validation or cache operation fails.
6. Enforce privileged configuration changes, audit them without logging certificates unnecessarily or leaking assertions, and establish tested certificate rotation and emergency SSO-disable procedures. Re-check config on every request. Keep local break-glass access independent of this candidate.

Before integration, test against a real non-production Entra tenant and the actual reverse proxy, browser cookie behavior, unique user mapping, session lifecycle, disabled/deactivated users, certificate and issuer rollover, multi-worker and restart behavior, cache outages, simultaneous requests/replays, malformed or signed-wrapped XML, and security scanning/independent review. The module is deliberately not mounted by this change.

Sources: [node-saml documentation](https://github.com/node-saml/node-saml), [Microsoft Entra SAML claims](https://learn.microsoft.com/en-us/entra/identity-platform/reference-saml-tokens), and [Microsoft Entra SAML protocol](https://learn.microsoft.com/en-us/entra/identity-platform/single-sign-on-saml-protocol).
