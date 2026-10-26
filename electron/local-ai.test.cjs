const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalAiAssistant, PROVIDERS } = require('./local-ai.cjs');

function createAssistant(fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-local-ai-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: buffer => buffer.toString().replace(/^enc:/, ''),
  };
  const assistant = new LocalAiAssistant({
    safeStorage,
    storagePath: path.join(directory, 'ai-keys.json'),
    localConfigPath: path.join(directory, 'local-ai.json'),
    fetchImpl: fetchImpl ?? (() => { throw new Error('network should not be used'); }),
  });
  return { assistant, directory };
}

test('exposes the supported providers plus the local endpoint', async () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['gemini', 'groq', 'openrouter', 'anthropic', 'cohere', 'deepseek', 'mistral', 'together']);
  const { assistant } = createAssistant();
  const providers = await assistant.configuredProviders();
  assert.equal(providers.length, Object.keys(PROVIDERS).length + 1);
  assert.deepEqual(providers.at(-1), { id: 'local', name: 'Local OpenAI-compatible API', configured: false });
});

test('localConfig returns documented defaults when nothing is saved', async () => {
  const { assistant } = createAssistant();
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:1234/v1', model: '', hasApiKey: false });
});

test('saveLocalConfig normalises localhost URLs and persists them', async () => {
  const { assistant, directory } = createAssistant();
  const saved = await assistant.saveLocalConfig({ baseUrl: 'HTTP://127.0.0.1:1234/v1/', model: 'qwen2.5-coder' });
  assert.deepEqual(saved, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-coder', hasApiKey: false });
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-coder', hasApiKey: false });
  assert.equal(fs.existsSync(path.join(directory, 'local-ai.json')), true);

  const localhost = await assistant.saveLocalConfig({ baseUrl: 'http://localhost:1234', model: 'm' });
  assert.equal(localhost.baseUrl, 'http://localhost:1234/v1');
});

test('saveLocalConfig rejects non-local, insecure or ambiguous endpoints', async () => {
  const { assistant } = createAssistant();
  const cases = [
    'https://127.0.0.1:1234/v1',
    'http://example.com/v1',
    'http://user:pass@127.0.0.1:1234/v1',
    'http://127.0.0.1:1234/v1?key=1',
    'http://127.0.0.1:1234/v1#fragment',
    'not a url',
  ];
  for (const baseUrl of cases) {
    await assert.rejects(
      () => assistant.saveLocalConfig({ baseUrl, model: 'm' }),
      /localhost|valid localhost API URL/,
      baseUrl,
    );
  }
  await assert.rejects(() => assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: '' }), /model name/);
});

test('local API keys are encrypted on disk and reported as configured', async () => {
  const { assistant, directory } = createAssistant();
  const saved = await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: 'sk-local-secret' });
  assert.equal(saved.hasApiKey, true);
  const raw = fs.readFileSync(path.join(directory, 'local-ai.json'), 'utf8');
  assert.doesNotMatch(raw, /sk-local-secret/);
  assert.match(raw, /"version":1/);

  const cleared = await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', clearApiKey: true });
  assert.equal(cleared.hasApiKey, false);
});

test('testLocalConfig loads OpenAI-compatible models over plain HTTP', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
          { id: 'llama-3.1', name: null },
          { id: 42 },
          { id: 'x'.repeat(200) },
        ],
      }),
    };
  });

  const result = await assistant.testLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1' });
  assert.deepEqual(result, {
    models: [{ id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' }, { id: 'llama-3.1', name: 'llama-3.1' }],
    defaultModel: 'qwen2.5-coder',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(calls[0].options.redirect, 'error');
});

test('readLocalConfig refuses unsupported settings files', async () => {
  const { assistant, directory } = createAssistant();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'local-ai.json'), JSON.stringify({ version: 2, baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', encryptedApiKey: '' }));
  await assert.rejects(() => assistant.readLocalConfig(), /unsupported format/);
});

test('a corrupt key or endpoint store can be repaired from the app', async () => {
  const { assistant, directory } = createAssistant();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ai-keys.json'), '{ this is not json');
  fs.writeFileSync(path.join(directory, 'local-ai.json'), 'not json either');

  // Reading still succeeds and reports everything as unconfigured.
  const providers = await assistant.configuredProviders();
  assert.equal(providers.find(provider => provider.id === 'gemini').configured, false);
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:1234/v1', model: '', hasApiKey: false });

  // Saving rewrites both stores, so the user can recover without deleting files.
  await assistant.saveKey('groq', 'gsk-test-key');
  const repaired = await assistant.configuredProviders();
  assert.equal(repaired.find(provider => provider.id === 'groq').configured, true);
  await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' });
  assert.equal((await assistant.localConfig()).model, 'qwen');

  // Clearing also succeeds against the repaired store.
  const cleared = await assistant.clearKey('groq');
  assert.equal(cleared.find(provider => provider.id === 'groq').configured, false);
});
