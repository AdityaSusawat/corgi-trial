import 'reflect-metadata';
import { NextRequest, NextResponse } from 'next/server';
import { executeMcpTool, MCP_TOOLS } from '@/lib/mcp/tools';

const SERVER_INFO = {
    name: 'corgi-policy-admin-mcp',
    version: '1.0.0',
    protocolVersion: '2024-11-05',
    description:
        'Corgi Commercial Insurance Policy Administration & Double-Entry Ledger MCP Server (3 Read Tools + 1 Maker-Checker Gated Write Tool)',
};

export async function GET() {
    return NextResponse.json({
        jsonrpc: '2.0',
        serverInfo: SERVER_INFO,
        capabilities: {
            tools: { listChanged: false },
        },
        tools: MCP_TOOLS,
    });
}

export async function POST(req: NextRequest) {
    let body: {
        jsonrpc?: string;
        id?: string | number | null;
        method?: string;
        params?: Record<string, unknown>;
    } = {};

    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error: Invalid JSON payload' },
            },
            { status: 400 }
        );
    }

    const rpcId = body.id ?? 1;
    const method = body.method;

    try {
        if (method === 'initialize') {
            return NextResponse.json({
                jsonrpc: '2.0',
                id: rpcId,
                result: {
                    protocolVersion: SERVER_INFO.protocolVersion,
                    capabilities: {
                        tools: { listChanged: false },
                    },
                    serverInfo: {
                        name: SERVER_INFO.name,
                        version: SERVER_INFO.version,
                    },
                },
            });
        }

        if (method === 'notifications/initialized') {
            return NextResponse.json({ jsonrpc: '2.0', id: rpcId, result: {} });
        }

        if (method === 'tools/list') {
            return NextResponse.json({
                jsonrpc: '2.0',
                id: rpcId,
                result: {
                    tools: MCP_TOOLS.map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                    })),
                },
            });
        }

        if (method === 'tools/call') {
            const params = body.params ?? {};
            const toolName = String(params.name || '');
            const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

            const execution = await executeMcpTool(toolName, toolArgs);

            return NextResponse.json({
                jsonrpc: '2.0',
                id: rpcId,
                result: {
                    content: execution.content,
                    isError: Boolean(execution.isError),
                    structuredData: execution.structuredData,
                },
            });
        }

        return NextResponse.json(
            {
                jsonrpc: '2.0',
                id: rpcId,
                error: {
                    code: -32601,
                    message: `Method not found: "${method}". Supported MCP methods: initialize, tools/list, tools/call.`,
                },
            },
            { status: 404 }
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            {
                jsonrpc: '2.0',
                id: rpcId,
                error: { code: -32603, message },
            },
            { status: 500 }
        );
    }
}