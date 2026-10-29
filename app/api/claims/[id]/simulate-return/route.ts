import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import { Claim, ClaimReserveEvent } from '@/lib/db/entities';
import { recordClaimPayoutReturn } from '@/lib/services/ledger-service';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: claimId } = await context.params;
        const body = await req.json();

        const {
            returnedAmountCents,
            returnCode = 'R01_INSUFFICIENT_FUNDS',
            effectiveDate = new Date().toISOString().slice(0, 10),
            externalPayoutId,
        } = body;

        const db = await getDb();
        const claim = await db.getRepository(Claim).findOne({
            where: { id: claimId },
        });

        if (!claim) {
            return NextResponse.json(
                { error: `CLAIM_NOT_FOUND: Claim ${claimId} does not exist.` },
                { status: 404 }
            );
        }

        if (claim.total_paid_cents <= 0) {
            return NextResponse.json(
                {
                    error: `NO_SETTLED_PAYOUT_TO_RETURN: Claim ${claim.claim_number} has $0.00 in settled payouts to bounce.`,
                },
                { status: 400 }
            );
        }

        // Find latest settled payout event if amount or externalPayoutId is omitted
        const latestPayoutEvent = await db.getRepository(ClaimReserveEvent).findOne({
            where: {
                claim_id: claimId,
                event_type: 'PAYOUT_SETTLED',
            },
            order: { recorded_at: 'DESC' },
        });

        const amountToReturn = returnedAmountCents
            ? Number(returnedAmountCents)
            : latestPayoutEvent?.paid_delta_cents || claim.total_paid_cents;

        const resolvedExternalId =
            externalPayoutId ||
            latestPayoutEvent?.external_payout_id ||
            `ach_ret_${claim.claim_number}_${Date.now()}`;

        const result = await recordClaimPayoutReturn({
            idempotencyKey: `ret_${claimId}_${Date.now()}`,
            claimId,
            returnedAmountCents: amountToReturn,
            returnCode,
            effectiveDate,
            externalPayoutId: resolvedExternalId,
        });

        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[CLAIM_RETURN_SIM_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}