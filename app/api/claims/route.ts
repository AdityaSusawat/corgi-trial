import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { openClaimWithInitialReserve } from '@/lib/services/ledger-service';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        const {
            policyId,
            dateOfLoss,
            claimantName,
            lossDescription,
            initialReserveCents,
            plaidVerificationId = 'plaid_sandbox_verified_good',
            claimantBankRouting = '011000015',
            claimantBankAccountMask = '1111',
            claimantUsdcWalletAddress = null,
            createdBy = 'ops_maker@corgi.insure',
        } = body;

        if (!policyId) {
            return NextResponse.json(
                { error: 'policyId is required.' },
                { status: 400 }
            );
        }

        if (!dateOfLoss) {
            return NextResponse.json(
                { error: 'dateOfLoss (YYYY-MM-DD) is required.' },
                { status: 400 }
            );
        }

        if (!claimantName || !lossDescription) {
            return NextResponse.json(
                { error: 'claimantName and lossDescription are required.' },
                { status: 400 }
            );
        }

        const parsedReserveCents = Number(initialReserveCents);
        if (!Number.isInteger(parsedReserveCents) || parsedReserveCents <= 0) {
            return NextResponse.json(
                { error: 'initialReserveCents must be a positive integer.' },
                { status: 400 }
            );
        }

        const result = await openClaimWithInitialReserve({
            idempotencyKey: `intake_${policyId}_${Date.now()}`,
            policyId,
            dateOfLoss,
            claimantName: claimantName.trim(),
            lossDescription: lossDescription.trim(),
            initialReserveCents: parsedReserveCents,
            plaidVerificationId,
            claimantBankRouting,
            claimantBankAccountMask,
            claimantUsdcWalletAddress,
            createdBy,
        });

        return NextResponse.json(result, { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[CLAIMS_INTAKE_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}