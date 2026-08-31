import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["platform_admin", "tenant_admin", "analyst", "customer"]);
export const accountStatus = pgEnum("account_status", ["invited", "active", "disabled", "locked"]);
export const uploadStatus = pgEnum("upload_status", ["staged", "validated", "rejected", "processed"]);
export const reportStatus = pgEnum("report_status", ["draft", "published", "archived"]);
export const auditSeverity = pgEnum("audit_severity", ["info", "warning", "critical"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 48 }).notNull().unique(),
  status: varchar("status", { length: 24 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
  email: varchar("email", { length: 320 }).notNull(),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  passwordHash: text("password_hash"),
  role: userRole("role").notNull().default("customer"),
  status: accountStatus("status").notNull().default("invited"),
  authProvider: varchar("auth_provider", { length: 32 }).notNull().default("local"),
  mfaSecretEncrypted: text("mfa_secret_encrypted"),
  mfaRequired: boolean("mfa_required").notNull().default(true),
  backupCodesHash: jsonb("backup_codes_hash").$type<string[]>().notNull().default([]),
  failedSignInCount: integer("failed_sign_in_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastSignedInAt: timestamp("last_signed_in_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("users_email_unique").on(table.email), index("users_tenant_idx").on(table.tenantId)]);

export const datasetTemplates = pgTable("dataset_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  schemaMapping: jsonb("schema_mapping").notNull(),
  outcomeCodes: jsonb("outcome_codes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uploads = pgTable("uploads", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "restrict" }),
  templateId: uuid("template_id").references(() => datasetTemplates.id, { onDelete: "restrict" }),
  storageKey: text("storage_key").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  sourceFilename: varchar("source_filename", { length: 255 }).notNull(),
  sourceMonth: integer("source_month").notNull(),
  sourceYear: integer("source_year").notNull(),
  recordCount: integer("record_count").notNull().default(0),
  status: uploadStatus("status").notNull().default("staged"),
  validationResults: jsonb("validation_results").notNull().default({}),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("uploads_hash_unique").on(table.sha256), index("uploads_period_idx").on(table.sourceYear, table.sourceMonth)]);

export const outreachRecords = pgTable("outreach_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  uploadId: uuid("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
  callId: varchar("call_id", { length: 100 }).notNull(),
  memberId: varchar("member_id", { length: 100 }),
  renewalDate: timestamp("renewal_date", { withTimezone: true }),
  reachable: boolean("reachable"),
  callStatusCode: varchar("call_status_code", { length: 24 }),
  attemptOneCode: integer("attempt_one_code"),
  attemptTwoCode: integer("attempt_two_code"),
  attemptThreeCode: integer("attempt_three_code"),
  rawFields: jsonb("raw_fields").notNull().default({}),
}, table => [index("outreach_records_upload_idx").on(table.uploadId), index("outreach_records_status_idx").on(table.callStatusCode)]);

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: varchar("title", { length: 180 }).notNull(),
  description: text("description"),
  templateId: uuid("template_id").references(() => datasetTemplates.id, { onDelete: "restrict" }),
  layoutConfig: jsonb("layout_config").notNull().default({}),
  status: reportStatus("status").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reportPublications = pgTable("report_publications", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").notNull().references(() => reports.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  authorizedPeriods: jsonb("authorized_periods").notNull().default([]),
  publishedBy: uuid("published_by").references(() => users.id, { onDelete: "restrict" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("report_publication_unique").on(table.reportId, table.tenantId)]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  requestId: varchar("request_id", { length: 64 }).notNull(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
  action: varchar("action", { length: 96 }).notNull(),
  severity: auditSeverity("severity").notNull().default("info"),
  resourceType: varchar("resource_type", { length: 64 }).notNull(),
  resourceId: varchar("resource_id", { length: 128 }),
  ipHash: varchar("ip_hash", { length: 96 }).notNull(),
  userAgent: varchar("user_agent", { length: 512 }),
  method: varchar("method", { length: 12 }).notNull(),
  statusCode: integer("status_code").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  metadata: jsonb("metadata").notNull().default({}),
}, table => [index("audit_occurred_idx").on(table.occurredAt), index("audit_actor_idx").on(table.actorId), index("audit_action_idx").on(table.action)]);
