import { registerIcon, registerSidePanel, type InputSchema, type InputValue, type SidePanelHandle, type StrategyState, type StrategyTrade, type Vela } from '@luxalgo/vela';
import { calculateBacktestAnalytics, type BacktestAnalytics } from './backtestStats';

interface StrategySetting {
  title: string;
  value: InputValue;
}

interface StrategyResult {
  id: string;
  title: string;
  state: StrategyState;
  trades: readonly StrategyTrade[];
  settings: readonly StrategySetting[];
  updatedAt: number;
}

const panelStyles = `
  .omega-backtest { display:flex; flex-direction:column; gap:10px; height:100%; min-height:0; overflow:auto; padding:10px; color:var(--omega-text,#eef4fb) !important; background:var(--omega-bg,#17202c); font:12px/1.45 sans-serif; }
  .omega-backtest-controls { display:flex; align-items:center; gap:8px; }
  .omega-backtest-controls select { min-width:0; flex:1; border:1px solid var(--omega-border,#46566c); border-radius:4px; padding:6px; color:var(--omega-text,#eef4fb) !important; background:var(--omega-elevated,#2a3749); font:inherit; }
  .omega-backtest-controls select option { color:var(--omega-text,#eef4fb); background:var(--omega-elevated,#2a3749); }
  .omega-backtest-controls .vela-button { border:1px solid var(--omega-border,#46566c); color:var(--omega-text,#eef4fb) !important; background:var(--omega-elevated,#2a3749); }
  .omega-backtest-tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; }
  .omega-backtest-tabs button,.omega-backtest-filter select { min-width:0; border:1px solid var(--omega-border,#46566c); border-radius:4px; padding:6px; color:var(--omega-text,#eef4fb) !important; background:var(--omega-elevated,#2a3749); font:inherit; }
  .omega-backtest-tabs button[aria-selected="true"] { background:var(--omega-accent,#2563eb); border-color:var(--omega-accent,#2563eb); color:#fff !important; }
  .omega-backtest-filter { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
  .omega-backtest-status,.omega-backtest-label,.omega-backtest-table th,.omega-backtest-empty { color:var(--omega-text,#eef4fb) !important; }
  .omega-backtest-status[data-error="true"] { color:var(--omega-error,#f23645) !important; }
  .omega-backtest-metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
  .omega-backtest-metric { min-width:0; padding:8px; border:1px solid var(--omega-border,#46566c); border-radius:5px; background:var(--omega-elevated,#2a3749); }
  .omega-backtest-label { display:block; font-size:11px; }
  .omega-backtest-value { display:block; margin-top:2px; overflow-wrap:anywhere; color:var(--omega-text,#eef4fb) !important; font-size:14px; font-weight:650; }
  .omega-backtest-positive { color:var(--omega-success,#10b981) !important; }
  .omega-backtest-negative { color:var(--omega-error,#f23645) !important; }
  .omega-backtest-section-title { margin:4px 0 0; color:var(--omega-text,#eef4fb) !important; font-size:13px; }
  .omega-backtest-table-wrap { overflow:auto; border:1px solid var(--omega-border,#46566c); border-radius:5px; }
  .omega-backtest-table { width:100%; border-collapse:collapse; white-space:nowrap; font-size:10px; }
  .omega-backtest-table th,.omega-backtest-table td { padding:7px 6px; border-bottom:1px solid var(--omega-border,#46566c); color:var(--omega-text,#eef4fb) !important; text-align:right; }
  .omega-backtest-table th:first-child,.omega-backtest-table td:first-child { text-align:left; }
  .omega-backtest-table th { position:sticky; top:0; background:var(--omega-elevated,#2a3749); font-weight:700; }
  .omega-backtest-empty { padding:12px 4px; }
  .omega-backtest-settings { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
  .omega-backtest-setting { display:flex; justify-content:space-between; gap:8px; padding:6px 8px; border:1px solid var(--omega-border,#46566c); border-radius:4px; color:var(--omega-text,#eef4fb) !important; background:var(--omega-elevated,#2a3749); }
  .omega-backtest-setting span { overflow-wrap:anywhere; }
  .omega-backtest-setting strong { text-align:right; overflow-wrap:anywhere; }
  .omega-backtest-chart { overflow:hidden; min-height:116px; padding:8px; border:1px solid var(--omega-border,#46566c); border-radius:5px; background:var(--omega-elevated,#2a3749); }
  .omega-backtest-chart svg { display:block; width:100%; height:100px; overflow:visible; }
  .omega-backtest-chart-label { display:flex; justify-content:space-between; gap:8px; color:var(--omega-text,#eef4fb) !important; font-size:11px; }
  .omega-backtest-help { padding:8px; border-left:3px solid var(--omega-accent,#2563eb); border-radius:3px; color:var(--omega-text,#eef4fb) !important; background:var(--omega-elevated,#2a3749); font-size:11px; }
  .omega-backtest-table td.omega-backtest-muted { color:var(--omega-muted,#a9b7c7) !important; }
`;

function formatNumber(value: number, digits = 2): string {
  if (value === Infinity) return '∞';
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatSigned(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${formatNumber(value, digits)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value, 6)}%`;
}

function strategyCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'strategy' : 'strategies'}`;
}

function strategySettings(handle: {
  inputs: readonly InputSchema[];
  props: readonly InputSchema[];
  inputValues(): Record<string, InputValue>;
  propValues(): Record<string, InputValue>;
}): StrategySetting[] {
  const inputValues = handle.inputValues();
  const propValues = handle.propValues();
  const values = [
    ...handle.inputs.map(schema => ({ schema, value: inputValues[schema.key] ?? schema.defval })),
    ...handle.props.map(schema => ({ schema, value: propValues[schema.key] ?? schema.defval })),
  ];
  return values.map(({ schema, value }) => ({ title: schema.title, value }));
}

function formatSetting(value: InputValue): string {
  if (typeof value === 'number') return formatNumber(value, 8);
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    : '—';
}

function durationLabel(trade: StrategyTrade): string {
  if (!trade.exit) return 'Open';
  const elapsed = trade.exit.time - trade.entry.time;
  if (!Number.isFinite(elapsed) || elapsed < 0) return '—';
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1_440)}d`;
}

function metric(label: string, value: string, valueClass = ''): HTMLElement {
  const card = document.createElement('div');
  card.className = 'omega-backtest-metric';
  const caption = document.createElement('span');
  caption.className = 'omega-backtest-label';
  caption.textContent = label;
  const result = document.createElement('strong');
  result.className = `omega-backtest-value ${valueClass}`.trim();
  result.textContent = value;
  card.append(caption, result);
  return card;
}

function tradeTable(trades: readonly StrategyTrade[]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'omega-backtest-table-wrap';
  const table = document.createElement('table');
  table.className = 'omega-backtest-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const title of ['Side', 'Entry', 'Exit', 'Qty', 'P&L', 'Fees', 'MAE', 'MFE', 'Duration']) {
    const cell = document.createElement('th');
    cell.textContent = title;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  const ordered = [...trades].sort((left, right) => (right.exit?.time ?? right.entry.time) - (left.exit?.time ?? left.entry.time));
  for (const trade of ordered.slice(0, 250)) {
    const row = document.createElement('tr');
    const values = [
      trade.open ? `${trade.side} · open` : trade.side,
      formatTime(trade.entry.time),
      trade.exit ? formatTime(trade.exit.time) : '—',
      formatNumber(trade.qty, 8),
      trade.pnl === undefined ? (trade.open ? 'Open' : '—') : formatSigned(trade.pnl, 8),
      trade.commission === undefined ? '—' : formatNumber(trade.commission, 8),
      trade.maxDrawdown === undefined ? '—' : `-${formatNumber(trade.maxDrawdown, 8)}`,
      trade.maxRunup === undefined ? '—' : formatNumber(trade.maxRunup, 8),
      durationLabel(trade),
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 4 && trade.pnl !== undefined) {
        cell.className = trade.pnl > 0 ? 'omega-backtest-positive' : trade.pnl < 0 ? 'omega-backtest-negative' : '';
      }
      row.append(cell);
    });
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function realizedEquityChart(analytics: BacktestAnalytics): HTMLElement {
  const box = document.createElement('div');
  box.className = 'omega-backtest-chart';
  const label = document.createElement('div');
  label.className = 'omega-backtest-chart-label';
  const title = document.createElement('span');
  title.textContent = 'Realised equity';
  const final = document.createElement('strong');
  final.textContent = formatNumber(analytics.realizedEquity.at(-1)?.equity ?? analytics.initialCapital, 8);
  label.append(title, final);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 300 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Realised equity after each closed trade');
  const values = [analytics.initialCapital, ...analytics.realizedEquity.map(point => point.equity)];
  if (values.length < 2) {
    const empty = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    empty.setAttribute('x', '150'); empty.setAttribute('y', '53'); empty.setAttribute('text-anchor', 'middle');
    empty.setAttribute('fill', 'currentColor'); empty.textContent = 'No closed trades yet';
    svg.append(empty);
  } else {
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const span = maximum - minimum || 1;
    const points = values.map((value, index) => `${(4 + index / (values.length - 1) * 292).toFixed(2)},${(94 - (value - minimum) / span * 88).toFixed(2)}`).join(' ');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', points); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'var(--omega-accent,#2563eb)'); line.setAttribute('stroke-width', '2');
    svg.append(line);
  }
  box.append(label, svg);
  return box;
}

function downloadTrades(title: string, trades: readonly StrategyTrade[]): void {
  const escape = (value: string | number | undefined) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines: Array<Array<string | number | undefined>> = [['Side', 'Status', 'Entry time', 'Entry price', 'Exit time', 'Exit price', 'Quantity', 'P&L', 'Commission', 'MAE', 'MFE']];
  for (const trade of trades) lines.push([trade.side, trade.open ? 'Open' : 'Closed', trade.entry.time, trade.entry.price, trade.exit?.time, trade.exit?.price, trade.qty, trade.pnl, trade.commission, trade.maxDrawdown, trade.maxRunup]);
  const url = URL.createObjectURL(new Blob([lines.map(line => line.map(escape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'strategy'}-trades.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function monthlyTable(analytics: BacktestAnalytics): HTMLElement {
  if (!analytics.monthly.length) {
    const empty = document.createElement('div');
    empty.className = 'omega-backtest-empty';
    empty.textContent = 'Monthly results appear after the first closed trade.';
    return empty;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'omega-backtest-table-wrap';
  const table = document.createElement('table');
  table.className = 'omega-backtest-table';
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const name of ['Month', 'Net P&L', 'Trades', 'Wins', 'Losses']) {
    const cell = document.createElement('th'); cell.textContent = name; heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  for (const result of [...analytics.monthly].reverse()) {
    const row = document.createElement('tr');
    const values = [result.month, formatSigned(result.netProfit, 8), String(result.trades), String(result.wins), String(result.losses)];
    values.forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value;
      if (index === 1) cell.className = result.netProfit > 0 ? 'omega-backtest-positive' : result.netProfit < 0 ? 'omega-backtest-negative' : '';
      row.append(cell);
    });
    body.append(row);
  }
  table.append(head, body); wrapper.append(table);
  return wrapper;
}

registerIcon(
  'omega-backtest',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-7"/></svg>',
);

registerSidePanel({
  id: 'omega-backtest',
  title: 'Strategy Backtest',
  icon: 'omega-backtest',
  order: 74,
  width: 360,
  resizable: true,
  minWidth: 280,
  maxWidth: 560,
  mount(_context, body, header) {
    const style = document.createElement('style');
    style.textContent = panelStyles;
    document.head.append(style);

    const root = document.createElement('section');
    root.className = 'omega-backtest';
    const controls = document.createElement('div');
    controls.className = 'omega-backtest-controls';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Strategy');
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'vela-button';
    refresh.textContent = 'Refresh';
    refresh.setAttribute('aria-label', 'Refresh strategy results');
    const exportCsv = document.createElement('button');
    exportCsv.type = 'button';
    exportCsv.className = 'vela-button';
    exportCsv.textContent = 'CSV';
    exportCsv.setAttribute('aria-label', 'Export trade ledger as CSV');
    controls.append(select, refresh, exportCsv);
    const tabs = document.createElement('div');
    tabs.className = 'omega-backtest-tabs';
    const tabButtons = ['Overview', 'Performance', 'Trades'].map(name => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name; button.dataset.view = name.toLowerCase();
      button.setAttribute('aria-selected', String(name === 'Overview'));
      return button;
    });
    tabs.append(...tabButtons);
    const status = document.createElement('div');
    status.className = 'omega-backtest-status';
    status.setAttribute('role', 'status');
    const metrics = document.createElement('div');
    metrics.className = 'omega-backtest-metrics';
    const settingsTitle = document.createElement('h3');
    settingsTitle.className = 'omega-backtest-section-title';
    settingsTitle.textContent = 'Active strategy settings';
    const settingsRoot = document.createElement('div');
    settingsRoot.className = 'omega-backtest-settings';
    const tradeTitle = document.createElement('h3');
    tradeTitle.className = 'omega-backtest-section-title';
    const tradesRoot = document.createElement('div');
    root.append(controls, status, tabs, metrics, settingsTitle, settingsRoot, tradeTitle, tradesRoot);
    body.replaceChildren(root);

    let chart: Vela | null = null;
    let chartGeneration = 0;
    let selectedId = '';
    let view = 'overview';
    const results = new Map<string, StrategyResult>();
    const runVersions = new Map<string, number>();
    const unsubscribers: Array<() => void> = [];

    const setStatus = (message: string, error = false) => {
      status.textContent = message;
      status.dataset.error = String(error);
    };

    const render = () => {
      const ordered = [...results.values()].sort((left, right) => left.title.localeCompare(right.title));
      const priorSelection = selectedId;
      if (!ordered.some(result => result.id === selectedId)) selectedId = ordered[0]?.id ?? '';
      select.replaceChildren();
      for (const result of ordered) {
        const option = document.createElement('option');
        option.value = result.id;
        option.textContent = result.title;
        option.selected = result.id === selectedId;
        select.append(option);
      }
      select.disabled = ordered.length === 0;
      if (priorSelection !== selectedId) select.value = selectedId;
      header.setTitle(chart?.market.symbol ? `Strategy Backtest — ${chart.market.symbol}` : 'Strategy Backtest');

      metrics.replaceChildren();
      settingsRoot.replaceChildren();
      tradesRoot.replaceChildren();
      const current = results.get(selectedId);
      if (!current) {
        settingsTitle.hidden = true;
        settingsRoot.hidden = true;
        tradeTitle.textContent = 'Trade list';
        const empty = document.createElement('div');
        empty.className = 'omega-backtest-empty';
        empty.textContent = 'Apply a Pine strategy to this chart to view its backtest results.';
        metrics.append(metric('Net profit', '—'), metric('Win rate', '—'), metric('Profit factor', '—'), metric('Max drawdown', '—'));
        tradesRoot.append(empty);
        return;
      }

      settingsTitle.hidden = false;
      settingsRoot.hidden = false;
      if (current.settings.length) {
        for (const setting of current.settings) {
          const row = document.createElement('div');
          row.className = 'omega-backtest-setting';
          const label = document.createElement('span');
          label.textContent = setting.title;
          const value = document.createElement('strong');
          value.textContent = formatSetting(setting.value);
          row.append(label, value);
          settingsRoot.append(row);
        }
      } else {
        const noSettings = document.createElement('div');
        noSettings.className = 'omega-backtest-empty';
        noSettings.textContent = 'No configurable strategy inputs or properties. The script is using its declared defaults.';
        settingsRoot.append(noSettings);
      }

      const summary = calculateBacktestAnalytics(current.state, current.trades);
      const netClass = summary.netProfit > 0 ? 'omega-backtest-positive' : summary.netProfit < 0 ? 'omega-backtest-negative' : '';
      const openClass = summary.openProfit > 0 ? 'omega-backtest-positive' : summary.openProfit < 0 ? 'omega-backtest-negative' : '';
      settingsTitle.hidden = view !== 'overview';
      settingsRoot.hidden = view !== 'overview';
      if (view === 'performance') {
        tradeTitle.textContent = 'Performance and risk';
        metrics.append(
          metric('Gross profit', formatNumber(summary.grossProfit, 8), 'omega-backtest-positive'),
          metric('Gross loss', formatNumber(summary.grossLoss, 8), 'omega-backtest-negative'),
          metric('Average trade', formatSigned(summary.averageTrade ?? NaN, 8), (summary.averageTrade ?? 0) > 0 ? 'omega-backtest-positive' : (summary.averageTrade ?? 0) < 0 ? 'omega-backtest-negative' : ''),
          metric('Average win', formatNumber(summary.averageWin ?? NaN, 8), 'omega-backtest-positive'),
          metric('Average loss', formatNumber(summary.averageLoss ?? NaN, 8), 'omega-backtest-negative'),
          metric('Payoff ratio', formatNumber(summary.payoffRatio ?? NaN)),
          metric('Largest win', formatNumber(summary.largestWin ?? NaN, 8), 'omega-backtest-positive'),
          metric('Largest loss', formatNumber(summary.largestLoss ?? NaN, 8), 'omega-backtest-negative'),
          metric('Maximum run-up', formatNumber(summary.maxRunup, 8), 'omega-backtest-positive'),
          metric('Total commissions', formatNumber(summary.totalCommission, 8)),
          metric('Longest win streak', formatNumber(summary.longestWinStreak, 0)),
          metric('Longest loss streak', formatNumber(summary.longestLossStreak, 0)),
          metric('Long trades / P&L', `${summary.longTrades} / ${formatSigned(summary.longProfit, 8)}`, summary.longProfit > 0 ? 'omega-backtest-positive' : summary.longProfit < 0 ? 'omega-backtest-negative' : ''),
          metric('Short trades / P&L', `${summary.shortTrades} / ${formatSigned(summary.shortProfit, 8)}`, summary.shortProfit > 0 ? 'omega-backtest-positive' : summary.shortProfit < 0 ? 'omega-backtest-negative' : ''),
        );
        const help = document.createElement('div');
        help.className = 'omega-backtest-help';
        help.textContent = `PineTS/Vela state: position ${formatNumber(current.state.position, 8)} at average price ${formatNumber(current.state.avgPrice, 8)}. The metrics above use the engine state and its trade ledger.`;
        const monthlyTitle = document.createElement('h3');
        monthlyTitle.className = 'omega-backtest-section-title';
        monthlyTitle.textContent = 'Monthly realised results';
        tradesRoot.append(help, monthlyTitle, monthlyTable(summary));
        return;
      }
      if (view === 'trades') {
        tradeTitle.textContent = `Trade ledger (${current.trades.length})`;
        if (current.trades.length) tradesRoot.append(tradeTable(current.trades));
        else {
          const empty = document.createElement('div');
          empty.className = 'omega-backtest-empty';
          empty.textContent = 'This strategy has not generated any trades for the loaded chart history.';
          tradesRoot.append(empty);
        }
        metrics.append(
          metric('Ledger closed', formatNumber(summary.ledgerClosedTrades, 0)),
          metric('Open trades', formatNumber(summary.openTrades, 0)),
          metric('Winning trades', formatNumber(current.state.wins, 0), 'omega-backtest-positive'),
          metric('Losing trades', formatNumber(current.state.losses, 0), 'omega-backtest-negative'),
        );
        return;
      }
      metrics.append(realizedEquityChart(summary));
      metrics.append(
        metric('Net profit', formatSigned(summary.netProfit, 8), netClass),
        metric('Return', formatPercent(summary.returnPercent), netClass),
        metric('Equity', formatNumber(summary.equity, 8)),
        metric('Initial capital', formatNumber(summary.initialCapital, 8)),
        metric('Open P&L', formatSigned(summary.openProfit, 8), openClass),
        metric('Win rate', formatPercent(summary.winRate)),
        metric('Profit factor', formatNumber(summary.profitFactor ?? NaN)),
        metric('Max drawdown', `${formatNumber(summary.maxDrawdown, 8)}${summary.drawdownPercent === null ? '' : ` · ${formatPercent(summary.drawdownPercent)}`}`, 'omega-backtest-negative'),
        metric('Closed trades', formatNumber(summary.closedTrades, 0)),
        metric('Open trades', formatNumber(summary.openTrades, 0)),
      );
      const total = current.trades.length;
      const visibleCount = Math.min(total, 100);
      tradeTitle.textContent = `Trades (${total}${total > visibleCount ? ` · latest ${visibleCount}` : ''})`;
      if (total === 0) {
        const empty = document.createElement('div');
        empty.className = 'omega-backtest-empty';
        empty.textContent = 'This strategy has not generated any trades for the loaded chart history.';
        tradesRoot.append(empty);
      } else {
        tradesRoot.append(tradeTable(current.trades));
      }
    };

    const refreshResults = async () => {
      const activeChart = chart;
      if (!activeChart) return;
      const generation = chartGeneration;
      const handles = activeChart.indicators().filter(handle => (
        typeof handle.source === 'string' && /^\s*strategy\s*\(/m.test(handle.source)
      ));
      let failures = 0;
      const snapshots = await Promise.all(handles.map(async handle => {
        const version = runVersions.get(handle.id) ?? 0;
        try {
          const context = await handle.context(['strategy', 'trades']);
          if (chart !== activeChart || chartGeneration !== generation || version !== (runVersions.get(handle.id) ?? 0)) return null;
          if (!context?.strategy) {
            results.delete(handle.id);
            return null;
          }
          return {
            id: handle.id,
            title: handle.title,
            state: context.strategy,
            trades: context.trades ?? [],
            settings: strategySettings(handle),
            updatedAt: Date.now(),
          } satisfies StrategyResult;
        } catch (error) {
          failures += 1;
          console.error(`Could not read backtest results for "${handle.title}":`, error);
          return null;
        }
      }));
      if (chart !== activeChart || chartGeneration !== generation) return;
      for (const snapshot of snapshots) {
        if (snapshot) results.set(snapshot.id, snapshot);
      }
      render();
      setStatus(failures
        ? `Could not read results for ${failures} script${failures === 1 ? '' : 's'}.`
        : results.size ? `${strategyCountLabel(results.size)} on this chart · calculated by the PineTS strategy engine.`
          : 'No strategy is currently applied to this chart.', failures > 0);
    };

    const bindChart = (next: Vela) => {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      chartGeneration += 1;
      chart = next;
      results.clear();
      runVersions.clear();
      unsubscribers.push(
        chart.on('indicator:added', () => { void refreshResults(); }),
        chart.on('indicator:removed', event => {
          results.delete(event.id);
          runVersions.set(event.id, (runVersions.get(event.id) ?? 0) + 1);
          render();
          void refreshResults();
        }),
        chart.on('market:changed', () => {
          results.clear();
          render();
          void refreshResults();
        }),
        chart.on('script:run', run => {
          const nextVersion = (runVersions.get(run.id) ?? 0) + 1;
          runVersions.set(run.id, nextVersion);
          if (run.kind !== 'strategy' || !run.strategy) {
            results.delete(run.id);
            render();
            return;
          }
          const runChart = chart;
          const generation = chartGeneration;
          void run.trades().then(trades => {
            if (chart !== runChart || chartGeneration !== generation || runVersions.get(run.id) !== nextVersion) return;
            const handle = runChart?.indicators().find(item => item.id === run.id);
            results.set(run.id, {
              id: run.id,
              title: run.title,
              state: run.strategy!,
              trades,
              settings: handle ? strategySettings(handle) : [],
              updatedAt: Date.now(),
            });
            render();
            setStatus(`${strategyCountLabel(results.size)} on this chart · calculated by the PineTS strategy engine · updated ${new Date().toLocaleTimeString()}.`);
          }).catch(error => {
            if (chart !== runChart || chartGeneration !== generation || runVersions.get(run.id) !== nextVersion) return;
            console.error(`Could not load trade ledger for "${run.title}":`, error);
            setStatus(`Could not load trade ledger for "${run.title}": ${error instanceof Error ? error.message : String(error)}`, true);
          });
        }),
      );
      render();
      void refreshResults();
    };

    select.addEventListener('change', () => {
      selectedId = select.value;
      render();
    });
    for (const button of tabButtons) {
      button.addEventListener('click', () => {
        view = button.dataset.view ?? 'overview';
        for (const item of tabButtons) item.setAttribute('aria-selected', String(item === button));
        render();
      });
    }
    refresh.addEventListener('click', () => void refreshResults());
    exportCsv.addEventListener('click', () => {
      const current = results.get(selectedId);
      if (current) downloadTrades(current.title, current.trades);
    });
    return {
      onChart: bindChart,
      onOpen: () => void refreshResults(),
      destroy() {
        chartGeneration += 1;
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        style.remove();
        root.remove();
      },
    } satisfies SidePanelHandle;
  },
});
