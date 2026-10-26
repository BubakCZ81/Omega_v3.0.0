import assert from 'node:assert/strict';
import test from 'node:test';
import { clearStartupIndicators } from './startupWorkspaceState.ts';

test('clears only persisted script indicators before workspace startup', () => {
  const source = JSON.stringify({
    version: 1,
    charts: [{ id: 'primary', indicators: { manifest: ['old'], natives: ['old'] }, ext: { 'omega.scriptIndicators': [{ id: 'local-script:x' }], keep: true } }],
  });
  const result = JSON.parse(clearStartupIndicators(source));
  assert.deepEqual(result.charts[0].indicators, { manifest: [], natives: [] });
  assert.equal(result.charts[0].ext['omega.scriptIndicators'], undefined);
  assert.equal(result.charts[0].ext.keep, true);
});

test('leaves invalid or unrelated workspace data unchanged', () => {
  assert.equal(clearStartupIndicators(null), null);
  assert.equal(clearStartupIndicators('not json'), 'not json');
  assert.equal(clearStartupIndicators(JSON.stringify({ version: 2, charts: [] })), JSON.stringify({ version: 2, charts: [] }));
});
