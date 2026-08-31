import { describe, expect, it } from "vitest";
import { createSession, mayAssignRole, readSession, validatePassword } from "./security";

process.env.APP_SESSION_SECRET = "test-session-secret-with-at-least-thirty-two-characters";

describe("local identity security controls", () => {
  it("requires the documented high-assurance local password shape", () => {
    expect(validatePassword("shortPassword12!")).toBe(false);
    expect(validatePassword("OnlyOneDigit!!A")).toBe(false);
    expect(validatePassword("Bridge*Harbor!2026?" )).toBe(true);
  });

  it("creates an issuer- and audience-bound session with an explicit authentication stage", async () => {
    const token = await createSession({ sub: "bddf9d6c-0aec-4e33-8d81-0b7de826154d", role: "customer", tenantId: "ad06dcd0-73ee-4901-b3c5-daa80de3b98a", stage: "full" });
    const session = await readSession(token);
    expect(session).toMatchObject({ sub: "bddf9d6c-0aec-4e33-8d81-0b7de826154d", role: "customer", stage: "full" });
    expect(session?.csrf).toHaveLength(32);
  });

  it("prevents tenant administrators from escalating privileges through account management", () => {
    expect(mayAssignRole("tenant_admin", "customer")).toBe(true);
    expect(mayAssignRole("tenant_admin", "analyst")).toBe(true);
    expect(mayAssignRole("tenant_admin", "tenant_admin")).toBe(false);
    expect(mayAssignRole("tenant_admin", "platform_admin")).toBe(false);
  });
});
