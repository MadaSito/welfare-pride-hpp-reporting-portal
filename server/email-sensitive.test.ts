import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: {} as any, log: vi.fn(() => "id"), find: vi.fn(), write: vi.fn(), send: vi.fn(), transport: vi.fn(), fetch: vi.fn() }));
vi.mock("./repository", () => ({ getEmailConfig: () => mocks.config, logMail: mocks.log, findMailLog: mocks.find }));
vi.mock("./logging", () => ({ writeLog: mocks.write }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.transport } }));
const token = "fake-sensitive-token-not-a-credential";
const message = { to: "user@example.test", subject: "Secure login", text: `https://example.test/magic-link#token=${token}`, sensitive: true, requireNoBcc: true };
function noLeak() { expect(JSON.stringify([mocks.log.mock.calls, mocks.write.mock.calls])).not.toContain(token); }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.config = { enabled: 1, primary_provider: "smtp", secondary_provider: "graph", smtp_host: "smtp.example.test", smtp_port: 587,
    smtp_secure: 0, smtp_from: "sender@example.test", graph_tenant_id: "tenant", graph_client_id: "id", graph_client_secret: "secret", graph_sender: "sender@example.test", global_bcc: null };
  mocks.send.mockReset().mockResolvedValue({}); mocks.transport.mockReset().mockReturnValue({ sendMail: mocks.send });
  mocks.fetch.mockReset(); vi.stubGlobal("fetch", mocks.fetch); vi.stubEnv("EMAIL_SIMULATED", "false"); vi.stubEnv("GLOBAL_EMAIL_BCC", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("sensitive authentication email", () => {
  it("requires SMTP TLS, retains no credential, and cannot resend", async () => {
    const { sendEmail, resendMailLog } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: true, status: "sent" });
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true }));
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ subject: "[Sensitive email: content not retained]", payload: null }));
    noLeak(); mocks.find.mockReturnValue({ recipient: message.to, subject: "[Sensitive email: content not retained]", payload: null });
    await expect(resendMailLog("id")).rejects.toThrow(/cannot be resent/);
  });
  it("does not retain Graph sent items", async () => {
    mocks.config.primary_provider = "graph";
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockResolvedValueOnce({ ok: true });
    const { sendEmail } = await import("./email"); expect(await sendEmail(message)).toMatchObject({ ok: true, status: "sent" });
    const payload = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(payload.saveToSentItems).toBe(false); expect(payload.message.bccRecipients).toEqual([]); noLeak();
  });
  it("redacts errors and does not fail over", async () => {
    mocks.send.mockRejectedValueOnce(new Error(`provider echoed ${token}`));
    const { sendEmail } = await import("./email"); const result = await sendEmail(message);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(token); expect(mocks.fetch).not.toHaveBeenCalled(); noLeak();
  });
  it.each(["database", "environment"])("blocks %s BCC", async source => {
    if (source === "database") mocks.config.global_bcc = "hidden@example.test"; else vi.stubEnv("GLOBAL_EMAIL_BCC", "hidden@example.test");
    const { sendEmail } = await import("./email"); expect(await sendEmail(message)).toMatchObject({ ok: false, status: "failed" });
    expect(mocks.send).not.toHaveBeenCalled(); noLeak();
  });
  it("does not retain simulated messages", async () => {
    vi.stubEnv("EMAIL_SIMULATED", "true"); const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: true, status: "simulated" }); expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ payload: null })); noLeak();
  });
});
