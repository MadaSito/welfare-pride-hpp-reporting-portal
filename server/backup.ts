import { ZipArchive } from "archiver";
import unzipper from "unzipper";
import Papa from "papaparse";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, listMonthlyMetrics, upsertMonthlyMetric, listAuditEvents, getEmailConfig, updateEmailConfig, getSiemConfig, updateSiemConfig, getEntraConfig, updateEntraConfig, getBrandConfig, updateBrandConfig, listIpRules, addIpRule, registerBackup, listBackups, deleteBackupRecord } from "./repository";
import { writeLog } from "./logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, "portal.db");
const brandingDir = path.resolve(__dirname, "..", "branding");
const backupDir = path.join(dataDir, "backups");
mkdirSync(backupDir, { recursive: true });

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Prevent CSV formula injection in spreadsheet software */
function safeCell(v: unknown): string {
  const s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) return `'"${s}"`;
  return s;
}

// ---------------------------------------------------------------------
// Full snapshot backup (.zip)
// ---------------------------------------------------------------------
export async function createSnapshotBackup(opts?: { encryptPassword?: string; createdBy?: string }): Promise<{ filename: string; size: number; encrypted: boolean; fullPath: string; checksum: string }> {
  const name = `wp-hpp-snapshot-${timestamp()}`;
  const zipPath = path.join(backupDir, `${name}.zip`);

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const archive = new (ZipArchive as any)({ zlib: { level: 9 } });
    out.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(out);
    // Flush WAL so the db file is consistent
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    if (existsSync(dbPath)) archive.file(dbPath, { name: "database/portal.db" });
    if (existsSync(brandingDir)) archive.directory(brandingDir, "branding");
    // Also include JSON config dump inside the zip
    const configDump = JSON.stringify(exportJsonConfig(), null, 2);
    archive.append(configDump, { name: "config.json" });
    archive.finalize();
  });

  let finalPath = zipPath;
  let filename = `${name}.zip`;
  let encrypted = false;

  if (opts?.encryptPassword) {
    const salt = randomBytes(16);
    const key = pbkdf2Sync(opts.encryptPassword, salt, 150000, 32, "sha256");
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const raw = readFileSync(zipPath);
    const enc = Buffer.concat([cipher.update(raw), cipher.final()]);
    const bundle = Buffer.concat([salt, iv, enc]);
    const encPath = path.join(backupDir, `${name}.zip.enc`);
    writeFileSync(encPath, bundle);
    try { rmSync(zipPath); } catch {}
    finalPath = encPath;
    filename = `${name}.zip.enc`;
    encrypted = true;
  }

  const stat = statSync(finalPath);
  const checksum = createHash("sha256").update(readFileSync(finalPath)).digest("hex");
  registerBackup(filename, stat.size, encrypted, checksum, opts?.createdBy ?? null);
  writeLog("info", "backup.created", { filename, size: stat.size, encrypted, checksum });
  return { filename, size: stat.size, encrypted, fullPath: finalPath, checksum };
}

// ---------------------------------------------------------------------
// CSV metrics export / import
// ---------------------------------------------------------------------
export function exportMetricsCsv(year?: number): string {
  const rows = listMonthlyMetrics(year);
  const out = rows.map(r => ({
    "Reporting Year": safeCell(r.reporting_year),
    "Reporting Month": safeCell(r.reporting_month),
    "Calls round 1": safeCell(r.calls_round1),
    "Calls round 2": safeCell(r.calls_round2),
    "Calls round 3": safeCell(r.calls_round3),
    "ACA YES": safeCell(r.aca_yes),
    "ACA No": safeCell(r.aca_no),
    "Head of Household": safeCell(r.head_of_household),
    "Staff members making calls": safeCell(r.staff_members),
    "Calls referred to JHPP": safeCell(r.calls_jhpp),
    "Calls referred to WR": safeCell(r.calls_wr),
    "Notes": safeCell(r.notes || ""),
  }));
  return Papa.unparse(out, { newline: "\n" });
}

export function importMetricsCsv(csvText: string, enteredBy?: string): { imported: number; errors: { row: number; error: string }[] } {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: "greedy" });
  const errors: { row: number; error: string }[] = [];
  let imported = 0;
  parsed.data.forEach((r, i) => {
    const year = Number(r["Reporting Year"] ?? r["reporting_year"]);
    const month = Number(r["Reporting Month"] ?? r["reporting_month"]);
    if (!year || year < 2000 || year > 2100) { errors.push({ row: i + 2, error: "Invalid reporting year" }); return; }
    if (!month || month < 1 || month > 12) { errors.push({ row: i + 2, error: "Invalid reporting month (1-12)" }); return; }
    try {
      upsertMonthlyMetric({
        tenantId: null,
        reporting_year: year,
        reporting_month: month,
        calls_round1: Math.max(0, Number(r["Calls round 1"] ?? r["calls_round1"]) || 0),
        calls_round2: Math.max(0, Number(r["Calls round 2"] ?? r["calls_round2"]) || 0),
        calls_round3: Math.max(0, Number(r["Calls round 3"] ?? r["calls_round3"]) || 0),
        aca_yes: Math.max(0, Number(r["ACA YES"] ?? r["aca_yes"]) || 0),
        aca_no: Math.max(0, Number(r["ACA No"] ?? r["aca_no"]) || 0),
        head_of_household: Math.max(0, Number(r["Head of Household"] ?? r["head_of_household"]) || 0),
        staff_members: Math.max(0, Number(r["Staff members making calls"] ?? r["staff_members"]) || 0),
        calls_jhpp: Math.max(0, Number(r["Calls referred to JHPP"] ?? r["calls_jhpp"]) || 0),
        calls_wr: Math.max(0, Number(r["Calls referred to WR"] ?? r["calls_wr"]) || 0),
        notes: (r["Notes"] ?? r["notes"] ?? "").slice(0, 1000) || null,
        entered_by: enteredBy ?? null,
      });
      imported++;
    } catch (err) {
      errors.push({ row: i + 2, error: String(err) });
    }
  });
  return { imported, errors };
}

// ---------------------------------------------------------------------
// CSV audit logs export
// ---------------------------------------------------------------------
export function exportAuditCsv(limit = 5000): string {
  const { events } = listAuditEvents({ limit });
  const rows = events.map(e => ({
    "Occurred At (UTC)": safeCell(e.occurred_at),
    "Request ID": safeCell(e.request_id),
    "Actor Email": safeCell(e.actor_email || ""),
    "Actor Role": safeCell(e.actor_role || ""),
    "Action": safeCell(e.action),
    "Severity": safeCell(e.severity),
    "Resource Type": safeCell(e.resource_type),
    "Resource ID": safeCell(e.resource_id || ""),
    "Real IP": safeCell(e.real_ip || ""),
    "Geo Country": safeCell(e.geo_country || ""),
    "Method": safeCell(e.method),
    "Status": safeCell(e.status_code),
    "Metadata": safeCell(e.metadata || ""),
  }));
  return Papa.unparse(rows, { newline: "\n" });
}

// ---------------------------------------------------------------------
// JSON configuration portability
// ---------------------------------------------------------------------
export function exportJsonConfig(): object {
  const email = { ...getEmailConfig() };
  email.smtp_pass = email.smtp_pass ? "__configured__" : null;
  email.graph_client_secret = email.graph_client_secret ? "__configured__" : null;
  const entra = { ...getEntraConfig() };
  entra.client_secret = entra.client_secret ? "__configured__" : null;
  const siem = { ...getSiemConfig() };
  siem.webhook_token = siem.webhook_token ? "__configured__" : null;
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    email,
    siem,
    entra,
    branding: getBrandConfig(),
    ipRules: listIpRules(),
  };
}

export function importJsonConfig(data: any): { applied: string[]; warnings: string[] } {
  if (!data || data.version !== 1) throw new Error("Invalid config format: version 1 required");
  const applied: string[] = [];
  const warnings: string[] = [];
  if (data.email) {
    const cur = getEmailConfig();
    const c = { ...data.email };
    if (c.smtp_pass === "__configured__") c.smtp_pass = cur.smtp_pass;
    if (c.graph_client_secret === "__configured__") c.graph_client_secret = cur.graph_client_secret;
    updateEmailConfig(c);
    applied.push("email");
  }
  if (data.siem) {
    const cur = getSiemConfig();
    const c = { ...data.siem };
    if (c.webhook_token === "__configured__") c.webhook_token = cur.webhook_token;
    updateSiemConfig(c);
    applied.push("siem");
  }
  if (data.entra) {
    const cur = getEntraConfig();
    const c = { ...data.entra };
    if (c.client_secret === "__configured__") c.client_secret = cur.client_secret;
    updateEntraConfig(c);
    applied.push("entra");
  }
  if (data.branding) {
    updateBrandConfig(data.branding);
    applied.push("branding");
  }
  if (Array.isArray(data.ipRules)) {
    for (const r of data.ipRules) {
      if (r.type && r.value) addIpRule(r.type, r.value, r.reason || null);
    }
    applied.push("ipRules");
  }
  return { applied, warnings };
}

// ---------------------------------------------------------------------
// Restore snapshot
// ---------------------------------------------------------------------
export async function restoreSnapshot(buffer: Buffer, opts?: { decryptPassword?: string }): Promise<{ ok: boolean; message: string }> {
  let zipBuf = buffer;
  if (opts?.decryptPassword) {
    try {
      const salt = buffer.subarray(0, 16);
      const iv = buffer.subarray(16, 32);
      const enc = buffer.subarray(32);
      const key = pbkdf2Sync(opts.decryptPassword, salt, 150000, 32, "sha256");
      const decipher = createDecipheriv("aes-256-cbc", key, iv);
      zipBuf = Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch (err) {
      return { ok: false, message: `Decryption failed: ${String(err)}` };
    }
  }

  const tmpDir = path.join(backupDir, `restore-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const zip = await unzipper.Open.buffer(zipBuf);
    await zip.extract({ path: tmpDir });
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, message: `Invalid zip archive: ${String(err)}` };
  }

  const newDb = path.join(tmpDir, "database", "portal.db");
  if (!existsSync(newDb)) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, message: "Archive missing required database/portal.db" };
  }

  try {
    // Safety backup of current db
    if (existsSync(dbPath)) writeFileSync(`${dbPath}.pre-restore`, readFileSync(dbPath));
    writeFileSync(dbPath, readFileSync(newDb));
    // Restore branding files if present
    const newBranding = path.join(tmpDir, "branding");
    if (existsSync(newBranding)) {
      mkdirSync(brandingDir, { recursive: true });
      for (const f of readdirSync(newBranding)) {
        writeFileSync(path.join(brandingDir, f), readFileSync(path.join(newBranding, f)));
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
    writeLog("warn", "backup.restore.completed", {});
    return { ok: true, message: "Snapshot restored successfully. A server restart may be needed to reload cached handles." };
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, message: `Restore failed: ${String(err)}` };
  }
}

export function backupFilePath(filename: string): string | null {
  const safe = path.basename(filename);
  const p = path.join(backupDir, safe);
  return existsSync(p) ? p : null;
}

export { listBackups, deleteBackupRecord };
