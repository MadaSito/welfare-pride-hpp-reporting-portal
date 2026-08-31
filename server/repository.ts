import { Pool } from "pg";
import type { Role } from "./security";

export type DbUser = { id: string; tenant_id: string | null; email: string; display_name: string; password_hash: string | null; role: Role; status: "invited" | "active" | "disabled" | "locked"; mfa_secret_encrypted: string | null; mfa_required: boolean; locked_until: Date | null; failed_sign_in_count: number };

let pool: Pool | undefined;
export function getPool() {
  if (!process.env.DATABASE_URL) return null;
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 10, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
  return pool;
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
  const client = getPool(); if (!client) return null;
  const result = await client.query<DbUser>(`SELECT id, tenant_id, email, display_name, password_hash, role, status, mfa_secret_encrypted, mfa_required, locked_until, failed_sign_in_count FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<DbUser | null> {
  const client = getPool(); if (!client) return null;
  const result = await client.query<DbUser>(`SELECT id, tenant_id, email, display_name, password_hash, role, status, mfa_secret_encrypted, mfa_required, locked_until, failed_sign_in_count FROM users WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] ?? null;
}

export async function markSignInFailure(userId: string) { const client = getPool(); if (client) await client.query(`UPDATE users SET failed_sign_in_count = failed_sign_in_count + 1, locked_until = CASE WHEN failed_sign_in_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END, updated_at = now() WHERE id = $1`, [userId]); }
export async function markSignInSuccess(userId: string) { const client = getPool(); if (client) await client.query(`UPDATE users SET failed_sign_in_count = 0, locked_until = NULL, last_signed_in_at = now(), updated_at = now() WHERE id = $1`, [userId]); }
export async function setMfaSecret(userId: string, encryptedSecret: string) { const client = getPool(); if (client) await client.query(`UPDATE users SET mfa_secret_encrypted = $2, status = 'active', updated_at = now() WHERE id = $1`, [userId, encryptedSecret]); }
export async function listUsers(tenantId?: string | null) { const client = getPool(); if (!client) return []; const result = await client.query(`SELECT id, tenant_id, email, display_name, role, status, auth_provider, mfa_required, last_signed_in_at, created_at FROM users ${tenantId ? "WHERE tenant_id = $1" : ""} ORDER BY created_at DESC LIMIT 250`, tenantId ? [tenantId] : []); return result.rows; }
export async function createUser(input: { tenantId: string | null; email: string; displayName: string; role: Role; passwordHash: string }) { const client = getPool(); if (!client) throw new Error("DATABASE_UNAVAILABLE"); const result = await client.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, password_hash, status, auth_provider, mfa_required) VALUES ($1,$2,$3,$4,$5,'invited','local',true) RETURNING id`, [input.tenantId, input.email, input.displayName, input.role, input.passwordHash]); return result.rows[0]!.id; }
export async function disableUser(userId: string) { const client = getPool(); if (!client) throw new Error("DATABASE_UNAVAILABLE"); await client.query(`UPDATE users SET status = 'disabled', disabled_at = now(), updated_at = now() WHERE id = $1`, [userId]); }
export async function updatePassword(userId: string, passwordHash: string) { const client = getPool(); if (!client) throw new Error("DATABASE_UNAVAILABLE"); await client.query(`UPDATE users SET password_hash = $2, status = 'active', updated_at = now() WHERE id = $1`, [userId, passwordHash]); }
