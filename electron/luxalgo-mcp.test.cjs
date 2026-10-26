const test = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_TOOLS, LuxAlgoMcpClient } = require('./luxalgo-mcp.cjs');

const searchTool = {
  name: 'library_search',
  description: 'Search public trading and indicator reference material.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2_000 },
      context: { type: 'string', minLength: 1 },
    },
    required: ['query', 'context'],
    additionalProperties: false,
  },
  securitySchemes: [{ type: 'noauth' }],
};

function rpcResponse(id, result, { sessionId = 'test-session' } = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
  });
}

function makeMcpFetch({ tools = [searchTool], toolResult, status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push({ payload, headers: options.headers });
    if (payload.method === 'initialize') {
      return rpcResponse(payload.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'LuxAlgo', version: '2.1.0' } });
    }
    if (payload.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (status !== 200) return new Response('Server unavailable', { status });
    if (payload.method === 'tools/list') return rpcResponse(payload.id, { tools });
    if (payload.method === 'tools/call') {
      return rpcResponse(payload.id, toolResult ?? { content: [{ type: 'text', text: 'Reference result' }] });
    }
    throw new Error(`Unexpected MCP method: ${payload.method}`);
  };
  return { fetchImpl, requests };
}

test('calls only the selected public read-only LuxAlgo Library tool', async () => {
  const { fetchImpl, requests } = makeMcpFetch();
  const client = new LuxAlgoMcpClient({ fetchImpl });
  const args = {
    query: 'moving average',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  };
  const result = await client.callTool('library_search', args);
  assert.equal(result, 'Reference result');
  const call = requests.find(request => request.payload.method === 'tools/call');
  assert.deepEqual(call.payload.params, { name: 'library_search', arguments: args });
  assert.equal(ALLOWED_TOOLS.has('journal_add_trade'), false);
  assert.equal(requests[0].headers['MCP-Protocol-Version'], undefined);
  assert.equal(requests[1].payload.id, undefined);
  assert.equal(requests.at(-1).headers['MCP-Protocol-Version'], '2025-03-26');
});

test('rejects tools outside the public read-only allowlist without connecting', async () => {
  let calls = 0;
  const client = new LuxAlgoMcpClient({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(client.callTool('journal_add_trade', {}), /not allowed/);
  assert.equal(calls, 0);
});

test('validates arguments against the live MCP tool schema', async () => {
  const { fetchImpl, requests } = makeMcpFetch();
  const client = new LuxAlgoMcpClient({ fetchImpl });
  await assert.rejects(client.callTool('library_search', {
    query: 'ok',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
    unexpected: true,
  }), /not allowed/);
  assert.equal(requests.some(request => request.payload.method === 'tools/call'), false);
});

test('rejects tools declared with non-public security schemes', async () => {
  const protectedTool = { ...searchTool, securitySchemes: [{ type: 'oauth2' }] };
  const { fetchImpl } = makeMcpFetch({ tools: [protectedTool] });
  const client = new LuxAlgoMcpClient({ fetchImpl });
  await assert.rejects(client.callTool('library_search', {
    query: 'test',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  }), /unavailable or requires permissions/);
});

test('reports server errors and malformed tool responses', async () => {
  const failedClient = new LuxAlgoMcpClient({ fetchImpl: async () => new Response('Unavailable', { status: 503 }) });
  await assert.rejects(failedClient.callTool('library_search', {
    query: 'test',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  }), /HTTP 503/);

  const { fetchImpl } = makeMcpFetch({ toolResult: { isError: true, content: [{ type: 'text', text: 'Request rejected' }] } });
  const client = new LuxAlgoMcpClient({ fetchImpl });
  await assert.rejects(client.callTool('library_search', {
    query: 'test',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  }), /Request rejected/);
});

test('propagates request cancellation and bounds response size', async () => {
  const controller = new AbortController();
  controller.abort();
  const cancelledClient = new LuxAlgoMcpClient({
    fetchImpl: async (_url, options) => {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response(null);
    },
  });
  await assert.rejects(cancelledClient.callTool('library_search', {
    query: 'test',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  }, controller.signal), /cancelled/);

  const client = new LuxAlgoMcpClient({ fetchImpl: async () => new Response('x'.repeat(1_000_001)) });
  await assert.rejects(client.callTool('library_search', {
    query: 'test',
    context: 'Searching public trading concepts and indicators to provide reference material for technical analysis.',
  }), /size limit/);
});
