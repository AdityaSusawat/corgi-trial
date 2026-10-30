import 'reflect-metadata';
import * as readline from 'readline';
import { executeMcpTool, MCP_TOOLS } from '../lib/mcp/tools';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});

function sendResponse(id: string | number | null, result: unknown) {
    process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
    );
}

function sendError(
    id: string | number | null,
    code: number,
    message: string
) {
    process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
    );
}

rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const req = JSON.parse(line);
        const id = req.id ?? null;
        const method = req.method;

        if (method === 'initialize') {
            sendResponse(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false } },
                serverInfo: {
                    name: 'corgi-policy-admin-mcp',
                    version: '1.0.0',
                },
            });
            return;
        }

        if (method === 'notifications/initialized') {
            return;
        }

        if (method === 'tools/list') {
            sendResponse(id, {
                tools: MCP_TOOLS.map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                })),
            });
            return;
        }

        if (method === 'tools/call') {
            const toolName = String(req.params?.name || '');
            const toolArgs = req.params?.arguments || {};
            const out = await executeMcpTool(toolName, toolArgs);
            sendResponse(id, {
                content: out.content,
                isError: Boolean(out.isError),
            });
            return;
        }

        sendError(id, -32601, `Unsupported MCP method: ${method}`);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(null, -32700, msg);
    }
});