import 'reflect-metadata';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import {
    ApprovalRequest,
    Broker,
    Claim,
    LedgerEntry,
    LedgerTransaction,
    Policy,
    WebhookEvent,
} from '@/lib/db/entities';

//export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const db = await getDb();

        const policyRepo = db.getRepository<Policy>('Policy');
        const brokerRepo = db.getRepository<Broker>('Broker');
        const txRepo = db.getRepository<LedgerTransaction>('LedgerTransaction');
        const entryRepo = db.getRepository<LedgerEntry>('LedgerEntry');
        const claimRepo = db.getRepository<Claim>('Claim');
        const webhookRepo = db.getRepository<WebhookEvent>('WebhookEvent');
        const approvalRepo = db.getRepository<ApprovalRequest>('ApprovalRequest');

        const [brokers, policies, transactions, entries, claims, webhooks, approvals] =
            await Promise.all([
                brokerRepo.find({ order: { created_at: 'ASC' } }),
                policyRepo.find({
                    relations: { events: true, broker: true },
                    order: { created_at: 'DESC' },
                }),
                txRepo.find({
                    relations: { entries: true },
                    order: { recorded_at: 'DESC' },
                    take: 30,
                }),
                entryRepo.find(),
                claimRepo.find({
                    relations: { events: true, policy: true },
                    order: { created_at: 'DESC' },
                }),
                webhookRepo.find({
                    order: { first_received_at: 'DESC' },
                    take: 15,
                }),
                approvalRepo.find({
                    order: { created_at: 'DESC' },
                }),
            ]);

        let totalDebitsCents = 0;
        let totalCreditsCents = 0;
        const accountMap = new Map<
            string,
            { debitsCents: number; creditsCents: number; entryCount: number }
        >();

        for (const entry of entries) {
            const current = accountMap.get(entry.account_code) || {
                debitsCents: 0,
                creditsCents: 0,
                entryCount: 0,
            };

            if (entry.direction === 'DEBIT') {
                current.debitsCents += entry.amount_cents;
                totalDebitsCents += entry.amount_cents;
            } else {
                current.creditsCents += entry.amount_cents;
                totalCreditsCents += entry.amount_cents;
            }
            current.entryCount += 1;
            accountMap.set(entry.account_code, current);
        }

        const trialBalances = Array.from(accountMap.entries()).map(
            ([accountCode, stats]) => ({
                accountCode,
                debitsCents: stats.debitsCents,
                creditsCents: stats.creditsCents,
                netCents: stats.debitsCents - stats.creditsCents,
                entryCount: stats.entryCount,
            })
        );

        return NextResponse.json({
            brokers,
            policies,
            claims,
            webhooks,
            approvals,
            ledger: {
                transactions,
                trialBalances,
                totalDebitsCents,
                totalCreditsCents,
                isBalanced: totalDebitsCents === totalCreditsCents,
            },
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[CONSOLE_STATE_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}