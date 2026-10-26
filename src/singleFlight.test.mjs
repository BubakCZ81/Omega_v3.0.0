import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlightGate } from './singleFlight.ts';

test('allows only one in-flight action until the caller releases its gate', () => {
  const gate = createSingleFlightGate();
  const release = gate.acquire();

  assert.equal(typeof release, 'function');
  assert.equal(gate.acquire(), null);

  release();
  assert.equal(typeof gate.acquire(), 'function');
});

test('releasing a gate more than once does not unlock another action', () => {
  const gate = createSingleFlightGate();
  const firstRelease = gate.acquire();
  assert.equal(typeof firstRelease, 'function');
  firstRelease();

  const secondRelease = gate.acquire();
  assert.equal(typeof secondRelease, 'function');
  firstRelease();
  assert.equal(gate.acquire(), null);

  secondRelease();
  assert.equal(typeof gate.acquire(), 'function');
});
