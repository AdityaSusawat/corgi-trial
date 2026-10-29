import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { applyMidTermEndorsement } from '@/lib/services/ledger-service';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: policyId } = await context.params;
        const body = await req.json();

        const {
            endorsementEffectiveDate,
            annualizedBasePremiumDeltaCents,
            newCoverageLimitCents,
            newDeductibleCents,
            description = 'Mid-term coverage adjustment',
            bypassMakerChecker = true,
            createdBy = 'CONSOLE_USER',
        } = body;

        if (!endorsementEffectiveDate) {
            return NextResponse.json(
                { error: 'endorsementEffectiveDate (YYYY-MM-DD) is required.' },
                { status: 400 }
            );
        }

        if (annualizedBasePremiumDeltaCents === undefined) {
            return NextResponse.json(
                { error: 'annualizedBasePremiumDeltaCents is required.' },
                { status: 400 }
            );
        }

        const result = await applyMidTermEndorsement({
            idempotencyKey: `endorse_${policyId}_${Date.now()}`,
            policyId,
            endorsementEffectiveDate,
            description,
            annualizedBasePremiumDeltaCents: Number(annualizedBasePremiumDeltaCents),
            newCoverageLimitCents: newCoverageLimitCents
                ? Number(newCoverageLimitCents)
                : undefined,
            newDeductibleCents: newDeductibleCents
                ? Number(newDeductibleCents)
                : undefined,
            bypassMakerChecker,
            createdBy,
        });

        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ENDORSE_API_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}