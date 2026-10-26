import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface CTraderSymbol {
  id: string;
  name: string;
  digits?: number;
}

interface CTraderQuote {
  subscriptionId?: string;
  accountId: string;
  symbolId: string;
  symbol: string;
  bid?: number;
  ask?: number;
  timestamp: string | number;
}

interface CTraderFeedBridge {
  symbols(): Promise<CTraderSymbol[]>;
  bars(request: {
    symbol: string;
    timeframe: string;
    range: { from?: number; to?: number; limit?: number };
  }): Promise<OHLCV[]>;
  subscribeSymbol(symbolId: string): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<boolean>;
  onQuote(callback: (quote: CTraderQuote) => void): () => void;
}

declare global {
  interface Window {
    velaCTraderFeed?: CTraderFeedBridge;
  }
}

interface LiveBarState {
  ticker: string;
  timeframe: string;
  callback: (bar: OHLCV) => void;
  current?: OHLCV;
}

const timeframeIntervals = new Map<string, number>([
  ['1', 60_000], ['1M', 60_000],
  ['2', 120_000], ['2M', 120_000],
  ['3', 180_000], ['3M', 180_000],
  ['4', 240_000], ['4M', 240_000],
  ['5', 300_000], ['5M', 300_000],
  ['6', 360_000], ['6M', 360_000],
  ['10', 600_000], ['10M', 600_000],
  ['12', 720_000], ['12M', 720_000],
  ['15', 900_000], ['15M', 900_000],
  ['20', 1_200_000], ['20M', 1_200_000],
  ['30', 1_800_000], ['30M', 1_800_000],
  ['45', 2_700_000], ['45M', 2_700_000],
  ['60', 3_600_000], ['1H', 3_600_000], ['H1', 3_600_000],
  ['120', 7_200_000], ['2H', 7_200_000], ['H2', 7_200_000],
  ['180', 10_800_000], ['3H', 10_800_000], ['H3', 10_800_000],
  ['90', 5_400_000], ['90M', 5_400_000],
  ['240', 14_400_000], ['4H', 14_400_000], ['H4', 14_400_000],
  ['360', 21_600_000], ['6H', 21_600_000], ['H6', 21_600_000],
  ['480', 28_800_000], ['8H', 28_800_000], ['H8', 28_800_000],
  ['720', 43_200_000], ['12H', 43_200_000], ['H12', 43_200_000],
  ['D', 86_400_000], ['1D', 86_400_000], ['D1', 86_400_000],
  ['W', 604_800_000], ['1W', 604_800_000], ['W1', 604_800_000],
]);

function normalizeTicker(ticker: string): string {
  return ticker.replace(/^ctrader:/i, '').trim();
}

function timeframeKey(timeframe: string): string {
  return timeframe.trim().toUpperCase();
}

interface ResolvedTimeframe {
  sourceTimeframe: string;
  sourceMinutes: number;
  targetMinutes: number;
  bucketMs: number;
  aggregate: boolean;
}

const nativeMinutePeriods = [240, 60, 30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1];

export function resolveCTraderTimeframe(timeframe: string): ResolvedTimeframe {
  const key = timeframeKey(timeframe);
  if (key === 'D' || key === '1D' || key === 'D1') {
    return { sourceTimeframe: 'D', sourceMinutes: 1440, targetMinutes: 1440, bucketMs: 0, aggregate: false };
  }
  if (key === 'W' || key === '1W' || key === 'W1') {
    return { sourceTimeframe: 'W', sourceMinutes: 0, targetMinutes: 0, bucketMs: 604_800_000, aggregate: false };
  }
  if (key === 'M' || key === 'MN1' || key === '1MO') {
    return { sourceTimeframe: 'MN1', sourceMinutes: 0, targetMinutes: 0, bucketMs: 0, aggregate: false };
  }

  const hourMatch = /^(?:H(\d+)|(\d+)H)$/.exec(key);
  const minuteMatch = /^(\d+)(?:M)?$/.exec(key);
  const targetMinutes = hourMatch
    ? Number(hourMatch[1] ?? hourMatch[2]) * 60
    : Number(minuteMatch?.[1]);
  if (!Number.isSafeInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 43_200) {
    throw new Error(`cTrader does not support the ${timeframe} timeframe.`);
  }
  const sourceMinutes = nativeMinutePeriods.find(minutes => targetMinutes % minutes === 0) ?? 1;
  return {
    sourceTimeframe: String(sourceMinutes),
    sourceMinutes,
    targetMinutes,
    bucketMs: targetMinutes * 60_000,
    aggregate: sourceMinutes !== targetMinutes,
  };
}

function aggregateBars(bars: readonly OHLCV[], bucketMs: number): OHLCV[] {
  if (!bucketMs) return [...bars];
  const buckets = new Map<number, OHLCV>();
  for (const bar of bars) {
    const time = Math.floor(bar.time / bucketMs) * bucketMs;
    const bucket = buckets.get(time);
    if (!bucket) {
      buckets.set(time, { ...bar, time });
      continue;
    }
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume = (bucket.volume ?? 0) + (bar.volume ?? 0);
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

export function bucketStart(timestamp: number, timeframe: string): number {
  const key = timeframeKey(timeframe);
  if (key === 'M' || key === 'MN1' || key === '1MO') {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  const resolved = resolveCTraderTimeframe(timeframe);
  const interval = timeframeIntervals.get(key) ?? resolved.bucketMs;
  if (!interval) throw new Error(`cTrader does not support the ${timeframe} timeframe.`);
  if (interval === 604_800_000) {
    const mondayOffset = 3 * 86_400_000;
    return Math.floor((timestamp + mondayOffset) / interval) * interval - mondayOffset;
  }
  return Math.floor(timestamp / interval) * interval;
}

export class CTraderDataProvider implements DataProvider {
  private descriptors: SymbolDescriptor[] = [];
  private readonly symbolsByName = new Map<string, CTraderSymbol>();
  private connected = false;
  private readonly bridge: CTraderFeedBridge;

  constructor(bridge: CTraderFeedBridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'ctrader',
      displayName: 'cTrader broker feed',
      supportedTimeframes: ['1', '2', '3', '4', '5', '6', '10', '12', '15', '20', '30', '45', '60', '90', '120', '180', '240', '360', '480', '720', 'D', 'W', 'MN1'],
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  setSymbols(symbols: readonly CTraderSymbol[]) {
    this.connected = true;
    this.symbolsByName.clear();
    this.descriptors = symbols.map(symbol => {
      this.symbolsByName.set(symbol.name.toUpperCase(), symbol);
      return {
        ticker: symbol.name,
        description: `${symbol.name} via cTrader`,
        type: 'broker',
        prefix: 'CTRADER',
      };
    });
  }

  disconnect() {
    this.connected = false;
    this.descriptors = [];
    this.symbolsByName.clear();
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('Select and authorize a cTrader account before loading its chart data.');
    const resolved = resolveCTraderTimeframe(timeframe);
    const symbol = this.symbolsByName.get(normalizeTicker(ticker).toUpperCase());
    if (!symbol) throw new Error(`The selected cTrader account does not provide ${ticker}.`);
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const sourceLimit = Math.min(
      50_000,
      limit * Math.max(1, resolved.targetMinutes / Math.max(1, resolved.sourceMinutes))
        + (resolved.aggregate ? 5 : 0),
    );
    const bars = await this.bridge.bars({
      symbol: symbol.id,
      timeframe: resolved.sourceTimeframe,
      range: { ...range, limit: sourceLimit },
    });
    const transformed = resolved.aggregate ? aggregateBars(bars, resolved.bucketMs) : bars;
    return transformed.length > limit ? transformed.slice(-limit) : transformed;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const symbol = this.symbolsByName.get(normalizeTicker(ticker).toUpperCase());
    return symbol
      ? {
        ticker: symbol.name,
        name: symbol.name,
        description: `${symbol.name} via cTrader`,
        exchange: 'cTrader',
        digits: symbol.digits,
      }
      : undefined;
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    if (!this.connected) throw new Error('Select and authorize a cTrader account before streaming its chart data.');
    resolveCTraderTimeframe(timeframe);
    const symbol = this.symbolsByName.get(normalizeTicker(ticker).toUpperCase());
    if (!symbol) throw new Error(`The selected cTrader account does not provide ${ticker}.`);
    let active = true;
    let subscriptionId: string | undefined;
    const live: LiveBarState = { ticker: symbol.name, timeframe, callback: onBar };
    const unsubscribeQuote = this.bridge.onQuote(quote => {
      if (!active || quote.subscriptionId !== subscriptionId) return;
      const bid = quote.bid;
      const ask = quote.ask;
      const price = Number.isFinite(bid) && Number.isFinite(ask)
        ? (bid! + ask!) / 2
        : Number.isFinite(bid) ? bid! : ask;
      if (!Number.isFinite(price) || price === undefined || price <= 0) return;
      const parsedTimestamp = typeof quote.timestamp === 'number' ? quote.timestamp : Date.parse(quote.timestamp);
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
      const time = bucketStart(timestamp, timeframe);
      if (!live.current || time > live.current.time) {
        live.current = { time, open: price, high: price, low: price, close: price, volume: 0 };
      } else if (time === live.current.time) {
        live.current.high = Math.max(live.current.high, price);
        live.current.low = Math.min(live.current.low, price);
        live.current.close = price;
      } else {
        return;
      }
      onBar({ ...live.current });
    });
    void this.bridge.subscribeSymbol(symbol.id).then(id => {
      subscriptionId = id;
      if (!active) void this.bridge.unsubscribe(id);
    }).catch(error => {
      if (active) {
        console.error(`[cTrader] Live chart subscription failed for ${symbol.name}:`, error);
        document.dispatchEvent(new CustomEvent('omega:ctrader-feed-status', {
          detail: { message: error instanceof Error ? error.message : String(error), error: true },
        }));
      }
    });
    return () => {
      active = false;
      unsubscribeQuote();
      if (subscriptionId) void this.bridge.unsubscribe(subscriptionId);
    };
  }
}

export function initializeCTraderFeed(getWorkspace: () => VelaWorkspace): void {
  const bridge = window.velaCTraderFeed;
  if (!bridge) return;

  const provider = new CTraderDataProvider(bridge);
  let connected = false;
  let revision = 0;

  const registerProvider = async (chart: VelaWorkspace['chart'], expectedRevision: number) => {
    if (!connected || expectedRevision !== revision) return;
    await chart.data.registerProvider('ctrader', provider);
    await chart.data.ready();
    if (!connected || expectedRevision !== revision) chart.data.unregisterProvider('ctrader');
  };
  const registerWorkspace = async (expectedRevision: number) => {
    await Promise.all(getWorkspace().cells().map(cell => registerProvider(cell.chart, expectedRevision)));
  };
  const setFeedStatus = (message: string, error = false) => {
    document.dispatchEvent(new CustomEvent('omega:ctrader-feed-status', { detail: { message, error } }));
  };
  const disable = () => {
    connected = false;
    revision += 1;
    provider.disconnect();
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('ctrader');
  };

  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerProvider(cell.chart, revision).catch(error => {
      console.error('Could not register the cTrader provider on a new chart:', error);
      setFeedStatus(error instanceof Error ? error.message : String(error), true);
    });
  });

  document.addEventListener('omega:ctrader-account-selected', event => {
    const symbols = (event as CustomEvent<CTraderSymbol[]>).detail;
    provider.setSymbols(symbols);
    connected = true;
    const expectedRevision = ++revision;
    void registerWorkspace(expectedRevision).then(() => {
      if (connected && expectedRevision === revision) {
        setFeedStatus('cTrader history and live quotes are ready. Search for CTRADER:SYMBOL or use the selected symbol on the chart.');
      }
    }).catch(error => {
      if (!connected || expectedRevision !== revision) return;
      console.error('Could not register cTrader market data:', error);
      setFeedStatus(error instanceof Error ? error.message : String(error), true);
    });
  });

  document.addEventListener('omega:ctrader-disconnected', () => {
    disable();
  });
  document.addEventListener('omega:trading-broker-connecting', () => {
    disable();
  });
  document.addEventListener('omega:trading-broker-connected', event => {
    if ((event as CustomEvent<string>).detail !== 'ctrader') disable();
  });

  document.addEventListener('omega:ctrader-chart-symbol', event => {
    const symbol = (event as CustomEvent<{ symbol: string }>).detail?.symbol;
    if (!connected || !symbol) {
      setFeedStatus('Authorize a cTrader account and choose one of its symbols first.', true);
      return;
    }
    const expectedRevision = revision;
    void registerWorkspace(expectedRevision).then(async () => {
      if (!connected || expectedRevision !== revision) return;
      await getWorkspace().chart.setMarket({ symbol: `ctrader:${symbol}` });
      if (connected && expectedRevision === revision) setFeedStatus(`Loaded cTrader:${symbol} on the active chart.`);
    }).catch(error => {
      if (!connected || expectedRevision !== revision) return;
      console.error(`Could not load cTrader:${symbol} on the chart:`, error);
      setFeedStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
}
