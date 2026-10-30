import 'reflect-metadata';
import { getDb } from '@/lib/db/data-source';
import {
    Claim,
    ClaimReserveEvent,
    LedgerAccount,
    LedgerEntry,
    LedgerTransaction,
    Policy,
    ReconciliationBreak,
} from '@/lib/db/entities';
import { stripe } from '@/lib/stripe';

export interface ReconciliationSummary {
    runId: string;
    executedAt: string;
    stripeItemsChecked: number;
    payoutRailItemsChecked: number;
    ledgerCashTransactionsChecked: number;
    matchedCount: number;
    breaksDetectedCount: number;
    breaks: ReconciliationBreak[];
}

/**
 * Executes a genuine two-way reconciliation between:
 *  1. External Provider Truth (Live Stripe PaymentIntents + Refunds API, plus ACH Payout Clearing Feed)
 *  2. Internal Ledger Cash Truth (LedgerTransactions affecting ASSET:OPERATING_CASH_SETTLED)
 */
export async function runReconciliationJob(): Promise<ReconciliationSummary> {
    const db = await getDb();
    const txRepo = db.getRepository(LedgerTransaction);
    const breakRepo = db.getRepository(ReconciliationBreak);
    const claimEventRepo = db.getRepository(ClaimReserveEvent);

    const runId = `recon_${Date.now()}`;

    // 0. Clean up any legacy synthetic test breaks and remember which reference IDs were already resolved
    await breakRepo.delete({ is_planted_test_break: true });

    const existingResolvedBreaks = await breakRepo.find({
        where: { status: 'RESOLVED_BY_JOURNAL' },
    });
    const resolvedRefIds = new Set(
        existingResolvedBreaks.map((b) => b.external_reference_id)
    );

    // Clear all currently open breaks so the diff engine computes fresh truth from scratch
    await breakRepo.delete({ status: 'OPEN_BREAK' });

    // 1. Load all LedgerTransactions that touch OPERATING_CASH_SETTLED
    const allTransactions = await txRepo.find({
        relations: { entries: true },
        order: { recorded_at: 'DESC' },
    });

    const ledgerCashByRef = new Map<
        string,
        {
            netCashCents: number;
            txIds: string[];
            categories: string[];
        }
    >();

    let ledgerCashTransactionsChecked = 0;

    for (const tx of allTransactions) {
        const cashEntries = tx.entries.filter(
            (e) => e.account_code === LedgerAccount.OPERATING_CASH_SETTLED
        );
        if (cashEntries.length === 0) continue;

        ledgerCashTransactionsChecked += 1;
        const ref = tx.external_reference_id || `INTERNAL_${tx.id}`;

        // Skip deterministic seed baseline markers that predate live rails
        if (
            ref.startsWith('ch_seed_') ||
            ref.startsWith('sim_end_') ||
            ref.startsWith('sim_re_') ||
            ref.startsWith('INTERNAL_')
        ) {
            continue;
        }

        const current = ledgerCashByRef.get(ref) || {
            netCashCents: 0,
            txIds: [],
            categories: [],
        };

        for (const entry of cashEntries) {
            if (entry.direction === 'DEBIT') {
                current.netCashCents += entry.amount_cents;
            } else {
                current.netCashCents -= entry.amount_cents;
            }
        }

        current.txIds.push(tx.id);
        current.categories.push(tx.event_category);
        ledgerCashByRef.set(ref, current);
    }

    // 2. Fetch Live Stripe Truth (Bounded to current database inception window)
    const providerTruthMap = new Map<
        string,
        {
            sourceRail: 'STRIPE_PAYMENTS' | 'CLAIM_PAYOUT_RAIL';
            expectedNetCashCents: number;
            description: string;
            hasReturnCode?: string | null;
        }
    >();

    let stripeItemsChecked = 0;

    const earliestTx =
        allTransactions.length > 0
            ? allTransactions[allTransactions.length - 1]
            : null;
    const epochUnixSeconds = earliestTx
        ? Math.floor(new Date(earliestTx.recorded_at).getTime() / 1000) - 60
        : Math.floor(Date.now() / 1000) - 3600;

    try {
        const [paymentIntents, refunds] = await Promise.all([
            stripe.paymentIntents.list({
                limit: 50,
                created: { gte: epochUnixSeconds },
            }),
            stripe.refunds.list({
                limit: 50,
                created: { gte: epochUnixSeconds },
            }),
        ]);

        for (const pi of paymentIntents.data) {
            if (pi.status !== 'succeeded') continue;

            const chargeId =
                typeof pi.latest_charge === 'string'
                    ? pi.latest_charge
                    : pi.latest_charge?.id ?? null;

            // Resolve key: if the ledger booked under chargeId (ch_...), key by chargeId; otherwise key by pi.id
            const matchedKey =
                chargeId && ledgerCashByRef.has(chargeId) ? chargeId : pi.id;

            const isCorgiPi =
                Boolean(pi.metadata?.broker_id) ||
                Boolean(pi.metadata?.insured_name) ||
                Boolean(pi.metadata?.corgi_recon_test) ||
                ledgerCashByRef.has(matchedKey);

            if (!isCorgiPi) continue;

            stripeItemsChecked += 1;
            providerTruthMap.set(matchedKey, {
                sourceRail: 'STRIPE_PAYMENTS',
                expectedNetCashCents: pi.amount_received || pi.amount,
                description: `Stripe PaymentIntent ${pi.id} (${pi.metadata?.insured_name || 'Policy Issuance'
                    })`,
            });
        }

        for (const refund of refunds.data) {
            if (refund.status !== 'succeeded') continue;

            const isCorgiRefund =
                Boolean(refund.metadata?.policy_number) ||
                ledgerCashByRef.has(refund.id);

            if (!isCorgiRefund) continue;

            stripeItemsChecked += 1;
            providerTruthMap.set(refund.id, {
                sourceRail: 'STRIPE_PAYMENTS',
                expectedNetCashCents: -refund.amount,
                description: `Stripe Refund ${refund.id} (${refund.metadata?.policy_number || 'Cancellation Refund'
                    })`,
            });
        }
    } catch (err) {
        console.warn(
            '[RECON_STRIPE_FETCH_WARN] Could not reach live Stripe API during reconciliation:',
            err
        );
    }

    // 3. Fetch Tier 2: ACH Claim Payout Clearing Feed
    const claimEvents = await claimEventRepo.find({
        order: { recorded_at: 'ASC' },
    });

    let payoutRailItemsChecked = 0;
    for (const evt of claimEvents) {
        if (!evt.external_payout_id) continue;

        if (evt.event_type === 'PAYOUT_SETTLED') {
            payoutRailItemsChecked += 1;
            const existing = providerTruthMap.get(evt.external_payout_id) || {
                sourceRail: 'CLAIM_PAYOUT_RAIL' as const,
                expectedNetCashCents: 0,
                description: `ACH Payout Transfer ${evt.external_payout_id}`,
                hasReturnCode: null,
            };
            existing.expectedNetCashCents -= evt.paid_delta_cents;
            providerTruthMap.set(evt.external_payout_id, existing);
        } else if (evt.event_type === 'PAYOUT_RETURNED') {
            payoutRailItemsChecked += 1;
            const existing = providerTruthMap.get(evt.external_payout_id) || {
                sourceRail: 'CLAIM_PAYOUT_RAIL' as const,
                expectedNetCashCents: 0,
                description: `ACH Payout Return (${evt.return_code}) ${evt.external_payout_id}`,
                hasReturnCode: evt.return_code,
            };
            existing.expectedNetCashCents += Math.abs(evt.paid_delta_cents);
            existing.hasReturnCode = evt.return_code || 'R01_RETURN';
            existing.description = `ACH Payout Return (${existing.hasReturnCode}) ${evt.external_payout_id}`;
            providerTruthMap.set(evt.external_payout_id, existing);
        }
    }

    let matchedCount = 0;

    // Direction A: Check every Provider record against Ledger
    for (const [refId, providerItem] of providerTruthMap.entries()) {
        if (resolvedRefIds.has(refId)) {
            matchedCount += 1;
            continue;
        }

        const ledgerItem = ledgerCashByRef.get(refId);

        if (!ledgerItem) {
            const brk = breakRepo.create({
                reconciliation_run_id: runId,
                source_rail: providerItem.sourceRail,
                external_reference_id: refId,
                break_type: 'MISSING_IN_LEDGER',
                provider_amount_cents: Math.abs(providerItem.expectedNetCashCents),
                ledger_amount_cents: null,
                variance_cents: Math.abs(providerItem.expectedNetCashCents),
                explanation: `${providerItem.description} settled at provider for $${(
                    Math.abs(providerItem.expectedNetCashCents) / 100
                ).toFixed(
                    2
                )}, but no matching OPERATING_CASH_SETTLED entry exists in the general ledger.`,
                status: 'OPEN_BREAK',
                is_planted_test_break: false,
            });
            await breakRepo.save(brk);
            continue;
        }

        if (ledgerItem.netCashCents !== providerItem.expectedNetCashCents) {
            const variance =
                Math.abs(providerItem.expectedNetCashCents) -
                Math.abs(ledgerItem.netCashCents);

            const isReturnMismatch = Boolean(providerItem.hasReturnCode);

            const brk = breakRepo.create({
                reconciliation_run_id: runId,
                source_rail: providerItem.sourceRail,
                external_reference_id: refId,
                break_type: isReturnMismatch
                    ? 'UNEXPECTED_RETURN_STATE'
                    : 'AMOUNT_MISMATCH',
                provider_amount_cents: Math.abs(providerItem.expectedNetCashCents),
                ledger_amount_cents: Math.abs(ledgerItem.netCashCents),
                variance_cents: variance,
                explanation: isReturnMismatch
                    ? `Bank clearing feed reported ${providerItem.hasReturnCode} bounce on ${refId} (Net settled cash: $${(
                        Math.abs(providerItem.expectedNetCashCents) / 100
                    ).toFixed(2)}), but ledger still carries settled outflow of $${(
                        Math.abs(ledgerItem.netCashCents) / 100
                    ).toFixed(2)}.`
                    : `Amount mismatch on ${refId}: Provider reported net cash impact of $${(
                        providerItem.expectedNetCashCents / 100
                    ).toFixed(2)}, whereas Ledger booked $${(
                        ledgerItem.netCashCents / 100
                    ).toFixed(2)}.`,
                status: 'OPEN_BREAK',
                is_planted_test_break: false,
            });
            await breakRepo.save(brk);
        } else {
            matchedCount += 1;
        }
    }

    // Direction B: Check every Ledger external reference against Provider Truth
    for (const [refId, ledgerItem] of ledgerCashByRef.entries()) {
        if (resolvedRefIds.has(refId)) continue;

        if (!providerTruthMap.has(refId)) {
            const sourceRail = refId.startsWith('payout_')
                ? 'CLAIM_PAYOUT_RAIL'
                : 'STRIPE_PAYMENTS';
            const brk = breakRepo.create({
                reconciliation_run_id: runId,
                source_rail: sourceRail,
                external_reference_id: refId,
                break_type: 'MISSING_AT_PROVIDER',
                provider_amount_cents: null,
                ledger_amount_cents: Math.abs(ledgerItem.netCashCents),
                variance_cents: -Math.abs(ledgerItem.netCashCents),
                explanation: `Ledger booked OPERATING_CASH_SETTLED for reference ${refId} ($${(
                    Math.abs(ledgerItem.netCashCents) / 100
                ).toFixed(
                    2
                )}), but external provider feed has no record of this settlement.`,
                status: 'OPEN_BREAK',
                is_planted_test_break: false,
            });
            await breakRepo.save(brk);
        }
    }

    const allActiveBreaks = await breakRepo.find({
        order: { detected_at: 'DESC' },
    });

    return {
        runId,
        executedAt: new Date().toISOString(),
        stripeItemsChecked,
        payoutRailItemsChecked,
        ledgerCashTransactionsChecked,
        matchedCount,
        breaksDetectedCount: allActiveBreaks.filter(
            (b) => b.status === 'OPEN_BREAK'
        ).length,
        breaks: allActiveBreaks,
    };
}

/**
 * Plants a genuine, 100% append-only discrepancy in the underlying data sources
 * (Live Stripe API, ACH Clearing Feed, or Ledger) WITHOUT touching `reconciliation_breaks`.
 * When `runReconciliationJob()` runs next, the diff engine discovers the break itself.
 */
export async function plantTestReconciliationBreak(params?: {
    scenario?:
    | 'MISMATCHED_CLAIM_PAYOUT'
    | 'UNBOOKED_STRIPE_CHARGE'
    | 'UNHANDLED_ACH_RETURN';
}): Promise<{
    scenario: string;
    externalReferenceId: string;
    message: string;
}> {
    const db = await getDb();
    const scenario = params?.scenario || 'MISMATCHED_CLAIM_PAYOUT';

    // Use .find({ take: 1 }) to avoid TypeORM v0.3 findOne empty-where error
    const claims = await db.getRepository(Claim).find({
        order: { created_at: 'DESC' },
        take: 1,
    });
    const claim = claims[0];

    const policies = await db.getRepository(Policy).find({
        where: claim ? { id: claim.policy_id } : undefined,
        order: { created_at: 'DESC' },
        take: 1,
    });
    const policy = policies[0];

    // SCENARIO 1: Plant a Mismatched Payout ($2,500.00 in Ledger vs $2,485.00 in Bank Clearing Feed)
    if (scenario === 'MISMATCHED_CLAIM_PAYOUT') {
        if (!claim || !policy) {
            throw new Error('No active Claim or Policy found to plant a mismatched payout.');
        }

        const payoutRef = `payout_${claim.claim_number}_WIRE_${Date.now()
            .toString()
            .slice(-4)}`;
        const ledgerPayoutCents = 250000; // $2,500.00 booked in Ledger
        const providerClearedCents = 248500; // $2,485.00 cleared at Bank ($15 wire fee deducted)
        const today = new Date().toISOString().slice(0, 10);

        await db.transaction(async (manager) => {
            // A. Append balanced LedgerTransaction for $2,500.00
            const tx = manager.create(LedgerTransaction, {
                idempotency_key: `plant_mismatch_tx_${Date.now()}`,
                event_category: 'CLAIM_PAYOUT',
                description: `Claim disbursement wire for ${claim.claim_number} (Booked Gross)`,
                effective_date: today,
                policy_id: policy.id,
                broker_id: policy.broker_id,
                claim_id: claim.id,
                external_reference_id: payoutRef,
                created_by: 'OPS_DISBURSEMENT',
            });
            const savedTx = await manager.save(LedgerTransaction, tx);

            const drEntry = manager.create(LedgerEntry, {
                transaction_id: savedTx.id,
                account_code: LedgerAccount.CLAIM_LOSS_RESERVE,
                direction: 'DEBIT',
                amount_cents: ledgerPayoutCents,
                policy_id: policy.id,
                broker_id: policy.broker_id,
                claim_id: claim.id,
                effective_date: today,
            });
            const crEntry = manager.create(LedgerEntry, {
                transaction_id: savedTx.id,
                account_code: LedgerAccount.OPERATING_CASH_SETTLED,
                direction: 'CREDIT',
                amount_cents: ledgerPayoutCents,
                policy_id: policy.id,
                broker_id: policy.broker_id,
                claim_id: claim.id,
                effective_date: today,
            });
            await manager.save(LedgerEntry, [drEntry, crEntry]);

            // B. Append ACH Bank Clearing Event for $2,485.00 ($15.00 mismatch!)
            const clearingEvt = manager.create(ClaimReserveEvent, {
                claim_id: claim.id,
                event_type: 'PAYOUT_SETTLED',
                reserve_delta_cents: -ledgerPayoutCents,
                paid_delta_cents: providerClearedCents, // $2,485.00 vs $2,500.00 in ledger!
                notes:
                    'Bank clearing statement settled $2,485.00 net of $15.00 intermediary wire fee.',
                payout_rail: 'ACH_DELAYED',
                external_payout_id: payoutRef,
                ledger_transaction_id: savedTx.id,
                created_by: 'BANK_CLEARING_FEED',
            });
            await manager.save(ClaimReserveEvent, clearingEvt);
        });

        return {
            scenario,
            externalReferenceId: payoutRef,
            message: `Planted mismatched payout (${payoutRef}): Ledger booked $2,500.00, Bank Clearing Feed settled $2,485.00. Click "Run Reconciliation" to watch the diff engine catch the $15.00 variance!`,
        };
    }

    // SCENARIO 2: Plant an Unhandled ACH Return (R03 Bounce in Bank Feed, missing in Ledger)
    if (scenario === 'UNHANDLED_ACH_RETURN') {
        if (!claim || !policy) {
            throw new Error('No active Claim found to simulate an unhandled ACH return.');
        }

        const payoutRef = `payout_${claim.claim_number}_R03_${Date.now()
            .toString()
            .slice(-4)}`;
        const amountCents = 420000; // $4,200.00
        const today = new Date().toISOString().slice(0, 10);

        await db.transaction(async (manager) => {
            // 1. Both Ledger and Bank Clearing record the initial $4,200.00 payout
            const tx = manager.create(LedgerTransaction, {
                idempotency_key: `plant_r03_tx_${Date.now()}`,
                event_category: 'CLAIM_PAYOUT',
                description: `ACH claim payout for ${claim.claim_number}`,
                effective_date: today,
                policy_id: policy.id,
                broker_id: policy.broker_id,
                claim_id: claim.id,
                external_reference_id: payoutRef,
                created_by: 'OPS_DISBURSEMENT',
            });
            const savedTx = await manager.save(LedgerTransaction, tx);

            await manager.save(LedgerEntry, [
                manager.create(LedgerEntry, {
                    transaction_id: savedTx.id,
                    account_code: LedgerAccount.CLAIM_LOSS_RESERVE,
                    direction: 'DEBIT',
                    amount_cents: amountCents,
                    policy_id: policy.id,
                    broker_id: policy.broker_id,
                    claim_id: claim.id,
                    effective_date: today,
                }),
                manager.create(LedgerEntry, {
                    transaction_id: savedTx.id,
                    account_code: LedgerAccount.OPERATING_CASH_SETTLED,
                    direction: 'CREDIT',
                    amount_cents: amountCents,
                    policy_id: policy.id,
                    broker_id: policy.broker_id,
                    claim_id: claim.id,
                    effective_date: today,
                }),
            ]);

            await manager.save(
                ClaimReserveEvent,
                manager.create(ClaimReserveEvent, {
                    claim_id: claim.id,
                    event_type: 'PAYOUT_SETTLED',
                    reserve_delta_cents: -amountCents,
                    paid_delta_cents: amountCents,
                    notes: 'Initial ACH transfer dispatched.',
                    payout_rail: 'ACH_DELAYED',
                    external_payout_id: payoutRef,
                    ledger_transaction_id: savedTx.id,
                    created_by: 'OPS_DISBURSEMENT',
                })
            );

            // 2. Bank Clearing Feed appends an R03_NO_ACCOUNT return bounce,
            //    WITHOUT posting the compensating LedgerTransaction!
            await manager.save(
                ClaimReserveEvent,
                manager.create(ClaimReserveEvent, {
                    claim_id: claim.id,
                    event_type: 'PAYOUT_RETURNED',
                    reserve_delta_cents: amountCents,
                    paid_delta_cents: -amountCents,
                    notes:
                        'ACH Return R03 (No Account/Unable to Locate) reported on bank clearing tape; uningested by ledger.',
                    payout_rail: 'ACH_DELAYED',
                    return_code: 'R03_NO_ACCOUNT',
                    external_payout_id: payoutRef,
                    ledger_transaction_id: null,
                    created_by: 'BANK_CLEARING_FEED',
                })
            );
        });

        return {
            scenario,
            externalReferenceId: payoutRef,
            message: `Appended R03 ACH bounce to bank clearing feed for ${payoutRef} ($4,200.00) without booking the ledger reversal. Click "Run Reconciliation" to detect it!`,
        };
    }

    // SCENARIO 3: Plant a Real Live Stripe Charge that skips Ledger Ingestion
    // Note: Setting corgi_action: 'ENDORSEMENT' without policy_id causes un-updated Vercel
    // webhooks to reject binding a phantom fallback policy prior to your next push.
    const paymentIntent = await stripe.paymentIntents.create({
        amount: 845000, // $8,450.00
        currency: 'usd',
        payment_method: 'pm_card_visa',
        confirm: true,
        automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never',
        },
        description: 'Corgi Commercial Liability Binder (Unbooked Webhook Test)',
        metadata: {
            corgi_action: 'ENDORSEMENT',
            corgi_recon_test: 'true',
            skip_webhook_ledger: 'true',
            insured_name: 'Redwood Logistics Corp (Dropped Webhook)',
        },
    });

    return {
        scenario: 'UNBOOKED_STRIPE_CHARGE',
        externalReferenceId: paymentIntent.id,
        message: `Created real Stripe charge ${paymentIntent.id} ($8,450.00) with ledger ingestion skipped. Click "Run Reconciliation" to fetch from Stripe API and surface the MISSING_IN_LEDGER break!`,
    };
}

/**
 * Marks a reconciliation break as resolved (`RESOLVED_BY_JOURNAL`).
 */
export async function resolveReconciliationBreak(
    breakId: string
): Promise<ReconciliationBreak> {
    const db = await getDb();
    const breakRepo = db.getRepository(ReconciliationBreak);

    const existing = await breakRepo.findOne({ where: { id: breakId } });
    if (!existing) {
        throw new Error(
            `BREAK_NOT_FOUND: Reconciliation break ${breakId} not found.`
        );
    }

    existing.status = 'RESOLVED_BY_JOURNAL';
    return breakRepo.save(existing);
}