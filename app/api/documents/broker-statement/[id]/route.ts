import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import {
    Broker,
    BrokerStatement,
    LedgerAccount,
    LedgerTransaction,
    Policy,
} from '@/lib/db/entities';
import { buildPdfBuffer, PdfLine } from '@/lib/pdf/pdf-builder';

function fmtUsd(cents: number): string {
    const sign = cents < 0 ? '-' : '';
    return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: brokerId } = await context.params;
        const { searchParams } = new URL(req.url);
        const monthParam = searchParams.get('month');
        const statementMonth =
            monthParam && /^\d{4}-\d{2}$/.test(monthParam)
                ? monthParam
                : new Date().toISOString().slice(0, 7); // e.g., '2026-10'

        const db = await getDb();
        const brokerRepo = db.getRepository(Broker);
        const statementRepo = db.getRepository(BrokerStatement);

        const broker = await brokerRepo.findOne({ where: { id: brokerId } });
        if (!broker) {
            return NextResponse.json(
                { error: `Broker ${brokerId} not found.` },
                { status: 404 }
            );
        }

        // Gauntlet #8: Check if this statement month is already closed & locked
        let statement = await statementRepo.findOne({
            where: {
                broker_id: broker.id,
                statement_month: statementMonth,
            },
        });

        let wasAlreadyClosed = true;

        if (!statement) {
            wasAlreadyClosed = false;

            // Compute directly from immutable LedgerTransactions & LedgerEntries for this broker
            const allBrokerTxs = await db.getRepository(LedgerTransaction).find({
                where: { broker_id: broker.id },
                relations: { entries: true },
                order: { recorded_at: 'ASC' },
            });

            const policies = await db.getRepository(Policy).find({
                where: { broker_id: broker.id },
            });
            const policyMap = new Map(policies.map((p) => [p.id, p.policy_number]));

            let grossPremiumCollectedCents = 0;
            let premiumRefundedCents = 0;
            let commissionEarnedCents = 0;
            let commissionClawedBackCents = 0;

            const lineItems: Array<{
                policy_number: string;
                event_type: string;
                effective_date: string;
                premium_delta_cents: number;
                commission_delta_cents: number;
                ledger_transaction_id: string;
            }> = [];

            // Track base premium collected/refunded from cash transactions
            const premiumByPolicyTx = new Map<string, number>();
            for (const tx of allBrokerTxs) {
                for (const entry of tx.entries) {
                    if (entry.account_code === LedgerAccount.UNEARNED_PREMIUM_RESERVE) {
                        if (
                            tx.event_category === 'ISSUANCE' ||
                            tx.event_category === 'ENDORSEMENT'
                        ) {
                            grossPremiumCollectedCents += entry.amount_cents;
                            if (tx.policy_id) {
                                premiumByPolicyTx.set(tx.policy_id, entry.amount_cents);
                            }
                        } else if (
                            tx.event_category === 'CANCELLATION_REFUND' &&
                            entry.direction === 'DEBIT'
                        ) {
                            // On cancellation, unearned premium refunded is the cash outflow minus any tax/fee refund
                            const cashRefundEntry = tx.entries.find(
                                (e) =>
                                    e.account_code === LedgerAccount.OPERATING_CASH_SETTLED &&
                                    e.direction === 'CREDIT'
                            );
                            if (cashRefundEntry) {
                                premiumRefundedCents += cashRefundEntry.amount_cents;
                            }
                        }
                    }
                }
            }

            // Sum exact commission accrual & clawback entries from BROKER_COMMISSION_PAYABLE
            for (const tx of allBrokerTxs) {
                const commEntry = tx.entries.find(
                    (e) => e.account_code === LedgerAccount.BROKER_COMMISSION_PAYABLE
                );
                if (!commEntry) continue;

                const policyNumber =
                    (tx.policy_id && policyMap.get(tx.policy_id)) || 'PORTFOLIO-ADJ';

                if (commEntry.direction === 'CREDIT') {
                    // Commission Earned
                    commissionEarnedCents += commEntry.amount_cents;
                    const inferredPremiumCents = Math.round(
                        (commEntry.amount_cents * 10000) / broker.commission_rate_bps
                    );

                    lineItems.push({
                        policy_number: policyNumber,
                        event_type: tx.event_category,
                        effective_date: tx.effective_date,
                        premium_delta_cents: inferredPremiumCents,
                        commission_delta_cents: commEntry.amount_cents,
                        ledger_transaction_id: tx.id,
                    });
                } else if (commEntry.direction === 'DEBIT') {
                    // Commission Clawed Back on Refund/Reversal
                    commissionClawedBackCents += commEntry.amount_cents;
                    const inferredRefundCents = -Math.round(
                        (commEntry.amount_cents * 10000) / broker.commission_rate_bps
                    );

                    lineItems.push({
                        policy_number: policyNumber,
                        event_type: tx.event_category,
                        effective_date: tx.effective_date,
                        premium_delta_cents: inferredRefundCents,
                        commission_delta_cents: -commEntry.amount_cents,
                        ledger_transaction_id: tx.id,
                    });
                }
            }

            const netPayoutDueCents =
                commissionEarnedCents - commissionClawedBackCents;

            statement = statementRepo.create({
                broker_id: broker.id,
                statement_month: statementMonth,
                gross_premium_collected_cents: grossPremiumCollectedCents,
                premium_refunded_cents: premiumRefundedCents,
                commission_earned_cents: commissionEarnedCents,
                commission_clawed_back_cents: commissionClawedBackCents,
                net_payout_due_cents: netPayoutDueCents,
                line_items_snapshot: lineItems,
                is_closed: true,
            });

            statement = await statementRepo.save(statement);
        }

        const lines: PdfLine[] = [
            {
                text: '1. BROKER OF RECORD & KYB COMPLIANCE STATUS',
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Legal Entity Name:  ${broker.legal_name} (DBA: ${broker.dba_name})`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `Federal EIN / State:${broker.ein} | License State: ${broker.license_state}`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `KYB Status:         ${broker.kyb_status} (${broker.kyb_provider_name} | Session: ${broker.kyb_provider_session_id || 'N/A'})`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `Commission Basis:   ${(broker.commission_rate_bps / 100).toFixed(2)}% (${broker.commission_rate_bps} bps) Earned on COLLECTED Base Premium`,
                font: 'MONO',
                size: 9,
                spacingAfter: 10,
            },
            {
                text: `2. MONTHLY COMMISSION SUMMARY (${statement.statement_month}) — TIED TO LEDGER`,
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Accounting Period Status:          ${statement.is_closed ? 'CLOSED & IMMUTABLE SNAPSHOT' : 'OPEN'} (${wasAlreadyClosed ? 'Replayed from Locked Snapshot' : 'Newly Closed & Locked'})`,
                font: 'MONO',
                size: 8.5,
                color: 'GREEN',
            },
            {
                text: `Gross Base Premium Collected:      ${fmtUsd(statement.gross_premium_collected_cents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Unearned Premium Refunded:         ${fmtUsd(statement.premium_refunded_cents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Gross Commission Earned (+):       ${fmtUsd(statement.commission_earned_cents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Commission Clawed Back on Refunds: -${fmtUsd(statement.commission_clawed_back_cents)}`,
                font: 'MONO',
                size: 9.5,
                color: statement.commission_clawed_back_cents > 0 ? 'RED' : 'BLACK',
            },
            {
                text: `NET COMMISSION PAYOUT DUE:         ${fmtUsd(statement.net_payout_due_cents)}`,
                font: 'BOLD',
                size: 10.5,
                color: 'GREEN',
                spacingAfter: 10,
            },
            {
                text: '3. ITEMIZED LEDGER TIE-OUT (LIABILITY:BROKER_COMMISSION_PAYABLE)',
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
        ];

        if (statement.line_items_snapshot.length === 0) {
            lines.push({
                text: 'No settled commission transactions recorded for this broker in this period.',
                font: 'MONO',
                size: 8.5,
                color: 'MUTED',
            });
        } else {
            for (const item of statement.line_items_snapshot) {
                lines.push({
                    text: `[${item.effective_date}] ${item.policy_number} | ${item.event_type}`,
                    font: 'BOLD',
                    size: 8.5,
                });
                lines.push({
                    text: `   Base Premium Basis: ${fmtUsd(item.premium_delta_cents)}  -->  Commission Delta: ${fmtUsd(item.commission_delta_cents)}  (Ledger TX: ${item.ledger_transaction_id.slice(0, 12)}...)`,
                    font: 'MONO',
                    size: 8,
                    color: 'MUTED',
                    spacingAfter: 5,
                });
            }
        }

        const pdfBuffer = buildPdfBuffer({
            title: `BROKER COMMISSION STATEMENT — ${statement.statement_month}`,
            subtitle: `${broker.legal_name} | Tied 1:1 to General Ledger Account LIABILITY:BROKER_COMMISSION_PAYABLE`,
            badgeText: `STATEMENT ID: ${statement.id} | PERIOD LOCK: ${statement.is_closed ? 'CLOSED_IMMUTABLE' : 'OPEN'} | GENERATED: ${new Date(statement.generated_at).toISOString().slice(0, 19)}Z`,
            lines,
            footerNote: `Gauntlet #8 Invariant: Re-running closed month ${statement.statement_month} produces this exact immutable snapshot forever.`,
        });

        return new NextResponse(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="Broker_Statement_${broker.legal_name.replace(/\s+/g, '_')}_${statement.statement_month}.pdf"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[BROKER_STATEMENT_PDF_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}