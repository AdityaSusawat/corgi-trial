import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
    console.warn(
        '[STRIPE] Warning: STRIPE_SECRET_KEY is not defined. Stripe operations will fail.'
    );
}

export const stripe = new Stripe(STRIPE_SECRET_KEY ?? '', {
    apiVersion: '2025-02-24.acacia' as any,
    typescript: true,
});