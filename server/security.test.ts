import { describe, expect, it } from "vitest";
import { canonicalRole, canManageTarget, mayAssignRole, validatePassword, hashIp } from "./security";

describe("role canonicalization", () => {
  it("normalizes legacy role names", () => {
    expect(canonicalRole("platform_admin")).toBe("super_admin");
    expect(canonicalRole("tenant_admin")).toBe("admin");
    expect(canonicalRole("analyst")).toBe("manager");
    expect(canonicalRole("customer")).toBe("view_only");
  });
  it("passes canonical roles unchanged", () => {
    expect(canonicalRole("super_admin")).toBe("super_admin");
    expect(canonicalRole("view_only")).toBe("view_only");
  });
});

describe("bounded role assignment", () => {
  it("allows super_admin any role", () => {
    expect(mayAssignRole("super_admin", "super_admin")).toBe(true);
    expect(mayAssignRole("super_admin", "view_only")).toBe(true);
  });
  it("restricts admin to manager and view_only", () => {
    expect(mayAssignRole("admin", "super_admin")).toBe(false);
    expect(mayAssignRole("admin", "admin")).toBe(false);
    expect(mayAssignRole("admin", "manager")).toBe(true);
    expect(mayAssignRole("admin", "view_only")).toBe(true);
  });
  it("denies manager and view_only", () => {
    expect(mayAssignRole("manager", "view_only")).toBe(false);
    expect(mayAssignRole("view_only", "view_only")).toBe(false);
  });
});

describe("super admin isolation", () => {
  it("isolates super admin accounts from lower roles", () => {
    expect(canManageTarget("admin", "super_admin")).toBe(false);
    expect(canManageTarget("admin", "manager")).toBe(true);
    expect(canManageTarget("super_admin", "super_admin")).toBe(true);
  });
});

describe("password policy", () => {
  it("rejects empty, overlong, and known-compromised passwords", () => {
    expect(validatePassword("")).toBe(false);
    expect(validatePassword("a".repeat(257))).toBe(false);
    expect(validatePassword("SuperAdmin2026!#W")).toBe(false);
  });
  it("accepts passwords of any length without forced complexity rules", () => {
    expect(validatePassword("short")).toBe(true);
    expect(validatePassword("nouppercase12!!")).toBe(true);
    expect(validatePassword("Correct-Horse-Battery-Staple#99!")).toBe(true);
  });
});

describe("ip hashing", () => {
  it("produces stable digests for audit persistence", () => {
    expect(hashIp("198.51.100.2")).toBe(hashIp("198.51.100.2"));
    expect(hashIp("198.51.100.2")).not.toBe(hashIp("198.51.100.3"));
  });
});

import { encryptSecret, decryptSecret } from "./security";

describe("secret encryption", () => {
  it("roundtrips secrets under AES-256-GCM", () => {
    const raw = "MFA_SECRET_BASE32_ABCD";
    expect(decryptSecret(encryptSecret(raw))).toBe(raw);
  });
});

import { isAllowedOrigin } from "./security";

describe("isAllowedOrigin", () => {
  const req = { get: () => "attacker-controlled" } as any;
  it("accepts only the exact configured origin, not host headers or wildcard preview domains", () => {
    const previous = process.env.APP_ORIGIN;
    process.env.APP_ORIGIN = "https://portal.example.org";
    try {
      expect(isAllowedOrigin(req, "https://portal.example.org")).toBe(true);
      expect(isAllowedOrigin(req, "https://evil.attacker.test")).toBe(false);
      expect(isAllowedOrigin(req, "http://localhost:3000")).toBe(false);
      expect(isAllowedOrigin(req, "https://portal.example.org.evil.test")).toBe(false);
      expect(isAllowedOrigin(req, "https://portal.example.org/path")).toBe(false);
      expect(isAllowedOrigin(req)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = previous;
    }
  });
  it("fails closed when APP_ORIGIN is not configured", () => {
    const previous = process.env.APP_ORIGIN;
    delete process.env.APP_ORIGIN;
    try { expect(isAllowedOrigin(req, "http://localhost:3000")).toBe(false); }
    finally { if (previous !== undefined) process.env.APP_ORIGIN = previous; }
  });
});
