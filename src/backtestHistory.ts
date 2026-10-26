import type { DataProvider, OHLCV } from '@luxalgo/vela';

export const BACKTEST_PROVIDER_PREFIX = 'omega_backtest';
const HISTORY_PAGE_SIZE = 10_000;
const MAX_BACKTEST_BARS = 50_000;

export class BacktestHistoryProvider implements DataProvider {
  private initialBars: OHLCV[] | null;
  private readonly source: DataProvider;
  private readonly providerName: string;

  constructor(source: DataProvider, providerName: string, initialBars: OHLCV[]) {
    this.source = source;
    this.providerName = providerName;
    this.initialBars = initialBars;
  }

  info() {
    return {
      name: this.providerName,
      displayName: 'Backtest history',
      capabilities: {
        enumerate: Boolean(this.source.listSymbols),
        stream: false,
        symbolInfo: Boolean(this.source.getSymbolInfo),
      },
    };
  }

  listSymbols() {
    return this.source.listSymbols?.() ?? Promise.resolve([]);
  }

  async getSymbolInfo(ticker: string) {
    return this.source.getSymbolInfo?.(ticker);
  }

  subscribe(): () => void {
    return () => {};
  }

  getBars(ticker: string, timeframe: string, range: Parameters<DataProvider['getBars']>[2]): Promise<OHLCV[]> {
    if (this.initialBars && range.from === undefined && range.to === undefined) {
      const bars = this.initialBars;
      this.initialBars = null;
      return Promise.resolve(bars);
    }
    return this.source.getBars(ticker, timeframe, range);
  }
}

export async function registerBacktestHistoryProvider(
  registry: {
    registerProvider: (name: string, provider: DataProvider) => unknown;
    unregisterProvider: (name: string) => unknown;
    ready: () => Promise<void>;
  },
  source: DataProvider,
  providerName: string,
  bars: OHLCV[],
  isCurrent: () => boolean,
): Promise<BacktestHistoryProvider | null> {
  const provider = new BacktestHistoryProvider(source, providerName, bars);
  registry.registerProvider(providerName, provider);
  try {
    await registry.ready();
  } catch (error) {
    registry.unregisterProvider(providerName);
    throw error;
  }
  if (!isCurrent()) {
    registry.unregisterProvider(providerName);
    return null;
  }
  return provider;
}

export async function loadBacktestHistory(
  provider: DataProvider,
  ticker: string,
  timeframe: string,
  from: number,
  to: number,
  isCurrent: () => boolean,
): Promise<OHLCV[] | null> {
  const barsByTime = new Map<number, OHLCV>();
  let cursor = to;
  while (cursor >= from && barsByTime.size < MAX_BACKTEST_BARS) {
    const remaining = MAX_BACKTEST_BARS - barsByTime.size;
    const page = await provider.getBars(ticker, timeframe, {
      from,
      to: cursor,
      limit: Math.min(HISTORY_PAGE_SIZE, remaining),
    });
    if (!isCurrent()) return null;
    if (page.length === 0) break;
    for (const bar of page) {
      if (bar.time >= from && bar.time <= cursor) barsByTime.set(bar.time, bar);
    }
    const oldest = page[0]?.time;
    if (oldest === undefined || oldest <= from || oldest >= cursor) break;
    cursor = oldest - 1;
  }
  return [...barsByTime.values()].sort((left, right) => left.time - right.time);
}
