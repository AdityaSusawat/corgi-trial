import 'reflect-metadata';
import { NextResponse } from 'next/server';
import { runReconciliationJob } from '@/lib/services/reconciliation-service';

export async function POST() {
    try {
        const summary = await runReconciliationJob();
        return NextResponse.json(summary);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[RECONCILIATION_RUN_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}