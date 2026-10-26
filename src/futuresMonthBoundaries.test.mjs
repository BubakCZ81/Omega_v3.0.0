import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFuturesMonthBoundaries } from './futuresMonthBoundaries.ts';

test('boundaries start at the first of each UTC month inside the range', () => {
  const boundaries = buildFuturesMonthBoundaries(Date.UTC(2024, 0, 15), Date.UTC(2024, 2, 15));
  assert.deepEqual(boundaries.map(boundary => boundary.time), [
    Date.UTC(2024, 1, 1),
    Date.UTC(2024, 2, 1),
  ]);
  assert.deepEqual(boundaries.map(boundary => boundary.label), [
    'FEB START / JAN END',
    'MAR START / FEB END',
  ]);
});

test('a range that starts exactly on a month boundary includes that month', () => {
  const boundaries = buildFuturesMonthBoundaries(Date.UTC(2024, 1, 1), Date.UTC(2024, 1, 2));
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].time, Date.UTC(2024, 1, 1));
});

test('year rollover produces a January boundary labelled after December', () => {
  const boundaries = buildFuturesMonthBoundaries(Date.UTC(2024, 11, 10), Date.UTC(2025, 0, 10));
  assert.deepEqual(boundaries, [{ time: Date.UTC(2025, 0, 1), label: 'JAN START / DEC END' }]);
});

test('invalid or inverted ranges return no boundaries', () => {
  assert.deepEqual(buildFuturesMonthBoundaries(Number.NaN, 1), []);
  assert.deepEqual(buildFuturesMonthBoundaries(10, 5), []);
  assert.deepEqual(buildFuturesMonthBoundaries(Date.UTC(2024, 0, 15), Date.UTC(2024, 0, 20)), []);
});
