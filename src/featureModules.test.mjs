import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootWithOptionalModules,
  isOptionalModuleEnabled,
  loadOptionalModule,
  optionalModuleIds,
} from './featureModules.ts';

test('the optional module catalogue contains unique module identifiers', () => {
  assert.equal(new Set(optionalModuleIds).size, optionalModuleIds.length);
  assert.ok(optionalModuleIds.includes('backtest'));
  assert.ok(optionalModuleIds.includes('neural-network'));
});

test('disableModules supports repeated, comma-separated, case-insensitive values', () => {
  assert.equal(isOptionalModuleEnabled('backtest', '?disableModules=broker,BACKTEST'), false);
  assert.equal(isOptionalModuleEnabled('news', '?disableModules=broker&disableModules=news'), false);
  assert.equal(isOptionalModuleEnabled('broker', '?disableModules=backtester'), true);
});

test('disabled optional modules do not invoke their loader', async () => {
  let loaded = false;
  const result = await loadOptionalModule('backtest', async () => {
    loaded = true;
    return 'module';
  }, '?disableModules=backtest');

  assert.deepEqual(result, { enabled: false });
  assert.equal(loaded, false);
});

test('module load failures are reported and disable only that module', async () => {
  const failure = new Error('module failed');
  const reports = [];
  const result = await loadOptionalModule('broker', async () => {
    throw failure;
  }, '', (message, error) => reports.push({ message, error }));

  assert.deepEqual(result, { enabled: false });
  assert.deepEqual(reports, [{ message: 'Optional broker module failed to load:', error: failure }]);
});

test('core startup waits for optional module boot tasks', async () => {
  const sequence = [];
  const result = await bootWithOptionalModules([
    Promise.resolve().then(() => sequence.push('module')),
  ], () => {
    sequence.push('core');
    return 'started';
  });

  assert.deepEqual(sequence, ['module', 'core']);
  assert.equal(result, 'started');
});
