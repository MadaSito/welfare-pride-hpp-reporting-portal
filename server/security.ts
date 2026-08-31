import type { NextFunction, Request, Response } from "express";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export const ROLES = ["platform_admin", "tenant_admin", "analyst", "customer"] as const;
export type Role = (typeof ROLES)[number];
export type SessionClaims = { sub: string; role: Role; tenantId: string | null; csrf: string; stage: "full" | "mfa_verify" | "mfa_enroll" };
export type AuthenticatedRequest = Request & { session?: SessionClaims; requestId?: string; ipHash?: string };

const SESSION_COOKIE = "__Host-wp_session";
const ACCESS_ROLES: Record<Role, Role[]> = {
  platform_admin: ROLES.slice() as Role[],
  tenant_admin: ["tenant_admin", "analyst", "customer"],
  analyst: ["analyst", "customer"],
  customer: ["customer"],
};

function secret() {
  const configured = process.env.APP_SESSION_SECRET;
  if (!configured || configured.length < 32) throw new Error("APP_SESSION_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(configured);
}

export function hashIp(ip: string) {
  const salt = process.env.AUDIT_HASH_SALT || process.env.APP_SESSION_SECRET || "unconfigured";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export function validatePassword(password: string) {
  return password.length >= 14 && /[a-z]/.test(password) && /[A-Z]/.test(password) && (password.match(/[0-9]/g)?.length ?? 0) >= 2 && (password.match(/[^A-Za-z0-9]/g)?.length ?? 0) >= 3;
}

export function mayAssignRole(actor: Role, requested: Role) {
  return actor === "platform_admin" || (actor === "tenant_admin" && ["analyst", "customer"].includes(requested));
}

export async function createSession(claims: Omit<SessionClaims, "csrf"> & { csrf?: string }, ttl: string = "15m") {
  return new SignJWT({ role: claims.role, tenantId: claims.tenantId, csrf: claims.csrf ?? randomBytes(24).toString("base64url"), stage: claims.stage })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer("welfare-pride-hpp")
    .setAudience("welfare-pride-hpp-web")
    .setExpirationTime(ttl)
    .sign(secret());
}

export async function readSession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: "welfare-pride-hpp", audience: "welfare-pride-hpp-web" });
    if (!payload.sub || !ROLES.includes(payload.role as Role) || !["full", "mfa_verify", "mfa_enroll"].includes(String(payload.stage))) return null;
    return { sub: payload.sub, role: payload.role as Role, tenantId: typeof payload.tenantId === "string" ? payload.tenantId : null, csrf: String(payload.csrf), stage: payload.stage as SessionClaims["stage"] };
  } catch { return null; }
}

export async function sessionMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(`${SESSION_COOKIE}=`.length);
  req.session = token ? await readSession(token) ?? undefined : undefined;
  req.ipHash = hashIp(req.ip || "unknown");
  next();
}

export function requireSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.session || req.session.stage !== "full") return res.status(401).json({ error: "AUTHENTICATION_REQUIRED", requestId: req.requestId });
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.session || req.session.stage !== "full" || !roles.some(role => ACCESS_ROLES[req.session!.role].includes(role))) return res.status(403).json({ error: "ACCESS_DENIED", requestId: req.requestId });
    next();
  };
}

export function verifyCsrf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.header("origin");
  const expectedOrigin = process.env.APP_ORIGIN;
  if (origin && expectedOrigin && origin !== expectedOrigin) return res.status(403).json({ error: "ORIGIN_REJECTED", requestId: req.requestId });
  if (req.session?.stage === "full") {
    const provided = req.header("x-csrf-token") || "";
    const expected = req.session.csrf || "";
    if (!provided || provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return res.status(403).json({ error: "CSRF_REJECTED", requestId: req.requestId });
  }
  next();
}

export function attachSession(res: Response, token: string) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 15 * 60 * 1000 });
}

export function clearSession(res: Response) { res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/" }); }

function encryptionKey() {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key) throw new Error("APP_ENCRYPTION_KEY is required for MFA secrets.");
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes.");
  return decoded;
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  return [iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()].map(part => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string) {
  const [iv, ciphertext, tag] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
