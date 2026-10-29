import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db/data-source';
import { Broker } from '@/lib/db/entities';
import { calculatePolicyIssuancePricing } from '@/lib/math/insurance-math';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const {
            brokerId,
            insuredName,
            insuredEin,
            insuredAddress,
            riskState = 'CA',
            productLine = 'COMMERCIAL_GENERAL_LIABILITY',
            effectiveStartDate = '2026-05-01',
            effectiveEndDate,
            coverageLimitCents = 100_000_000,
            deductibleCents = 1_000_000,
            annualBasePremiumCents = 1_200_000,
            autoConfirmWithTestCard = true,
        } = body;

        const db = await getDb();
        const brokerRepo = db.getRepository(Broker);

        const broker = brokerId
            ? await brokerRepo.findOne({ where: { id: brokerId } })
            : await brokerRepo.findOne({ where: { kyb_status: 'APPROVED' } });

        if (!broker) {
            return NextResponse.json(
                { error: 'BROKER_NOT_FOUND: Specified broker does not exist.' },
                { status: 404 }
            );
        }

        // Hard KYB Gate prior to collecting customer funds
        if (broker.kyb_status !== 'APPROVED') {
            return NextResponse.json(
                {
                    error: `BROKER_KYB_GATE_BLOCKED: Broker "${broker.legal_name}" has KYB status "${broker.kyb_status}". Only APPROVED brokers can bind policies.`,
                },
                { status: 403 }
            );
        }

        // Calculate deterministic gross pricing (Base + State Surplus Tax + Stamping + Policy Fee)
        const pricing = calculatePolicyIssuancePricing({
            annualBasePremiumCents: Number(annualBasePremiumCents),
            effectiveStartDate,
            effectiveEndDate,
            riskState,
            brokerCommissionRateBps: broker.commission_rate_bps,
        });

        // Create live Stripe PaymentIntent in test mode
        const paymentIntent = await stripe.paymentIntents.create({
            amount: pricing.totalGrossChargedCents,
            currency: 'usd',
            ...(autoConfirmWithTestCard
                ? {
                    payment_method: 'pm_card_visa',
                    confirm: true,
                    return_url: 'https://corgi-trial-eta.vercel.app',
                }
                : {
                    automatic_payment_methods: {
                        enabled: true,
                        allow_redirects: 'never',
                    },
                }),
            description: `Corgi Commercial Policy Issuance — ${insuredName} (${riskState.toUpperCase()})`,
            metadata: {
                corgi_action: 'POLICY_ISSUANCE',
                broker_id: broker.id,
                insured_name: insuredName,
                insured_ein: insuredEin || '94-9999999',
                insured_address:
                    insuredAddress || '555 Market St, San Francisco, CA 94105',
                risk_state: riskState.toUpperCase(),
                product_line: productLine,
                effective_start_date: pricing.effectiveStartDate,
                effective_end_date: pricing.effectiveEndDate,
                coverage_limit_cents: String(coverageLimitCents),
                deductible_cents: String(deductibleCents),
                annual_base_premium_cents: String(pricing.basePremiumCents),
            },
        });

        return NextResponse.json({
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            status: paymentIntent.status,
            pricing,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[CHECKOUT_API_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}