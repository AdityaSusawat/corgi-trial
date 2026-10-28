# Corgi Work Trial: Track 1 (Policy Administration) Context & Guardrails

## Core Objective
A production-grade, deployed US commercial insurance policy administration platform running on Next.js (App Router), TypeScript, TypeORM, and Neon PostgreSQL.

## The Inviolable Financial Rules (Automatic Fails if Broken)
1. **Zero UPDATE or DELETE on Financial Tables:** Never execute `UPDATE` or `DELETE` on ledger or money-movement records. Corrections MUST be append-only reversal journal entries plus a re-book.
2. **Never Use Floats for Money:** All currencies are USD in integer cents (`BIGINT` in Postgres / `number` cents in TypeScript). Pro-rata rounding uses Banker's Rounding (half-to-even) with the carrier absorbing the penny.
3. **Idempotent Webhooks:** All webhook consumers must verify HMAC signatures and enforce `event_id` uniqueness before state transitions. Twice is one.
4. **State Taxes & Statutory Fees are Separate:** Taxes and surplus stamping fees ride the customer payment but NEVER pollute core premium figures or earned-premium math.
5. **Maker-Checker Security:** The initiator of a claim payout or high-value refund can never approve their own transaction.

## Primary Entities
- `LedgerTransaction` (Event header: idempotency key, effective date, audit trail)
- `LedgerEntry` (Double-entry line: account name, DEBIT/CREDIT direction, integer cents)
- `Policy` (Coverage limits, status, state tax/fee breakdown, effective term)
- `Endorsement` (Mid-term pro-rata amendments, effective date, reversal link)
- `Claim` (Incurred = Paid + Reserve <= Limit, maker-checker approval queue)