import type { DataProvider, OHLCV } from '@luxalgo/vela';

const DATABASE_NAME = 'omega-market-data';
const DATABASE_VERSION = 1;
const SERIES_STORE = 'candle-series';
const MAX_CACHED_BARS_PER_SERIES = 50_000;

export interface CandleSeriesStore {
  get(key: string): Promise<OHLCV[]>;
  merge(key: string, bars: OHLCV[]): Promise<OHLCV[]>;
}

type StoredSeries = {
  key: string;
  bars: OHLCV[];
  updatedAt: number;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export class IndexedDbCandleSeriesStore implements CandleSeriesStore {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SERIES_STORE)) {
          request.result.createObjectStore(SERIES_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the candle cache.'));
      request.onblocked = () => reject(new Error('Opening the candle cache was blocked.'));
    }).catch(error => {
      this.database = null;
      throw error;
    });
    this.database = opening;
    return opening;
  }

  async get(key: string): Promise<OHLCV[]> {
    const database = await this.open();
    const transaction = database.transaction(SERIES_STORE, 'readonly');
    const stored = await requestResult(transaction.objectStore(SERIES_STORE).get(key)) as StoredSeries | undefined;
    return Array.isArray(stored?.bars) ? stored.bars : [];
  }

  async merge(key: string, bars: OHLCV[]): Promise<OHLCV[]> {
    const database = await this.open();
    const transaction = database.transaction(SERIES_STORE, 'readwrite');
    const store = transaction.objectStore(SERIES_STORE);
    const existing = await requestResult(store.get(key)) as StoredSeries | undefined;
    const mergedByTime = new Map<number, OHLCV>();
    for (const bar of existing?.bars ?? []) mergedByTime.set(bar.time, bar);
    for (const bar of bars) mergedByTime.set(bar.time, bar);
    const merged = [...mergedByTime.values()]
      .sort((left, right) => left.time - right.time)
      .slice(-MAX_CACHED_BARS_PER_SERIES);
    store.put({ key, bars: merged, updatedAt: Date.now() } satisfies StoredSeries);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save candle history.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving candle history was aborted.'));
    });
    return merged;
  }
}

function cacheKey(provider: string, ticker: string, timeframe: string): string {
  return `${provider.toLowerCase()}:${ticker.trim().toUpperCase()}:${timeframe.trim().toUpperCase()}`;
}

function timeframeDurationMs(timeframe: string, barTime: number): number {
  const normalized = timeframe.trim().toUpperCase();
  if (/^\d+$/.test(normalized)) return Number(normalized) * 60_000;
  if (normalized === 'D' || normalized === '1D') return 86_400_000;
  if (normalized === 'W' || normalized === '1W') return 7 * 86_400_000;
  if (normalized === 'M' || normalized === '1M') {
    const date = new Date(barTime);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - barTime;
  }
  return 60_000;
}

function isClosedBar(bar: OHLCV, timeframe: string, now: number): boolean {
  return bar.time + timeframeDurationMs(timeframe, bar.time) <= now;
}

function selectBars(bars: OHLCV[], range: Parameters<DataProvider['getBars']>[2]): OHLCV[] {
  const filtered = bars.filter(bar =>
    (range.from === undefined || bar.time >= range.from)
    && (range.to === undefined || bar.time <= range.to));
  if (range.limit === undefined || filtered.length <= range.limit) return filtered;
  return range.from === undefined
    ? filtered.slice(-range.limit)
    : filtered.slice(0, range.limit);
}

export class PersistentCandleProvider implements DataProvider {
  private readonly source: DataProvider;
  private readonly store: CandleSeriesStore;
  private readonly now: () => number;
  private readonly tailRefreshes = new Map<string, Promise<OHLCV[]>>();

  constructor(
    source: DataProvider,
    store: CandleSeriesStore = new IndexedDbCandleSeriesStore(),
    now: () => number = Date.now,
  ) {
    this.source = source;
    this.store = store;
    this.now = now;
  }

  info() {
    return this.source.info?.() ?? {
      name: 'binance',
      capabilities: { enumerate: Boolean(this.source.listSymbols), stream: Boolean(this.source.subscribe), symbolInfo: Boolean(this.source.getSymbolInfo) },
    };
  }

  listSymbols() {
    return this.source.listSymbols?.() ?? Promise.resolve([]);
  }

  getSymbolInfo(ticker: string) {
    return this.source.getSymbolInfo?.(ticker) ?? Promise.resolve(undefined);
  }

  subscribe(ticker: string, timeframe: string, onBar: Parameters<NonNullable<DataProvider['subscribe']>>[2]) {
    return this.source.subscribe?.(ticker, timeframe, onBar) ?? (() => undefined);
  }

  async getBars(
    ticker: string,
    timeframe: string,
    range: Parameters<DataProvider['getBars']>[2],
  ): Promise<OHLCV[]> {
    const key = cacheKey(this.info().name, ticker, timeframe);
    const cached = await this.readCached(key);
    if (cached.length === 0) return this.fetchAndCache(key, ticker, timeframe, range);

    // A warm chart must paint from disk immediately. The live subscription keeps
    // the forming candle current; the small missing historical tail is refreshed
    // in the background instead of making the whole platform wait for a network hop.
    if (range.from === undefined) {
      const cachedWindow = selectBars(cached, range);
      if (cachedWindow.length > 0) {
        void this.refreshTail(key, ticker, timeframe, range, cached);
        return cachedWindow;
      }
    }

    return this.loadAndMerge(key, ticker, timeframe, range, cached);
  }

  private async loadAndMerge(
    key: string,
    ticker: string,
    timeframe: string,
    range: Parameters<DataProvider['getBars']>[2],
    cached: OHLCV[],
  ): Promise<OHLCV[]> {
    const oldestCached = cached[0].time;
    const newestCached = cached[cached.length - 1].time;
    const to = range.to ?? this.now();
    const cachedWindow = selectBars(cached, range);
    const fullyCached = range.from !== undefined
      ? range.from >= oldestCached && to <= newestCached
      : to >= oldestCached && to < newestCached
        && (range.limit === undefined || cachedWindow.length >= range.limit);

    if (fullyCached) return cachedWindow;

    let fetchRange = range;
    if (range.from !== undefined && range.from >= oldestCached && to > newestCached) {
      fetchRange = { ...range, from: newestCached };
    } else if (range.from === undefined && to >= newestCached) {
      fetchRange = { ...range, from: newestCached, limit: undefined };
    }

    const fresh = await this.source.getBars(ticker, timeframe, fetchRange);
    await this.writeCached(key, fresh.filter(bar => isClosedBar(bar, timeframe, this.now())));
    const merged = new Map<number, OHLCV>();
    for (const bar of cached) merged.set(bar.time, bar);
    for (const bar of fresh) merged.set(bar.time, bar);
    return selectBars([...merged.values()].sort((left, right) => left.time - right.time), range);
  }

  private refreshTail(
    key: string,
    ticker: string,
    timeframe: string,
    range: Parameters<DataProvider['getBars']>[2],
    cached: OHLCV[],
  ): Promise<OHLCV[]> {
    const existing = this.tailRefreshes.get(key);
    if (existing) return existing;
    const refresh = this.loadAndMerge(key, ticker, timeframe, range, cached)
      .catch(error => {
        console.warn('Background candle refresh failed; cached candles remain available.', error);
        return selectBars(cached, range);
      })
      .finally(() => this.tailRefreshes.delete(key));
    this.tailRefreshes.set(key, refresh);
    return refresh;
  }

  async getBarsProgressive(
    ticker: string,
    timeframe: string,
    range: Parameters<DataProvider['getBars']>[2],
    onBatch: (bars: OHLCV[]) => void,
    options?: { signal?: AbortSignal },
  ): Promise<OHLCV[]> {
    const key = cacheKey(this.info().name, ticker, timeframe);
    const cached = await this.readCached(key);
    if (cached.length > 0) {
      const cachedWindow = selectBars(cached, range);
      if (cachedWindow.length > 0) onBatch(cachedWindow);
      if (options?.signal?.aborted) return cachedWindow;
    }

    const fresh = cached.length > 0
      ? await this.refreshTail(key, ticker, timeframe, range, cached)
      : await this.getBars(ticker, timeframe, range);
    if (!options?.signal?.aborted && fresh.length > 0) onBatch(fresh);
    return fresh;
  }

  private async fetchAndCache(
    key: string,
    ticker: string,
    timeframe: string,
    range: Parameters<DataProvider['getBars']>[2],
  ): Promise<OHLCV[]> {
    const bars = await this.source.getBars(ticker, timeframe, range);
    await this.writeCached(key, bars.filter(bar => isClosedBar(bar, timeframe, this.now())));
    return bars;
  }

  private async readCached(key: string): Promise<OHLCV[]> {
    try {
      return await this.store.get(key);
    } catch (error) {
      console.warn('Persistent candle cache could not be read; fetching from the provider.', error);
      return [];
    }
  }

  private async writeCached(key: string, bars: OHLCV[]): Promise<void> {
    if (bars.length === 0) return;
    try {
      await this.store.merge(key, bars);
    } catch (error) {
      console.warn('Persistent candle cache could not be saved; continuing with provider data.', error);
    }
  }
}
