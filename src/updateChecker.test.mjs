import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, fetchLatestStableVersion, parseStableVersion } from './updateChecker.ts';

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const implementation = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => payload };
  };
  implementation.calls = calls;
  return implementation;
}

test('parseStableVersion accepts three-part versions with an optional v prefix', () => {
  assert.deepEqual(parseStableVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseStableVersion(' 0.13.0 '), [0, 13, 0]);
  assert.equal(parseStableVersion('1.2'), null);
  assert.equal(parseStableVersion('v01.2.3'), null);
  assert.equal(parseStableVersion('1.2.3-beta.1'), null);
  assert.equal(parseStableVersion('release-1.2.3'), null);
});

test('compareVersions orders semantic versions and rejects invalid input', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
  assert.ok(compareVersions('1.2.3', '1.10.0') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.throws(() => compareVersions('1.2', '1.2.3'), /stable three-part/);
});

test('fetchLatestStableVersion picks the highest stable tag and skips prereleases', async () => {
  const fetchImpl = fakeFetch([
    { name: 'v0.9.0' },
    { name: 'v1.0.0' },
    { name: 'v1.2.0-beta.1' },
    { name: 'v1.1.5' },
    { name: 'not-a-version' },
    { name: 42 },
    null,
  ]);
  const latest = await fetchLatestStableVersion('LuxAlgo/PineTS', fetchImpl);
  assert.equal(latest, '1.1.5');
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.github\.com\/repos\/LuxAlgo\/PineTS\/tags\?per_page=100$/);
  assert.equal(fetchImpl.calls[0].options.headers.Accept, 'application/vnd.github+json');
});

test('fetchLatestStableVersion surfaces provider failures', async () => {
  await assert.rejects(() => fetchLatestStableVersion('LuxAlgo/Vela', fakeFetch([], { ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(() => fetchLatestStableVersion('LuxAlgo/Vela', fakeFetch({ tags: [] })), /invalid tags response/);
  await assert.rejects(() => fetchLatestStableVersion('LuxAlgo/Vela', fakeFetch([{ name: 'nightly' }])), /No stable semantic-version tags/);
});
