import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/data-source';
import { Broker, Policy, PolicyEvent } from '@/lib/db/entities';
import {
    calculateAsOfEarnedPosition,
    PolicyFinancialSlice,
} from '@/lib/math/insurance-math';
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
        const { id: policyId } = await context.params;
        const { searchParams } = new URL(req.url);
        const asOfDateParam = searchParams.get('asOfDate');
        const asOfDate =
            asOfDateParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfDateParam)
                ? asOfDateParam
                : new Date().toISOString().slice(0, 10);

        const db = await getDb();
        const policy = await db.getRepository(Policy).findOne({
            where: { id: policyId },
        });

        if (!policy) {
            return NextResponse.json(
                { error: `Policy ${policyId} not found.` },
                { status: 404 }
            );
        }

        const [broker, allEvents] = await Promise.all([
            db.getRepository(Broker).findOne({ where: { id: policy.broker_id } }),
            db.getRepository(PolicyEvent).find({
                where: { policy_id: policy.id },
                order: { sequence_number: 'ASC' },
            }),
        ]);

        // Filter events active as of `asOfDate` (Bi-Temporal Reconstruction - Gauntlet #9)
        const eventsUpToDate = allEvents.filter(
            (e) => e.effective_date <= asOfDate
        );

        // Identify reversed events (Gauntlet #4: The Correction Test)
        const reversedEventIds = new Set(
            eventsUpToDate
                .filter(
                    (e) =>
                        e.event_type === 'ENDORSEMENT_REVERSAL' && e.reverses_event_id
                )
                .map((e) => e.reverses_event_id as string)
        );

        // Reconstruct active coverage snapshot & financial sums as of `asOfDate`
        let reconstructedWrittenPremiumCents = 0;
        let reconstructedStateTaxCents = 0;
        let reconstructedStampingFeeCents = 0;
        let reconstructedFeeCents = 0;
        let reconstructedGrossCents = 0;
        let latestSnapshot = {
            coverage_limit_cents: policy.coverage_limit_cents,
            deductible_cents: policy.deductible_cents,
            insured_address: policy.insured_address,
            vehicles_covered: [] as string[],
            additional_insureds: [] as string[],
            annualized_base_premium_cents: policy.current_written_premium_cents,
        };

        for (const evt of eventsUpToDate) {
            reconstructedWrittenPremiumCents += evt.prorated_premium_delta_cents;
            reconstructedStateTaxCents += evt.state_tax_delta_cents;
            reconstructedStampingFeeCents += evt.stamping_fee_delta_cents;
            reconstructedFeeCents += evt.fee_or_penalty_delta_cents;
            reconstructedGrossCents += evt.total_gross_delta_cents;

            if (
                evt.event_type !== 'ENDORSEMENT_REVERSAL' &&
                !reversedEventIds.has(evt.id) &&
                evt.coverage_snapshot
            ) {
                latestSnapshot = evt.coverage_snapshot;
            }
        }

        // Calculate Earned vs Unearned Premium as of `asOfDate` (Gauntlets #1, #2, #3)
        const activeEarningSlices: PolicyFinancialSlice[] = eventsUpToDate
            .filter((e) => e.event_type !== 'POLICY_CANCELLED')
            .map((e) => ({
                eventId: e.id,
                eventType: e.event_type,
                effectiveDate: e.effective_date,
                recordedAt: new Date(e.recorded_at).toISOString(),
                activeDaysInTerm: e.active_days_in_term,
                proratedBasePremiumDeltaCents: e.prorated_premium_delta_cents,
                stateTaxDeltaCents: e.state_tax_delta_cents,
                stampingFeeDeltaCents: e.stamping_fee_delta_cents,
                feeOrPenaltyDeltaCents: e.fee_or_penalty_delta_cents,
                reversesEventId: e.reverses_event_id,
            }));

        const earningSummary = calculateAsOfEarnedPosition({
            asOfDate,
            policyStartDate: policy.effective_start_date,
            policyEndDate: policy.effective_end_date,
            slices: activeEarningSlices,
        });

        const isCancelledAsOf = eventsUpToDate.some(
            (e) => e.event_type === 'POLICY_CANCELLED'
        );

        const effectiveStatusAsOf = isCancelledAsOf
            ? policy.status
            : eventsUpToDate.length > 0
                ? 'BOUND_ACTIVE'
                : 'PRE_INCEPTION';

        const lines: PdfLine[] = [
            {
                text: 'ITEM 1. NAMED INSURED & PRODUCER (BROKER OF RECORD)',
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Named Insured:      ${policy.insured_name} (EIN: ${policy.insured_ein})`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `Mailing Address:    ${latestSnapshot.insured_address || policy.insured_address}`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `Risk State & Line:  ${policy.risk_state} | ${policy.product_line}`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `Producer / Broker:  ${broker
                        ? `${broker.legal_name} (KYB: ${broker.kyb_status} | Comm: ${(
                            broker.commission_rate_bps / 100
                        ).toFixed(2)}%)`
                        : 'Direct'
                    }`,
                font: 'MONO',
                size: 9,
                spacingAfter: 10,
            },
            {
                text: 'ITEM 2. POLICY PERIOD & AS-OF RECONSTRUCTION METADATA',
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Policy Term:        ${policy.effective_start_date} to ${policy.effective_end_date} (${policy.term_days} Calendar Days - Leap-Year Aware)`,
                font: 'MONO',
                size: 9,
            },
            {
                text: `As-Of View Date:    ${asOfDate}   |   Status As-Of Date: ${effectiveStatusAsOf}`,
                font: 'MONO',
                size: 9,
                color: isCancelledAsOf ? 'RED' : 'GREEN',
                spacingAfter: 10,
            },
            {
                text: 'ITEM 3. COMMERCIAL COVERAGE SCHEDULE & STATUTORY PREMIUM BREAKDOWN',
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Aggregate Coverage Limit:          ${fmtUsd(latestSnapshot.coverage_limit_cents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Per-Occurrence Deductible:         ${fmtUsd(latestSnapshot.deductible_cents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Net Written Base Premium (As-Of):  ${fmtUsd(reconstructedWrittenPremiumCents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `State Surplus Lines Tax (${policy.risk_state}):     ${fmtUsd(reconstructedStateTaxCents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `State Stamping Office Fee:         ${fmtUsd(reconstructedStampingFeeCents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `Carrier Policy / Short-Rate Fee:   ${fmtUsd(reconstructedFeeCents)}`,
                font: 'MONO',
                size: 9.5,
            },
            {
                text: `TOTAL GROSS CHARGED (AS-OF):       ${fmtUsd(reconstructedGrossCents)}`,
                font: 'BOLD',
                size: 10,
                spacingAfter: 10,
            },
            {
                text: `ITEM 4. DAILY PRO-RATA EARNING RECOGNITION AS OF ${asOfDate}`,
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
            {
                text: `Earned Base Premium:    ${fmtUsd(
                    isCancelledAsOf
                        ? reconstructedWrittenPremiumCents
                        : earningSummary.earnedBasePremiumCents
                )}   |   Unearned Liability Reserve: ${fmtUsd(
                    isCancelledAsOf ? 0 : earningSummary.unearnedBasePremiumCents
                )}`,
                font: 'MONO',
                size: 9,
                spacingAfter: 10,
            },
            {
                text: `ITEM 5. IMMUTABLE ENDORSEMENT & EVENT SCHEDULE (ACTIVE AS OF ${asOfDate})`,
                font: 'BOLD',
                size: 10.5,
                color: 'ORANGE',
                drawRuleBelow: true,
                spacingAfter: 6,
            },
        ];

        if (eventsUpToDate.length === 0) {
            lines.push({
                text: `No policy events had taken effect on or before ${asOfDate}.`,
                font: 'MONO',
                size: 8.5,
                color: 'MUTED',
            });
        } else {
            for (const evt of eventsUpToDate) {
                const isReversed = reversedEventIds.has(evt.id);
                const tag = isReversed ? '[SUPERSEDED BY REVERSAL]' : '';
                lines.push({
                    text: `#${evt.sequence_number} [${evt.effective_date}] ${evt.event_type} ${tag}`,
                    font: 'BOLD',
                    size: 8.5,
                    color: isReversed ? 'MUTED' : 'BLACK',
                });
                lines.push({
                    text: `   ${evt.description} | Premium Delta: ${fmtUsd(evt.prorated_premium_delta_cents)} | Gross: ${fmtUsd(evt.total_gross_delta_cents)}`,
                    font: 'MONO',
                    size: 8,
                    color: 'MUTED',
                    spacingAfter: 5,
                });
            }
        }

        const pdfBuffer = buildPdfBuffer({
            title: `COMMERCIAL INSURANCE DECLARATIONS — ${policy.policy_number}`,
            subtitle: `Corgi Commercial Underwriting Platform | Bi-Temporal Contract Reconstruction`,
            badgeText: `RECONSTRUCTED AS OF DATE: ${asOfDate} | STRIPE REF: ${policy.stripe_payment_intent_id ||
                policy.stripe_charge_id ||
                'SEED_BASELINE'
                }`,
            lines,
            footerNote: `Corgi Surplus Lines Policy ${policy.policy_number} | As-Of ${asOfDate} | Taxes & Fees Strictly Segregated from Base Premium`,
        });

        return new NextResponse(new Uint8Array(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${policy.policy_number}_Declarations_AsOf_${asOfDate}.pdf"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[DEC_PAGE_PDF_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}