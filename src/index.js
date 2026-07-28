#!/usr/bin/env node
// MCP server exposing the AZ AL Dev Tools Roslyn engine as tools.
//
// Talks MCP (newline-delimited JSON) on its own stdio, and LSP-framed JSON-RPC
// to a child AZALDevToolsServer process. All logging goes to stderr -- stdout is
// the MCP channel and must not be polluted.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { DevToolsServer, discoverPaths } from './devtools.js';
import { buildTools } from './tools.js';

const VERBOSE = process.env.AL_MCP_VERBOSE === '1';
const IDLE_MS = Number(process.env.AL_MCP_IDLE_MS ?? 5 * 60_000);

function log(message) {
  if (VERBOSE) process.stderr.write(`[al-devtools-mcp] ${message}\n`);
}

// Fail fast with an actionable message rather than on the first tool call.
try {
  const { devtoolsPath, alPath } = discoverPaths();
  log(`dev tools: ${devtoolsPath}`);
  log(`al language: ${alPath}`);
} catch (err) {
  process.stderr.write(`[al-devtools-mcp] startup check failed: ${err.message}\n`);
}

const devtools = new DevToolsServer({ idleTimeoutMs: IDLE_MS, log });
const tools = buildTools(devtools);
const byName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  { name: 'al-devtools', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const tool = byName.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  const started = Date.now();
  try {
    const result = await tool.handler(args);
    log(`${name} ok in ${Date.now() - started}ms`);
    return { content: [{ type: 'text', text: result.text }] };
  } catch (err) {
    log(`${name} failed in ${Date.now() - started}ms: ${err.message}`);
    return { content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (idle shutdown ${IDLE_MS}ms)`);
