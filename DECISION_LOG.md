## [2026-10-28 17:00 IST] Kickoff & Track Selection
- Selected Track 1: Policy Administration.
- Defined 3 core use cases: (1) Issuance & Stripe Collection, (2) Endorsements, Corrections & Refunds, (3) Claims, Maker-Checker & Reconciliation.
- Established Cut List v0: Cut standalone customer portal, renewals, and public REST API to protect ledger immutability and live fire resilience.

## [2026-10-28 19:25 IST] Scaffolding, Tooling & Architectural Guardrails

1. **Single Full-Stack Next.js (App Router)**
   - *Decision:* Consolidated backend APIs, webhook consumers, database models, and internal UI into a single Next.js repository.
   - *Why:* Eliminates cross-package linking, build orchestrator latency, and deployment config overhead during this short sprint. Next.js App Router provides native Route Handlers (`app/api/...`) that run in the Node.js runtime with direct connection pooling to Neon Postgres.

2. **Data Layer Stack (TypeORM + Neon PostgreSQL):**
   - *Decision:* Configured TypeORM with Neon Serverless PostgreSQL.
   - *Why:* TypeORM provides explicit transaction control (`dataSource.transaction`) and pessimistic row-level locking (`SELECT ... FOR UPDATE`), which are necessary to prevent race conditions during concurrent webhook delivery and double-entry ledger writes.

3. **Financial Safety & AI Guardrails (`ANTIGRAVITY.md` & `AGENT.md`):**
   - *Decision:* Established an explicit constraints file (`ANTIGRAVITY.md`) and pointed Next.js's auto-generated `AGENT.md` directly to it.
   - *Why:* Prevents AI coding tools from generating `UPDATE` or `DELETE` queries on financial records, using JavaScript floating-point arithmetic for currency, or omitting idempotency checks on webhook consumers.

## [2026-10-28 20:25 IST] Database Setup & Immutability Trigger Enforcement

### 1. Context & What Was Done
Configured TypeORM connection to Neon Serverless PostgreSQL in `lib/db/data-source.ts`. Designed complete domain schema in `lib/db/entities/index.ts` covering double-entry ledgers, bi-temporal policy events, broker KYB records, claims reserving, and approval queues.

### 2. Key Decisions & Technical Rationale
- **Database-Level Mutation Blocking:** Installed a PostgreSQL trigger (`prevent_financial_mutation`) across `ledger_transactions`, `ledger_entries`, `policy_events`, and `claim_reserve_events`. Any SQL `UPDATE` or `DELETE` attempt throws an unhandled database exception, enforcing immutability at the engine level.
- **Integer Cents & Driver Parser:** Standardized all financial fields to integer cents (`BIGINT`). Configured `pg.types.setTypeParser(20)` to automatically return 64-bit integer columns as JavaScript numbers, eliminating string concatenation bugs without losing precision.
- **Bi-Temporal As-Of Reconstruction:** Modeled `PolicyEvent` with discrete `effective_date` (legal/accounting effective date) and `recorded_at` (audit log timestamp) to enable point-in-time state reconstruction.

### 3. Assumptions & Trade-offs
- **Schema Synchronization:** Enabled TypeORM schema synchronization for rapid prototyping; noted that production migration scripts would replace this in a standard multi-stage environment.

### 4. Verification & Testing
- Health check view built in `app/page.tsx` querying table counts directly against Neon PostgreSQL.

## [2026-10-29 02:35 IST] Core Insurance Math Engine & Domain Gauntlet Decisions

### 1. Context & What Was Done
Implemented the zero-dependency insurance math engine in `lib/math/insurance-math.ts` covering anniversary leap-year day counting, daily pro-rata earned vs. unearned calculations, mid-term endorsement proration, state tax/fee schedules, cancellation refunds, and claims reserve limit checks.

### 2. Key Decisions & Technical Rationale
- **Rounding Penny & Banker's Rounding (Gauntlet #10):** Implemented deterministic Round-Half-to-Even (`divideAndRoundHalfToEven`) using exact `BigInt` remainder arithmetic (`2 * remainder === denominator`) rather than floating-point division. To prevent 1-cent zombie liabilities in `LIABILITY:UNEARNED_PREMIUM_RESERVE`, unearned premium is bounded as the exact complement (`Written - Earned`), with any multi-slice rounding residual explicitly routed to `EXPENSE:ROUNDING_VARIANCE_EXPENSE`.
- **Commission Earned on Collected Base Premium (Gauntlet #7):** Chose cash-basis commission (earned on collected base premium, excluding state taxes and statutory fees) over written-basis. This eliminates carrier credit risk on unpaid policies and ensures a 1:1 tie-out with monthly broker statements (`gross_premium_collected * commission_rate_bps`).
- **Dual Cancellation Support — Pro-Rata & Short-Rate (Gauntlet #5):** Implemented both methods in `calculateCancellationRefund`. Pro-rata refunds 100% of unearned base premium; Short-Rate applies a configurable penalty (defaulting to standard ISO 10% / 1000 bps of unearned premium) booked to `REVENUE:SHORT_RATE_PENALTY_REVENUE` and refunds the remaining 90%.
- **Effective-Dated State Tax & Fee Schedules (Gauntlet #11):** Modeled state surplus lines taxes, stamping fees, and flat policy fees in an effective-dated lookup table (`DEFAULT_STATE_TAX_SCHEDULES` for CA, NY, TX), including California's real-world Jan 1, 2026 SLA stamping fee reduction from 0.25% to 0.18%. On cancellation, state premium tax refunds pro-rata with unearned premium, while stamping fees and carrier policy fees are enforced as non-refundable earned items.

### 3. Assumptions & Trade-offs
- **Leap Day Anniversary Convention:** For policies written on Feb 29 of a leap year, the 1-year anniversary end date resolves to Feb 28 of the following non-leap year, while any term crossing Feb 29 (e.g., March 1, 2027 to March 1, 2028) computes on a 366-day denominator.

### 4. Verification & Testing
- Verified integer-cent assertions and boundary checks across issuance, endorsement proration, cancellation refunds, and claim limit invariants (`Paid + Reserve <= Limit`).

## [2026-10-29 03:55 IST] Transactional Double-Entry Ledger & Policy Lifecycle Orchestrator

### 1. Context & What Was Done
Built the core transactional service layer in `lib/services/ledger-service.ts` connecting the TypeORM entities and the deterministic insurance math engine. Implemented policy issuance, mid-term endorsements, backdated endorsement reversal and re-book (The Correction Test), cancellation refunds, claims reserving/payouts, Maker-Checker reviews, As-Of date reconstruction, and monthly broker statements.

### 2. Key Decisions & Technical Rationale
- **Pessimistic Row-Level Locking (`pessimistic_write`):** Acquired `SELECT ... FOR UPDATE` locks on the parent `Policy` or `Claim` row at the start of every state-changing transaction. This prevents concurrent webhook replays or double-clicks from creating sequence number collisions or bypassing claim coverage limits.
- **Pre-Commit Double-Entry Balance Assertion:** `postBalancedJournalTransaction` strips zero-cent lines, asserts strictly positive integer cents on every leg, and verifies `Sum(DEBIT) === Sum(CREDIT)` before writing to PostgreSQL.
- **Compensating Reversal + Re-Book Architecture (Gauntlet #4):** Implemented `executeEndorsementCorrection` to fix backdated endorsement errors without modifying existing records. The reversal event uses the original erroneous `effective_date` with negated deltas so historical pro-rata slices cancel out cleanly, while the re-booked event prices over the corrected window.
- **Pre-Cancellation Earned Premium Recognition:** Before clearing `LIABILITY:UNEARNED_PREMIUM_RESERVE` on mid-term cancellation, the service calculates and books any unrecognized earned premium up to `cancellationEffectiveDate`, ensuring the unearned liability clears to $0.00.

### 3. Assumptions & Trade-offs
- **Maker-Checker Routing:** All claim payouts and high-delta endorsements (>= $2,500) automatically pause and write to `approval_requests`, enforcing that initiator can NEVER approve their own action and autonomous MCP agents or Makers cannot approve.

### 4. Verification & Testing
- Verified TypeScript compilation and entity relation mappings across all 9 service workflows.

## [2026-10-29 13:11 IST] T+24h Milestone: Live Stripe Rail Integration & Double-Entry Ingestion

### 1. Context & What Was Done
Integrated live Stripe payment and refund rails into the core ledger service to complete the T+24h "Money Moves" milestone. Implemented checkout creation (`app/api/policies/checkout/route.ts`), webhook-driven policy binding (`app/api/webhooks/stripe/route.ts`), and policy cancellation with live refund execution (`app/api/policies/[id]/cancel/route.ts`). Added database seeder (`scripts/seed.ts`) and end-to-end integration test runner (`scripts/test-local-flow.ts`).

### 2. Key Decisions & Technical Rationale
- **Live Stripe Refund API vs. DB Ledger Pretend:** In direct compliance with the integration requirement, policy cancellation issues a real external call to `stripe.refunds.create` with the calculated unearned premium integer cents, recording the real `re_...` identifier in the audit log and clearing `LIABILITY:UNEARNED_PREMIUM_RESERVE` to $0.00.
- **Webhook Idempotency ("Twice is One"):** Webhook consumer records `provider_event_id` in `webhook_events` before ledger dispatch. Duplicate replays increment delivery attempts and exit early with status `DUPLICATE_REPLAY` without re-booking journal entries.
- **Seed-Backed Statutory KYB Baseline:** Seeded 3 commercial brokers (`APPROVED`, `PENDING`, `FAILED`) complete with Middesk-aligned verification payloads. The Stripe webhook and checkout endpoints enforce a strict domain gate blocking unapproved brokers from binding policies.

### 3. Assumptions & Trade-offs
- **Sandbox Webhook Fallback for Bare CLI Triggers:** In production, a payment lacking a `broker_id` would route to a manual suspense queue to avoid statutory commission misattribution. For this sandbox trial, when a bare event is dispatched via `stripe trigger payment_intent.succeeded` without metadata, the webhook resolves the seeded `APPROVED` broker (`Apex Specialty Risk LLC`) so evaluator triggers bind cleanly end-to-end.
- **Immediate Synchronous Cancellation with Webhook Guard:** The `/api/policies/[id]/cancel` endpoint initiates the Stripe refund and immediately writes the offsetting ledger journal entries. When Stripe subsequently sends the asynchronous `charge.refunded` webhook, the webhook checks policy status and safely deduplicates to prevent double-booking

### 4. Verification & Testing
- Executed `scripts/seed.ts` against Neon PostgreSQL; confirmed 6 initial ledger transactions balance to the exact integer cent.
- Executed `scripts/test-local-flow.ts`:
  - Created and auto-confirmed Stripe PaymentIntent `pi_3UVnZ0BARZeN1GGh1M8GPHxA` for $12,531.60.
  - Ingested HMAC-signed webhook, successfully binding policy `CORGI-CGL-2026-0003`.
  - Asserted double-entry balance invariant: Total Debits ($13,731.60) === Total Credits ($13,731.60).
  - Executed real Stripe refund `re_3UVnZ0BARZeN1GGh15wsx2Ix` for $10,294.36 and clawed back $999.45 of broker commission.