import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import { Claim } from '@/lib/db/entities';
import { reviewApprovalRequest } from '@/lib/services/ledger-service';

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: approvalRequestId } = await context.params;
        const body = await req.json();

        const {
            decision, // 'APPROVED' | 'REJECTED'
            reviewedByUser = 'lead_checker@corgi.insure',
            reviewedByRole = 'CHECKER_LEAD',
            reviewNotes = 'Reviewed and verified against policy coverage limits.',
        } = body;

        if (decision !== 'APPROVED' && decision !== 'REJECTED') {
            return NextResponse.json(
                { error: 'decision must be either "APPROVED" or "REJECTED".' },
                { status: 400 }
            );
        }

        const result = await reviewApprovalRequest({
            approvalRequestId,
            decision,
            reviewedByUser,
            reviewedByRole,
            reviewNotes,
        });

        // If a claim payout request was rejected, restore the claim status back to OPEN
        if (
            decision === 'REJECTED' &&
            result.approvalRequest.claim_id
        ) {
            const db = await getDb();
            const claimRepo = db.getRepository(Claim);
            const claim = await claimRepo.findOne({
                where: { id: result.approvalRequest.claim_id },
            });
            if (claim && claim.status === 'PENDING_APPROVAL') {
                claim.status = claim.total_paid_cents > 0 ? 'PAID_PARTIAL' : 'OPEN';
                await claimRepo.save(claim);
            }
        }

        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[APPROVAL_REVIEW_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}