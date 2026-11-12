import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  logMail: vi.fn(() => "mail-log-id"),
  findMailLog: vi.fn(),
  writeLog: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("./repository", () => ({
  getEmailConfig: () => mocks.config,
  logMail: mocks.logMail,
  findMailLog: mocks.findMailLog,
}));
vi.mock("./logging", () => ({ writeLog: mocks.writeLog }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));

const secret = "SECRET_REPORT_BYTES_9281";
const bytes = Buffer.concat([Buffer.from(secret), Buffer.from([0, 255, 1, 128])]);
const attachment = { filename: "report.pdf", content: bytes, contentType: "application/pdf" };
const message = {
  to: "recipient@example.test",
  subject: `Report ${secret}`,
  text: `Body ${secret}`,
  correlationId: "request-123",
  attachments: [attachment],
  requireNoBcc: true,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.config = {
    primary_provider: "smtp", secondary_provider: null,
    smtp_host: "smtp.example.test", smtp_port: 587, smtp_secure: 0,
    smtp_user: null, smtp_pass: null, smtp_from: "sender@example.test",
    graph_tenant_id: "tenant", graph_client_id: "client", graph_client_secret: "secret",
    graph_sender: "sender@example.test", global_bcc: null, enabled: 1,
  };
  mocks.sendMail.mockReset().mockResolvedValue({});
  mocks.createTransport.mockReset().mockReturnValue({ sendMail: mocks.sendMail });
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("EMAIL_SIMULATED", "false");
  vi.stubEnv("GLOBAL_EMAIL_BCC", "");
  vi.stubEnv("SMTP_SECURE", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectLogsSafe() {
  const output = JSON.stringify([mocks.logMail.mock.calls, mocks.writeLog.mock.calls]);
  expect(output).not.toContain(secret);
  expect(output).not.toContain(bytes.toString("base64"));
  expect(output).not.toContain("report.pdf");
}

describe("email engine enabled switch", () => {
  const ordinaryMessage = { to: message.to, subject: `Subject ${secret}`, text: `Body ${secret}`, correlationId: message.correlationId };
  const paths = [
    { name: "SMTP with Graph failover", primary: "smtp", secondary: "graph", simulated: false },
    { name: "Graph with SMTP failover", primary: "graph", secondary: "smtp", simulated: false },
    { name: "simulation provider", primary: "simulation", secondary: "smtp", simulated: false },
    { name: "environment simulation", primary: "smtp", secondary: "graph", simulated: true },
  ];

  for (const enabled of [0, false]) {
    for (const path of paths) {
      for (const [kind, email] of [["attachment", message], ["ordinary", ordinaryMessage]] as const) {
        it(`rejects ${kind} email when enabled=${enabled}, including ${path.name}`, async () => {
          mocks.config.enabled = enabled;
          mocks.config.primary_provider = path.primary;
          mocks.config.secondary_provider = path.secondary;
          mocks.config.smtp_pass = "CREDENTIAL_SECRET_9281";
          mocks.config.graph_client_secret = "CREDENTIAL_SECRET_9281";
          vi.stubEnv("EMAIL_SIMULATED", String(path.simulated));
          const { sendEmail, emailCircuitStatus } = await import("./email");
          const result = await sendEmail(email);
          expect(result).toEqual({ ok: false, provider: "none", status: "failed", error: "Email engine is disabled", logId: "mail-log-id" });
          expect(mocks.logMail).toHaveBeenCalledOnce();
          expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({
            provider: "none", status: "failed", error: "Email engine is disabled",
            subject: "[Disabled email: content not retained]", payload: null, correlation_id: "request-123",
          }));
          expect(mocks.fetch).not.toHaveBeenCalled();
          expect(mocks.createTransport).not.toHaveBeenCalled();
          expect(mocks.sendMail).not.toHaveBeenCalled();
          expect(emailCircuitStatus()).toMatchObject({ consecutiveFailures: 0, tripped: false });
          expectLogsSafe();
          expect(JSON.stringify([mocks.logMail.mock.calls, mocks.writeLog.mock.calls])).not.toContain("CREDENTIAL_SECRET_9281");
        });
      }
    }
  }

  it.each([undefined, null, 2, "1"])("fails closed on invalid enabled value %s", async enabled => {
    mocks.config.enabled = enabled;
    const { sendEmail } = await import("./email");
    expect(await sendEmail(ordinaryMessage)).toMatchObject({ ok: false, provider: "none", status: "failed", error: "Email engine is disabled" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it("rejects disabled email before BCC or attachment validation", async () => {
    mocks.config.enabled = 0;
    mocks.config.global_bcc = "archive@example.test";
    const { sendEmail } = await import("./email");
    const result = await sendEmail({ ...message, attachments: [{ ...attachment, content: "invalid" as unknown as Buffer }] });
    expect(result).toMatchObject({ ok: false, provider: "none", status: "failed", error: "Email engine is disabled" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it.each([1, true])("sends through SMTP when enabled=%s", async enabled => {
    mocks.config.enabled = enabled;
    const { sendEmail } = await import("./email");
    expect(await sendEmail(ordinaryMessage)).toMatchObject({ ok: true, provider: "smtp", status: "sent" });
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ordinaryMessage.to, subject: ordinaryMessage.subject, text: ordinaryMessage.text }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([1, true])("sends through Graph when enabled=%s", async enabled => {
    mocks.config.enabled = enabled;
    mocks.config.primary_provider = "graph";
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockResolvedValueOnce({ ok: true });
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: true, provider: "graph", status: "sent" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][0]).toContain("/sendMail");
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it.each(["provider", "environment"])("permits %s simulation when enabled", async source => {
    if (source === "provider") mocks.config.primary_provider = "simulation";
    else vi.stubEnv("EMAIL_SIMULATED", "true");
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: true, provider: "simulation", status: "simulated" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it("re-reads the switch and sends only after it is enabled", async () => {
    mocks.config.enabled = 0;
    const { sendEmail, emailCircuitStatus } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, status: "failed", error: "Email engine is disabled" });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    mocks.config.enabled = 1;
    expect(await sendEmail(message)).toMatchObject({ ok: true, provider: "smtp", status: "sent" });
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    expect(emailCircuitStatus()).toMatchObject({ consecutiveFailures: 0, tripped: false });
    expectLogsSafe();
  });

  it("dispatches to an enabled secondary provider after a primary failure", async () => {
    mocks.config.primary_provider = "graph";
    mocks.config.secondary_provider = "smtp";
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const { sendEmail } = await import("./email");
    expect(await sendEmail(ordinaryMessage)).toMatchObject({ ok: true, provider: "smtp", status: "sent" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledOnce();
  });

  it("enforces the switch for resends too", async () => {
    mocks.config.enabled = 0;
    mocks.findMailLog.mockReturnValue({ recipient: ordinaryMessage.to, subject: ordinaryMessage.subject, payload: ordinaryMessage.text });
    const { resendMailLog } = await import("./email");
    expect(await resendMailLog("original-id")).toMatchObject({ ok: false, provider: "none", status: "failed", error: "Email engine is disabled" });
    expect(mocks.findMailLog).toHaveBeenCalledWith("original-id");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it("cannot resend the content-free log of a disabled email", async () => {
    mocks.findMailLog.mockReturnValue({ recipient: ordinaryMessage.to, subject: "[Disabled email: content not retained]", payload: null });
    const { resendMailLog } = await import("./email");
    await expect(resendMailLog("disabled-id")).rejects.toThrow(/Disabled emails cannot be resent/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
});

describe("email attachment delivery", () => {
  it("sends exact Graph fileAttachment base64, without logging content, names, or body", async () => {
    mocks.config.primary_provider = "graph";
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: true });
    const { sendEmail } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: true, provider: "graph", status: "sent" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [url, options] = mocks.fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://graph.microsoft.com/v1.0/users/sender%40example.test/sendMail");
    const body = JSON.parse(options.body as string);
    expect(body.message.attachments).toEqual([{ "@odata.type": "#microsoft.graph.fileAttachment", name: "report.pdf", contentType: "application/pdf", contentBytes: bytes.toString("base64") }]);
    expect(body.message.bccRecipients).toEqual([]);
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ status: "sent", payload: null, correlation_id: "request-123" }));
    expectLogsSafe();
  });

  it("passes the original Buffer to SMTP and forces STARTTLS", async () => {
    const { sendEmail } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: true, provider: "smtp", status: "sent" });
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true }));
    const sent = mocks.sendMail.mock.calls[0][0];
    expect(sent.attachments).toEqual([attachment]);
    expect(sent.attachments[0].content).toBe(bytes);
    expect(sent.bcc).toBeUndefined();
    expectLogsSafe();
  });

  it("uses implicit TLS without requiring a STARTTLS upgrade", async () => {
    mocks.config.smtp_secure = 1;
    mocks.config.smtp_port = 465;
    const { sendEmail } = await import("./email");
    expect((await sendEmail(message)).status).toBe("sent");
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, requireTLS: false, disableFileAccess: true, disableUrlAccess: true }));
  });

  it("does not report delivery if the SMTP server cannot upgrade to TLS", async () => {
    mocks.sendMail.mockRejectedValue(new Error("STARTTLS not supported"));
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, provider: "smtp", status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown" }));
    expectLogsSafe();
  });

  it.each(["database", "environment", "both"])("fails closed before dispatch when %s BCC is configured", async source => {
    if (source !== "environment") mocks.config.global_bcc = "archive@example.test";
    if (source !== "database") vi.stubEnv("GLOBAL_EMAIL_BCC", "hidden@example.test");
    const { sendEmail } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: false, provider: "none", status: "failed", error: expect.stringMatching(/BCC/) });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it("also rejects configured BCC before simulation", async () => {
    vi.stubEnv("EMAIL_SIMULATED", "true");
    vi.stubEnv("GLOBAL_EMAIL_BCC", "archive@example.test");
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, status: "failed", provider: "none" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it.each(["/etc/passwd", "https://example.test/report.pdf"]) ("rejects path or URL attachment content %s before dispatch", async content => {
    const { sendEmail } = await import("./email");
    const result = await sendEmail({ ...message, attachments: [{ ...attachment, content: content as unknown as Buffer }] });
    expect(result).toMatchObject({ ok: false, status: "failed", provider: "none" });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects path-like filenames instead of accepting a file source", async () => {
    const { sendEmail } = await import("./email");
    expect(await sendEmail({ ...message, attachments: [{ ...attachment, filename: "../report.pdf" }] })).toMatchObject({ ok: false, status: "failed" });
    expect(mocks.createTransport).not.toHaveBeenCalled();
  });

  it("redacts SMTP provider errors even if they include attachment bytes or filenames", async () => {
    mocks.sendMail.mockRejectedValue(new Error(`server response ${secret} ${bytes.toString("base64")} report.pdf`));
    const { sendEmail } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: false, provider: "smtp", status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(result)).not.toContain("report.pdf");
    expectLogsSafe();
  });

  it("does not fail over from Graph to SMTP on an attachment failure", async () => {
    mocks.config.primary_provider = "graph";
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => `${secret} report.pdf` });
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, provider: "graph", status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it("never exposes Graph token response text in errors", async () => {
    mocks.config.primary_provider = "graph";
    mocks.config.secondary_provider = "simulation";
    const responseText = vi.fn(async () => `${secret} report.pdf`);
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 401, text: responseText });
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, provider: "graph", status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(responseText).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it.each(["environment", "provider"])("records %s simulation as simulated, not sent", async source => {
    if (source === "environment") vi.stubEnv("EMAIL_SIMULATED", "true");
    if (source === "provider") mocks.config.primary_provider = "simulation";
    const { sendEmail } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: true, provider: "simulation", status: "simulated" });
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ provider: "simulation", status: "simulated", payload: null }));
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expectLogsSafe();
  });

  it.each(["smtp", "graph"])("does not dispatch the secondary after a %s attachment timeout", async primary => {
    mocks.config.primary_provider = primary;
    mocks.config.secondary_provider = primary === "smtp" ? "graph" : "smtp";
    const timeout = new Error(`Timed out after submission: ${secret} ${bytes.toString("base64")} report.pdf`);
    timeout.name = "TimeoutError";
    if (primary === "smtp") mocks.sendMail.mockRejectedValueOnce(timeout);
    else mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockRejectedValueOnce(timeout);
    const { sendEmail, emailCircuitStatus } = await import("./email");
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: false, provider: primary, status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(result.error).toMatch(/verify.*before retrying/i);
    expect(result.error).toMatch(/no automatic failover/i);
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ provider: primary, status: "unknown", payload: null, error: result.error }));
    expect(emailCircuitStatus()).toMatchObject({ consecutiveFailures: 1, tripped: false });
    if (primary === "smtp") {
      expect(mocks.sendMail).toHaveBeenCalledOnce();
      expect(mocks.fetch).not.toHaveBeenCalled();
    } else {
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(String(mocks.fetch.mock.calls[1][0])).toContain("/sendMail");
      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(mocks.sendMail).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(result)).not.toContain("report.pdf");
    expectLogsSafe();
  });

  it("does not claim simulation or retry after an attachment failure with simulation secondary", async () => {
    mocks.config.secondary_provider = "simulation";
    mocks.sendMail.mockRejectedValueOnce(new Error(secret));
    const { sendEmail } = await import("./email");
    expect(await sendEmail(message)).toMatchObject({ ok: false, provider: "smtp", status: "unknown", error: expect.stringMatching(/acceptance may be unknown/i) });
    expect(mocks.logMail).toHaveBeenCalledTimes(1);
    expect(mocks.logMail).not.toHaveBeenCalledWith(expect.objectContaining({ status: "simulated" }));
    expectLogsSafe();
  });

  it.each(["smtp", "graph"])("fails closed on an already-open %s circuit without attempting either provider", async primary => {
    mocks.config.primary_provider = primary;
    mocks.config.secondary_provider = primary === "smtp" ? "graph" : "smtp";
    if (primary === "smtp") mocks.sendMail.mockRejectedValue(new Error(secret));
    else mocks.fetch.mockRejectedValue(new Error(secret));
    const { sendEmail, emailCircuitStatus } = await import("./email");
    for (let i = 0; i < 3; i++) {
      expect(await sendEmail(message)).toMatchObject({ ok: false, provider: primary, status: "unknown" });
    }
    expect(emailCircuitStatus()).toMatchObject({ consecutiveFailures: 3, tripped: true });
    vi.clearAllMocks();
    const result = await sendEmail(message);
    expect(result).toMatchObject({ ok: false, provider: "none", status: "failed", error: expect.stringMatching(/not attempted.*circuit is open/i) });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ provider: "none", status: "failed", payload: null, error: result.error }));
    expect(emailCircuitStatus()).toMatchObject({ consecutiveFailures: 3, tripped: true });
    expectLogsSafe();
  });

  it("still bypasses an open circuit for ordinary email", async () => {
    mocks.config.secondary_provider = "graph";
    mocks.sendMail.mockRejectedValue(new Error("primary timeout"));
    mocks.fetch.mockResolvedValue({ ok: false, status: 500 });
    const { sendEmail, emailCircuitStatus } = await import("./email");
    const ordinary = { to: message.to, subject: "Normal", text: "Hello" };
    for (let i = 0; i < 3; i++) expect(await sendEmail(ordinary)).toMatchObject({ ok: false, status: "failed" });
    expect(emailCircuitStatus().tripped).toBe(true);
    vi.clearAllMocks();
    mocks.fetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockResolvedValueOnce({ ok: true });
    expect(await sendEmail(ordinary)).toMatchObject({ ok: true, provider: "graph", status: "sent" });
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("allows ordinary failover when the attachment array is empty", async () => {
    mocks.config.secondary_provider = "graph";
    mocks.sendMail.mockRejectedValueOnce(new Error("primary timeout"));
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockResolvedValueOnce({ ok: true });
    const { sendEmail } = await import("./email");
    expect(await sendEmail({ to: message.to, subject: "Normal", text: "Hello", attachments: [] })).toMatchObject({ ok: true, provider: "graph", status: "sent" });
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expectLogsSafe();
  });

  it("preserves ordinary SMTP behavior and global BCC without attachments", async () => {
    mocks.config.global_bcc = "db@example.test";
    vi.stubEnv("GLOBAL_EMAIL_BCC", "env@example.test");
    const { sendEmail } = await import("./email");
    expect(await sendEmail({ to: "user@example.test", subject: "Normal", text: "Hello" })).toMatchObject({ ok: true, status: "sent" });
    expect(mocks.createTransport.mock.calls[0][0]).not.toHaveProperty("requireTLS");
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ bcc: "db@example.test, env@example.test", text: "Hello" }));
    expect(mocks.sendMail.mock.calls[0][0]).not.toHaveProperty("attachments");
    expect(mocks.logMail).toHaveBeenCalledWith(expect.objectContaining({ subject: "Normal", payload: "Hello" }));
  });

  it("retains global BCC for normal Graph email", async () => {
    mocks.config.primary_provider = "graph";
    mocks.config.global_bcc = "db@example.test";
    vi.stubEnv("GLOBAL_EMAIL_BCC", "env@example.test");
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) }).mockResolvedValueOnce({ ok: true });
    const { sendEmail } = await import("./email");
    expect(await sendEmail({ to: "user@example.test", subject: "Normal", text: "Hello" })).toMatchObject({ ok: true, provider: "graph", status: "sent" });
    const body = JSON.parse((mocks.fetch.mock.calls[1][1] as RequestInit).body as string);
    expect(body.message.bccRecipients).toEqual([{ emailAddress: { address: "db@example.test" } }, { emailAddress: { address: "env@example.test" } }]);
    expect(body.message).not.toHaveProperty("attachments");
  });

  it("does not resend an attachment message from a content-free mail log", async () => {
    mocks.findMailLog.mockReturnValue({ recipient: message.to, subject: "[Attachment email: content not retained]", payload: null });
    const { resendMailLog } = await import("./email");
    await expect(resendMailLog("mail-log-id")).rejects.toThrow(/cannot be resent/);
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
