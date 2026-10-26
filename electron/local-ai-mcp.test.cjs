const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalAiAssistant } = require('./local-ai.cjs');

function makeAssistant({ libraryResult = 'LuxAlgo reference', fetchImpl } = {}) {
  let libraryCalls = 0;
  const assistant = new LocalAiAssistant({
    safeStorage: null,
    storagePath: '',
    fetchImpl: fetchImpl ?? (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'AI response' } }],
    }), { headers: { 'content-type': 'application/json' } })),
    luxalgoMcpClient: {
      callTool: async (name, args) => {
        libraryCalls += 1;
        assert.equal(name, 'library_search');
        assert.match(args.query, /moving average/);
        assert.equal(args.context.split(/\s+/).length >= 15, true);
        return libraryResult;
      },
    },
  });
  assistant.apiKey = async () => 'test-key';
  return { assistant, libraryCalls: () => libraryCalls };
}

const request = useLuxAlgoMcp => ({
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  prompt: 'Explain this moving average strategy.',
  source: 'strategy source',
  scriptName: 'Test strategy',
  useLuxAlgoMcp,
});

test('includes explicit LuxAlgo Library results as untrusted AI context when enabled', async () => {
  let sentRequest;
  const { assistant, libraryCalls } = makeAssistant({
    fetchImpl: async (_url, options) => {
      sentRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'AI response' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await assistant.complete(request(true));
  assert.equal(result.text, 'AI response');
  assert.equal(libraryCalls(), 1);
  assert.match(sentRequest.messages[1].content, /LuxAlgo Library reference from MCP/);
  assert.match(sentRequest.messages[1].content, /LuxAlgo reference/);
  assert.match(sentRequest.messages[1].content, /strategy source/);
});

test('does not call MCP when the opt-in is disabled and rejects invalid setting values', async () => {
  const { assistant, libraryCalls } = makeAssistant();
  await assistant.complete(request(false));
  assert.equal(libraryCalls(), 0);
  await assert.rejects(assistant.complete({ ...request(true), useLuxAlgoMcp: 'yes' }), /Invalid LuxAlgo MCP setting/);
  assert.equal(libraryCalls(), 0);
});

test('accepts localhost model APIs, discovers models and persists the chosen model', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-local-ai-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const assistant = new LocalAiAssistant({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'os_crypt',
      encryptString: value => Buffer.from(value),
      decryptString: value => value,
    },
    storagePath: path.join(directory, 'keys.json'),
    localConfigPath: path.join(directory, 'local.json'),
    luxalgoMcpClient: { callTool: async () => 'reference' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5', name: 'Qwen 2.5' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Local response' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const discovered = await assistant.testLocalConfig({ baseUrl: 'http://localhost:1234/v1' });
  assert.deepEqual(discovered.models, [{ id: 'qwen2.5', name: 'Qwen 2.5' }]);
  const saved = await assistant.saveLocalConfig({
    baseUrl: 'http://localhost:1234/v1',
    model: 'qwen2.5',
    apiKey: 'local-secret',
  });
  assert.equal(saved.hasApiKey, true);
  const diskConfig = JSON.parse(await fs.readFile(path.join(directory, 'local.json'), 'utf8'));
  assert.equal(diskConfig.encryptedApiKey, Buffer.from('local-secret').toString('base64'));
  const result = await assistant.complete({
    provider: 'local',
    model: 'qwen2.5',
    prompt: 'Explain this script.',
    source: 'strategy source',
    scriptName: 'Local test',
  });
  assert.equal(result.text, 'Local response');
  const completion = calls.at(-1);
  assert.equal(completion.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(completion.options.headers.Authorization, 'Bearer local-secret');
  assert.equal(JSON.parse(completion.options.body).model, 'qwen2.5');
  await assistant.saveLocalConfig({ baseUrl: saved.baseUrl, model: saved.model, clearApiKey: true });
  const cleared = JSON.parse(await fs.readFile(path.join(directory, 'local.json'), 'utf8'));
  assert.equal(cleared.encryptedApiKey, '');
});

test('rejects non-loopback endpoints before sending any request', async () => {
  let calls = 0;
  const assistant = new LocalAiAssistant({
    safeStorage: null,
    storagePath: '',
    localConfigPath: '',
    fetchImpl: async () => { calls += 1; },
  });
  for (const baseUrl of ['https://localhost:1234/v1', 'http://example.com/v1', 'http://127.0.0.1.attacker.test/v1']) {
    await assert.rejects(assistant.testLocalConfig({ baseUrl }), /must use plain HTTP on localhost/);
  }
  assert.equal(calls, 0);
});
