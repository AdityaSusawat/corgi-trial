# Commercial Insurance Policy Administration & Double-Entry Ledger Core

A production-grade, US commercial lines policy administration and general ledger platform built from first principles for American commercial insurance underwriting.

The system enforces strict financial and legal invariants: immutable double-entry bookkeeping, database-level mutation blocks on financial records, integer-cent arithmetic, bi-temporal contract reconstruction, dual-control Maker-Checker risk gates, two-way reconciliation, as-of reconstruction and an autonomous Model Context Protocol (MCP) agent surface. 

- Live Application: https://corgi-trial-eta.vercel.app

---

## Demo Credentials & Roles

The system enforces statutory Segregation of Duties (SoD). Switch roles directly using the top navigation switcher on the deployed dashboard:

- Underwriting Maker (Role: MAKER_OPS)
  - User: maker@corgi.insure
  - Permissions: Issue quotes, bind policies via live Stripe card checkout, draft mid-term endorsements, execute cancellations, file claims, and initiate claim payouts.
  - Restrictions: Cannot approve high-value claim disbursements (> $5,000) or self-approve pending requests.

- Lead Checker (Role: CHECKER_LEAD)
  - User: checker@corgi.insure
  - Permissions: Review pending dual-control queues, inspect immutable audit trails, approve/reject high-value claim payouts, approve agent-initiated proposals, and resolve reconciliation breaks.
  - Restrictions: Cannot self-approve requests they initiated as a Maker.

---

## US Insurance & Financial Domain Architecture

This platform was designed specifically around the operational realities of US commercial surplus lines insurance:

### 1. Custom Append-Only Double-Entry General Ledger
Every monetary movement in the system generates a balanced journal transaction where total debits equal total credits to the exact integer cent.
- Chart of Accounts: Operating Cash Settled (Asset), Unearned Premium Reserve (Liability), State Tax Payable (Liability), Statutory Stamping Fee Payable (Liability), Broker Commission Payable (Liability), Claims Loss Reserve (Liability), Claims Incurred Expense (Expense), and Broker Commission Expense (Expense).
- Database Invariant Triggers: PostgreSQL triggers (`prevent_financial_mutation`) abort any SQL `UPDATE` or `DELETE` executed against `ledger_transactions`, `ledger_entries`, `policy_events`, or `claim_reserve_events`.
- Zero Floating Point Math: All balances, transactions, and proration calculations operate on signed 64-bit integers (`BIGINT` in PostgreSQL, handled via integer cents). Sub-cent rounding residuals are tracked deterministically using Banker's Rounding (Round-Half-to-Even).

### 2. State Surplus Lines Tax & Statutory Fee Separation
State premium taxes (e.g., California 3.0% surplus lines tax + 0.2% SLA stamping fee) and flat carrier policy fees are calculated alongside gross billings but kept strictly isolated from base written premium.
- Daily pro-rata earned premium recognition and unearned premium liability reserves run strictly on pure base premium.
- Taxes and statutory fees never pollute broker sales commission calculations or earned premium liability reserves.

### 3. Cash-Basis Broker Commission Accounting & Clawbacks
Commercial lines policies are sold through independent brokerages.
- Commission is accrued strictly on collected base premium when funds clear, rather than on written quotes. This eliminates carrier credit risk on bounced binders.
- When a policy is cancelled mid-term and unearned premium is returned to the insured, the system automatically claws back unearned broker commission pro-rata.
- Monthly Broker Commission Statements tie out 1:1 against the general ledger (`LIABILITY:BROKER_COMMISSION_PAYABLE`). Once a billing period closes (`is_closed = true`), re-running that month serves the exact locked snapshot forever; subsequent backdated changes roll forward into open accounting periods.

### 4. Leap-Year-Aware Daily Pro-Rata Math Engine
Policy anniversary terms compute the exact calendar duration between UTC midnight bounds (365 days vs 366 days over leap years).
- Mid-term endorsements calculate coverage charges strictly on the remaining term days from `effective_date`, rather than the date operations entered the record (`recorded_at`).
- Point-in-time As-Of evaluation allows reconstructing policy limits, deductibles, active vehicle schedules, and earned vs unearned balances as they stood on any calendar date.

### 5. The Correction Test (Append-Only Compensating Reversals)
If a backdated endorsement is entered with an incorrect effective date or figure, no rows are modified.
- The engine appends an `ENDORSEMENT_REVERSAL` event linked to the erroneous record, accompanied by a compensating ledger transaction that mirrors and inverts every debit and credit.
- Immediately following, it appends an `ENDORSEMENT_REBOOK` event at the verified effective date with freshly prorated math.

### 6. Claims Solvency & Delayed ACH Return Rail
- Solvency Invariant: The system guarantees `Total Incurred = Total Paid + Outstanding Reserve <= Policy Coverage Limit`.
- Maker-Checker Threshold: Any claim disbursement exceeding $5,000 pauses execution and routes to `approval_requests`, requiring a second human controller to authorize.
- Asynchronous Return Rail: Models real banking return tapes (`R01_INSUFFICIENT_FUNDS`, `R03_NO_ACCOUNT`). Bounced disbursements restore the outstanding loss reserve and reverse cash outflows via balancing ledger journals.

### 7. Two-Way Reconciliation Diff Engine
An automated diff engine compares external provider truth (live Stripe PaymentIntents/Refunds API and ACH clearing feeds) against internal ledger cash entries (`ASSET:OPERATING_CASH_SETTLED`).
- Detects variances across `AMOUNT_MISMATCH`, `MISSING_IN_LEDGER`, and `UNEXPECTED_RETURN_STATE`.
- Includes append-only test planters to inject source-level wire fee variances, unbooked charges, and unhandled ACH returns to demonstrate real-time break detection.

### 8. Model Context Protocol (MCP) Agent Surface
Implements an MCP server conforming to the JSON-RPC 2.0 specification, exposing typed tools to autonomous AI agents:
- `get_policy_details` (Read Tool): Inspects active terms, coverage limits, deductibles, and endorsement history.
- `get_ledger_trial_balance` (Read Tool): Queries real-time chart of accounts balances and asserts the debit === credit invariant.
- `get_claim_summary` (Read Tool): Inspects remaining loss reserves, paid totals, and limit solvency headroom.
- `propose_claim_payout` (Gated Write Tool): Autonomous agents proposing disbursements are blocked from moving funds directly. Writes land in `approval_requests` (`is_agent_initiated: true`, `status: PENDING`), requiring human Lead Checker approval.

### 9. Pure TypeScript PDF 1.4 Binary Generator
Built without third-party canvas or headless browser dependencies:
- Compiles native PDF 1.4 byte streams using standard Type1 Helvetica and Courier fonts.
- Streams downloadable Declarations Pages (`/api/documents/dec-page/[id]?asOfDate=YYYY-MM-DD`) with retroactive contract reconstruction.
- Streams locked Monthly Broker Commission Statements (`/api/documents/broker-statement/[id]?month=YYYY-MM`) tied directly to general ledger entries.

---

## Integration Status: Live vs Simulated

| Integration Slot | Status | Provider / Mechanism | Implementation Details |
| :--- | :--- | :--- | :--- |
| Premium Collection | LIVE | Stripe Test Mode API | Real PaymentIntents confirmed via test cards, tracking real Stripe charge identifiers (`ch_...`). |
| Ingress Webhooks | LIVE | Stripe Webhooks | Cryptographic HMAC signature verification (`stripe-signature`) with idempotent deduplication via `webhook_events`. |
| Premium Refunds | LIVE | Stripe Refunds API | Real `stripe.refunds.create` calls triggered upon policy cancellations. |
| Broker KYB Verification | SIMULATED | Middesk / Persona Data Contract | Verified, Pending, and Failed sandbox verification states with live toggle endpoints gating policy binding. |
| Delayed Payout Rails | SIMULATED | ACH Clearing Tape Simulator | Models delayed bank clearing, transit states, and NACHA return codes (`R01`, `R03`). |
| AI Agent Interface | LIVE | MCP JSON-RPC 2.0 Server | Deployed endpoint at `/api/mcp` and local stdio runner for Claude Desktop / Cursor. |
| Document Generation | LIVE | Native PDF 1.4 Engine | Programmatic binary generator streaming dynamically reconstructed PDFs. |

---

## Tech Stack

- Application Framework: Next.js 16 (App Router, Server Route Handlers, Turbopack)
- Language: TypeScript (Strict mode, ES2022)
- Database: PostgreSQL on Neon Serverless
- Data Layer: TypeORM with custom entity listeners and PostgreSQL trigger migrations
- Payment Rails: Stripe API SDK (Node.js)
- Protocols: Model Context Protocol (JSON-RPC 2.0 over HTTP and stdio)
- Styling: Tailwind CSS

---

## Getting Started Locally

### Prerequisites
- Node.js 20+
- pnpm 9+
- A running PostgreSQL database (e.g., Neon)
- Stripe Test Mode API Keys

### Installation

1. Clone the repository:
```bash
git clone [repo_link_here]
cd corgi-trial
```

2. Install dependencies:
```bash
pnpm install
```

3. Configure environment variables:
Create a `.env` file in the root directory:
```env
DATABASE_URL=database_connection_string
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

4. Seed baseline demo data:
```bash
pnpm db:seed
```
This stands up believable brokers (APPROVED, PENDING, FAILED), active policies with realistic California risk profiles, matching double-entry ledger transactions, and an open claim with reserves.

5. Start the development server:
```bash
pnpm dev
```
Open `http://localhost:3000` to access the Operator Console.

---

## Verification & Test Workflows

The test suite exercises the complete lifecycle against live PostgreSQL and Stripe sandboxes:

```bash
# Run end-to-end verification (Issuance -> Collection -> Endorse -> Cancel -> Claim -> Return -> Recon)
pnpm tsx -r dotenv/config scripts/test-local-flow.ts
```

### Production Build Check
```bash
pnpm build
```

---

## Scope & Cut List (Deliberate Tradeoffs)

To prioritize financial immutability, core ledger accounting, and live third-party resilience, the following items were deliberately scoped out:

1. Insured-Facing Self-Service Portal:
   - Scoped Out: Built a unified Staff Console with Maker-Checker dual control instead of an end-customer portal. Customer self-service adds UI volume without exercising core financial invariants.
2. Automated Annual Renewal Pipelines:
   - Scoped Out: Deprioritized in favor of perfecting mid-term endorsements, leap-year boundary handling, and backdated correction reversal/re-book mechanics.
3. Multi-Currency Support:
   - Scoped Out: Hardened exclusively for US commercial lines in USD integer cents with Banker's Rounding.
4. Standalone Public REST API:
   - Scoped Out: Replaced by the Model Context Protocol (MCP) JSON-RPC 2.0 agent interface, providing structured tooling with strict human approval gates.

---

## Audit & Decision Log

A complete, timestamped record of architectural decisions, schema migrations, and domain tradeoffs is maintained in `DECISION_LOG.md`.
