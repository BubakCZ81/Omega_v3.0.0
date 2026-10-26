import './visualBacktest.css';
import { calculateBacktestAnalytics, type BacktestAnalytics } from './backtestStats';
import type { DataProvider, OHLCV, StrategyState, StrategyTrade } from '@luxalgo/vela';
import { BACKTEST_PROVIDER_PREFIX, loadBacktestHistory, registerBacktestHistoryProvider } from './backtestHistory';

type VisualChartCell = {
  id: string;
  host: HTMLElement;
  chart: {
    market: { symbol?: string; timeframe?: string };
    data: {
      providers: () => Array<{ name: string; displayName?: string }>;
      resolve: (symbol: string) => { provider?: string; ticker?: string } | null;
      providerInstance: (name: string) => DataProvider | undefined;
      registerProvider: (name: string, provider: DataProvider) => unknown;
      unregisterProvider: (name: string) => unknown;
      ready: () => Promise<void>;
    };
    replay: { bounds?: { first: number; last: number } | null };
    setMarket: (market: { symbol?: string; timeframe?: string; bars?: number; data?: OHLCV[]; visibleRange?: { from: number; to: number } }) => Promise<void>;
    historyComplete: () => Promise<void>;
    indicators: () => Array<VisualStrategyHandle>;
  };
};

type VisualStrategyHandle = {
  id: string;
  title: string;
  source?: string;
  inputs: Array<{ key: string; title: string; defval: unknown }>;
  props: Array<{ key: string; title: string; defval: unknown }>;
  inputValues: () => Record<string, unknown>;
  propValues: () => Record<string, unknown>;
  context: (keys: string[]) => Promise<{ strategy?: StrategyState; trades?: readonly StrategyTrade[] } | null>;
};

type VisualWorkspace = {
  active: VisualChartCell;
  setActiveCell: (id: string) => void;
  replay: {
    bounds?: { first: number; last: number };
    state: { active: boolean; playing: boolean; remaining: number; cursorTime?: number | null; nextTime?: number | null };
    start: (options: { from: number; cell: string }) => Promise<void>;
    pause: () => void;
    stop: () => void;
    step: () => boolean;
    on: (event: 'replay:start' | 'replay:step' | 'replay:play' | 'replay:pause' | 'replay:end', listener: () => void) => void;
  };
};

type ResultsView = 'trades' | 'equity' | 'statistics';

function localDateInputValue(time: number): string {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function number(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : '—';
}

function signed(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${number(value, digits)}` : '—';
}

/**
 * A dedicated visual-test workbench. It deliberately reuses Vela replay and
 * Pine strategy ledgers, keeping the test isolated in a separate chart tab.
 */
export function initializeVisualBacktest(
  workspace: VisualWorkspace,
  createTestChart: () => VisualChartCell | null,
  openIndicators: () => void,
  openPineEditor: () => void,
): void {
  const trigger = document.getElementById('visual-backtest-toggle');
  if (!(trigger instanceof HTMLButtonElement)) return;

  const root = document.createElement('section');
  root.id = 'omega-visual-backtest';
  root.hidden = true;
  root.setAttribute('aria-label', 'Visual Backtest');
  root.innerHTML = `
    <header class="omega-vbt-toolbar">
      <strong>Visual Backtest</strong>
      <label>Feed <select data-vbt="feed"><option value="">Auto</option></select></label>
      <label>Asset <input data-vbt="symbol" spellcheck="false"></label>
      <label>Timeframe <select data-vbt="timeframe">
        <option value="1">1m</option><option value="5">5m</option><option value="15">15m</option>
        <option value="30">30m</option><option value="60" selected>1h</option><option value="240">4h</option><option value="D">1D</option>
      </select></label>
      <label>From <input data-vbt="from" type="datetime-local" step="60"></label>
      <label>To <input data-vbt="to" type="datetime-local" step="60"></label>
      <label>Speed <select data-vbt="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select></label>
      <button type="button" data-vbt="start" class="omega-vbt-primary" title="Load historical candles for the selected period">Load History</button>
      <button type="button" data-vbt="play" disabled>Play</button>
      <button type="button" data-vbt="step" disabled>Step</button>
      <button type="button" data-vbt="stop" disabled>Stop</button>
      <button type="button" data-vbt="close" aria-label="Close Visual Backtest">×</button>
    </header>
    <div class="omega-vbt-chart-status"><strong data-vbt="pnl">P/L $0.00</strong><span data-vbt="status">Choose a period and start a test.</span></div>
    <section class="omega-vbt-bottom">
      <aside class="omega-vbt-parameters"><header><strong>Parameters</strong><div><button type="button" data-vbt="strategy">Add strategy</button><button type="button" data-vbt="indicators">Indicators</button></div></header><select data-vbt="strategies" aria-label="Backtest strategy"></select><div data-vbt="parameters" class="omega-vbt-parameter-list">Add a Pine strategy to the test chart.</div></aside>
      <div class="omega-vbt-results"><nav data-vbt="tabs"><button type="button" data-view="trades" aria-selected="true">Trades</button><button type="button" data-view="equity">Equity</button><button type="button" data-view="statistics">Statistics</button></nav><div data-vbt="results" class="omega-vbt-results-content">No strategy result yet.</div></div>
    </section>`;
  document.getElementById('app-container')?.append(root);

  const query = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-vbt="${name}"]`)!;
  const feed = query<HTMLSelectElement>('feed');
  const symbol = query<HTMLInputElement>('symbol');
  const timeframe = query<HTMLSelectElement>('timeframe');
  const from = query<HTMLInputElement>('from');
  const to = query<HTMLInputElement>('to');
  const speed = query<HTMLSelectElement>('speed');
  const start = query<HTMLButtonElement>('start');
  const play = query<HTMLButtonElement>('play');
  const step = query<HTMLButtonElement>('step');
  const stop = query<HTMLButtonElement>('stop');
  const status = query<HTMLElement>('status');
  const pnl = query<HTMLElement>('pnl');
  const strategySelect = query<HTMLSelectElement>('strategies');
  const parameters = query<HTMLElement>('parameters');
  const results = query<HTMLElement>('results');
  const tabList = query<HTMLElement>('tabs');
  let testCell: VisualChartCell | null = null;
  let activeView: ResultsView = 'trades';
  let playbackTimer: ReturnType<typeof setInterval> | null = null;
  let replayEndTime: number | null = null;
  let renderRevision = 0;
  let startRevision = 0;
  let startRequestInFlight = false;
  let backtestProviderRevision = 0;
  let activeBacktestProviderName: string | null = null;
  let sourceProviderName: string | null = null;
  let sourceProvider: DataProvider | null = null;

  const selectActiveStrategy = (): VisualStrategyHandle | null => testCell?.chart.indicators().find(item => item.id === strategySelect.value) ?? null;

  const renderResults = async () => {
    const revision = ++renderRevision;
    const strategies = (testCell?.chart.indicators() ?? []).filter(item => typeof item.source === 'string' && /^\s*strategy\s*\(/m.test(item.source));
    const selectedBefore = strategySelect.value;
    strategySelect.replaceChildren();
    for (const item of strategies) {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; strategySelect.append(option);
    }
    strategySelect.disabled = strategies.length === 0;
    if (strategies.some(item => item.id === selectedBefore)) strategySelect.value = selectedBefore;
    const strategy = selectActiveStrategy();
    parameters.replaceChildren();
    if (!strategy) {
      parameters.textContent = 'Add a Pine strategy to the test chart, then choose it here.';
      results.textContent = 'No strategy result yet.';
      pnl.textContent = 'P/L $0.00';
      return;
    }
    const values = { ...strategy.inputValues(), ...strategy.propValues() };
    for (const field of [...strategy.inputs, ...strategy.props]) {
      const row = document.createElement('div');
      row.className = 'omega-vbt-parameter';
      row.textContent = `${field.title}: ${String(values[field.key] ?? field.defval)}`;
      parameters.append(row);
    }
    let context: Awaited<ReturnType<VisualStrategyHandle['context']>>;
    try {
      context = await strategy.context(['strategy', 'trades']);
    } catch (error) {
      if (revision !== renderRevision) return;
      results.textContent = `Could not read strategy results: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    if (revision !== renderRevision) return;
    if (!context?.strategy) {
      results.textContent = 'The selected strategy has not produced a result yet.';
      return;
    }
    const analytics = calculateBacktestAnalytics(context.strategy, context.trades ?? []);
    pnl.textContent = `P/L $${signed(analytics.netProfit, 2)}`;
    pnl.className = analytics.netProfit > 0 ? 'positive' : analytics.netProfit < 0 ? 'negative' : '';
    renderAnalytics(analytics, context.trades ?? []);
  };

  const renderAnalytics = (analytics: BacktestAnalytics, trades: readonly StrategyTrade[]) => {
    results.replaceChildren();
    if (activeView === 'trades') {
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>P/L</th></tr></thead>';
      const body = document.createElement('tbody');
      for (const trade of [...trades].sort((a, b) => (b.exit?.time ?? b.entry.time) - (a.exit?.time ?? a.entry.time)).slice(0, 100)) {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${trade.side}</td><td>${new Date(trade.entry.time).toLocaleString()}</td><td>${trade.exit ? new Date(trade.exit.time).toLocaleString() : 'Open'}</td><td class="${(trade.pnl ?? 0) >= 0 ? 'positive' : 'negative'}">${signed(trade.pnl, 2)}</td>`;
        body.append(row);
      }
      table.append(body); results.append(table);
      if (!trades.length) results.textContent = 'No trades have been generated for this period.';
      return;
    }
    if (activeView === 'equity') {
      const values = [analytics.initialCapital, ...analytics.realizedEquity.map(point => point.equity)];
      const minimum = Math.min(...values); const maximum = Math.max(...values); const span = maximum - minimum || 1;
      const points = values.length > 1 ? values.map((value, index) => `${index / (values.length - 1) * 100},${100 - (value - minimum) / span * 100}`).join(' ') : '';
      results.innerHTML = `<div class="omega-vbt-equity-heading">Balance ${number(values.at(-1), 2)} · ${values.length - 1} closed trades</div><svg class="omega-vbt-equity" viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
      if (values.length < 2) results.insertAdjacentText('beforeend', ' No closed trades yet.');
      return;
    }
    const stats = [['Net profit', signed(analytics.netProfit, 2)], ['Return', `${number(analytics.returnPercent, 2)}%`], ['Win rate', `${number(analytics.winRate, 2)}%`], ['Profit factor', number(analytics.profitFactor, 2)], ['Max drawdown', number(analytics.maxDrawdown, 2)], ['Closed trades', String(analytics.closedTrades)]];
    for (const [label, value] of stats) {
      const card = document.createElement('div'); card.className = 'omega-vbt-stat'; card.innerHTML = `<span>${label}</span><strong>${value}</strong>`; results.append(card);
    }
  };

  const syncReplay = () => {
    const state = workspace.replay.state;
    const atEnd = state.active && isPastEnd();
    play.disabled = !state.active || state.remaining === 0 || atEnd;
    step.disabled = !state.active || state.remaining === 0 || atEnd;
    stop.disabled = !state.active && start.disabled === false;
    play.textContent = playbackTimer !== null ? 'Pause' : 'Play';
    if (atEnd) {
      pausePlayback();
      status.textContent = 'Selected end date reached.';
    } else if (state.active && state.cursorTime) {
      status.textContent = `${state.remaining} bars remaining · ${new Date(state.cursorTime).toLocaleString()}`;
    }
    void renderResults();
  };

  const populateFeeds = (chart: VisualChartCell) => {
    const selected = feed.value;
    feed.replaceChildren(new Option('Auto', ''));
    const providers = chart.chart.data.providers();
    for (const provider of providers) {
      if (provider.name.toLowerCase().startsWith(`${BACKTEST_PROVIDER_PREFIX}_`)) continue;
      feed.add(new Option(provider.displayName ?? provider.name, provider.name.toLowerCase()));
    }
    if (providers.some(provider => provider.name.toLowerCase() === selected)) feed.value = selected;
  };

  const populatePeriod = () => {
    const bounds = (testCell ?? workspace.active).chart.replay.bounds;
    const last = bounds?.last ?? Date.now();
    if (!from.value) from.value = localDateInputValue(Math.max(bounds?.first ?? 0, last - 30 * 24 * 60 * 60 * 1000));
    if (!to.value) to.value = localDateInputValue(last);
  };

  const focusTestChart = (): boolean => {
    testCell ??= createTestChart();
    if (!testCell) {
      status.textContent = 'No free chart tab is available for Visual Backtest.';
      return false;
    }
    workspace.setActiveCell(testCell.id);
    populateFeeds(testCell);
    return true;
  };

  trigger.addEventListener('click', () => {
    root.hidden = false;
    if (testCell) workspace.setActiveCell(testCell.id);
    const sourceCell = testCell ?? workspace.active;
    populateFeeds(sourceCell);
    const currentSymbol = sourceCell.chart.market.symbol ?? '';
    const resolved = sourceCell.chart.data.resolve(currentSymbol);
    symbol.value = resolved?.ticker ?? currentSymbol.replace(/^[^:]+:/, '');
    sourceProviderName = resolved?.provider?.toLowerCase() ?? null;
    sourceProvider = sourceProviderName ? sourceCell.chart.data.providerInstance(sourceProviderName) ?? null : null;
    if (sourceProviderName) feed.value = sourceProviderName;
    timeframe.value = sourceCell.chart.market.timeframe ?? '60';
    populatePeriod();
    status.textContent = 'Set the test period, then start a Visual Backtest tab.';
  });
  query<HTMLButtonElement>('close').addEventListener('click', () => {
    ++startRevision;
    workspace.replay.stop();
    pausePlayback();
    root.hidden = true;
  });
  query<HTMLButtonElement>('indicators').addEventListener('click', () => {
    if (focusTestChart()) openIndicators();
  });
  query<HTMLButtonElement>('strategy').addEventListener('click', () => {
    if (focusTestChart()) openPineEditor();
  });
  strategySelect.addEventListener('change', () => void renderResults());
  tabList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-view]');
    if (!button) return;
    activeView = button.dataset.view as ResultsView;
    for (const item of tabList.querySelectorAll<HTMLButtonElement>('button')) item.setAttribute('aria-selected', String(item === button));
    void renderResults();
  });
  start.addEventListener('click', async () => {
    const startTime = new Date(from.value).getTime(); const endTime = new Date(to.value).getTime();
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      status.textContent = 'Choose a valid From and To period.'; return;
    }
    testCell ??= createTestChart();
    if (!testCell) { status.textContent = 'No free chart tab is available for Visual Backtest.'; return; }
    const ticker = symbol.value.trim().toUpperCase();
    if (!ticker) { status.textContent = 'Enter an asset symbol.'; return; }
    if (startRequestInFlight) return;
    const requestRevision = ++startRevision;
    startRequestInFlight = true;
    replayEndTime = endTime;
    start.disabled = true; status.textContent = 'Loading historical data…';
    try {
      workspace.setActiveCell(testCell.id);
      pausePlayback();
      // A new tab can be created before optional feeds finish registering on it.
      // Reuse the exact provider that resolved the source chart so a valid symbol
      // such as AAPL remains valid in the isolated backtest tab.
      if (sourceProviderName && sourceProvider) {
        testCell.chart.data.registerProvider(sourceProviderName, sourceProvider);
        await testCell.chart.data.ready();
        populateFeeds(testCell);
        if ([...feed.options].some(option => option.value === sourceProviderName)) feed.value = sourceProviderName;
      }
      const marketSymbol = feed.value ? `${feed.value}:${ticker}` : ticker;
      const resolved = testCell.chart.data.resolve(marketSymbol);
      if (!resolved?.provider || !resolved.ticker) {
        throw new Error(`Could not resolve ${ticker} to a market-data provider.`);
      }
      const provider = testCell.chart.data.providerInstance(resolved.provider);
      if (!provider) throw new Error(`The ${resolved.provider} data provider is unavailable.`);
      const bars = await loadBacktestHistory(
        provider,
        resolved.ticker,
        timeframe.value,
        startTime,
        endTime,
        () => requestRevision === startRevision,
      );
      if (requestRevision !== startRevision) return;
      if (!bars?.length) {
        throw new Error(`No candles were returned for ${ticker} in the selected period. Check the feed, symbol, date range, and historical-data access.`);
      }
      const backtestProviderName = `${BACKTEST_PROVIDER_PREFIX}_${++backtestProviderRevision}`;
      const registeredProvider = await registerBacktestHistoryProvider(
        testCell.chart.data,
        provider,
        backtestProviderName,
        bars,
        () => requestRevision === startRevision,
      );
      if (!registeredProvider) return;
      const backtestSymbol = `${backtestProviderName}:${resolved.ticker}`;
      await testCell.chart.setMarket({
        symbol: backtestSymbol,
        timeframe: timeframe.value,
        bars: bars.length,
      });
      const previousProviderName = activeBacktestProviderName;
      activeBacktestProviderName = backtestProviderName;
      if (previousProviderName) testCell.chart.data.unregisterProvider(previousProviderName);
      if (requestRevision !== startRevision) return;
      await testCell.chart.historyComplete();
      if (requestRevision !== startRevision) return;
      await testCell.chart.setMarket({ visibleRange: { from: startTime, to: endTime } });
      const bounds = testCell.chart.replay.bounds;
      if (!bounds || startTime > bounds.last) {
        throw new Error(`Loaded ${bars.length.toLocaleString()} candles, but none fall inside the selected period.`);
      }
      replayEndTime = Math.min(endTime, bounds.last);
      await workspace.replay.start({ from: startTime, cell: testCell.id });
      if (requestRevision !== startRevision) {
        workspace.replay.stop();
        return;
      }
      if (!workspace.replay.state.active) {
        throw new Error('The selected period has no replayable historical candles.');
      }
      status.textContent = `Loaded ${bars.length.toLocaleString()} historical candles. Press Play to begin visual playback.`;
    } catch (error) {
      if (requestRevision === startRevision) {
        status.textContent = `Could not start Visual Backtest: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      startRequestInFlight = false;
      start.disabled = false;
      if (requestRevision === startRevision) {
        syncReplay();
      }
    }
  });
  play.addEventListener('click', () => {
    if (playbackTimer !== null) pausePlayback(); else startPlayback();
    syncReplay();
  });
  step.addEventListener('click', () => {
    if (isPastEnd()) {
      status.textContent = 'Selected end date reached.';
      syncReplay();
      return;
    }
    workspace.replay.step();
    syncReplay();
  });
  stop.addEventListener('click', () => {
    ++startRevision;
    workspace.replay.stop();
    pausePlayback();
    status.textContent = 'Visual Backtest stopped.';
    syncReplay();
  });
  speed.addEventListener('change', () => { if (playbackTimer !== null) startPlayback(); });
  for (const event of ['replay:start', 'replay:step', 'replay:play', 'replay:pause', 'replay:end'] as const) workspace.replay.on(event, syncReplay);

  function isPastEnd(): boolean {
    const nextTime = workspace.replay.state.nextTime;
    return typeof nextTime === 'number' && replayEndTime !== null && nextTime > replayEndTime;
  }

  function pausePlayback(): void {
    if (playbackTimer !== null) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
    workspace.replay.pause();
  }

  function startPlayback(): void {
    pausePlayback();
    if (!workspace.replay.state.active || isPastEnd()) {
      syncReplay();
      return;
    }
    const interval = Math.max(16, Math.round(1000 / Number(speed.value)));
    playbackTimer = setInterval(() => {
      if (isPastEnd() || !workspace.replay.step()) {
        pausePlayback();
        syncReplay();
      }
    }, interval);
  }
}
