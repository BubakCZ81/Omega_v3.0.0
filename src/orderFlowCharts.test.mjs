import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRangeBars, buildRenkoBricks } from './orderFlowCharts.ts';

function barsFromCloses(closes) {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1];
    return {
      time: index * 60_000,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    };
  });
}

function assertUniformBricks(bricks, boxSize) {
  for (const brick of bricks) {
    assert.ok(Math.abs(Math.abs(brick.close - brick.open) - boxSize) < 1e-9, `brick ${brick.open}->${brick.close} is not one box`);
    assert.equal(brick.high, Math.max(brick.open, brick.close));
    assert.equal(brick.low, Math.min(brick.open, brick.close));
  }
  for (let index = 1; index < bricks.length; index += 1) {
    assert.equal(bricks[index].open, bricks[index - 1].close, 'bricks must connect');
  }
}

test('renko draws two bricks on a two-box reversal and keeps them connected', () => {
  const bricks = buildRenkoBricks(barsFromCloses([100, 101, 102, 100]), {
    mode: 'fixed', source: 'close', boxSize: 1,
  });
  assert.deepEqual(bricks.map(brick => [brick.open, brick.close]), [
    [100, 101],
    [101, 102],
    [102, 101],
    [101, 100],
  ]);
  assertUniformBricks(bricks, 1);
});

test('renko ignores a one-box pullback (classic two-brick reversal)', () => {
  const bricks = buildRenkoBricks(barsFromCloses([100, 101, 102, 101]), {
    mode: 'fixed', source: 'close', boxSize: 1,
  });
  assert.deepEqual(bricks.map(brick => [brick.open, brick.close]), [[100, 101], [101, 102]]);
});

test('renko reverses symmetrically after a downtrend', () => {
  const bricks = buildRenkoBricks(barsFromCloses([102, 101, 100, 102]), {
    mode: 'fixed', source: 'close', boxSize: 1,
  });
  assert.deepEqual(bricks.map(brick => [brick.open, brick.close]), [
    [102, 101],
    [101, 100],
    [100, 101],
    [101, 102],
  ]);
  assertUniformBricks(bricks, 1);
});

test('renko prints one brick per box when price gaps', () => {
  const bricks = buildRenkoBricks(barsFromCloses([100, 105]), {
    mode: 'fixed', source: 'close', boxSize: 1,
  });
  assert.equal(bricks.length, 5);
  assert.deepEqual(bricks.map(brick => brick.close), [101, 102, 103, 104, 105]);
  assertUniformBricks(bricks, 1);
});

test('renko close-only source ignores wicks, OHLC source uses intrabar extremes', () => {
  const source = [
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 60_000, open: 100, high: 101.5, low: 100, close: 100.2 },
  ];
  const closeOnly = buildRenkoBricks(source, { mode: 'fixed', source: 'close', boxSize: 1 });
  assert.equal(closeOnly.length, 0, 'a wick must not print a brick in close-only mode');

  const ohlc = buildRenkoBricks(source, { mode: 'fixed', source: 'ohlc', boxSize: 1 });
  assert.equal(ohlc.length, 1);
  assert.deepEqual([ohlc[0].open, ohlc[0].close], [100, 101]);
});

test('renko brick size can be expressed in pips', () => {
  const bricks = buildRenkoBricks(barsFromCloses([1.1, 1.1005, 1.101, 1.1]), {
    mode: 'pips', source: 'close', brickPips: 5, pipSize: 0.0001,
  });
  assert.deepEqual(bricks.map(brick => [brick.open, brick.close]), [
    [1.1, 1.1005],
    [1.1005, 1.101],
    [1.101, 1.1005],
    [1.1005, 1.1],
  ]);
  assert.ok(Math.abs(bricks[0].close - bricks[0].open - 0.0005) < 1e-9);
});

test('renko rejects invalid pip brick settings', () => {
  const source = barsFromCloses([100, 110]);
  assert.deepEqual(buildRenkoBricks(source, { mode: 'pips', brickPips: 0, pipSize: 1 }), []);
  assert.deepEqual(buildRenkoBricks(source, { mode: 'pips', brickPips: 3001, pipSize: 1 }), []);
  assert.deepEqual(buildRenkoBricks([], { mode: 'fixed', boxSize: 1 }), []);
});

test('range bars decompose the candle path into complete ranges', () => {
  const bars = buildRangeBars([
    { time: 1, open: 100, high: 100, low: 100, close: 100 },
    { time: 2, open: 100, high: 101, low: 99, close: 100 },
  ], { brickPips: 1, pipSize: 1 });

  // The second candle walks open -> low -> high -> close (100 → 99 → 101 → 100),
  // which is four complete one-point range bars rather than one per source candle.
  assert.deepEqual(
    bars.map(bar => [bar.low, bar.high, bar.close]),
    [[99, 100, 99], [99, 100, 100], [100, 101, 101], [100, 101, 100]],
  );
  for (const bar of bars) {
    assert.equal(bar.high - bar.low, 1);
    assert.ok(bar.close === bar.high || bar.close === bar.low);
  }
});

test('range bars stay uniform, connected and close at an extreme', () => {
  const random = (() => {
    let seed = 7;
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
  })();
  const source = [{ time: 0, open: 100, high: 100, low: 100, close: 100 }];
  let price = 100;
  for (let index = 1; index < 80; index += 1) {
    const open = price;
    const close = open + (random() - 0.5) * 4;
    const high = Math.max(open, close) + random() * 1.5;
    const low = Math.min(open, close) - random() * 1.5;
    source.push({ time: index * 60_000, open, high, low, close });
    price = close;
  }

  const rangeSize = 1;
  const bars = buildRangeBars(source, { brickPips: rangeSize, pipSize: 1 });
  assert.ok(bars.length > 0);
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    assert.ok(Math.abs(bar.high - bar.low - rangeSize) < 1e-9, `bar ${index} range`);
    assert.ok(Math.abs(bar.close - bar.high) < 1e-9 || Math.abs(bar.close - bar.low) < 1e-9, `bar ${index} close`);
    if (index > 0) assert.ok(Math.abs(bar.open - bars[index - 1].close) < 1e-9, `bar ${index} open must follow previous close`);
    assert.ok(bar.open >= bar.low - 1e-9 && bar.open <= bar.high + 1e-9, `bar ${index} open inside range`);
  }
});

test('range bars do not print before the full range is covered', () => {
  const bars = buildRangeBars([
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 60_000, open: 100, high: 100.4, low: 99.6, close: 100 },
  ], { brickPips: 1, pipSize: 1 });
  assert.deepEqual(bars, []);
});

test('range bars fill a price gap with consecutive bars', () => {
  const bars = buildRangeBars([
    { time: 0, open: 100, high: 100, low: 100, close: 100 },
    { time: 60_000, open: 105, high: 105, low: 105, close: 105 },
  ], { brickPips: 1, pipSize: 1 });
  assert.deepEqual(bars.map(bar => [bar.low, bar.high]), [
    [100, 101], [101, 102], [102, 103], [103, 104], [104, 105],
  ]);
});

test('range bars ignore flat candles and invalid settings', () => {
  const flat = buildRangeBars([
    { time: 1, open: 100, high: 100, low: 100, close: 100 },
    { time: 2, open: 100, high: 100, low: 100, close: 100 },
  ], { brickPips: 1, pipSize: 1 });
  assert.equal(flat.length, 0);
  assert.deepEqual(buildRangeBars([], { brickPips: 1, pipSize: 1 }), []);
  assert.deepEqual(buildRangeBars([
    { time: 1, open: 1, high: 1, low: 1, close: 1 },
    { time: 2, open: 1, high: 2, low: 1, close: 2 },
  ], { brickPips: 0, customBrickPips: 0 }), []);
});
