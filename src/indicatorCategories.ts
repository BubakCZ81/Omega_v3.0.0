const primaryCategories = [
  'Discover',
  'Favorites',
  'My Scripts',
  'All scripts',
  'Built-in',
] as const;

export const popularIndicatorCategories = [
  'Moving Averages',
  'Oscillators',
  'Bands & Channels',
  'Trend',
  'Volume',
  'Volatility',
  'Trailing Stops',
] as const;

export function buildIndicatorCategoryList(additionalCategories: Iterable<string>): string[] {
  return [...new Set([...primaryCategories, ...popularIndicatorCategories, ...additionalCategories])];
}
