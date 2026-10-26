import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreWorkspaceScriptIndicators, snapshotWorkspaceScriptIndicators } from './workspaceScriptIndicators.ts';

function indicator(overrides = {}) {
  return {
    id: 'local-script:My%20Script',
    title: 'My Script',
    source: '//@version=6\nindicator("My Script")',
    visible: true,
    ...overrides,
  };
}

test('snapshot keeps only app-managed script indicators with known sources', () => {
  const snapshot = snapshotWorkspaceScriptIndicators([
    indicator({ inputValues: () => ({ length: 20, enabled: true, label: 'fast', nested: { skip: true } }), propValues: () => ({ color: 'red' }) }),
    indicator({ id: 'browser:indicator-1', title: 'Browser', source: '//@version=6\nindicator("Browser")' }),
    indicator({ id: 'native:rsi', title: 'RSI' }),
    indicator({ id: 'local-script:no-source', title: 'Missing', source: undefined }),
  ]);

  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot[0], {
    id: 'local-script:My%20Script',
    name: 'My Script',
    script: '//@version=6\nindicator("My Script")',
    language: 'pine',
    inputs: { length: 20, enabled: true, label: 'fast' },
    props: { color: 'red' },
  });
  assert.equal(snapshot[1].id, 'browser:indicator-1');
  assert.equal(snapshot[1].inputs, undefined);
});

test('snapshot marks hidden indicators and omits empty input maps', () => {
  const [entry] = snapshotWorkspaceScriptIndicators([
    indicator({ visible: false, inputValues: () => ({}), propValues: () => ({ nested: [] }) }),
  ]);
  assert.equal(entry.hidden, true);
  assert.equal(entry.inputs, undefined);
  assert.equal(entry.props, undefined);
});

test('restore replaces app indicators and ignores malformed payload entries', () => {
  const removed = [];
  const added = [];
  restoreWorkspaceScriptIndicators([
    { id: 'local-script:A', name: 'A', script: '//@version=6\nindicator("A")', language: 'pine', inputs: { length: 10 } },
    { id: 'local-script:B', name: 'B', script: '//@version=6\nindicator("B")', language: 'pine', hidden: true },
    { id: 'native:rsi', name: 'Not a script', script: 'x', language: 'pine' },
    { id: 'local-script:C', name: 'Wrong language', script: 'x', language: 'javascript' },
    { id: 'local-script:D', name: 'Missing script', language: 'pine' },
    null,
    'nope',
  ], {
    chart: {
      indicators: () => [
        { id: 'local-script:Old', title: 'Old', source: 'x', remove: () => removed.push('local-script:Old') },
        { id: 'native:rsi', title: 'RSI', remove: () => removed.push('native:rsi') },
      ],
    },
    addIndicator: entry => added.push(entry),
  });

  assert.deepEqual(removed, ['local-script:Old']);
  assert.deepEqual(added, [
    { id: 'local-script:A', name: 'A', script: '//@version=6\nindicator("A")', language: 'pine', inputs: { length: 10 } },
    { id: 'local-script:B', name: 'B', script: '//@version=6\nindicator("B")', language: 'pine', hidden: true },
  ]);
});

test('restore tolerates a non-array payload', () => {
  const added = [];
  restoreWorkspaceScriptIndicators({ id: 'local-script:A' }, {
    chart: { indicators: () => [] },
    addIndicator: entry => added.push(entry),
  });
  assert.deepEqual(added, []);
});
