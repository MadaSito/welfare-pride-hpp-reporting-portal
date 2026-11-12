import type Database from "better-sqlite3";

// One account-wide bucket covers both enrollment and login challenges, including
// recovery codes. Eight failures are allowed in a fixed 15-minute window.
export const MFA_MAX_FAILURES = 8;
export const MFA_WINDOW_MS = 15 * 60 * 1000;

export function migrateMfaLimiter(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mfa_attempt_limits (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    failures INTEGER NOT NULL CHECK (failures > 0),
    expires_at INTEGER NOT NULL
  )`);
}

export type MfaVerification<T> =
  | { status: "invalid"; error: "AUTHENTICATION_REQUIRED" | "MFA_NOT_CONFIGURED" | "MFA_STAGE_INVALID" }
  | { status: "failure" }
  | { status: "success"; value: T };

/**
 * Check the bucket and perform verification in the same IMMEDIATE transaction.
 * In particular, callback must be synchronous: no credential can be inspected
 * before admission, and recovery-code consumption and enrollment updates must
 * commit with the counter. Concurrent processes therefore cannot overshoot it.
 */
export function attemptMfa<T>(
  db: Database.Database,
  accountId: string,
  verify: () => MfaVerification<T>,
  now?: number,
): MfaVerification<T> | { status: "blocked" } {
  const transaction = db.transaction(() => {
    const at = now ?? Date.now();
    const bucket = db.prepare("SELECT failures, expires_at FROM mfa_attempt_limits WHERE user_id = ?").get(accountId) as
      | { failures: number; expires_at: number }
      | undefined;
    if (bucket && bucket.expires_at > at && bucket.failures >= MFA_MAX_FAILURES) return { status: "blocked" as const };

    const result = verify();
    if (result.status === "failure") {
      if (!bucket || bucket.expires_at <= at) {
        db.prepare(`INSERT INTO mfa_attempt_limits(user_id, failures, expires_at) VALUES (?, 1, ?)
          ON CONFLICT(user_id) DO UPDATE SET failures = 1, expires_at = excluded.expires_at`).run(accountId, at + MFA_WINDOW_MS);
      } else {
        db.prepare("UPDATE mfa_attempt_limits SET failures = failures + 1 WHERE user_id = ?").run(accountId);
      }
    } else if (result.status === "success") {
      db.prepare("DELETE FROM mfa_attempt_limits WHERE user_id = ?").run(accountId);
    }
    return result;
  });
  return transaction.immediate();
}
