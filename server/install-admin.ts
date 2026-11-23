import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// Fresh installation only. No password arguments, environment values, email,
// output capture, or logging. Validation precedes importing/opening SQLite.
async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("PRIVATE_TERMINAL_REQUIRED");
  if (!process.env.DATA_DIR || !path.isAbsolute(process.env.DATA_DIR)) throw new Error("ABSOLUTE_DATA_DIR_REQUIRED");
  if (process.env.SQLITE_PATH && !path.isAbsolute(process.env.SQLITE_PATH)) throw new Error("ABSOLUTE_SQLITE_PATH_REQUIRED");
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--email" || !z.string().trim().email().max(254).safeParse(args[1]).success) throw new Error("INVALID_ARGUMENTS");
  const email = args[1].trim().toLowerCase();
  const { bootstrapFirstAdmin, db, findUserById, insertAuditEvent } = await import("./repository");
  const { hashPassword, hashIp } = await import("./security");
  try {
    const password = "A1!b2@#" + randomBytes(24).toString("base64url");
    const hash = await hashPassword(password);
    // The outer immediate transaction keeps first-user creation, mandatory
    // enrollment, password change, and its audit event indivisible. The existing
    // bootstrap helper uses a nested savepoint and refuses any existing user.
    db.transaction(() => {
      const id = bootstrapFirstAdmin(email, hash);
      db.prepare("UPDATE users SET mfa_required = 1, must_change_password = 1 WHERE id = ?").run(id);
      const user = findUserById(id)!;
      insertAuditEvent({
        requestId: randomUUID(), actorId: null, actorRole: null,
        tenantId: user.tenant_id, action: "installation.admin.created", resourceType: "user",
        resourceId: id, ipHash: hashIp("local-installation"), method: "CLI", statusCode: 201,
        afterState: { role: "super_admin", mfaRequired: true, mustChangePassword: true },
        metadata: { source: "fresh-server-installer", passwordDelivery: "private-terminal-once" },
      });
    }).immediate();
    // Only after the transaction commits; no application/process log receives
    // this password. Operator must keep the SSH session private and unrecorded.
    process.stdout.write(`Initial administrator: ${email}\nTemporary password (shown once): ${password}\nSave this password privately now. Enroll authenticator MFA, save the recovery codes, then change the password before accessing the portal.\n`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  const message = err instanceof Error ? err.message : "";
  const publicMessage = ["PRIVATE_TERMINAL_REQUIRED", "ABSOLUTE_DATA_DIR_REQUIRED", "ABSOLUTE_SQLITE_PATH_REQUIRED", "INVALID_ARGUMENTS"].includes(message)
    ? message : message.includes("database already contains users") ? "EXISTING_USERS_INSTALLATION_REFUSED" : "INSTALLATION_ADMIN_CREATION_FAILED";
  process.stderr.write(`Installation bootstrap failed: ${publicMessage}\n`);
  process.exitCode = 1;
});
