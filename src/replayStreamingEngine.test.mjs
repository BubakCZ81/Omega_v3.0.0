import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplayAwareEngine } from './replayStreamingEngine.ts';

function stubEngine(streaming = true) {
  const modes = [];
  const engine = {
    language: 'pine',
    capabilities: { streaming },
    prepare: (source, instanceId) => ({ source, instanceId }),
    execute: request => {
      modes.push(request.mode);
      return { ok: true };
    },
  };
  return { engine, modes };
}

test('replay requests run in live mode so streams stay incremental', () => {
  const { engine, modes } = stubEngine();
  const replayAware = createReplayAwareEngine(engine, () => true);
  replayAware.execute({ mode: 'replay' }, {});
  assert.deepEqual(modes, ['live']);
});

test('non-replay requests keep their original mode', () => {
  const { engine, modes } = stubEngine();
  const replayAware = createReplayAwareEngine(engine, () => false);
  replayAware.execute({ mode: 'replay' }, {});
  replayAware.execute({ mode: 'live' }, {});
  assert.deepEqual(modes, ['replay', 'live']);
});

test('engines without streaming support are never re-routed', () => {
  const { engine, modes } = stubEngine(false);
  const replayAware = createReplayAwareEngine(engine, () => true);
  replayAware.execute({ mode: 'replay' }, {});
  assert.deepEqual(modes, ['replay']);
});

test('prepare and capabilities are forwarded unchanged', () => {
  const { engine } = stubEngine();
  const replayAware = createReplayAwareEngine(engine, () => true);
  assert.equal(replayAware.language, 'pine');
  assert.equal(replayAware.capabilities, engine.capabilities);
  assert.deepEqual(replayAware.prepare('plot(close)', 'i-1'), { source: 'plot(close)', instanceId: 'i-1' });
});
