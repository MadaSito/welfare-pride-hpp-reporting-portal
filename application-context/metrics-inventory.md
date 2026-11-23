# Welfare Pride HPP Reporting Portal — Current Metrics and Tracking Inventory

Reviewed: **23 November 2026**. Database snapshot: **11:10:33 UTC**.

This inventory distinguishes **displayed metrics**, **persisted fields and events**, **log-only telemetry**, and **metrics that could be derived but are not currently implemented**. It is based on the attached cloud host's deployed source and running application bundle, matching local schema/ingestion/repository/UI source, and aggregate-only database queries. No passwords, MFA seeds/codes, individual user records, or raw outreach records were retrieved. The running application was not changed.

## 1. Outreach metrics calculated and displayed

The Overview page requests `/api/v1/dashboard/summary` and calculates the following from normalized outreach rows:

- **Outreach record count:** number of stored outreach rows in the query's scope. This is not a distinct-member count or a distinct-Call-ID count.
- **Reachable record count:** rows whose normalized `reachable` value is `true`.
- **Reachability percentage:** reachable rows divided by all outreach rows, multiplied by 100. The headline card displays one decimal place; a missing denominator is shown as a dash. Rows marked No or unknown remain in the denominator.
- **Renewal-action record count:** rows with a code from **1 through 5 inclusive in any of the first, second, or third attempt fields**. A row is counted once even if several attempt fields qualify. This is a code-based proxy, not independently confirmed renewal completion.
- **Call-status outcome distribution:** row counts grouped by normalized Call Status code. The API returns the six largest groups; a null code is displayed as `Unclassified`. The chart is not guaranteed to represent every status category.
- **Monthly reachability percentage:** the same reachability calculation grouped by uploaded source year/month, rounded to a whole percentage.
- **Monthly renewal-action percentage:** qualifying renewal-action rows divided by all rows in that source year/month, rounded to a whole percentage.
- **Data-quality display indicator:** `Validated` if the summary contains any outreach rows, otherwise `Pending`. This is a simple UI indicator, **not a measured completeness, accuracy, or validation-success score**.

**Calculation boundaries:** months come from upload metadata, not a call-event timestamp. The trend query orders ascending and returns at most 24 months, rather than explicitly selecting the latest 24. Platform-admin and analyst summary queries are global; other roles use the upload tenant ID. A customer without any report-publication record receives an empty summary. Although authorized periods are stored on publications, this summary query does not apply them as month/year filters. The frontend label “Reachable members” currently measures rows, not deduplicated members.

## 2. Outreach source fields captured during processing

Each processed row stores:

- Internal outreach-record ID and parent upload ID.
- **Call ID.** Required when processing a row; it is not enforced as a unique key.
- **Member ID**, when supplied.
- **Renewal date**, parsed to a timestamp; missing or unparseable values become null.
- **Reachability**, normalized as Yes → true, No → false, anything else → null.
- **Call Status code**, extracted as the first alphanumeric token of the source status text.
- **First-attempt outcome code**, extracted from the leading numeric code in `1st Attempt Comments`.
- **Second-attempt outcome code**, extracted from `2nd Attempt Comments`.
- **Third-attempt outcome code**, extracted from `3rd Attempt Comments`.
- **Original source field values** in `raw_fields`, including original status/attempt comments and any extra columns present.

The ingestion validator explicitly recognizes **Welfare Pride Staff** and **Member Primary Language** as optional columns. Their values are retained in raw source fields when supplied, but there are **no implemented staff-productivity or language-breakdown metrics**. Numeric attempt codes describe outcomes; they are not a measured number of calls, call duration, or attempt success rate.

## 3. Upload, validation, and processing tracking

For an accepted file, the application persists:

- Upload ID, owning tenant ID, original filename, and storage key.
- SHA-256 content fingerprint, used for whole-file duplicate detection.
- Source reporting month and year.
- Source row count (`record_count`).
- Current upload status: the implemented routes save `validated` and then `processed`.
- Validation result: validity Boolean, row count, missing required headers, recognized headers, warnings, and SHA-256 fingerprint.
- Uploading user ID and creation/upload timestamp.

It also records these operational outcomes:

- **Dataset rejection:** filename, row count, missing headers, and fingerprint as the audited resource ID.
- **Accepted dataset storage:** filename, row count, fingerprint, source month/year, tenant ID, upload ID, actor, and time.
- **Processing success:** number of normalized records produced.
- **Handled processing failure:** upload ID and a failure reason, such as unavailable source or parsing failure.

Rejected files are **not inserted into `uploads`** by the validation route; their supported rejection path is an audit event. Invalid/oversized files, missing period data, duplicate-file responses, and other early-return cases do not all have their own named audit events. Duplicate-file outcomes normally appear as HTTP 409 responses in request logs, not a dedicated duplicate counter. File byte size is shown transiently in the browser but is not persisted as an upload-size metric. Request duration can be logged for an upload/process endpoint; there is no separate ingestion-stage timer or throughput metric.

`staged` and `rejected` are schema-supported upload states, but their presence in the enum is not evidence of implemented state transitions or current records. Template ID fields exist, but the reviewed upload route does not assign them or provide template-usage statistics.

## 4. User, account, and authentication tracking

### Metrics displayed on People & access

- **Active accounts:** returned accounts with status `active`.
- **Pending access:** returned accounts with status `invited`.
- **Disabled accounts:** returned accounts with status `disabled`.

These are calculated in the browser from the user-list API, which returns at most **250 accounts**. They are not guaranteed full-database totals once that limit is reached. “Active accounts” means enabled account state, **not currently online users or daily active users**. The “MFA required” card annotation is not an MFA-adoption percentage.

### Persisted account attributes and counters

- User ID, tenant ID, display name, email, role, account status, and authentication provider.
- MFA-required flag and presence of an encrypted MFA seed. Secret presence is a configuration indicator, not proof that enrollment verification succeeded.
- **Failed sign-in count:** increments on rejected local password-login attempts for a known user. It resets to zero after successful local MFA or Entra sign-in. It is not a lifetime failure counter and excludes unknown-account attempts, malformed requests, MFA failures, and Entra denials.
- **Lock-until timestamp:** set/extended to 15 minutes after the failure threshold is met. This mechanism does not itself change the account's status to `locked`.
- **Last successful sign-in timestamp.**
- Account creation, most recent update, and disable timestamps.

Authentication and lifecycle events capture successful/failed local sign-in, password verification, MFA enrollment requirements/start, MFA verification failures, sign-out, password changes and failed current-password verification, user creation/creation denial, profile/role updates, disablement, MFA reset, user-list access, and controlled initial-admin bootstrap.

Microsoft Entra event handlers are implemented but **configuration-gated**. Do not interpret their existence as evidence that federation is configured or has been used. There is no separate MFA-enrollment-completed event, persistent session inventory, online-user gauge, expiry/automatic-logout event, or measured session duration. Password hashes, encrypted seeds, and reserved backup-code hash fields are security storage, **not reportable usage metrics**.

## 5. Report lifecycle and platform usage tracking

Report records persist:

- Report ID, title, description, and layout configuration.
- Current status and version number; version increases on publication.
- Creating user, creation time, update time, and latest publication time.

Publication records persist:

- Report-to-tenant assignment.
- Authorized reporting periods.
- Publishing user and publication timestamp.

Audits record:

- **Report draft creation**, including the report title and ID.
- **Report publication**, including the report ID, tenant count for that publication request, and authorized periods.
- **Report catalogue access.** This means the list was requested, not that an individual report was opened or read.
- **Dashboard summary access**, with global/tenant query scope.
- **User-list access.**
- **Audit-centre access**, including query filters.
- **Audit CSV export**, including exported record count and query filters.
- **SIEM destination validation/rejection**, including protocol/hostname and port on accepted validation.

Counts or trends of drafts/publications/catalogue requests can be derived from these records, but a dedicated report-usage statistics dashboard is not present. `archived` is a schema-supported report state; no reviewed archive route makes this a currently implemented archive metric. There is no individual report-open/download counter. The report catalogue returns at most 100 published reports.

## 6. Audit dimensions and exact event catalogue

Each database audit event has an event ID, occurrence timestamp, request/correlation ID, actor ID when available, tenant ID when available, action, severity, resource type/ID, salted IP hash, user agent, method, audit status code, optional before/after state, and event-specific metadata. Severity is normally info for codes below 400, warning for 4xx, and critical for 5xx. Bootstrap is explicitly warning severity.

Profile updates capture old/new display name and role. MFA resets capture old/new enrollment-presence Booleans. Disablement records previous/new account status as metadata. Actor role is included in the structured audit stdout projection, but is not stored in the audit table by the current insert helper.

### Local authentication

- `auth.sign_in.failed`
- `auth.mfa_enrollment.required`
- `auth.password.verified`
- `auth.mfa.enrollment.started`
- `auth.mfa.failed`
- `auth.sign_in.succeeded`
- `auth.sign_out`
- `auth.password_change.failed`
- `auth.password_changed`

### Entra authentication — configuration-gated

- `auth.entra.started`
- `auth.entra.start_failed`
- `auth.entra.callback_rejected`
- `auth.entra.denied`
- `auth.entra.succeeded`
- `auth.entra.callback_failed`

Entra denial metadata distinguishes missing MFA assurance from an unauthorized account. Some audit failure codes are 401/403 while the actual HTTP response is a 302 redirect; those are different measurements.

### Account lifecycle

- `bootstrap.admin.created`
- `user.list.viewed`
- `user.creation.denied`
- `user.created`
- `user.disabled`
- `user.updated`
- `user.mfa_reset`

### Dataset operations

- `dataset.rejected`
- `dataset.stored`
- `dataset.processing.failed`
- `dataset.processed`

### Report, dashboard, audit, and integration operations

- `report.created`
- `report.published`
- `report.catalog.viewed`
- `dashboard.summary.viewed`
- `audit.center.viewed`
- `audit.exported`
- `siem.configuration.rejected`
- `siem.configuration.validated`
- `system.request.error`

**Audit access:** the current API/export returns time, action, severity, resource type/ID, status code, and request ID. It supports action-substring, severity, and resource-type filters. The list defaults to 250 and allows at most 500 rows; export is capped at 500. Full stored actor/user-agent/metadata/before-after details are not exposed in this API projection. An event listing/export is not a statistics aggregation endpoint.

**Attribution limitations:** pre-login events normally lack actor and tenant IDs because these are taken from the incoming cookie session rather than the pending challenge. A known affected user is usually represented by resource ID instead. This also affects successful-login audit attribution because the new session is set on the response, not assigned to the current request before auditing. Null-tenant events are not returned by tenant-only audit filtering. The `emailHash` metadata value on failed login is currently the email's length, not an actual hash; it must not be treated as a unique-user identifier.

Middleware session/role denials, CSRF/origin rejections, rate limits, many validation errors, and several early-return failures have **no dedicated named audit event**. They are normally visible only as HTTP response codes in request logs. The global error audit records error class but supplies no actor or tenant. Audit persistence also depends on successful database insertion. Duplicate later route definitions in deployed source do not imply doubled event counts: the first handlers finish the response without continuing.

## 7. Technical telemetry and health signals

Structured stdout logs include timestamp, log level, event name, and redacted detail fields.

- **HTTP request completion** (`http.request.completed`): correlation ID, method, URL path, actual HTTP status, and duration in milliseconds.
- **Unhandled request error** (`http.unhandled_error`): correlation ID, path, and error message.
- **Server startup** (`server.started`): environment and listening port.
- **Server startup failure** (`server.start.failed`): error message.
- **Audit projection** (`audit.event`): action, correlation ID, actor/tenant/resource IDs when available, status, and actor role when available. This stdout record omits the complete database metadata and before/after states.
- **Health endpoint:** status, response timestamp, and a database-pool-configured Boolean. The database Boolean is **not a successful database ping**.
- **Authentication-provider endpoint:** local enabled flag and whether Entra configuration passes the settings check.
- **Container status/health:** Docker exposes running/restart/health state where health checks are configured. The inspected PostgreSQL and Redis containers reported healthy; this is not an application-maintained performance history.

Retained request logs can support request counts, status/error rates, endpoint usage, average latency, and latency percentiles. Those aggregations and a dedicated metrics exporter/time-series dashboard are **not implemented in the reviewed application**. Request logs do not include authenticated actor or tenant dimensions. JSON parsing precedes request logging, so malformed body errors can lack completion/correlation telemetry; aborted requests do not have a separate logged event.

No application-level CPU, memory, disk, network, database query latency/pool utilization, Redis hit/miss, uptime-percentage, certificate-expiry, backup-success, or restore-test metric capture was found. Infrastructure may expose its own diagnostics, but this inventory does not claim that they are centrally collected. SIEM code currently validates destinations; it does not implement forwarding, delivery retries, queue depth, or delivery-success metrics.

## 8. Values actually present on the attached test instance

The aggregate-only snapshot at 11:10:33 UTC showed:

- **Users:** 1.
- **Tenants:** 0.
- **Accepted uploads:** 0.
- **Normalized outreach records:** 0.
- **Reports:** 0.
- **Report publications:** 0.
- **Audit events:** 10.

Recorded event counts were:

- `bootstrap.admin.created`: 1.
- `auth.mfa_enrollment.required`: 1.
- `auth.mfa.enrollment.started`: 1.
- `auth.password.verified`: 1.
- `auth.sign_in.succeeded`: 1.
- `dashboard.summary.viewed`: 1.
- `report.catalog.viewed`: 1.
- `user.list.viewed`: 1.
- `system.request.error`: 2.

These are a point-in-time snapshot of the **attached persistent test instance**, not assumed totals for another preview/deployment. Outreach metrics are implemented but have no source data on this instance yet. The other event types are instrumented handlers, not events proven to have occurred. Requests and account changes after this timestamp may change the counts.

## 9. Not currently implemented as metrics

A dedicated **Admin Statistics page** for application/user utilization is not present. In particular, the application does not currently calculate or display:

- Daily/weekly/monthly active users, unique visitors, retention/cohorts, or adoption rates.
- Currently online users, concurrent active sessions, session duration, page dwell time, or click/navigation journeys.
- Individual report opens/downloads, report popularity, per-user report readership, or general report export usage.
- Dedicated login/MFA success rates or MFA adoption/completion rates.
- Distinct-member reachability, outreach attempts-per-member, verified renewal completion, conversion rate, or renewal aging.
- Staff productivity, language breakdowns, per-attempt outcome distributions, or call duration.
- A numerical data-quality score, field completeness, row-level duplicate rate, or comprehensive validation-pass/rejection-rate dashboard.
- Upload storage-volume/file-size totals, isolated processing-duration/throughput, or queue performance.
- Aggregated technical performance/SLO dashboards, infrastructure-resource time series, or SIEM delivery statistics.

Some measures can be built from the fields/events already retained; others require additional capture. They should not be described as currently tracked headline metrics simply because they are possible to calculate. The constant sample arrays and fixed audit navigation badge in the UI are not telemetry; the current Overview charts use API-provided data instead of those sample arrays.

## Source map

- Deployed `server/index.ts`: metric queries, event call sites, reporting/ingestion routes, health/provider responses, and configuration boundaries.
- Running `/app/dist/index.js`: confirmed matching metric/event instrumentation exists in the deployed bundle.
- `server/ingestion.ts`: required/optional headers, validation fields, raw-field retention, date/status/attempt normalization.
- `server/repository.ts`: account counters, timestamps, account updates, user-list limits.
- `server/audit.ts` and `drizzle/schema.ts` / `db/init.sql`: audit dimensions, stored state, append-only trigger definition.
- `server/logging.ts` and `server/security.ts`: request telemetry, redaction, IP hashing, and uninstrumented middleware rejection boundaries.
- `scripts/bootstrap-admin.mjs`: controlled bootstrap event.
- `client/src/pages/Home.tsx`: live cards/charts, browser-derived account counts, and display-only indicators.
