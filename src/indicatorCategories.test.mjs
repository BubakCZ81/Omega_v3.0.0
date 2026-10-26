import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndicatorCategoryList, popularIndicatorCategories } from './indicatorCategories.ts';

test('keeps primary and popular indicator categories pinned in a stable order', () => {
  const categories = buildIndicatorCategoryList(['Statistics', 'Trend', 'Research']);

  assert.deepEqual(categories.slice(0, 5), ['Discover', 'Favorites', 'My Scripts', 'All scripts', 'Built-in']);
  assert.deepEqual(categories.slice(5, 12), [...popularIndicatorCategories]);
});

test('retains catalog-specific categories without duplicates', () => {
  const categories = buildIndicatorCategoryList(['Statistics', 'Research', 'Moving Averages']);

  assert.deepEqual(categories.slice(-2), ['Statistics', 'Research']);
  assert.equal(categories.filter(category => category === 'Moving Averages').length, 1);
});
