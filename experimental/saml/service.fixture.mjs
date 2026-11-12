import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { createEntraSamlService } from "./service";
const tenant = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const object = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const issuer = `https://sts.windows.net/${tenant}/`;
const appOrigin = "https://portal.example.test";
const entity = `${appOrigin}/api/v1/auth/saml/metadata`;
const acs = `${appOrigin}/api/v1/auth/saml/acs`;
let dir, cert, key;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "saml-fixture-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=synthetic-idp"], { stdio: "ignore" });
  cert = readFileSync(join(dir, "cert.pem"), "utf8");
  key = readFileSync(join(dir, "key.pem"), "utf8");
});
after(() => rmSync(dir, { recursive: true, force: true }));
class Cache {
  values = /* @__PURE__ */ new Map();
  async saveAsync(k, value) {
    const createdAt = Date.now();
    this.values.set(k, { value, expiry: createdAt + 3e5 });
    return { value, createdAt };
  }
  async getAsync(k) {
    const item = this.values.get(k);
    if (!item || item.expiry <= Date.now()) {
      this.values.delete(k);
      return null;
    }
    return item.value;
  }
  async removeAsync(k) {
    if (!k) return null;
    const v = await this.getAsync(k);
    this.values.delete(k);
    return v;
  }
  // This test cache performs each operation synchronously before returning its promise.
  async consumeAsync(k) {
    const item = this.values.get(k);
    this.values.delete(k);
    return item && item.expiry > Date.now() ? item.value : null;
  }
  async saveIfAbsentAsync(k, value, expiry) {
    const item = this.values.get(k);
    if (item && item.expiry > Date.now()) return false;
    this.values.set(k, { value, expiry });
    return true;
  }
}
function setup(options = {}) {
  const config = { enabled: options.enabled ?? true, appOrigin, idpLoginUrl: "https://login.example.test/saml", idpIssuer: issuer, idpCertificate: cert, tenantId: tenant };
  const cache = new Cache();
  let sessions = 0;
  const service = createEntraSamlService({ getConfig: async () => config, cache, findUserByEntraId: async (tid, oid) => options.known === false || tid !== tenant || oid !== object ? null : { id: "pre-provisioned", active: options.active ?? true, authProvider: options.provider ?? "sso", tenantId: tenant, objectId: object }, issueSession: async (user) => {
    sessions++;
    return `session:${user.id}`;
  } });
  return { config, service, cache, sessionCount: () => sessions };
}
function sign(xml, target, weak = false) {
  const sig = new SignedXml({ privateKey: key, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#", signatureAlgorithm: weak ? "http://www.w3.org/2000/09/xmldsig#rsa-sha1" : "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" });
  sig.addReference({ xpath: `//*[local-name()='${target}']`, transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"], digestAlgorithm: weak ? "http://www.w3.org/2000/09/xmldsig#sha1" : "http://www.w3.org/2001/04/xmlenc#sha256" });
  sig.computeSignature(xml, { location: { reference: `//*[local-name()='${target}']/*[local-name()='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}
function response(id, overrides = {}) {
  const now = Date.now();
  const issue = new Date(now - 1e3).toISOString();
  const expires = new Date(now + 18e4).toISOString();
  const requestId = overrides.requestId ?? id;
  const attr = (name, value) => `<saml:Attribute Name="http://schemas.microsoft.com/identity/claims/${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${overrides.assertionId ?? `_${randomUUID()}`}" Version="2.0" IssueInstant="${issue}"><saml:Issuer>${overrides.assertionIssuer ?? issuer}</saml:Issuer><saml:Subject><saml:NameID>ignored</saml:NameID><saml:SubjectConfirmation Method="${overrides.method ?? "urn:oasis:names:tc:SAML:2.0:cm:bearer"}"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${overrides.recipient ?? acs}" ${overrides.omitSubjectExpiry ? "" : `NotOnOrAfter="${overrides.subjectExpiry ?? expires}"`}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now - 3e4).toISOString()}" NotOnOrAfter="${overrides.conditionsExpiry ?? expires}"><saml:AudienceRestriction><saml:Audience>${overrides.audience ?? entity}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issue}"/><saml:AttributeStatement>${attr("tenantid", overrides.tenant ?? tenant)}${attr("objectidentifier", overrides.object ?? object)}${overrides.duplicateObject ? attr("objectidentifier", object) : ""}</saml:AttributeStatement></saml:Assertion>`;
  const signedAssertion = overrides.unsigned || overrides.unsignedAssertion ? assertion : sign(assertion, "Assertion", overrides.weakSignature);
  const full = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomUUID()}" Version="2.0" IssueInstant="${issue}" Destination="${overrides.destination ?? acs}" InResponseTo="${requestId}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${overrides.responseIssuer ?? issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${overrides.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>${signedAssertion}</samlp:Response>`;
  return Buffer.from(overrides.unsigned || overrides.unsignedResponse ? full : sign(full, "Response", overrides.weakSignature)).toString("base64");
}
async function start(service) {
  const state = await service.beginLogin();
  const url = new URL(state.redirectUrl);
  const xml = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest"), "base64")).toString();
  const requestId = xml.match(/\bID="([^"]+)"/)?.[1];
  assert.ok(requestId);
  return { ...state, requestId, relayState: url.searchParams.get("RelayState") };
}
async function complete(service, flow, overrides = {}) {
  return service.completeLogin({ samlResponse: response(flow.requestId, overrides), browserToken: flow.browserToken, relayState: flow.relayState });
}
test("accepts a signed, correlated Entra assertion only once", async () => {
  const s = setup(), flow = await start(s.service);
  assert.equal(await complete(s.service, flow), "session:pre-provisioned");
  await assert.rejects(() => complete(s.service, flow));
  assert.equal(s.sessionCount(), 1);
  assert.deepEqual(await s.service.endpoints(), { entityId: entity, acsUrl: acs, loginUrl: `${appOrigin}/api/v1/auth/saml/login` });
});
for (const [label, overrides] of Object.entries({
  "completely unsigned message": { unsigned: true },
  "unsigned response": { unsignedResponse: true },
  "unsigned assertion": { unsignedAssertion: true },
  "SHA-1 signatures": { weakSignature: true },
  "wrong recipient": { recipient: "https://evil.test/acs" },
  "wrong audience": { audience: "https://evil.test" },
  "wrong assertion issuer": { assertionIssuer: "https://evil.test" },
  "wrong response issuer": { responseIssuer: "https://evil.test" },
  "wrong tenant": { tenant: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
  "unknown object identifier": { object: "cccccccc-cccc-cccc-cccc-cccccccccccc" },
  "wrong request id": { requestId: "_unsolicited" },
  "wrong destination": { destination: "https://evil.test/acs" },
  "error status": { status: "urn:oasis:names:tc:SAML:2.0:status:Responder" },
  "wrong confirmation method": { method: "urn:oasis:names:tc:SAML:2.0:cm:holder-of-key" },
  "missing subject expiry": { omitSubjectExpiry: true },
  "duplicate object identifier": { duplicateObject: true }
})) test(`rejects ${label}`, async () => {
  const s = setup(), flow = await start(s.service);
  await assert.rejects(() => complete(s.service, flow, overrides));
  assert.equal(s.sessionCount(), 0);
});
test("rejects expired conditions and bearer confirmations", async () => {
  for (const overrides of [{ conditionsExpiry: new Date(Date.now() - 12e4).toISOString() }, { subjectExpiry: new Date(Date.now() - 12e4).toISOString() }]) {
    const s = setup(), flow = await start(s.service);
    await assert.rejects(() => complete(s.service, flow, overrides));
  }
});
test("rejects browser mismatch and missing browser binding", async () => {
  const s = setup(), flow = await start(s.service);
  await assert.rejects(() => s.service.completeLogin({ samlResponse: response(flow.requestId), relayState: flow.relayState, browserToken: "" }));
  const other = await start(s.service);
  await assert.rejects(() => s.service.completeLogin({ samlResponse: response(flow.requestId), relayState: other.relayState, browserToken: other.browserToken }));
  assert.equal(s.sessionCount(), 0);
});
test("rejects unknown, inactive and locally authenticated accounts", async () => {
  for (const options of [{ known: false }, { active: false }, { provider: "local" }]) {
    const s = setup(options), flow = await start(s.service);
    await assert.rejects(() => complete(s.service, flow));
    assert.equal(s.sessionCount(), 0);
  }
});
test("rejects same assertion ID across two otherwise valid requests", async () => {
  const s = setup(), first = await start(s.service), second = await start(s.service), assertionId = `_${randomUUID()}`;
  assert.equal(await complete(s.service, first, { assertionId }), "session:pre-provisioned");
  await assert.rejects(() => complete(s.service, second, { assertionId }));
  assert.equal(s.sessionCount(), 1);
});
test("rejects tampering after signing and signatures from an untrusted key", async () => {
  {
    const s = setup(), flow = await start(s.service);
    const xml = Buffer.from(response(flow.requestId), "base64").toString("utf8").replace(object, "cccccccc-cccc-cccc-cccc-cccccccccccc");
    await assert.rejects(() => s.service.completeLogin({ samlResponse: Buffer.from(xml).toString("base64"), browserToken: flow.browserToken, relayState: flow.relayState }));
    assert.equal(s.sessionCount(), 0);
  }
  {
    const s = setup(), flow = await start(s.service);
    const responseSignedByDifferentKey = response(flow.requestId);
    const newKey = join(dir, "other.key"), newCert = join(dir, "other.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", newKey, "-out", newCert, "-days", "1", "-subj", "/CN=untrusted"], { stdio: "ignore" });
    s.config.idpCertificate = readFileSync(newCert, "utf8");
    const fresh = await start(s.service);
    await assert.rejects(() => s.service.completeLogin({ samlResponse: response(fresh.requestId), browserToken: fresh.browserToken, relayState: fresh.relayState }));
    assert.ok(responseSignedByDifferentKey);
    assert.equal(s.sessionCount(), 0);
  }
});
test("at most one concurrent copy can issue a session", async () => {
  const s = setup(), flow = await start(s.service), samlResponse = response(flow.requestId);
  const input = { samlResponse, browserToken: flow.browserToken, relayState: flow.relayState };
  const results = await Promise.allSettled([s.service.completeLogin(input), s.service.completeLogin(input)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(s.sessionCount(), 1);
});
test("fails closed for disabled and malformed configuration", async () => {
  const s = setup({ enabled: false });
  await assert.rejects(() => s.service.beginLogin());
  s.config.enabled = true;
  for (const bad of ["http://portal.example.test", "https://portal.example.test/", "https://portal.example.test/path", "https://evil.test@portal.example.test"]) {
    s.config.appOrigin = bad;
    await assert.rejects(() => s.service.beginLogin());
  }
  s.config.appOrigin = appOrigin;
  s.config.idpCertificate = "invalid";
  await assert.rejects(() => s.service.beginLogin());
});
