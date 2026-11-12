import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";

// This module is intentionally not wired to any routes or database.
export const REQUEST_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const SKEW_MS = 60_000;
const TENANT = "http://schemas.microsoft.com/identity/claims/tenantid";
const OBJECT = "http://schemas.microsoft.com/identity/claims/objectidentifier";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SAML_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const XML_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntraSamlConfig = {
  enabled: boolean;
  appOrigin: string;
  idpLoginUrl: string;
  idpIssuer: string;
  idpCertificate: string;
  tenantId: string;
};

// All cache operations must be shared across all service instances, durable for their
// expiry, and atomic as described below. Namespace per deployment is also required.
export type AtomicSamlCache = CacheProvider & {
  consumeAsync(key: string): Promise<string | null>; // atomic get-and-delete
  saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean>; // atomic NX + expiry
};
export type ProvisionedSsoUser = {
  id: string;
  active: boolean;
  authProvider: "sso" | "local";
  tenantId: string;
  objectId: string;
};
export type SamlDependencies<User extends ProvisionedSsoUser, Session> = {
  getConfig(): Promise<EntraSamlConfig | null>;
  cache: AtomicSamlCache;
  // Must return exactly one pre-provisioned account, or null on absent/ambiguous mapping.
  findUserByEntraId(tenantId: string, objectId: string): Promise<User | null>;
  // Must re-check active status at issuance in the backing store and rotate any old session.
  issueSession(user: User): Promise<Session>;
};

type Checked = { origin: string; loginUrl: string; acsUrl: string; entityId: string; idpLoginUrl: string; idpIssuer: string; cert: string; tenantId: string; namespace: string };
function fail(): never { throw new Error("SAML authentication failed"); }
function configured(value: string): string { if (typeof value !== "string" || !value.trim() || value !== value.trim()) return fail(); return value; }
function checkConfig(config: EntraSamlConfig | null): Checked {
  if (!config || config.enabled !== true) return fail();
  const input = configured(config.appOrigin);
  const originUrl = new URL(input);
  // Exact canonical origin, no path, credentials, query, fragment, or proxy-derived host.
  if (originUrl.protocol !== "https:" || input !== originUrl.origin || originUrl.username || originUrl.password) return fail();
  const idpLoginUrl = configured(config.idpLoginUrl);
  const login = new URL(idpLoginUrl);
  if (login.protocol !== "https:" || login.username || login.password || login.hash || ["SAMLRequest", "SAMLResponse", "RelayState", "SigAlg", "Signature"].some(k => login.searchParams.has(k))) return fail();
  const idpIssuer = configured(config.idpIssuer);
  const cert = configured(typeof config.idpCertificate === "string" ? config.idpCertificate.trim() : "");
  const x509 = new X509Certificate(cert);
  if (x509.publicKey.asymmetricKeyType !== "rsa" || (x509.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || Date.now() < Date.parse(x509.validFrom) || Date.now() >= Date.parse(x509.validTo)) return fail();
  const tenantId = configured(config.tenantId).toLowerCase();
  if (!GUID.test(tenantId)) return fail();
  const origin = originUrl.origin;
  const entityId = `${origin}/api/v1/auth/saml/metadata`;
  const acsUrl = `${origin}/api/v1/auth/saml/acs`;
  const loginUrl = `${origin}/api/v1/auth/saml/login`;
  const namespace = createHash("sha256").update(JSON.stringify([origin, idpLoginUrl, idpIssuer, x509.fingerprint256, tenantId])).digest("hex");
  return { origin, loginUrl, acsUrl, entityId, idpLoginUrl, idpIssuer, cert, tenantId, namespace };
}
function scopedCache(cache: AtomicSamlCache, namespace: string): AtomicSamlCache {
  const k = (key: string) => `entra-saml:${namespace}:${key}`;
  return {
    saveAsync: (key, value) => cache.saveAsync(k(key), value),
    getAsync: key => cache.getAsync(k(key)),
    removeAsync: key => key === null ? Promise.resolve(null) : cache.removeAsync(k(key)),
    consumeAsync: key => cache.consumeAsync(k(key)),
    saveIfAbsentAsync: (key, value, expiresAt) => cache.saveIfAbsentAsync(k(key), value, expiresAt),
  };
}
function library(c: Checked, cache: AtomicSamlCache, requestId?: string): SAML {
  return new SAML({
    entryPoint: c.idpLoginUrl, issuer: c.entityId, callbackUrl: c.acsUrl,
    idpIssuer: c.idpIssuer, idpCert: c.cert, audience: c.entityId,
    wantAuthnResponseSigned: true, wantAssertionsSigned: true,
    validateInResponseTo: ValidateInResponseTo.always, rejectReplayedAssertions: true,
    cacheProvider: cache, requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    acceptedClockSkewMs: SKEW_MS, maxAssertionAgeMs: REQUEST_TTL_MS,
    disableRequestedAuthnContext: true, identifierFormat: null,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}
function secureEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(a) || !/^[A-Za-z0-9_-]{43}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function onlyElement(parent: XmlElement, ns: string, local: string): XmlElement {
  const matches = Array.from(parent.childNodes).filter((n): n is XmlElement => n.nodeType === 1 && (n as XmlElement).namespaceURI === ns && (n as XmlElement).localName === local);
  if (matches.length !== 1) return fail();
  return matches[0];
}
function strictSignatureAlgorithms(element: XmlElement): void {
  const id = element.getAttribute("ID");
  if (!id) return fail();
  const signature = onlyElement(element, XML_SIGNATURE, "Signature");
  const info = onlyElement(signature, XML_SIGNATURE, "SignedInfo");
  const method = onlyElement(info, XML_SIGNATURE, "SignatureMethod").getAttribute("Algorithm");
  if (method !== "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" && method !== "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512") return fail();
  const reference = onlyElement(info, XML_SIGNATURE, "Reference");
  if (reference.getAttribute("URI") !== `#${id}`) return fail();
  const digest = onlyElement(reference, XML_SIGNATURE, "DigestMethod").getAttribute("Algorithm");
  if (digest !== "http://www.w3.org/2001/04/xmlenc#sha256" && digest !== "http://www.w3.org/2001/04/xmlenc#sha512") return fail();
}
// Fail-only checks on the same response whose top-level signature is required above.
function strictResponse(encoded: string, c: Checked, requestId: string): void {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_RESPONSE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail();
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES || bytes.toString("base64") !== encoded) return fail();
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail();
  const doc = new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SAML_PROTOCOL || root.localName !== "Response" || root.getAttribute("Destination") !== c.acsUrl || root.getAttribute("InResponseTo") !== requestId || root.getAttribute("Version") !== "2.0") return fail();
  strictSignatureAlgorithms(root);
  strictSignatureAlgorithms(onlyElement(root, SAML_ASSERTION, "Assertion"));
  if (onlyElement(root, SAML_ASSERTION, "Issuer").textContent !== c.idpIssuer) return fail();
  const status = onlyElement(root, SAML_PROTOCOL, "Status");
  if (onlyElement(status, SAML_PROTOCOL, "StatusCode").getAttribute("Value") !== "urn:oasis:names:tc:SAML:2.0:status:Success") return fail();
}
function record(x: unknown): Record<string, any> {
  if (!x || typeof x !== "object" || Array.isArray(x)) return fail();
  return x as Record<string, any>;
}
function one(x: unknown): Record<string, any> {
  if (!Array.isArray(x) || x.length !== 1) return fail();
  return record(x[0]);
}
function strictAssertion(profile: Profile, c: Checked, requestId: string): { tenantId: string; objectId: string } {
  if (profile.issuer !== c.idpIssuer || profile.inResponseTo !== requestId || typeof profile.getAssertion !== "function") return fail();
  const assertion = record(record(profile.getAssertion()).Assertion);
  const rootAttrs = record(assertion.$);
  if (rootAttrs.Version !== "2.0" || typeof rootAttrs.ID !== "string" || !rootAttrs.ID) return fail();
  const issue = Date.parse(rootAttrs.IssueInstant);
  const now = Date.now();
  if (!Number.isFinite(issue) || issue > now + SKEW_MS || issue + REQUEST_TTL_MS + SKEW_MS <= now) return fail();
  const conditions = record(one(assertion.Conditions).$);
  const notBefore = Date.parse(conditions.NotBefore), expires = Date.parse(conditions.NotOnOrAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expires) || notBefore >= expires || notBefore > now + SKEW_MS || expires <= now - SKEW_MS) return fail();
  const subject = one(assertion.Subject);
  const confirmation = one(subject.SubjectConfirmation);
  if (record(confirmation.$).Method !== BEARER) return fail();
  const data = record(one(confirmation.SubjectConfirmationData).$);
  const subjectExpires = Date.parse(data.NotOnOrAfter);
  if (data.Recipient !== c.acsUrl || data.InResponseTo !== requestId || !Number.isFinite(subjectExpires) || subjectExpires <= now - SKEW_MS) return fail();
  if (data.NotBefore !== undefined) return fail(); // SAML bearer SubjectConfirmationData must not contain NotBefore.
  one(assertion.AuthnStatement);
  if (!Array.isArray(assertion.AttributeStatement)) return fail();
  const claims = new Map<string, string>();
  for (const statement of assertion.AttributeStatement) {
    const attrs = record(statement).Attribute;
    if (!Array.isArray(attrs)) continue;
    for (const a of attrs) {
      const attr = record(a), name = record(attr.$).Name;
      if (name !== TENANT && name !== OBJECT) continue;
      if (claims.has(name)) return fail();
      const value = one(attr.AttributeValue);
      if (typeof value._ !== "string" || !GUID.test(value._) || Object.keys(value).some(k => k !== "_" && k !== "$")) return fail();
      claims.set(name, value._.toLowerCase());
    }
  }
  const tenantId = claims.get(TENANT), objectId = claims.get(OBJECT);
  if (!tenantId || tenantId !== c.tenantId || !objectId) return fail();
  return { tenantId, objectId };
}

export function createEntraSamlService<User extends ProvisionedSsoUser, Session>(deps: SamlDependencies<User, Session>) {
  if (!deps.cache || typeof deps.cache.consumeAsync !== "function" || typeof deps.cache.saveIfAbsentAsync !== "function") throw new Error("SAML requires an atomic shared cache");
  return {
    async endpoints() {
      const c = checkConfig(await deps.getConfig());
      return { entityId: c.entityId, acsUrl: c.acsUrl, loginUrl: c.loginUrl };
    },
    async metadata() {
      const c = checkConfig(await deps.getConfig());
      return library(c, scopedCache(deps.cache, c.namespace)).generateServiceProviderMetadata(null);
    },
    async beginLogin() {
      const c = checkConfig(await deps.getConfig());
      const cache = scopedCache(deps.cache, c.namespace);
      const requestId = `_${randomBytes(32).toString("hex")}`;
      const browserToken = randomBytes(32).toString("base64url");
      const redirectUrl = await library(c, cache, requestId).getAuthorizeUrlAsync(browserToken, {});
      if (!await cache.saveIfAbsentAsync(`browser:${browserToken}`, requestId, Date.now() + REQUEST_TTL_MS)) return fail();
      // The adapter MUST set this token in a host-only, HttpOnly, Secure, SameSite=None
      // cookie scoped to the ACS, and delete it after every callback (including failures).
      return { redirectUrl, browserToken, cookieMaxAgeMs: REQUEST_TTL_MS, cookiePath: "/api/v1/auth/saml/acs" };
    },
    async completeLogin(input: { samlResponse: string; relayState: string; browserToken: string }): Promise<Session> {
      const c = checkConfig(await deps.getConfig());
      if (!secureEqual(input.relayState, input.browserToken)) return fail();
      const cache = scopedCache(deps.cache, c.namespace);
      const requestId = await cache.consumeAsync(`browser:${input.browserToken}`);
      if (!requestId) return fail();
      // Bound malformed requests before the XML/signature processor.
      strictResponse(input.samlResponse, c, requestId);
      const result = await library(c, cache).validatePostResponseAsync({ SAMLResponse: input.samlResponse });
      if (!result.profile || result.loggedOut) return fail();
      const identity = strictAssertion(result.profile, c, requestId);
      const user = await deps.findUserByEntraId(identity.tenantId, identity.objectId);
      if (!user || user.active !== true || user.authProvider !== "sso" || user.tenantId.toLowerCase() !== identity.tenantId || user.objectId.toLowerCase() !== identity.objectId) return fail();
      if (checkConfig(await deps.getConfig()).namespace !== c.namespace) return fail();
      return deps.issueSession(user);
    },
  };
}
