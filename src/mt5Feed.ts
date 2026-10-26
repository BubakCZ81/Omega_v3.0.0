import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface Mt5Symbol {
  ticker: string;
  description: string;
  path: string;
  digits: number;
  point: number;
  currencyBase: string;
  currencyProfit: string;
  tradeContractSize?: number;
  tickValue?: number;
}

interface Mt5Connection {
  company: string;
  terminal: string;
  server: string;
  symbols: Mt5Symbol[];
}

interface Mt5Bridge {
  connect(pythonExecutable?: string): Promise<Mt5Connection>;
  symbols(): Promise<Mt5Symbol[]>;
  bars(request: { ticker: string; timeframe: string; range: { from?: number; to?: number; limit: number } }): Promise<OHLCV[]>;
  quote(ticker: string): Promise<{ bid: number; ask: number }>;
  ticks(request: { ticker: string; fromMsc: number; limit: number }): Promise<Mt5Tick[]>;
  marketBook(ticker: string): Promise<Mt5BookEntry[]>;
  info(ticker: string): Promise<Mt5Symbol | undefined>;
  disconnect(): Promise<boolean>;
}

interface Mt5Tick {
  time: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  volumeReal: number;
  flags: number;
}

interface Mt5TickBarState extends OHLCV {
  tickCount: number;
}

interface Mt5BookEntry {
  type: number;
  price: number;
  volume: number;
}

declare global {
  interface Window {
    velaMt5?: Mt5Bridge;
  }
}

const directTimeframes: Record<number, string> = {
  1: 'M1', 2: 'M2', 3: 'M3', 4: 'M4', 5: 'M5', 6: 'M6', 10: 'M10', 12: 'M12',
  15: 'M15', 20: 'M20', 30: 'M30', 60: 'H1', 120: 'H2', 180: 'H3', 240: 'H4',
  360: 'H6', 480: 'H8', 720: 'H12', 1440: 'D1', 10080: 'W1',
};

const minuteFrames = Object.entries(directTimeframes)
  .map(([minutes, timeframe]) => ({ minutes: Number(minutes), timeframe }))
  .sort((left, right) => right.minutes - left.minutes);

export function resolveMt5Timeframe(value: string): {
  timeframe: string;
  bucketMs: number;
  sourceMinutes: number;
  targetMinutes: number;
} {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'D' || normalized === '1D') {
    return { timeframe: 'D1', bucketMs: 0, sourceMinutes: 1440, targetMinutes: 1440 };
  }
  if (normalized === 'W' || normalized === '1W') {
    return { timeframe: 'W1', bucketMs: 0, sourceMinutes: 10080, targetMinutes: 10080 };
  }
  if (normalized === 'M' || normalized === '1M' || normalized === 'MN1') {
    return { timeframe: 'MN1', bucketMs: 0, sourceMinutes: 0, targetMinutes: 0 };
  }

  const minutes = Number(normalized);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error(`Unsupported MetaTrader timeframe: ${value}`);
  if (minutes === 43_200) return { timeframe: 'MN1', bucketMs: 0, sourceMinutes: 0, targetMinutes: 0 };
  const base = minuteFrames.find(frame => minutes % frame.minutes === 0);
  if (!base) throw new Error(`Unsupported MetaTrader timeframe: ${value}`);
  return {
    timeframe: base.timeframe,
    bucketMs: minutes === base.minutes ? 0 : minutes * 60_000,
    sourceMinutes: base.minutes,
    targetMinutes: minutes,
  };
}

export function aggregateMt5Bars(bars: readonly OHLCV[], bucketMs: number): OHLCV[] {
  if (bucketMs === 0) return [...bars];
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

export function mt5TickCountForTimeframe(timeframe: string): number | null {
  const match = /^T([1-9]\d{0,4})$/i.exec(timeframe.trim());
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count <= 10_000 ? count : null;
}

function tickPrice(tick: Mt5Tick): number {
  return Number.isFinite(tick.last) && tick.last > 0
    ? tick.last
    : Number.isFinite(tick.bid) && tick.bid > 0 ? tick.bid : tick.ask;
}

export function buildMt5TickBars(ticks: readonly Mt5Tick[], ticksPerBar: number): OHLCV[] {
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar < 1 || ticksPerBar > 10_000) {
    throw new RangeError('Tick bars must contain between 1 and 10,000 ticks.');
  }
  const bars: OHLCV[] = [];
  let current: Mt5TickBarState | null = null;
  for (const tick of ticks) {
    const price = tickPrice(tick);
    if (!Number.isFinite(tick.time) || tick.time < 0 || !Number.isFinite(price) || price <= 0) continue;
    if (!current) {
      const previousTime = bars.at(-1)?.time ?? -1;
      current = {
        time: Math.max(tick.time, previousTime + 1),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Number.isFinite(tick.volumeReal) && tick.volumeReal > 0 ? tick.volumeReal : 0,
        tickCount: 0,
      };
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      if (Number.isFinite(tick.volumeReal) && tick.volumeReal > 0) current.volume = (current.volume ?? 0) + tick.volumeReal;
    }
    current.tickCount += 1;
    if (current.tickCount === ticksPerBar) {
      const { tickCount: _tickCount, ...bar } = current;
      bars.push(bar);
      current = null;
    }
  }
  if (current) {
    const { tickCount: _tickCount, ...bar } = current;
    bars.push(bar);
  }
  return bars;
}

function tickKey(tick: Mt5Tick): string {
  return `${tick.time}|${tick.bid}|${tick.ask}|${tick.last}|${tick.volume}|${tick.volumeReal}|${tick.flags}`;
}

export class Mt5DataProvider implements DataProvider {
  private descriptors: SymbolDescriptor[] = [];
  private readonly bridge: Mt5Bridge;
  private connected = false;

  constructor(bridge: Mt5Bridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'mt5',
      displayName: 'MetaTrader 5 (broker feed)',
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  setSymbols(symbols: readonly Mt5Symbol[]) {
    this.connected = true;
    this.descriptors = symbols.map(symbol => ({
      ticker: symbol.ticker,
      description: symbol.description || symbol.ticker,
      type: mt5SymbolType(symbol.path),
      prefix: 'MT5',
    }));
  }

  disconnect() {
    this.connected = false;
    this.descriptors = [];
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('MetaTrader 5 feed is disconnected.');
    const ticksPerBar = mt5TickCountForTimeframe(timeframe);
    if (ticksPerBar !== null) return this.getTickBars(ticker, ticksPerBar, range);
    const resolved = resolveMt5Timeframe(timeframe);
    const limit = Math.max(1, range.limit ?? 1000);
    const multiplier = resolved.sourceMinutes === 0
      ? 1
      : Math.max(1, Math.ceil(resolved.targetMinutes / resolved.sourceMinutes));
    const bars = await this.bridge.bars({
      ticker,
      timeframe: resolved.timeframe,
      range: {
        ...range,
        limit: Math.min(50_000, limit * multiplier + 5),
      },
    });
    const aggregated = aggregateMt5Bars(bars, resolved.bucketMs);
    return aggregated.length > limit ? aggregated.slice(-limit) : aggregated;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const info = await this.bridge.info(ticker);
    if (!info) return undefined;
    const contractSize = Number(info.tradeContractSize);
    const tickValue = Number(info.tickValue);
    return {
      ticker: info.ticker,
      name: info.ticker,
      description: info.description,
      currency: info.currencyProfit || undefined,
      baseCurrency: info.currencyBase || undefined,
      exchange: info.path || 'MetaTrader 5 broker',
      timezone: 'UTC',
      minTick: info.point,
      digits: info.digits,
      pointValue: Number.isFinite(tickValue) && tickValue > 0 ? tickValue : 1,
      ...(Number.isFinite(contractSize) && contractSize > 0 ? { contractSize } : {}),
    };
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const ticksPerBar = mt5TickCountForTimeframe(timeframe);
    if (ticksPerBar !== null) return this.subscribeTicks(ticker, ticksPerBar, onBar);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || !this.connected) return;
      try {
        const bars = await this.getBars(ticker, timeframe, { limit: 2 });
        const latest = bars.at(-1);
        if (latest && active) onBar(latest);
      } catch (error) {
        if (active) console.error(`[MetaTrader 5] Live data failed for ${ticker}:`, error);
      } finally {
        if (active) timer = setTimeout(() => { void poll(); }, 1500);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }

  private async getTickBars(
    ticker: string,
    ticksPerBar: number,
    range: { from?: number; to?: number; limit?: number },
  ): Promise<OHLCV[]> {
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const tickLimit = Math.min(50_000, limit * ticksPerBar);
    const to = range.to ?? Date.now();
    let windowMs = 5 * 60_000;
    const collectTicks = async (fromMsc: number): Promise<Mt5Tick[]> => {
      const collected: Mt5Tick[] = [];
      let cursor = fromMsc;
      while (collected.length < tickLimit) {
        const requestLimit = Math.min(10_000, tickLimit - collected.length);
        const batch = await this.bridge.ticks({
          ticker,
          fromMsc: cursor,
          limit: requestLimit,
        });
        const eligible = batch.filter(tick => tick.time >= cursor && tick.time <= to);
        collected.push(...eligible);
        const lastTime = batch.at(-1)?.time;
        if (batch.length < requestLimit || lastTime === undefined || lastTime < cursor || lastTime >= to) break;
        cursor = lastTime + 1;
      }
      return collected;
    };

    let ticks: Mt5Tick[];
    if (range.from !== undefined) {
      ticks = await collectTicks(range.from);
    } else {
      let lowerWindow = 0;
      let upperWindow = 24 * 60 * 60_000;
      let bestUnderfilled: Mt5Tick[] = [];
      let latestFull: Mt5Tick[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const fromMsc = Math.max(0, to - windowMs);
        const sample = await collectTicks(fromMsc);
        if (sample.length >= tickLimit) {
          latestFull = sample;
          upperWindow = windowMs;
          windowMs = lowerWindow > 0
            ? Math.floor((lowerWindow + upperWindow) / 2)
            : Math.floor(upperWindow / 2);
        } else {
          if (sample.length > bestUnderfilled.length) bestUnderfilled = sample;
          lowerWindow = windowMs;
          windowMs = upperWindow > lowerWindow
            ? Math.floor((lowerWindow + upperWindow) / 2)
            : Math.min(upperWindow, windowMs * 2);
        }
        if (upperWindow - lowerWindow <= 250 || windowMs === 0) break;
      }
      ticks = latestFull.length >= tickLimit ? latestFull : bestUnderfilled;
    }

    return buildMt5TickBars(ticks, ticksPerBar).slice(-limit);
  }

  private subscribeTicks(
    ticker: string,
    ticksPerBar: number,
    onBar: (bar: OHLCV) => void,
  ): () => void {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = Math.max(0, Date.now() - 1000);
    let current: Mt5TickBarState | null = null;
    let previousBarTime = -1;
    let seenAtCursor = new Map<string, number>();

    const poll = async () => {
      if (!active || !this.connected) return;
      try {
        const ticks = await this.bridge.ticks({ ticker, fromMsc: cursor, limit: 2000 });
        const batchOccurrences = new Map<string, number>();
        for (const tick of ticks) {
          if (tick.time < cursor) continue;
          if (tick.time > cursor) {
            cursor = tick.time;
            seenAtCursor = new Map();
          }
          const key = tickKey(tick);
          const occurrence = (batchOccurrences.get(key) ?? 0) + 1;
          batchOccurrences.set(key, occurrence);
          if (occurrence <= (seenAtCursor.get(key) ?? 0)) continue;
          seenAtCursor.set(key, occurrence);
          const price = tickPrice(tick);
          if (!Number.isFinite(tick.time) || !Number.isFinite(price) || price <= 0) continue;
          if (!current) {
            current = {
              time: Math.max(tick.time, previousBarTime + 1),
              open: price,
              high: price,
              low: price,
              close: price,
              volume: Number.isFinite(tick.volumeReal) && tick.volumeReal > 0 ? tick.volumeReal : 0,
              tickCount: 0,
            };
          } else {
            current.high = Math.max(current.high, price);
            current.low = Math.min(current.low, price);
            current.close = price;
            if (Number.isFinite(tick.volumeReal) && tick.volumeReal > 0) current.volume = (current.volume ?? 0) + tick.volumeReal;
          }
          current.tickCount += 1;
          const { tickCount, ...bar } = current;
          onBar(bar);
          if (tickCount >= ticksPerBar) {
            previousBarTime = current.time;
            current = null;
          }
        }
        const lastTime = ticks.at(-1)?.time;
        if (lastTime !== undefined && lastTime > cursor) {
          cursor = lastTime;
          seenAtCursor = new Map();
        }
      } catch (error) {
        if (active) console.error(`[MetaTrader 5] Tick-bar stream failed for ${ticker}:`, error);
      } finally {
        if (active) timer = setTimeout(() => { void poll(); }, 250);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }
}

function mt5SymbolType(path: string): string {
  const segments = path.split(/[\\/]/).map(segment => segment.trim().toLowerCase()).filter(Boolean);
  const knownTypes: Record<string, string> = {
    forex: 'forex',
    currencies: 'forex',
    stocks: 'stock',
    shares: 'stock',
    equities: 'stock',
    futures: 'futures',
    commodities: 'commodity',
    metals: 'commodity',
    indices: 'index',
    indexes: 'index',
    crypto: 'crypto',
    cryptocurrencies: 'crypto',
  };
  return segments.map(segment => knownTypes[segment]).find(Boolean) ?? segments[0] ?? 'market';
}

export function initializeMt5Feed(getWorkspace: () => VelaWorkspace): void {
  const modal = document.getElementById('mt5-feed-modal');
  const openButton = document.getElementById('mt5-feed-toggle');
  const closeButton = document.getElementById('mt5-feed-close');
  const connectButton = document.getElementById('mt5-feed-connect') as HTMLButtonElement | null;
  const disconnectButton = document.getElementById('mt5-feed-disconnect') as HTMLButtonElement | null;
  const executableInput = document.getElementById('mt5-python-path') as HTMLInputElement | null;
  if (executableInput) {
    executableInput.value = 'python';
  }
  const status = document.getElementById('mt5-feed-status');
  const symbolSearch = document.getElementById('mt5-symbol-search') as HTMLInputElement | null;
  const symbolList = document.getElementById('mt5-symbol-list');
  const refreshSymbolsButton = document.getElementById('mt5-symbols-refresh') as HTMLButtonElement | null;
  if (!modal || !openButton || !closeButton || !connectButton || !disconnectButton || !executableInput
    || !status || !symbolSearch || !symbolList || !refreshSymbolsButton) return;
  if (!window.velaMt5) {
    status.textContent = 'MetaTrader 5 feed is only available in the Omega desktop app.';
    connectButton.disabled = true;
  }

  const provider = window.velaMt5 ? new Mt5DataProvider(window.velaMt5) : null;
  let connected = false;
  let revision = 0;
  let loadedSymbols: Mt5Symbol[] = [];
  let tradingAccountId: string | null = null;
  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.dataset.state = isError ? 'error' : 'info';
  };
  const deactivate = () => {
    const wasConnected = connected;
    connected = false;
    revision += 1;
    loadedSymbols = [];
    provider?.disconnect();
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
    if (tradingAccountId) {
      document.dispatchEvent(new CustomEvent('omega:trading-account-unavailable', { detail: tradingAccountId }));
    }
    tradingAccountId = null;
    connectButton.hidden = false;
    disconnectButton.hidden = true;
    renderSymbols();
    if (wasConnected) setStatus('MetaTrader data feed stopped because another provider is being connected.');
  };
  const registerProvider = async (chart: VelaWorkspace['chart'], expectedRevision: number) => {
    if (!provider || !connected || expectedRevision !== revision) return;
    chart.data.registerProvider('mt5', provider);
    await chart.data.ready();
    if (!connected || expectedRevision !== revision) chart.data.unregisterProvider('mt5');
  };
  const registerWorkspace = async (expectedRevision: number) => {
    const workspace = getWorkspace();
    await Promise.all(workspace.cells().map(cell => registerProvider(cell.chart, expectedRevision)));
  };
  const renderSymbols = () => {
    const query = symbolSearch.value.trim().toLowerCase();
    const filtered = loadedSymbols.filter(symbol => !query
      || symbol.ticker.toLowerCase().includes(query)
      || symbol.description.toLowerCase().includes(query)
      || symbol.path.toLowerCase().includes(query));
    symbolList.replaceChildren();
    if (!loadedSymbols.length) {
      const empty = document.createElement('p');
      empty.className = 'mt5-symbol-empty';
      empty.textContent = connected
        ? 'MT5 connected, but it returned no symbols. Open View > Symbols in MT5, enable instruments, then press Refresh.'
        : 'Connect MT5 to load Pepperstone symbols here.';
      symbolList.append(empty);
      return;
    }
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'mt5-symbol-empty';
      empty.textContent = 'No loaded MT5 symbols match this search.';
      symbolList.append(empty);
      return;
    }
    for (const symbol of filtered.slice(0, 100)) {
      const button = document.createElement('button');
      button.className = 'mt5-symbol-row';
      button.type = 'button';
      button.setAttribute('role', 'option');
      const ticker = document.createElement('strong');
      ticker.textContent = symbol.ticker;
      const detail = document.createElement('small');
      detail.textContent = `${symbol.description || symbol.ticker} · MT5`;
      button.append(ticker, detail);
      button.addEventListener('click', () => {
        if (connected) getWorkspace().active.setSymbol(`MT5:${symbol.ticker}`);
      });
      symbolList.append(button);
    }
    if (filtered.length > 100) {
      const more = document.createElement('p');
      more.className = 'mt5-symbol-empty';
      more.textContent = `Showing first 100 of ${filtered.length} symbols. Search to narrow the list.`;
      symbolList.append(more);
    }
  };

  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerProvider(cell.chart, revision).catch(error => {
      console.error('Could not register the MetaTrader provider on a new chart:', error);
      setStatus(error instanceof Error ? error.message : String(error), true);
    });
  });
  document.addEventListener('omega:trading-broker-connecting', deactivate);
  document.addEventListener('omega:trading-broker-connected', event => {
    if ((event as CustomEvent<string>).detail !== 'mt5') deactivate();
  });

  openButton.addEventListener('click', () => {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  });
  const closeModal = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  };
  closeButton.addEventListener('click', closeModal);
  symbolSearch.addEventListener('input', renderSymbols);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  connectButton.addEventListener('click', async () => {
    if (!window.velaMt5 || !provider) return;
    connectButton.disabled = true;
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'mt5' }));
    const attemptRevision = revision;
    setStatus('Connecting to the MetaTrader 5 terminal…');
    try {
      const connection = await window.velaMt5.connect(executableInput?.value.trim() || undefined);
      if (attemptRevision !== revision) return;
      loadedSymbols = connection.symbols;
      provider.setSymbols(connection.symbols);
      connected = true;
      const connectedRevision = ++revision;
      await registerWorkspace(connectedRevision);
      if (connectedRevision !== revision) return;
      tradingAccountId = `mt5:${connection.server || connection.terminal || 'terminal'}`;
      document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
        detail: {
          id: tradingAccountId,
          label: `MT5 · ${connection.server || connection.company || 'Terminal'}`,
          mode: 'CONNECTED',
          detail: 'MT5 market data · read-only',
        },
      }));
      connectButton.hidden = true;
      disconnectButton.hidden = false;
      document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'mt5' }));
      const sourceStatus = connection.symbols.length
        ? `${connection.symbols.length} Pepperstone symbols loaded, including ${connection.symbols.slice(0, 5).map(symbol => symbol.ticker).join(', ')}.`
        : 'The terminal returned zero symbols. In MT5 open View > Symbols, enable instruments, then press Refresh.';
      setStatus(`Connected to ${connection.company || connection.terminal}${connection.server ? ` (${connection.server})` : ''}. ${sourceStatus} You can select one from the MT5 list below or search MT5:SYMBOL in the chart picker.`, connection.symbols.length === 0);
      renderSymbols();
    } catch (error) {
      if (attemptRevision !== revision) return;
      connected = false;
      loadedSymbols = [];
      provider.disconnect();
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
      setStatus(error instanceof Error ? error.message : String(error), true);
      renderSymbols();
    } finally {
      connectButton.disabled = false;
    }
  });

  disconnectButton.addEventListener('click', async () => {
    if (!window.velaMt5) return;
    disconnectButton.disabled = true;
    try {
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
      await window.velaMt5.disconnect();
      deactivate();
      document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'mt5' }));
      setStatus('MetaTrader data feed disconnected. The chart provider is no longer registered.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      disconnectButton.disabled = false;
    }
  });

  refreshSymbolsButton.addEventListener('click', async () => {
    if (!window.velaMt5 || !connected) {
      setStatus('Connect to the MT5 terminal before refreshing its symbols.', true);
      return;
    }
    refreshSymbolsButton.disabled = true;
    const expectedRevision = revision;
    try {
      loadedSymbols = await window.velaMt5.symbols();
      if (expectedRevision !== revision || !connected) return;
      provider?.setSymbols(loadedSymbols);
      await registerWorkspace(expectedRevision);
      if (expectedRevision !== revision || !connected) return;
      renderSymbols();
      setStatus(`${loadedSymbols.length} Pepperstone symbols loaded from the MT5 terminal.`);
    } catch (error) {
      if (expectedRevision === revision) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    } finally {
      refreshSymbolsButton.disabled = false;
    }
  });

  renderSymbols();
}
