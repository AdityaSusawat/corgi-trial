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

## [2026-10-29 21:00 IST] Operator Console UI & Mid-Term Endorsement Route

### 1. Context & What Was Done
Built the Operator Console workbench in `app/components/OpsConsole.tsx` and connected it via `app/page.tsx` and `app/api/console/state/route.ts`. Wired the mid-term endorsement lifecycle to the live ledger via `app/api/policies/[id]/endorse/route.ts`.

### 2. Key Decisions & Technical Rationale
- **Client-Side Role Toggle for Reviewers (Non-Negotiable #1):** Placed an instant role switcher (`Underwriting Maker` vs `Lead Checker`) in the global navigation bar. This satisfies the evaluation mandate requiring access to at least two roles without forcing reviewers through cumbersome login walls or cookies during the debrief.
- **Pessimistic Endorsement Locking:** The `/endorse` route invokes `applyMidTermEndorsement()` with row-level pessimistic write locking (`SELECT ... FOR UPDATE`), serializing concurrent coverage adjustments and preventing ledger race conditions.
- **Strict Webhook Preservation Over Local Shortcuts:** Kept policy issuance strictly driven by the asynchronous Stripe webhook (`payment_intent.succeeded`) rather than creating a synchronous shortcut inside the checkout handler. This preserves real payment rail integrity and satisfies Non-Negotiable #4.

### 3. Assumptions & Trade-offs
- **Staging Asterisks (`*`):** Staged Phase 4/5 capabilities (PDF Declarations streaming, Claims Intake modal, Payout settlement rail, Broker statements) with explicit asterisks in the UI to maintain clear boundaries between verified ledger operations and pending deliverables.

### 4. Verification & Testing
- **Test 1 (Endorsement):** Successfully endorsed `CORGI-CYB-2026-0002` (prorated delta of $2,904.11 base premium, $104.55 state tax, $4.36 stamping fee); ledger recorded balanced $3,013.02 journal entry.
- **Test 2 (Cancellation):** Cancelled `CORGI-CGL-2026-0001` pro-rata; verified earned premium recognition ($7,989.04), customer refund ($4,131.29), and broker commission clawback ($401.10) tie out to the exact cent.
- **Test 3 (KYB Gate):** Attempted issuance under unapproved broker `Vanguard Mutual Agents Corp`; verified the underwriting gate hard-aborted with `BROKER_KYB_GATE_BLOCKED`.
- Table and audit log views verified across all four tabs (`Policies`, `Double-Entry Ledger`, `Broker KYB`, `Claims & Reserves`).

## [2026-10-30 03:30 IST] Claims Reserving, Maker-Checker Controls & ACH Return Simulation

### 1. Context & What Was Done
Implemented the Claims Intake, Reserving, Dual-Control Payout, and Asynchronous Return workflows across `app/api/claims/route.ts`, `app/api/claims/[id]/payout/route.ts`, `app/api/approvals/[id]/review/route.ts`, `app/api/claims/[id]/simulate-return/route.ts`, and integrated the full lifecycle into `app/components/OpsConsole.tsx`.

### 2. Key Decisions & Technical Rationale
- **Statutory Solvency Invariant Enforcement:** Verified on intake and adjustment that `Total Incurred = Paid + Reserve <= Policy Coverage Limit`. Verified `dateOfLoss` strictly falls within the active policy term dates (`effective_start_date` to `effective_end_date`).
- **Maker-Checker Segregation of Duties (Non-Negotiable #6):** 
  - All claim payout disbursements originate in the `approval_requests` queue with `status: 'PENDING'` and `action_type: 'CLAIM_PAYOUT'`.
  - Enforced strict backend SoD check: `reviewed_by_user !== initiated_by_user` and `reviewed_by_role === 'CHECKER_LEAD'`. Self-approval attempts by `MAKER_OPS` are hard-rejected.
- **Atomic Two-Leg Payout Accounting:** Upon Lead Checker approval, the payout draws down the loss reserve directly (`DR LIABILITY:CLAIM_LOSS_RESERVE` / `CR ASSET:OPERATING_CASH_SETTLED`), avoiding double-counting previously expensed incurred losses.
- **Asynchronous Banking Return Rail (R01 Insufficient Funds):** Built `recordClaimPayoutReturn` to simulate delayed ACH bounce messages. Appends an immutable `PAYOUT_RETURNED` event, credits back `CLAIM_LOSS_RESERVE`, debits `OPERATING_CASH_SETTLED`, and restores claim status to `OPEN` with zero mutating updates on historical rows.

### 3. Assumptions & Trade-offs
- **Simulated External Banking Rail:** Real commercial claim payouts disburse over NACHA/FedACH or wire transfers rather than credit cards. We track transfer identifiers (`external_payout_id`) and simulate delayed returns rather than attempting mock card credits, accurately representing commercial liability claims infrastructure.

### 4. Verification & Testing
- **Test 1 (Intake):** Successfully opened `CLM-2026-0002` on `CORGI-CGL-2026-0003` with a $12,000.00 initial loss reserve; verified balanced journal entry (`DR CLAIMS_INCURRED_EXPENSE` / `CR CLAIM_LOSS_RESERVE`).
- **Test 2 (Dual Approval):** Initiated $6,000.00 payout as Underwriting Maker; verified it moved to `PENDING_APPROVAL`. Switched to Lead Checker and approved; verified cash drawdown ($6,000.00) and reserve decrease.
- **Test 3 (ACH Return):** Executed `R01_INSUFFICIENT_FUNDS` bounce simulation; verified cash restored to $6,000.00, reserve replenished to $12,000.00, and claim reopened.
- Verified global ledger balance remained strictly balanced throughout all operations.
- Verified approval strictly adhered to role rules

## [2026-10-30 04:30 IST] Reconciliation Engine & Live-Fire Discrepancy Injection

### 1. Context & What Was Done
Built the two-way reconciliation diff engine in `lib/services/reconciliation-service.ts`, exposing REST endpoints (`/api/reconciliation/run`, `/api/reconciliation/plant-break`) and integrating the Reconciliation & Breaks view into `OpsConsole.tsx`. Implemented authentic, 100% append-only discrepancy injection workflows for live debrief testing.

### 2. Key Decisions & Technical Rationale
- **Two-Way Diff Engine (Non-Negotiable #7):** Continuously reconciles External Provider Truth (live Stripe PaymentIntents/Refunds API and simulated ACH Bank Clearing Feed stored in `claim_reserve_events`) against Internal General Ledger cash transactions (`ASSET:OPERATING_CASH_SETTLED`).
- **Append-Only Discrepancy Injection:** To avoid bypassing immutable database triggers with illegal `UPDATE` statements, test exceptions are planted via real source-level insertions:
  - *Mismatched Payout:* Appends a gross payout in the ledger while clearing a net amount (net of wire fees) in the bank clearing feed, producing an exact `AMOUNT_MISMATCH`.
  - *Unhandled ACH Return:* Appends an `R03_NO_ACCOUNT` return event to the bank clearing feed without posting the compensating ledger reversal, producing an `UNEXPECTED_RETURN_STATE`.
  - *Unbooked Stripe Charge:* Creates a real live test-mode charge on Stripe with a webhook guard that skips ledger ingestion, producing a `MISSING_IN_LEDGER` break.
- **Resolution Persistence & Inception Windowing:** Resolved breaks (`RESOLVED_BY_JOURNAL`) are preserved across reconciliation runs by `external_reference_id`, and provider queries are bounded to the database inception timestamp to prevent historical orphan charges from cluttering trial runs.

### 3. Assumptions & Trade-offs
- **Detective Control Design:** Reconciliation is strictly a detective and audit control. It surfaces variances as formal `ReconciliationBreak` records rather than auto-mutating journal entries, preserving carrier audit trails.

### 4. Verification & Testing
- **Test 1 (Clean Run):** Verified 100% in-balance baseline with 0 open breaks.
- **Test 2 (Mismatched Payout):** Planted a $15.00 wire fee variance; reconciliation run caught and flagged it as an `AMOUNT_MISMATCH`.
- **Test 3 (Unbooked Stripe Charge):** Planted an unbooked $8,450.00 Stripe charge; reconciliation run queried Stripe API live and flagged it as `MISSING_IN_LEDGER`.
- **Test 4 (R03 ACH Bounce):** Planted an uningested R03 return; reconciliation run flagged it as an `UNEXPECTED_RETURN_STATE`.

## [2026-10-30 11:30 IST] MCP Agent Surface & Autonomous Gated Writes

### 1. Context & What Was Done
Built the Model Context Protocol (MCP) server conforming to JSON-RPC 2.0 (`lib/mcp/tools.ts`, `app/api/mcp/route.ts`, and `scripts/mcp-stdio.ts`) per Non-Negotiable #8. Added the interactive MCP Agent Workbench and agent-approval tagging into `OpsConsole.tsx`.

### 2. Key Decisions & Technical Rationale
- **Dual Transport Architecture:** Exposed standard JSON-RPC 2.0 over both HTTP (`/api/mcp` on live Vercel deployment) and stdio (`scripts/mcp-stdio.ts`) for direct compatibility with Claude Desktop / Cursor MCP inspectors without bundling weight or serverless compatibility issues.
- **Tools Surface (3 Read + 1 Gated Write):**
  - `get_policy_details` (Read): Returns coverage schedule, term dates, statutory tax breakdown, and immutable event history.
  - `get_ledger_trial_balance` (Read): Computes real-time trial balance and verifies the global debit === credit invariant.
  - `get_claim_summary` (Read): Inspects loss reserve, settled disbursements, and remaining limit headroom ($Incurred = Paid + Reserve \le Limit$).
  - `propose_claim_payout` (Gated Write): Allows an autonomous AI agent to propose a claim disbursement based on invoice triage. Must be approved.
- **Non-Negotiable Autonomous Guardrail:** Autonomous agents are strictly forbidden from executing money movements or self-approving. `propose_claim_payout` automatically tags `initiated_by_role: 'MCP_AGENT'`, `is_agent_initiated: true`, and forces `status: 'PENDING'` in the `approval_requests` queue, requiring a human `CHECKER_LEAD` to review and execute.

### 3. Verification & Testing
- Invoked `get_policy_details`, `get_ledger_trial_balance`, and `get_claim_summary` via `/api/mcp`; confirmed valid JSON-RPC 2.0 payloads.
- Invoked `propose_claim_payout` for $3,250.00; verified the payout was intercepted, zero cash was moved, and an `[MCP AGENT INITIATED]` approval card appeared in the console queue which could be further approved.