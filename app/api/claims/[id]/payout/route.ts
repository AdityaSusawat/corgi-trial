import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import {
    adjustClaimReserve,
    initiateOrExecuteClaimPayout,
} from '@/lib/services/ledger-service';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: claimId } = await context.params;
        const body = await req.json();

        const {
            action = 'INITIATE_PAYOUT', // 'INITIATE_PAYOUT' | 'ADJUST_RESERVE'
            payoutAmountCents,
            reserveDeltaCents,
            effectiveDate = new Date().toISOString().slice(0, 10),
            payoutRail = 'ACH_DELAYED',
            notes = 'Claim settlement disbursement',
            initiatedByUser = 'ops_maker@corgi.insure',
            initiatedByRole = 'MAKER_OPS',
        } = body;

        if (action === 'ADJUST_RESERVE') {
            const parsedDelta = Number(reserveDeltaCents);
            if (!Number.isInteger(parsedDelta) || parsedDelta === 0) {
                return NextResponse.json(
                    { error: 'reserveDeltaCents must be a non-zero integer.' },
                    { status: 400 }
                );
            }

            const adjResult = await adjustClaimReserve({
                idempotencyKey: `adj_${claimId}_${Date.now()}`,
                claimId,
                reserveDeltaCents: parsedDelta,
                effectiveDate,
                notes,
                createdBy: initiatedByUser,
            });

            return NextResponse.json({
                status: 'RESERVE_ADJUSTED',
                ...adjResult,
            });
        }

        const parsedPayout = Number(payoutAmountCents);
        if (!Number.isInteger(parsedPayout) || parsedPayout <= 0) {
            return NextResponse.json(
                { error: 'payoutAmountCents must be a positive integer.' },
                { status: 400 }
            );
        }

        const result = await initiateOrExecuteClaimPayout({
            idempotencyKey: `pay_${claimId}_${Date.now()}`,
            claimId,
            payoutAmountCents: parsedPayout,
            effectiveDate,
            payoutRail:
                payoutRail === 'USDC_BASE_SEPOLIA'
                    ? 'USDC_BASE_SEPOLIA'
                    : 'ACH_DELAYED',
            notes,
            initiatedByUser,
            initiatedByRole,
        });

        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[CLAIM_PAYOUT_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}