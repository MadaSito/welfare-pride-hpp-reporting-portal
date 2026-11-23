# Monthly reporting fields — 2026-11-23

The latest user instruction supersedes the earlier prepopulation proposal: do not import the supplied accounts or monthly figures. Make the seven named metric fields available for manual monthly reporting. No account roster, historical account-date mutation, seed script, scheduled account creation, or supplied organizational metrics are included in this change. Current GitHub code is SQLite-based; the older attached PostgreSQL/Redis deployment remains unchanged.

## Primary monthly fields

1. **Number of staff making the calls** — `staff_members`.
2. **Total Number of Calls** — `total_calls`, independently entered rather than calculated from completed rounds.
3. **Total number of members REACHED** — `members_reached`.
4. **Number of Referrals** — `referrals`, independently entered rather than calculated from JHPP/WR destination counts.
5. **1st Round Completed Calls** — `calls_round1`.
6. **2nd Round Completed Calls** — `calls_round2`.
7. **3rd Round Completed Calls** — `calls_round3`.

Each period is keyed by tenant, reporting year and reporting month. The existing fresh-installation bootstrap supplies a Welfare Pride tenant; this field enhancement does not create that tenant or seed any months. Fields remain tenant-scoped rather than hard-coded to a single organization. New form values default to zero, and a present blank CSV count becomes zero. Counts must be nonnegative safe integers; decimal, negative, invalid-text and unsafe numeric values are rejected. Explicit zero totals are never replaced with derived values.

Existing ACA, household and JHPP/WR destination fields remain supplemental data rather than being deleted. Destination percentages are percentages of the destination subtotal, not a claim that an independently entered referral total has a known destination split. Repeated call-round counts and reached counts are independently captured; no unsupported cross-field reconciliation or unique-member deduplication is performed.

## Storage compatibility and reporting

Additive, idempotent migrations add `total_calls` and `referrals` as nullable columns and `members_reached` with zero default. Null independent totals identify legacy rows, allowing their existing rounds/destination-derived totals to remain readable without rewriting historical data. Current forms submit explicit numeric totals, including zero. Older API clients that omit the newly added fields preserve already saved independent counts. Compatibility fallback is not a seed/import of the supplied figures.

Metric detail/list APIs, tenant dashboard summaries/trends, manual entry, CSV exchange, executive report preview and PDF reporting use the independent counts. The API accepts the seven primary fields without requiring supplemental legacy inputs. Audit records include saved field states. Existing view-only write restrictions, tenant ownership derived from authenticated sessions, and CSRF protection are retained; request bodies cannot choose another tenant for a write.

The CSV API exports the seven canonical labels with year/month and supplemental fields. Imports support those labels, snake_case keys and older legacy labels. This maintains the generic existing import capability; no import is automatically executed by installation/startup, and the user's supplied data is not used in fixtures.

## Deployment/security boundary

Only source, non-sensitive documentation and generic disposable test fixtures are published. Supplied personal email addresses and organizational monthly values are deliberately excluded from public repository records. No actual account, monthly record or report is created outside isolated regression-test databases. This task does not deploy onto or modify the existing attached server.

The application remains subject to the unresolved production-security assessment. Availability of these reporting fields is not approval to store sensitive information, a security certification, proof of accessibility compliance, or proof of a completed VPS deployment. Validation results are recorded after integration below.

## Validation results

The complete integrated suite passed **201 tests across 17 files**. The new backend checks cover saving only the seven primary fields, independent total/reached/referral values in API/detail/dashboard/audit, explicit-zero preservation, old-client omission compatibility, negative/fractional/text/unsafe-count refusal, tenant and CSRF isolation, view-only write refusal, canonical CSV round-trip and blank-to-zero handling, and idempotent legacy-schema migration without changing existing IDs/counts/notes/dates or creating accounts/reports.

Seven isolated Chromium UI tests verify the entry labels and payload, independent versus round-derived counts, explicit zeros, legacy null fallback, count validation, load-failure write prevention, filtered dashboard figures and chart/table consistency, view-only controls, and 320-pixel overflow. Six report-specific tests use generic account-free fixtures for independent aggregation, explicit zeros, legacy compatibility, no-data output, HTML preview and PDF text. Existing report authorization, email and audit-isolation suites also passed. Temporary databases, browser profiles, Vite caches and test PDFs are isolated and cleaned up; no real organizational data was used.

TypeScript checking passed during each component integration and is repeated with the final production build. Existing IPv6 rate-limit and frontend chunk-size warnings remain relevant to the broader production assessment. The attached deployment was not updated; these are source-code and isolated regression-test results, not proof of live VPS operation.

The final TypeScript check, Vite/esbuild production build, branding-asset copy and Git whitespace check all passed after integration. Source is ready for the new-version checkout/build workflow; the fresh-server installer must not be rerun over an existing installation.
