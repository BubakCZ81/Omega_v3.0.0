/**
 * Relevance ranking for the indicator browser search.
 *
 * Matching everything against a single haystack made common words such as
 * "volume" return every indicator whose description or category mentions the
 * term, in insertion order. This module scores the match instead, so an exact
 * or prefix name match always appears before weaker, description-only hits.
 */

export interface IndicatorSearchFields {
  name: string;
  category?: string;
  collections?: readonly string[];
  description?: string;
}

export interface RankedIndicator<T> {
  item: T;
  score: number;
}

const WORD_SEPARATOR = /[^a-z0-9]+/;

function words(value: string): string[] {
  return value.toLowerCase().split(WORD_SEPARATOR).filter(Boolean);
}

function everyTokenStartsWord(value: string, tokens: readonly string[]): boolean {
  const valueWords = words(value);
  return tokens.every(token => valueWords.some(word => word.startsWith(token)));
}

/**
 * Returns a lower score for a better match, or null when the item does not
 * match at all. All query tokens must appear somewhere on the item.
 */
export function indicatorMatchScore(fields: IndicatorSearchFields, query: string): number | null {
  const tokens = words(query);
  if (!tokens.length) return 0;

  const name = fields.name ?? '';
  const category = fields.category ?? '';
  const collections = (fields.collections ?? []).join(' ');
  const description = fields.description ?? '';
  const phrase = tokens.join(' ');
  const haystack = `${name} ${category} ${collections} ${description}`.toLowerCase();
  if (!tokens.every(token => haystack.includes(token))) return null;

  const lowerName = name.toLowerCase();
  if (lowerName === phrase) return 0;
  if (lowerName.startsWith(phrase)) return 1;
  if (everyTokenStartsWord(lowerName, tokens)) return 2;
  if (lowerName.includes(phrase)) return 3;
  if (everyTokenStartsWord(category, tokens) || everyTokenStartsWord(collections, tokens)) return 4;
  if (`${category} ${collections}`.toLowerCase().includes(phrase)) return 5;
  if (everyTokenStartsWord(description, tokens)) return 6;
  return 7;
}

/**
 * Filters and orders items by match quality. When at least one name match
 * exists, description-only matches are dropped so the list stays focused;
 * description matches are still used for queries that only appear in text.
 */
export function rankIndicatorMatches<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => IndicatorSearchFields,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...items];

  const scored: RankedIndicator<T>[] = [];
  for (const item of items) {
    const score = indicatorMatchScore(fields(item), trimmed);
    if (score !== null) scored.push({ item, score });
  }
  if (!scored.length) return [];

  const best = Math.min(...scored.map(entry => entry.score));
  // Scores 0-3 are name matches, 4-5 category/collection matches, 6-7 matches
  // that only appear in the description. Keep category matches alongside name
  // matches, but hide description-only noise as soon as anything stronger hits.
  const limit = best <= 5 ? 5 : 7;
  return scored
    .filter(entry => entry.score <= limit)
    .sort((left, right) => left.score - right.score || fields(left.item).name.localeCompare(fields(right.item).name))
    .map(entry => entry.item);
}
