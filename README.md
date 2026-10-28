# Corgi Insurance — Policy Administration Platform

A production-grade, US commercial lines policy administration system built for the **Corgi Insurance Work Trial (Track 1: Policy Administration)**.

Engineered with strict adherence to domain financial invariants: double-entry append-only accounting, zero-`UPDATE`/`DELETE` triggers on financial tables, integer-cent arithmetic, and bi-temporal policy state reconstruction.

---

## Architecture & Tech Stack

- **Framework:** [Next.js](https://nextjs.org/) (App Router, Server Components & Dynamic Route Handlers)
- **Language:** TypeScript (strict mode, ES2022 target)
- **Database:** PostgreSQL via [Neon](https://neon.tech/) Serverless (with custom UTC session & driver BigInt parsers)
- **ORM / Data Layer:** [TypeORM](https://typeorm.io/) with custom database immutability triggers
- **Styling:** [Tailwind CSS](https://tailwindcss.com/)
- **External Integrations:** Stripe (payments, identity, cancellations), Plaid (bank account verification)

---

## Core Financial & Domain Principles

1. **Strict Immutability:** No `UPDATE` or `DELETE` statements on financial or policy event records. Database-level PostgreSQL triggers (`prevent_financial_mutation`) actively reject mutation attempts. Corrections are recorded as compensating reversals and re-books.
2. **Deterministic Integer Math:** All monetary figures are stored and processed in integer USD cents (`BIGINT`). Pro-rata allocations use Banker's Rounding (Round-Half-to-Even) via exact integer remainder math, with sub-cent rounding residuals tracked explicitly.
3. **Leap-Year-Aware Daily Proration:** Policy anniversary terms calculate exact elapsed calendar days (365 vs. 366 days over leap days) without hardcoded denominators.
4. **State Tax & Statutory Fee Separation:** Data-driven, effective-dated tax and fee schedules (e.g., California SLA rate adjustments, NY, TX) calculate alongside premiums but never pollute earned premium math or broker commission.
5. **Idempotency & Replay Safety:** Webhook ingestion layers verify cryptographic signatures and enforce strict `provider_event_id` uniqueness.

---