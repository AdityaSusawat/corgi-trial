import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import {
    plantTestReconciliationBreak,
    resolveReconciliationBreak,
} from '@/lib/services/reconciliation-service';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        const { scenario } = body;

        const result = await plantTestReconciliationBreak({ scenario });
        return NextResponse.json(result, { status: 201 });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PLANT_BREAK_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const body = await req.json();
        const { breakId } = body;

        if (!breakId) {
            return NextResponse.json(
                { error: 'breakId is required.' },
                { status: 400 }
            );
        }

        const resolved = await resolveReconciliationBreak(breakId);
        return NextResponse.json({ break: resolved });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[RESOLVE_BREAK_ERROR]', message);
        return NextResponse.json({ error: message }, { status: 400 });
    }
}