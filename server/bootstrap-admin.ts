import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// Never put a bootstrap password in arguments, environment variables, files, or logs.
// Require a private interactive terminal before opening the database.
async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Bootstrap requires a private interactive terminal; do not redirect or log its output.");
  if (!process.env.DATA_DIR || !path.isAbsolute(process.env.DATA_DIR)) throw new Error("Set DATA_DIR to the same absolute persistent directory used by the server.");
  if (process.env.SQLITE_PATH && !path.isAbsolute(process.env.SQLITE_PATH)) throw new Error("SQLITE_PATH must be absolute and match the server if set.");
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--email" || !z.string().email().safeParse(args[1]).success) throw new Error("Usage: node --import tsx server/bootstrap-admin.ts --email admin@example.org");
  const { bootstrapFirstAdmin, db } = await import("./repository");
  const { hashPassword } = await import("./security");
  try {
    const password = "A1!b2@#" + randomBytes(24).toString("base64url");
    const hash = await hashPassword(password);
    bootstrapFirstAdmin(args[1].trim(), hash);
    process.stdout.write(`Initial administrator: ${args[1].trim()}\nTemporary password (shown once): ${password}\nEnroll MFA and change this password at first sign-in.\n`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  process.stderr.write(`Bootstrap failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
  process.exitCode = 1;
});
