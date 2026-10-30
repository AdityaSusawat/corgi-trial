/**
 * Pure TypeScript PDF 1.4 Binary Generator
 * Zero external dependencies — 100% compatible with Next.js 16 Edge & Vercel Serverless.
 * Uses built-in PDF Standard Type1 Fonts: F1 (Helvetica), F2 (Helvetica-Bold), F3 (Courier).
 */

export interface PdfLine {
    text: string;
    font?: 'REGULAR' | 'BOLD' | 'MONO';
    size?: number;
    indent?: number;
    spacingAfter?: number;
    color?: 'BLACK' | 'ORANGE' | 'MUTED' | 'GREEN' | 'RED';
    drawRuleBelow?: boolean;
}

function escapePdfText(input: string): string {
    return input
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
}

export function buildPdfBuffer(params: {
    title: string;
    subtitle: string;
    badgeText?: string;
    lines: PdfLine[];
    footerNote?: string;
}): Buffer {
    const pageWidth = 612; // 8.5 in * 72 pt
    const pageHeight = 792; // 11 in * 72 pt
    const marginX = 44;

    const streamCommands: string[] = [];

    // 1. Top Header Banner (Dark Charcoal #111111 with Corgi Orange accent bar)
    streamCommands.push('0.067 0.067 0.067 rg');
    streamCommands.push(`0 ${pageHeight - 78} ${pageWidth} 78 re f`);

    // Orange accent stripe
    streamCommands.push('1.0 0.49 0.196 rg');
    streamCommands.push(`0 ${pageHeight - 82} ${pageWidth} 4 re f`);

    // Header Brand Title
    streamCommands.push('BT');
    streamCommands.push('1 1 1 rg');
    streamCommands.push('/F2 15 Tf');
    streamCommands.push(`${marginX} ${pageHeight - 34} Td`);
    streamCommands.push(`(${escapePdfText(params.title)}) Tj`);
    streamCommands.push('ET');

    // Header Subtitle
    streamCommands.push('BT');
    streamCommands.push('0.82 0.82 0.82 rg');
    streamCommands.push('/F1 9.5 Tf');
    streamCommands.push(`${marginX} ${pageHeight - 52} Td`);
    streamCommands.push(`(${escapePdfText(params.subtitle)}) Tj`);
    streamCommands.push('ET');

    if (params.badgeText) {
        streamCommands.push('BT');
        streamCommands.push('1.0 0.49 0.196 rg');
        streamCommands.push('/F3 8.5 Tf');
        streamCommands.push(`${marginX} ${pageHeight - 67} Td`);
        streamCommands.push(`(${escapePdfText(params.badgeText)}) Tj`);
        streamCommands.push('ET');
    }

    // 2. Render Document Content Lines
    let cursorY = pageHeight - 106;

    for (const line of params.lines) {
        const fontSize = line.size ?? 9.5;
        const indentX = marginX + (line.indent ?? 0);
        const fontKey =
            line.font === 'BOLD' ? '/F2' : line.font === 'MONO' ? '/F3' : '/F1';

        if (cursorY < 55) break; // Single-page statutory summary guard

        if (line.text.trim().length > 0) {
            // Set color
            if (line.color === 'ORANGE') {
                streamCommands.push('0.90 0.40 0.12 rg');
            } else if (line.color === 'MUTED') {
                streamCommands.push('0.42 0.45 0.49 rg');
            } else if (line.color === 'GREEN') {
                streamCommands.push('0.02 0.47 0.34 rg');
            } else if (line.color === 'RED') {
                streamCommands.push('0.75 0.12 0.18 rg');
            } else {
                streamCommands.push('0.07 0.07 0.07 rg');
            }

            streamCommands.push('BT');
            streamCommands.push(`${fontKey} ${fontSize} Tf`);
            streamCommands.push(`${indentX} ${cursorY} Td`);
            streamCommands.push(`(${escapePdfText(line.text)}) Tj`);
            streamCommands.push('ET');
        }

        if (line.drawRuleBelow) {
            const ruleY = cursorY - 5;
            streamCommands.push('0.85 0.86 0.88 RG');
            streamCommands.push('0.75 w');
            streamCommands.push(`${marginX} ${ruleY} m ${pageWidth - marginX} ${ruleY} l S`);
            cursorY -= 6;
        }

        cursorY -= fontSize + (line.spacingAfter ?? 4);
    }

    // 3. Bottom Statutory Footer
    streamCommands.push('0.85 0.86 0.88 RG');
    streamCommands.push('0.75 w');
    streamCommands.push(`${marginX} 42 m ${pageWidth - marginX} 42 l S`);

    const footerText =
        params.footerNote ||
        `Generated dynamically from immutable PostgreSQL ledger & event store | ${new Date().toISOString()}`;

    streamCommands.push('BT');
    streamCommands.push('0.45 0.45 0.45 rg');
    streamCommands.push('/F3 7.5 Tf');
    streamCommands.push(`${marginX} 28 Td`);
    streamCommands.push(`(${escapePdfText(footerText)}) Tj`);
    streamCommands.push('ET');

    const contentStream = streamCommands.join('\n');
    const streamByteLength = Buffer.byteLength(contentStream, 'utf8');

    // Assemble PDF 1.4 Objects and Cross-Reference Table
    const objects: string[] = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>\nendobj`,
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj',
        '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj',
        `7 0 obj\n<< /Length ${streamByteLength} >>\nstream\n${contentStream}\nendstream\nendobj`,
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [0];

    for (const obj of objects) {
        offsets.push(Buffer.byteLength(pdf, 'utf8'));
        pdf += obj + '\n';
    }

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += '0000000000 65535 f \n';

    for (let i = 1; i <= objects.length; i++) {
        const offsetStr = String(offsets[i]).padStart(10, '0');
        pdf += `${offsetStr} 00000 n \n`;
    }

    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, 'utf8');
}