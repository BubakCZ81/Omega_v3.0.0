import assert from 'node:assert/strict';
import test from 'node:test';
import { indicatorMatchScore, rankIndicatorMatches } from './indicatorSearch.ts';

const fields = item => ({
  name: item.name,
  category: item.category,
  collections: item.collections,
  description: item.description,
});

const items = [
  { name: 'On Balance Volume', category: 'Volume' },
  { name: 'MACD', category: 'Oscillators', description: 'Momentum study unrelated to traded volume.' },
  { name: 'Volume Profile', category: 'Volume' },
  { name: 'Klinger Oscillator', category: 'Volume', description: 'Compares volume force over two periods.' },
  { name: 'Volume', category: 'Volume' },
  { name: 'VWAP', category: 'Volume', collections: ['Intraday'] },
  { name: 'Trend Reversal', category: 'Trend', description: 'Marks a potential reversal using swing structure.' },
];

test('name matches rank ahead of category and description matches', () => {
  const ranked = rankIndicatorMatches(items, 'volume', fields).map(item => item.name);
  assert.deepEqual(ranked, [
    'Volume',
    'Volume Profile',
    'On Balance Volume',
    'Klinger Oscillator',
    'VWAP',
  ]);
});

test('description-only matches are dropped when the name matches', () => {
  const ranked = rankIndicatorMatches(items, 'volume', fields).map(item => item.name);
  assert.ok(!ranked.includes('MACD'));
});

test('description matches are still used when nothing else matches', () => {
  const ranked = rankIndicatorMatches(items, 'reversal', fields).map(item => item.name);
  assert.deepEqual(ranked, ['Trend Reversal']);
  const fallback = rankIndicatorMatches(items, 'swing', fields).map(item => item.name);
  assert.deepEqual(fallback, ['Trend Reversal']);
});

test('multi-word queries require every token and prefer the exact phrase', () => {
  assert.deepEqual(rankIndicatorMatches(items, 'volume profile', fields).map(item => item.name), ['Volume Profile']);
  assert.deepEqual(rankIndicatorMatches(items, 'balance volume', fields).map(item => item.name), ['On Balance Volume']);
  // Tokens may match different fields: MACD's description mentions volume.
  assert.deepEqual(rankIndicatorMatches(items, 'volume macd', fields).map(item => item.name), ['MACD']);
});

test('scores reflect the match tier', () => {
  assert.equal(indicatorMatchScore({ name: 'Volume' }, 'volume'), 0);
  assert.equal(indicatorMatchScore({ name: 'Volume Profile' }, 'volume'), 1);
  assert.equal(indicatorMatchScore({ name: 'On Balance Volume' }, 'volume'), 2);
  assert.equal(indicatorMatchScore({ name: 'Relative Volume' }, 'volume'), 2);
  assert.equal(indicatorMatchScore({ name: 'Klinger Oscillator', category: 'Volume' }, 'volume'), 4);
  assert.equal(indicatorMatchScore({ name: 'MACD', description: 'uses volume' }, 'volume'), 6);
  // Embedded (non-word-start) description match is the weakest tier.
  assert.equal(indicatorMatchScore({ name: 'MACD', description: 'xvolume channel' }, 'volume'), 7);
  assert.equal(indicatorMatchScore({ name: 'MACD' }, 'volume'), null);
});

test('empty and whitespace queries preserve the original order', () => {
  assert.deepEqual(rankIndicatorMatches(items, '', fields), items);
  assert.deepEqual(rankIndicatorMatches(items, '   ', fields), items);
});

test('matching is case insensitive and ignores punctuation', () => {
  assert.deepEqual(rankIndicatorMatches(items, 'VOLUME', fields).slice(0, 1).map(item => item.name), ['Volume']);
  assert.deepEqual(rankIndicatorMatches(items, 'on-balance', fields).map(item => item.name), ['On Balance Volume']);
});
