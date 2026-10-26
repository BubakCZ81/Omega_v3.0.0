const NEWS_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const MAX_QUERY_LENGTH = 80;
const MAX_NEWS_ITEMS = 30;

function normalizeNewsQuery(value) {
  if (typeof value !== 'string') throw new TypeError('A chart symbol is required for news search.');
  const query = value.trim();
  if (!query) throw new TypeError('A chart symbol is required for news search.');
  if (query.length > MAX_QUERY_LENGTH || !/^[a-zA-Z0-9:._^/ -]+$/.test(query)) {
    throw new TypeError('The chart symbol contains unsupported characters.');
  }
  return query;
}

function safeNewsLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function searchYahooNews(query, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('News search is unavailable in this runtime.');
  const params = new URLSearchParams({ q: normalizeNewsQuery(query), newsCount: '30', quotesCount: '0' });
  const response = await fetchImpl(`${NEWS_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`News provider returned HTTP ${response.status}.`);
  const result = await response.json();
  if (!result || !Array.isArray(result.news)) throw new Error('News provider returned an invalid response.');

  const seen = new Set();
  return result.news.slice(0, MAX_NEWS_ITEMS).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.publisher !== 'string') return [];
    const link = safeNewsLink(item.link);
    const publishedAt = Number(item.providerPublishTime);
    if (!link || !Number.isFinite(publishedAt)) return [];
    const id = typeof item.uuid === 'string' && item.uuid ? item.uuid : link;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      title: item.title.slice(0, 500),
      publisher: item.publisher.slice(0, 120),
      link,
      publishedAt: publishedAt * 1000,
      relatedTickers: Array.isArray(item.relatedTickers)
        ? item.relatedTickers.filter(ticker => typeof ticker === 'string').slice(0, 12)
        : [],
    }];
  });
}

module.exports = { normalizeNewsQuery, safeNewsLink, searchYahooNews };
