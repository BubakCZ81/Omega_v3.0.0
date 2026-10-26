const ENDPOINT = 'https://mcp.luxalgo.com/mcp';
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY_LENGTH = 1_000_000;
const MAX_TOOL_RESULT_LENGTH = 50_000;
const MAX_ARGUMENT_LENGTH = 12_000;
const REQUEST_TIMEOUT_MS = 30_000;

const ALLOWED_TOOLS = new Set([
  'library_search',
  'library_get_concept',
  'library_get_indicator',
  'library_get_source_code',
  'library_list_concepts',
  'library_list_indicators',
  'library_list_families',
  'library_get_family',
  'edge_symbols',
  'edge_presets',
  'edge_report',
  'trackers_datasets',
  'trackers_query',
  'trackers_latest',
  'trackers_ticker',
  'propfirms_list_simulatable',
  'propfirms_challenge_rules',
  'propfirms_simulate',
  'propfirms_simulate_trades',
  'propfirms_optimal_risk',
  'propfirms_compare',
  'propfirms_pass_rates',
  'propfirms_validate_strategy',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSchema(schema, depth = 0) {
  if (!isRecord(schema) || depth > 12) return false;
  if (schema.type && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) return false;
  if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.length > 100)) return false;
  if (schema.type === 'object') {
    if (schema.properties !== undefined && !isRecord(schema.properties)) return false;
    if (schema.required !== undefined
      && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))) return false;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!key || key.length > 100 || !validateSchema(property, depth + 1)) return false;
    }
  }
  if (schema.type === 'array' && schema.items !== undefined && !validateSchema(schema.items, depth + 1)) return false;
  return true;
}

function validateValue(value, schema, path = 'arguments', depth = 0) {
  if (depth > 12) throw new TypeError(`${path} is nested too deeply.`);
  const type = schema.type;
  const validType = !type
    || (type === 'object' && isRecord(value))
    || (type === 'array' && Array.isArray(value))
    || (type === 'string' && typeof value === 'string')
    || (type === 'number' && typeof value === 'number' && Number.isFinite(value))
    || (type === 'integer' && Number.isSafeInteger(value))
    || (type === 'boolean' && typeof value === 'boolean')
    || (type === 'null' && value === null);
  if (!validType) throw new TypeError(`${path} does not match the tool's input schema.`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    throw new TypeError(`${path} is not an allowed value.`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new TypeError(`${path} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new TypeError(`${path} is too long.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new TypeError(`${path} is below the allowed minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new TypeError(`${path} is above the allowed maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new TypeError(`${path} has too many items.`);
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw new TypeError(`${path}.${unknown} is not allowed by the tool's input schema.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateValue(item, properties[key], `${path}.${key}`, depth + 1);
    }
  }
}

function isPublicTool(tool) {
  if (!isRecord(tool) || typeof tool.name !== 'string' || !ALLOWED_TOOLS.has(tool.name)) return false;
  if (typeof tool.description !== 'string' || tool.description.length > 2_000) return false;
  if (!validateSchema(tool.inputSchema)) return false;
  const schemes = tool.securitySchemes;
  if (Array.isArray(schemes) && schemes.some((scheme) => !isRecord(scheme) || scheme.type !== 'noauth')) return false;
  return true;
}

function parseRpcResponse(text, contentType, expectedId) {
  let payloads;
  if (contentType?.includes('text/event-stream')) {
    payloads = text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return [];
      try {
        return [JSON.parse(data)];
      } catch {
        throw new Error('LuxAlgo MCP returned an invalid event-stream response.');
      }
    });
  } else {
    try {
      payloads = [JSON.parse(text)];
    } catch {
      throw new Error('LuxAlgo MCP returned an invalid JSON response.');
    }
  }
  const result = payloads.find((payload) => payload && payload.id === expectedId);
  if (!result) throw new Error('LuxAlgo MCP did not return the expected response.');
  if (result.error) {
    const message = typeof result.error.message === 'string' ? result.error.message.slice(0, 500) : 'MCP request failed.';
    throw new Error(`LuxAlgo MCP: ${message}`);
  }
  return result.result;
}

class LuxAlgoMcpClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.sessionId = '';
    this.protocolVersion = '';
    this.nextId = 1;
    this.initializing = null;
  }

  async readLimited(response) {
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > MAX_BODY_LENGTH) throw new Error('LuxAlgo MCP response exceeded the size limit.');
      return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_LENGTH) {
          await reader.cancel();
          throw new Error('LuxAlgo MCP response exceeded the size limit.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async post(payload, signal, notification = false) {
    if (typeof this.fetchImpl !== 'function') throw new Error('LuxAlgo MCP requests are unavailable in this runtime.');
    const id = this.nextId++;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}),
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), ...payload }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('LuxAlgo MCP request cancelled.');
      if (error?.name === 'TimeoutError') throw new Error('LuxAlgo MCP request timed out.');
      throw new Error(`Could not connect to LuxAlgo MCP: ${String(error?.message ?? error).slice(0, 300)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`LuxAlgo MCP rejected the public request (HTTP ${response.status}). This integration does not sign in.`);
    }
    if (!response.ok) throw new Error(`LuxAlgo MCP returned HTTP ${response.status}.`);
    const sessionId = response.headers?.get?.('Mcp-Session-Id');
    if (sessionId) this.sessionId = sessionId;
    if (notification || response.status === 202) return null;
    const text = await this.readLimited(response);
    return parseRpcResponse(text, response.headers?.get?.('content-type') ?? '', id);
  }

  async ensureInitialized(signal) {
    if (this.sessionId) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        const result = await this.post({
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'Omega', version: '2.7.0' },
          },
        }, signal);
        if (!isRecord(result) || typeof result.protocolVersion !== 'string') {
          throw new Error('LuxAlgo MCP returned an invalid initialization response.');
        }
        this.protocolVersion = result.protocolVersion;
        await this.post({ method: 'notifications/initialized', params: {} }, signal, true);
      })().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  async listTools(signal) {
    await this.ensureInitialized(signal);
    const result = await this.post({ method: 'tools/list', params: {} }, signal);
    if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error('LuxAlgo MCP returned an invalid tool list.');
    return result.tools.filter(isPublicTool).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  async callTool(name, args, signal) {
    if (typeof name !== 'string' || !ALLOWED_TOOLS.has(name)) throw new TypeError('That LuxAlgo MCP tool is not allowed in Omega.');
    if (!isRecord(args)) throw new TypeError('Tool arguments must be a JSON object.');
    if (JSON.stringify(args).length > MAX_ARGUMENT_LENGTH) throw new TypeError('Tool arguments are too large.');
    const tools = await this.listTools(signal);
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error('This tool is unavailable or requires permissions that Omega does not request.');
    validateValue(args, tool.inputSchema);
    const result = await this.post({ method: 'tools/call', params: { name, arguments: args } }, signal);
    if (!isRecord(result) || !Array.isArray(result.content)) throw new Error('LuxAlgo MCP returned an invalid tool result.');
    const text = result.content
      .filter((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
    if (result.isError) throw new Error(`LuxAlgo MCP tool failed: ${text.slice(0, 500) || 'Unknown tool error.'}`);
    if (!text) throw new Error('LuxAlgo MCP returned no readable text for this tool.');
    if (text.length > MAX_TOOL_RESULT_LENGTH) throw new Error('LuxAlgo MCP tool output exceeded the 50,000-character limit.');
    return text;
  }
}

module.exports = { ALLOWED_TOOLS, LuxAlgoMcpClient, isPublicTool, validateValue };
