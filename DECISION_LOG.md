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