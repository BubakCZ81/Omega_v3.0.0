import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface AlpacaSdkBridge {
  fetchHistoricalBars(request: {
    symbol: string;
    timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
    from: number;
    to: number;
    limit: number;
  }): Promise<OHLCV[] | null>;
}

const commonSymbols: SymbolDescriptor[] = [
  ['AAPL', 'Apple Inc.', 'NASDAQ'],
  ['MSFT', 'Microsoft Corporation', 'NASDAQ'],
  ['NVDA', 'NVIDIA Corporation', 'NASDAQ'],
  ['AMZN', 'Amazon.com Inc.', 'NASDAQ'],
  ['GOOGL', 'Alphabet Inc.', 'NASDAQ'],
  ['META', 'Meta Platforms Inc.', 'NASDAQ'],
  ['TSLA', 'Tesla Inc.', 'NASDAQ'],
  ['AVGO', 'Broadcom Inc.', 'NASDAQ'],
  ['COST', 'Costco Wholesale Corporation', 'NASDAQ'],
  ['NFLX', 'Netflix Inc.', 'NASDAQ'],
  ['JPM', 'JPMorgan Chase & Co.', 'NYSE'],
  ['V', 'Visa Inc.', 'NYSE'],
  ['WMT', 'Walmart Inc.', 'NYSE'],
  ['LLY', 'Eli Lilly and Company', 'NYSE'],
  ['ORCL', 'Oracle Corporation', 'NYSE'],
  ['XOM', 'Exxon Mobil Corporation', 'NYSE'],
  ['MA', 'Mastercard Incorporated', 'NYSE'],
  ['JNJ', 'Johnson & Johnson', 'NYSE'],
  ['HD', 'The Home Depot Inc.', 'NYSE'],
  ['BAC', 'Bank of America Corporation', 'NYSE'],
].map(([ticker, description, prefix]) => ({
  ticker: ticker as string,
  description: description as string,
  type: 'stock',
  prefix: prefix as string,
}));

const sdkTimeframes: Record<string, '1m' | '5m' | '15m' | '1h' | '1d'> = {
  '1': '1m',
  '1M': '1m',
  '1MIN': '1m',
  '5': '5m',
  '5M': '5m',
  '5MIN': '5m',
  '15': '15m',
  '15M': '15m',
  '15MIN': '15m',
  '60': '1h',
  '1H': '1h',
  'D': '1d',
  '1D': '1d',
};

const timeframeMilliseconds: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

interface ChartTimeframe {
  milliseconds: number;
  bucket: 'fixed' | 'week' | 'month';
}

const intradayLookbackMultiplier = 6;
const intradayMarketClosureBuffer = 3 * 24 * 60 * 60_000;
const dailyLookbackMultiplier = 1.5;
const dailyMarketClosureBuffer = 14 * 24 * 60 * 60_000;

function parseChartTimeframe(timeframe: string): ChartTimeframe | null {
  const key = timeframe.trim().toUpperCase();
  if (key === 'W' || key === '1W' || key === 'W1') {
    return { milliseconds: 7 * 24 * 60 * 60_000, bucket: 'week' };
  }
  const weeks = /^(?:W(\d+)|(\d+)W)$/.exec(key);
  if (weeks) {
    return { milliseconds: Number(weeks[1] ?? weeks[2]) * 7 * 24 * 60 * 60_000, bucket: 'week' };
  }
  if (key === 'M' || key === 'MN1' || key === '1MO' || key === '1MON') {
    return { milliseconds: 30 * 24 * 60 * 60_000, bucket: 'month' };
  }
  const months = /^(?:MO(\d+)|(\d+)(?:MO|MON))$/.exec(key);
  if (months) {
    return { milliseconds: Number(months[1] ?? months[2]) * 30 * 24 * 60 * 60_000, bucket: 'month' };
  }
  if (key === 'D' || key === '1D' || key === 'D1') {
    return { milliseconds: 24 * 60 * 60_000, bucket: 'fixed' };
  }
  const days = /^(\d+)D$/.exec(key);
  if (days) {
    return { milliseconds: Number(days[1]) * 24 * 60 * 60_000, bucket: 'fixed' };
  }
  const hours = /^(?:H(\d+)|(\d+)H)$/.exec(key);
  if (hours) {
    return { milliseconds: Number(hours[1] ?? hours[2]) * 60 * 60_000, bucket: 'fixed' };
  }
  const minutes = /^(\d+)(?:M|MIN)?$/.exec(key);
  if (!minutes) return null;
  return { milliseconds: Number(minutes[1]) * 60_000, bucket: 'fixed' };
}

function sourceTimeframeFor(target: ChartTimeframe): '1m' | '5m' | '15m' | '1h' | '1d' {
  if (target.bucket !== 'fixed') return '1d';
  for (const timeframe of ['1d', '1h', '15m', '5m', '1m'] as const) {
    const interval = timeframeMilliseconds[timeframe];
    if (interval <= target.milliseconds && target.milliseconds % interval === 0) return timeframe;
  }
  return '1m';
}

function bucketTime(time: number, target: ChartTimeframe): number {
  if (target.bucket === 'month') {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  if (target.bucket === 'week') {
    const mondayOffset = 3 * 24 * 60 * 60_000;
    return Math.floor((time + mondayOffset) / (7 * 24 * 60 * 60_000)) * (7 * 24 * 60 * 60_000) - mondayOffset;
  }
  return Math.floor(time / target.milliseconds) * target.milliseconds;
}

function aggregateBars(bars: readonly OHLCV[], target: ChartTimeframe): OHLCV[] {
  const buckets = new Map<number, OHLCV>();
  for (const bar of bars) {
    const time = bucketTime(bar.time, target);
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

function normalizeTicker(ticker: string): string {
  return ticker.replace(/^alpaca:/i, '').trim().toUpperCase();
}

export class AlpacaDataProvider implements DataProvider {
  private readonly bridge: AlpacaSdkBridge;
  private connected = false;
  private descriptors: SymbolDescriptor[] = commonSymbols;

  constructor(bridge: AlpacaSdkBridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'alpaca',
      displayName: 'Alpaca (Broker SDK)',
      // Vela otherwise uses its own rapid fallback polling. We expose a
      // controlled polling subscription below so each chart owns one cancellable
      // refresh loop instead of repeatedly reloading full history.
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('Connect Alpaca through the Broker panel to load chart data.');
    const normalized = timeframe.trim().toUpperCase();
    const target = parseChartTimeframe(timeframe);
    if (!target || !Number.isSafeInteger(target.milliseconds) || target.milliseconds < 60_000) {
      throw new Error(`Alpaca Broker SDK cannot map chart timeframe "${timeframe}" to a supported market-data interval.`);
    }
    const sdkTimeframe = sdkTimeframes[normalized] ?? sourceTimeframeFor(target);
    const limit = Math.max(1, Math.min(10_000, Math.floor(range.limit ?? 1000)));
    const to = range.to ?? Date.now();
    const sourceInterval = timeframeMilliseconds[sdkTimeframe];
    const isDailyOrHigher = target.milliseconds >= timeframeMilliseconds['1d'];
    const lookbackMultiplier = isDailyOrHigher ? dailyLookbackMultiplier : intradayLookbackMultiplier;
    const marketClosureBuffer = isDailyOrHigher ? dailyMarketClosureBuffer : intradayMarketClosureBuffer;
    const from = range.from ?? to - Math.ceil(limit * target.milliseconds * lookbackMultiplier) - marketClosureBuffer;
    const sourceLimit = Math.min(10_000, Math.max(1, Math.ceil((to - from) / sourceInterval) + 2));
    const bars = await this.bridge.fetchHistoricalBars({
      symbol: normalizeTicker(ticker),
      timeframe: sdkTimeframe,
      from,
      to,
      limit: sourceLimit,
    });
    if (!bars) throw new Error('Alpaca Broker SDK history is unavailable. Connect Alpaca in the Broker panel.');
    const aggregated = target.bucket === 'fixed' && sourceInterval === target.milliseconds
      ? bars
      : aggregateBars(bars, target);
    return aggregated.length > limit ? aggregated.slice(-limit) : aggregated;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo> {
    const normalized = normalizeTicker(ticker);
    return {
      ticker: normalized,
      name: normalized,
      description: 'US equities via Alpaca Broker SDK market data',
      currency: 'USD',
      exchange: 'IEX',
      timezone: 'America/New_York',
    };
  }

  subscribe(
    ticker: string,
    timeframe: string,
    onBar: Parameters<NonNullable<DataProvider['subscribe']>>[2],
  ): () => void {
    const target = parseChartTimeframe(timeframe);
    const pollMs = Math.min(60_000, Math.max(15_000, Math.round((target?.milliseconds ?? 60_000) / 4)));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped || !this.connected) return;
      try {
        const bars = await this.getBars(ticker, timeframe, { limit: 2 });
        const latest = bars.at(-1);
        if (!stopped && latest) onBar(latest);
      } catch (error) {
        if (!stopped) console.warn(`Alpaca live refresh failed for ${ticker} ${timeframe}:`, error);
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), pollMs);
      }
    };
    timer = setTimeout(() => void poll(), pollMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

}

export function initializeAlpacaSdkFeed(getWorkspace: () => VelaWorkspace): void {
  const bridge = window.velaBroker as (Window['velaBroker'] & AlpacaSdkBridge) | undefined;
  if (!bridge?.fetchHistoricalBars) return;

  const provider = new AlpacaDataProvider(bridge);
  let connected = false;
  let revision = 0;
  const registerChart = async (chart: VelaWorkspace['chart'], expectedRevision: number) => {
    chart.data.registerProvider('alpaca', provider);
    await chart.data.ready();
    if (!connected || expectedRevision !== revision) chart.data.unregisterProvider('alpaca');
  };
  const registerWorkspace = async () => {
    const currentRevision = revision;
    await Promise.all(getWorkspace().cells().map(cell => registerChart(cell.chart, currentRevision)));
  };
  const disable = () => {
    connected = false;
    revision += 1;
    provider.setConnected(false);
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('alpaca');
  };
  const connect = async (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'alpaca') {
      disable();
      return;
    }
    connected = true;
    revision += 1;
    provider.setConnected(true);
    try {
      await registerWorkspace();
      document.dispatchEvent(new CustomEvent('omega:alpaca-provider-ready'));
    } catch (error) {
      console.error('Could not register Alpaca Broker SDK chart data:', error);
    }
  };
  const disconnect = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'alpaca') return;
    disable();
  };

  document.addEventListener('omega:trading-broker-connected', event => { void connect(event); });
  document.addEventListener('omega:trading-broker-disconnected', disconnect);
  document.addEventListener('omega:trading-broker-connecting', disable);
  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerChart(cell.chart, revision).catch(error => {
      console.error('Could not register Alpaca Broker SDK data on a new chart:', error);
    });
  });
}
