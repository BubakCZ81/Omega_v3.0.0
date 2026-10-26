import assert from 'node:assert/strict';
import test from 'node:test';
import { favoriteDrawingToolTypes } from './drawingToolFavorites.ts';

test('keeps only the starred drawing tools in starring order', () => {
  assert.deepEqual(
    favoriteDrawingToolTypes(['trendline', 'box', 'fibretracement']),
    ['trendline', 'box', 'fibretracement'],
  );
});

test('drops blanks and duplicates', () => {
  assert.deepEqual(
    favoriteDrawingToolTypes(['trendline', ' ', 'trendline', 'box', '']),
    ['trendline', 'box'],
  );
});

test('empty favorites stay empty instead of falling back to every tool', () => {
  assert.deepEqual(favoriteDrawingToolTypes([]), []);
});
