import type { NextFunction, Request, Response } from "express";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";

export const ROLES = ["super_admin", "admin", "manager", "view_only"] as const;
export type Role = (typeof ROLES)[number];

const LEGACY_ROLE_MAP: Record<string, Role> = {
  platform_admin: "super_admin",
  tenant_admin: "admin",
  analyst: "manager",
  customer: "view_only",
};
export function canonicalRole(role: string): Role {
  if ((ROLES as readonly string[]).includes(role)) return role as Role;
  return LEGACY_ROLE_MAP[role] ?? "view_only";
}

export type SessionClaims = {
  sub: string;
  role: Role;
  tenantId: string | null;
  csrf: string;
  stage: "full" | "mfa_verify" | "mfa_enroll";
  displayName?: string;
  email?: string;
};
export type AuthenticatedRequest = Request & {
  session?: SessionClaims;
  requestId?: string;
  ipHash?: string;
  realIp?: string;
  geoCountry?: string;
};

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "wp_session";

const ACCESS_ROLES: Record<Role, Role[]> = {
  super_admin: ["super_admin", "admin", "manager", "view_only"],
  admin: ["admin", "manager", "view_only"],
  manager: ["manager", "view_only"],
  view_only: ["view_only"],
};

function secret(): Uint8Array {
  const configured = process.env.APP_SESSION_SECRET;
  if (!configured || configured.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_SESSION_SECRET must contain at least 32 characters in production.");
    }
    return new TextEncoder().encode("development-only-session-secret-min32ch!!");
  }
  return new TextEncoder().encode(configured);
}

export function hashIp(ip: string): string {
  const salt = process.env.AUDIT_HASH_SALT || process.env.APP_SESSION_SECRET || "welfare-audit-salt";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export function validatePassword(password: string): boolean {
  if (typeof password !== "string") return false;
  if (password.length < 14 || password.length > 128) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if ((password.match(/[0-9]/g)?.length ?? 0) < 2) return false;
  if ((password.match(/[^A-Za-z0-9]/g)?.length ?? 0) < 3) return false;
  return true;
}

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

export function mayAssignRole(actor: Role, requested: Role): boolean {
  if (actor === "super_admin") return true;
  if (actor === "admin") return requested === "manager" || requested === "view_only";
  return false;
}

export function canManageTarget(actor: Role, targetRole: Role): boolean {
  if (actor === "super_admin") return true;
  if ((targetRole as string) === "super_admin") return false;
  if (actor === "admin") return (targetRole as string) !== "super_admin" && (targetRole as string) !== "admin";
  return false;
}

export async function createSession(claims: Omit<SessionClaims, "csrf"> & { csrf?: string }, ttl = "30m"): Promise<string> {
  return new SignJWT({
    role: claims.role,
    tenantId: claims.tenantId,
    csrf: claims.csrf ?? randomBytes(24).toString("base64url"),
    stage: claims.stage,
    displayName: claims.displayName,
    email: claims.email,
  })
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
    if (!payload.sub) return null;
    const role = canonicalRole(String(payload.role));
    if (!ROLES.includes(role)) return null;
    const stage = String(payload.stage);
    if (!["full", "mfa_verify", "mfa_enroll"].includes(stage)) return null;
    return {
      sub: payload.sub,
      role,
      tenantId: typeof payload.tenantId === "string" ? payload.tenantId : null,
      csrf: String(payload.csrf),
      stage: stage as SessionClaims["stage"],
      displayName: typeof payload.displayName === "string" ? payload.displayName : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return null;
  }
}

export async function sessionMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(`${SESSION_COOKIE}=`.length);
  req.session = token ? (await readSession(token)) ?? undefined : undefined;
  const ip = req.realIp || req.ip || "unknown";
  req.ipHash = hashIp(ip);
  next();
}

export function requireSession(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.session || req.session.stage !== "full") {
    res.status(401).json({ error: "AUTHENTICATION_REQUIRED", requestId: req.requestId });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.session || req.session.stage !== "full") {
      res.status(401).json({ error: "AUTHENTICATION_REQUIRED", requestId: req.requestId });
      return;
    }
    const actor = req.session.role;
    const allowed = ACCESS_ROLES[actor] ?? [];
    if (!roles.some(role => allowed.includes(role))) {
      res.status(403).json({ error: "ACCESS_DENIED", requestId: req.requestId });
      return;
    }
    next();
  };
}

function parseOrigin(urlStr?: string | null): string | null {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
export function isAllowedOrigin(req: AuthenticatedRequest, originHeader?: string | null): boolean {
  if (!originHeader) return true;
  const origin = parseOrigin(originHeader);
  if (!origin) return false;
  const configured = (process.env.APP_ORIGIN || process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => parseOrigin(s))
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  if (host && origin === `${proto}://${host}`) return true;
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".us5.manus.computer") || u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch {}
  return false;
}
export function verifyCsrf(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.header("origin");
  if (origin && !isAllowedOrigin(req, origin)) {
    res.status(403).json({ error: "ORIGIN_REJECTED", requestId: req.requestId });
    return;
  }
  if (req.session?.stage === "full") {
    const provided = req.header("x-csrf-token") || "";
    const expected = req.session.csrf || "";
    if (!provided || provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      res.status(403).json({ error: "CSRF_REJECTED", requestId: req.requestId });
      return;
    }
  }
  next();
}
function isSecure(req?: Request): boolean {
  if (req?.secure) return true;
  const proto = (req?.get?.("x-forwarded-proto") || "").split(",")[0].trim();
  if (proto === "https") return true;
  return process.env.NODE_ENV === "production" && process.env.COOKIE_INSECURE !== "true";
}
export function attachSession(res: Response, token: string, req?: Request): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(req),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 60 * 1000,
  });
}
export function clearSession(res: Response, req?: Request): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: isSecure(req),
    sameSite: "lax",
    path: "/",
  });
}
function encryptionKey(): Buffer {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ENCRYPTION_KEY is required for MFA secrets in production.");
    }
    return Buffer.from("01234567890123456789012345678901");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes (base64).");
  return decoded;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, ct, cipher.getAuthTag()].map(part => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const [iv, ciphertext, tag] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(`mfa-recovery:${norm}`).digest("hex");
}
