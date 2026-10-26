import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTradingSessionStatus, getOpenTradingSessions } from './tradingSessions.ts';

test('lists Asia-Pacific sessions by their local weekday hours', () => {
  const now = new Date('2026-01-12T01:00:00Z');

  assert.deepEqual(getOpenTradingSessions(now), ['Wellington', 'Sydney', 'Tokyo', 'Singapore']);
  assert.equal(
    formatTradingSessionStatus(getOpenTradingSessions(now)),
    'Trading sessions: Wellington, Sydney, Tokyo, Singapore',
  );
});

test('shows the London and New York overlap', () => {
  const now = new Date('2026-01-12T15:00:00Z');

  assert.deepEqual(getOpenTradingSessions(now), ['London', 'New York']);
  assert.equal(formatTradingSessionStatus(getOpenTradingSessions(now)), 'Trading sessions: London–New York overlap');
});

test('observes daylight-saving time and excludes weekends', () => {
  const duringNewYorkDaylightTime = new Date('2026-03-09T12:00:00Z');
  const saturday = new Date('2026-01-10T15:00:00Z');

  assert.deepEqual(getOpenTradingSessions(duringNewYorkDaylightTime), ['London', 'New York']);
  assert.deepEqual(getOpenTradingSessions(saturday), []);
  assert.equal(formatTradingSessionStatus([]), 'No major trading sessions open');
});
