import { registerIcon, registerSidePanel, type SidePanelHandle, type Vela } from '@luxalgo/vela';

type MarketFlowView = 'time-sales' | 'dom';
type TradeSide = 'BUY' | 'SELL';
type TimeSalesColumn = 'time' | 'price' | 'size' | 'side';

const timeSalesColumnNames: TimeSalesColumn[] = ['time', 'price', 'size', 'side'];
const defaultTimeSalesColumnWidths = [28, 28, 24, 20];
const minTimeSalesColumnWidth = 12;

export interface MarketFlowStyle {
  fontSize: number;
  background: string;
  text: string;
  buy: string;
  sell: string;
  grid: string;
}

type MarketFlowStyleKey = keyof MarketFlowStyle;

const marketFlowStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 12, background: '#131722', text: '#d1d4dc', buy: '#22c55e', sell: '#ef5350', grid: '#2a2e39' },
  dom: { fontSize: 12, background: '#131722', text: '#d1d4dc', buy: '#22c55e', sell: '#ef5350', grid: '#2a2e39' },
};
const marketFlowLightStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 12, background: '#ffffff', text: '#111827', buy: '#15803d', sell: '#b91c1c', grid: '#cbd5e1' },
  dom: { fontSize: 12, background: '#ffffff', text: '#111827', buy: '#15803d', sell: '#b91c1c', grid: '#cbd5e1' },
};
const marketFlowStyleKeys: MarketFlowStyleKey[] = ['fontSize', 'background', 'text', 'buy', 'sell', 'grid'];

export function normalizeTimeSalesColumnWidths(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== timeSalesColumnNames.length) return [...defaultTimeSalesColumnWidths];
  const widths = value.map(Number);
  if (widths.some(width => !Number.isFinite(width) || width < minTimeSalesColumnWidth)) return [...defaultTimeSalesColumnWidths];
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(width => width / total * 100);
}

export function resizeTimeSalesColumn(widths: readonly number[], index: number, delta: number): number[] {
  if (index < 0 || index >= widths.length - 1 || !Number.isFinite(delta)) return [...widths];
  const result = [...widths];
  const left = result[index] + delta;
  const right = result[index + 1] - delta;
  if (left < minTimeSalesColumnWidth || right < minTimeSalesColumnWidth) return result;
  result[index] = left;
  result[index + 1] = right;
  return result;
}

function loadTimeSalesColumnWidths(): number[] {
  const stored = localStorage.getItem('omega-market-flow-time-sales-columns');
  if (!stored) return [...defaultTimeSalesColumnWidths];
  try {
    return normalizeTimeSalesColumnWidths(JSON.parse(stored));
  } catch {
    return [...defaultTimeSalesColumnWidths];
  }
}

export function getMarketFlowStyle(view: MarketFlowView): MarketFlowStyle {
  const defaults = typeof document !== 'undefined' && document.body?.dataset.theme === 'light'
    ? marketFlowLightStyleDefaults
    : marketFlowStyleDefaults;
  const style = { ...defaults[view] };
  for (const key of marketFlowStyleKeys) {
    const stored = localStorage.getItem(`omega-market-flow-${view}-${key}`);
    if (stored === null) continue;
    if (key === 'fontSize') {
      const fontSize = Number(stored);
      if ([10, 11, 12, 13, 14, 16, 18].includes(fontSize)) style.fontSize = fontSize;
    } else if (/^#[\da-f]{6}$/i.test(stored)) {
      style[key] = stored;
    }
  }
  return style;
}

export function setMarketFlowStyle(view: MarketFlowView, key: MarketFlowStyleKey, value: string | number): void {
  if (key === 'fontSize') {
    const fontSize = Number(value);
    if (![10, 11, 12, 13, 14, 16, 18].includes(fontSize)) throw new Error('Choose a supported market panel font size.');
    localStorage.setItem(`omega-market-flow-${view}-${key}`, String(fontSize));
  } else {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Choose a valid six-digit panel color.');
    localStorage.setItem(`omega-market-flow-${view}-${key}`, value);
  }
  applyMarketFlowStyle(view);
}

function applyMarketFlowStyle(view: MarketFlowView): void {
  if (typeof document === 'undefined') return;
  const style = getMarketFlowStyle(view);
  for (const root of document.querySelectorAll<HTMLElement>(`.vela-panel-omega-${view} .omega-market-flow`)) {
    root.style.setProperty('--omega-market-font-size', `${style.fontSize}px`);
    root.style.setProperty('--omega-market-bg', style.background);
    root.style.setProperty('--omega-market-text', style.text);
    root.style.setProperty('--omega-market-buy', style.buy);
    root.style.setProperty('--omega-market-sell', style.sell);
    root.style.setProperty('--omega-market-grid', style.grid);
  }
}

export function refreshMarketFlowStyles(): void {
  applyMarketFlowStyle('time-sales');
  applyMarketFlowStyle('dom');
}
interface MarketTrade {
  time: number;
  price: number;
  quantity: number;
  side: TradeSide | 'FLAT';
  key?: string;
}

export function mt5SymbolForChart(chart: Vela): string | null {
  const activeSymbol = chart.market.symbol?.trim();
  if (!activeSymbol) return null;
  const resolved = chart.data.resolve(activeSymbol);
  if (resolved?.provider.toLowerCase() === 'mt5') return resolved.ticker.trim();
  if (chart.market.provider?.toLowerCase() === 'mt5' || /^mt5:/i.test(activeSymbol)) {
    const ticker = activeSymbol.replace(/^mt5:/i, '').trim();
    return ticker && ticker.length <= 100 ? ticker : null;
  }
  return null;
}

interface DepthLevel {
  price: number;
  quantity: number;
}

interface MarketDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

const panelStyles = `
  .omega-market-flow { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); background:var(--omega-market-bg,var(--vela-bg,#131722)); font:var(--omega-market-font-size,12px)/1.45 sans-serif; }
  .omega-market-flow-status { padding:8px 10px; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); border-bottom:1px solid var(--omega-market-grid,var(--vela-border,#2a2e39)); font-size:.9em; }
  .omega-market-flow-status[data-state="live"] { color:var(--omega-success,#10b981); }
  .omega-market-flow-status[data-state="error"] { color:var(--omega-error,#f23645); }
  .omega-market-flow-note { margin:8px; padding:7px 9px; color:var(--omega-market-text,var(--vela-fg,#d1d4dc)); background:color-mix(in srgb,var(--omega-market-text,#d1d4dc) 7%,transparent); border:1px solid color-mix(in srgb,var(--omega-market-text,#d1d4dc) 22%,transparent); border-radius:4px; font-size:.9em; }
  .omega-market-flow-table-wrap { flex:1; min-height:0; overflow:auto; }
  .omega-market-flow-table { width:100%; border-collapse:separate; border-spacing:0; font: .92em/1.4 Consolas,monospace; font-variant-numeric:tabular-nums; color:var(--omega-market-text,#d1d4dc); }
  .omega-market-flow-table th,.omega-market-flow-table td { padding:6px 8px; text-align:right; white-space:nowrap; }
  .omega-market-flow-table th { position:sticky; top:0; overflow:visible; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); background:var(--omega-market-bg,var(--vela-bg,#131722)); border-bottom:1px solid var(--omega-market-grid,var(--vela-border,#2a2e39)); font-size:calc(var(--omega-market-font-size,12px) * 1.0833); font-weight:700; }
  .omega-market-flow-table-resizable { table-layout:fixed; }
  .omega-market-flow-table-resizable .omega-market-flow-column-boundary { border-right:1px solid #64748b; }
  .omega-market-flow-table-resizable th.omega-market-flow-column-boundary { border-right:2px solid var(--vela-accent,#4d9cff); }
  .omega-market-flow-column-resizer { appearance:none; position:absolute; z-index:2; top:15%; right:-4px; width:9px; height:70%; padding:0; border:0; border-radius:4px; background:var(--vela-accent,#4d9cff); box-shadow:0 0 0 1px var(--omega-market-bg,#131722),0 0 5px color-mix(in srgb,var(--vela-accent,#4d9cff) 75%,transparent); cursor:col-resize; touch-action:none; }
  .omega-market-flow-column-resizer::after { content:""; position:absolute; top:50%; left:3px; width:2px; height:14px; border-block:1px solid var(--omega-market-bg,#131722); transform:translateY(-50%); }
  .omega-market-flow-column-resizer:hover,.omega-market-flow-column-resizer:focus-visible { background:var(--vela-accent-hover,#7ab7ff); box-shadow:0 0 0 2px var(--omega-market-bg,#131722),0 0 8px var(--vela-accent,#4d9cff); }
  .omega-market-flow-table th:first-child,.omega-market-flow-table td:first-child { text-align:left; }
  .omega-market-flow-table .omega-market-flow-price { text-align:left; }
  .omega-market-flow-table tbody td { font-size:calc(var(--omega-market-font-size,12px) * 1.1667); font-weight:700; }
  .omega-market-flow-time,.omega-market-flow-size { color:#f8fafc; letter-spacing:.01em; }
  body[data-theme="light"] .vela-panel.vela-panel-omega-time-sales .omega-market-flow-time,
  body[data-theme="light"] .vela-panel.vela-panel-omega-time-sales .omega-market-flow-size { color:#000; }
  .omega-market-flow-table tbody td.omega-market-flow-buy { color:var(--omega-market-buy,#22c55e); }
  .omega-market-flow-table tbody td.omega-market-flow-sell { color:var(--omega-market-sell,#ef5350); }
  body[data-theme="light"] .vela-panel.vela-panel-omega-time-sales .omega-market-flow-table tbody td.omega-market-flow-buy { color:var(--omega-market-buy,#166534); }
  body[data-theme="light"] .vela-panel.vela-panel-omega-time-sales .omega-market-flow-table tbody td.omega-market-flow-sell { color:var(--omega-market-sell,#b91c1c); }
  .omega-market-flow-size { min-width:6ch; }
  .omega-market-flow-table tbody tr+tr { border-top:1px solid var(--omega-market-grid,var(--vela-border,#2a2e39)); }
  .omega-market-flow-buy { color:var(--omega-market-buy,var(--omega-success,#10b981)); }
  .omega-market-flow-sell { color:var(--omega-market-sell,var(--omega-error,#f23645)); }
  .omega-market-flow-empty { padding:16px 10px; color:var(--omega-market-text,var(--vela-muted,#9ca3af)); text-align:center; }
  .omega-market-flow-depth-cell { position:relative; isolation:isolate; overflow:hidden; }
  .omega-market-flow-depth-bar { position:absolute; z-index:0; inset-block:2px; opacity:.48; pointer-events:none; }
  .omega-market-flow-depth-bar.bid { right:0; background:var(--omega-market-buy,var(--omega-success,#10b981)); }
  .omega-market-flow-depth-bar.ask { left:0; background:var(--omega-market-sell,var(--omega-error,#f23645)); }
  body[data-theme="light"] .vela-panel.vela-panel-omega-dom .omega-market-flow-depth-bar.bid { background:#22c55e; }
  body[data-theme="light"] .vela-panel.vela-panel-omega-dom .omega-market-flow-depth-bar.ask { background:#ef4444; }
  .omega-market-flow-depth-value { position:relative; z-index:1; color:#f8fafc; font-size:calc(var(--omega-market-font-size,12px) * 1.1667); font-weight:800; text-shadow:0 1px 2px #000; }
  body[data-theme="light"] .vela-panel.vela-panel-omega-dom .omega-market-flow-depth-value { color:#000; text-shadow:0 1px 1px #fff; }
  .omega-market-flow-spread { padding:10px 8px; border-block:1px solid var(--omega-market-grid,var(--vela-border,#2a2e39)); color:var(--omega-market-text,var(--vela-fg-bright,#f1f5f9)); font:700 calc(var(--omega-market-font-size,12px) * 1.3333) Consolas,monospace; font-variant-numeric:tabular-nums; text-align:center; }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer { left:-8px; width:16px; }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer::after { left:7px; width:2px; background:var(--vela-separator,var(--vela-border,#2a2e39)); }
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer:hover::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer:hover::after,
  .vela-panel.vela-panel-omega-time-sales .vela-panel-resizer[data-dragging]::after,
  .vela-panel.vela-panel-omega-dom .vela-panel-resizer[data-dragging]::after { background:var(--vela-separator-hover-line,#5794f2); }
`;

let panelStylesInstalled = false;

export function binanceStreamForSymbol(chart: Vela): { symbol: string; futures: boolean } | null {
  const activeSymbol = chart.market.symbol?.trim();
  if (!activeSymbol) return null;
  const resolved = chart.data.resolve(activeSymbol);
  if (!resolved || resolved.provider.toLowerCase() !== 'binance') return null;
  const ticker = resolved.ticker.trim().toUpperCase();
  const futures = ticker.endsWith('.P');
  const symbol = futures ? ticker.slice(0, -2) : ticker;
  return /^[A-Z0-9]{2,30}$/.test(symbol) ? { symbol: symbol.toLowerCase(), futures } : null;
}

export function parseBinanceTrade(value: unknown): MarketTrade | null {
  if (!value || typeof value !== 'object') return null;
  const trade = value as Record<string, unknown>;
  const time = Number(trade.T ?? trade.E);
  const price = Number(trade.p);
  const quantity = Number(trade.q);
  if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) return null;
  return { time, price, quantity, side: trade.m === true ? 'SELL' : 'BUY' };
}

export function parseMt5Ticks(value: unknown, previousPrice = 0): { ticks: MarketTrade[]; cursor: number } {
  if (!Array.isArray(value)) return { ticks: [], cursor: 0 };
  const seen = new Set<string>();
  let cursor = 0;
  let lastPrice = previousPrice;
  const ticks: MarketTrade[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const time = Number(raw.time);
    const bid = Number(raw.bid);
    const ask = Number(raw.ask);
    const last = Number(raw.last);
    const volume = Number(raw.volumeReal ?? raw.volume);
    const flags = Number(raw.flags);
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(bid) || bid < 0
      || !Number.isFinite(ask) || ask < 0 || !Number.isFinite(last) || last < 0) continue;
    const price = last > 0 ? last : bid > 0 && ask >= bid ? (bid + ask) / 2 : bid || ask;
    if (!(price > 0)) continue;
    cursor = Math.max(cursor, time);
    const key = `${time}:${bid}:${ask}:${last}:${flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const direction = lastPrice > 0 ? Math.sign(price - lastPrice) : 0;
    ticks.push({
      time,
      price,
      quantity: Number.isFinite(volume) && volume > 0 ? volume : 0,
      side: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'FLAT',
      key,
    });
    lastPrice = price;
  }
  return { ticks, cursor };
}

export function isRecentMt5Tick(time: number, now = Date.now()): boolean {
  return Number.isFinite(time) && time >= now - 10_000 && time <= now + 2_000;
}

export function parseMt5Book(value: unknown): MarketDepth | null {
  if (!Array.isArray(value)) return null;
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const price = Number(entry.price);
    const quantity = Number(entry.volume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (entry.side === 'bid') bids.push({ price, quantity });
    else if (entry.side === 'ask') asks.push({ price, quantity });
  }
  if (!bids.length || !asks.length) return null;
  return {
    bids: bids.sort((left, right) => right.price - left.price),
    asks: asks.sort((left, right) => left.price - right.price),
  };
}

function parseDepthLevels(value: unknown): DepthLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(level => {
    if (!Array.isArray(level) || level.length < 2) return [];
    const price = Number(level[0]);
    const quantity = Number(level[1]);
    return Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity >= 0
      ? [{ price, quantity }]
      : [];
  }).filter(level => level.quantity > 0);
}

export function parseBinanceDepth(value: unknown): MarketDepth | null {
  if (!value || typeof value !== 'object') return null;
  const depth = value as Record<string, unknown>;
  const bids = parseDepthLevels(depth.b ?? depth.bids);
  const asks = parseDepthLevels(depth.a ?? depth.asks);
  if (bids.length === 0 || asks.length === 0) return null;
  return {
    bids: bids.sort((left, right) => right.price - left.price),
    asks: asks.sort((left, right) => left.price - right.price),
  };
}

function createCell(tag: 'td' | 'th', text: string, className = ''): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function formatPrice(price: number): string {
  return price.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

export function formatTradeSize(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) return '—';
  if (quantity < 0.01) {
    const maximumFractionDigits = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(quantity))));
    return quantity.toLocaleString(undefined, { maximumFractionDigits });
  }
  return quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTradeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function renderTrades(tableBody: HTMLTableSectionElement, trades: readonly MarketTrade[]): void {
  tableBody.replaceChildren();
  for (const trade of trades) {
    const row = document.createElement('tr');
    const sideClass = trade.side === 'BUY' ? 'omega-market-flow-buy' : trade.side === 'SELL' ? 'omega-market-flow-sell' : '';
    const cells = [
      createCell('td', formatTradeTime(trade.time), 'omega-market-flow-time'),
      createCell('td', formatPrice(trade.price), `omega-market-flow-price ${sideClass}`.trim()),
      createCell('td', formatTradeSize(trade.quantity), 'omega-market-flow-size'),
      createCell('td', trade.side, sideClass),
    ];
    cells.slice(0, -1).forEach(cell => cell.classList.add('omega-market-flow-column-boundary'));
    row.append(...cells);
    tableBody.append(row);
  }
}

function installTimeSalesColumnResizers(table: HTMLTableElement, heading: HTMLTableRowElement): void {
  const colGroup = document.createElement('colgroup');
  const columns = timeSalesColumnNames.map(() => document.createElement('col'));
  const widths = loadTimeSalesColumnWidths();
  const applyWidths = () => {
    columns.forEach((column, index) => { column.style.width = `${widths[index]}%`; });
  };
  columns.forEach(column => colGroup.append(column));
  table.prepend(colGroup);
  table.classList.add('omega-market-flow-table-resizable');
  applyWidths();

  heading.querySelectorAll<HTMLTableCellElement>('th').forEach((cell, index) => {
    if (index >= columns.length - 1) return;
    const resizer = document.createElement('button');
    resizer.type = 'button';
    resizer.className = 'omega-market-flow-column-resizer';
    resizer.setAttribute('aria-label', `Resize ${timeSalesColumnNames[index]} and ${timeSalesColumnNames[index + 1]} columns`);
    resizer.title = 'Drag to resize columns';
    resizer.addEventListener('pointerdown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = table.getBoundingClientRect().width;
      if (startWidth <= 0) return;
      const startingWidths = [...widths];
      const move = (moveEvent: PointerEvent) => {
        const next = resizeTimeSalesColumn(startingWidths, index, (moveEvent.clientX - startX) / startWidth * 100);
        widths.splice(0, widths.length, ...next);
        applyWidths();
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        localStorage.setItem('omega-market-flow-time-sales-columns', JSON.stringify(widths));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    });
    cell.append(resizer);
  });
}

function renderDepth(
  tableBody: HTMLTableSectionElement,
  spread: HTMLElement,
  depth: MarketDepth | null,
): void {
  tableBody.replaceChildren();
  if (!depth) {
    spread.textContent = 'Waiting for live order book…';
    return;
  }
  const maxQuantity = Math.max(1, ...depth.bids.map(level => level.quantity), ...depth.asks.map(level => level.quantity));
  const appendLevel = (level: DepthLevel, side: 'bid' | 'ask') => {
    const row = document.createElement('tr');
    const sizeCell = createCell('td', '');
    sizeCell.className = 'omega-market-flow-depth-cell';
    const bar = document.createElement('span');
    bar.className = `omega-market-flow-depth-bar ${side}`;
    bar.style.width = `${Math.max(1, level.quantity / maxQuantity * 100)}%`;
    const size = document.createElement('span');
    size.className = 'omega-market-flow-depth-value';
    size.textContent = level.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 });
    sizeCell.append(bar, size);
    row.append(sizeCell, createCell('td', formatPrice(level.price), side === 'bid' ? 'omega-market-flow-buy' : 'omega-market-flow-sell'));
    tableBody.append(row);
  };

  for (const ask of [...depth.asks].reverse()) appendLevel(ask, 'ask');
  const bestBid = depth.bids[0]?.price;
  const bestAsk = depth.asks[0]?.price;
  spread.textContent = bestBid !== undefined && bestAsk !== undefined
    ? `SPREAD  ${formatPrice(bestAsk - bestBid)}`
    : 'Spread unavailable';
  for (const bid of depth.bids) appendLevel(bid, 'bid');
}

function installPanelStyles(): void {
  if (panelStylesInstalled) return;
  const style = document.createElement('style');
  style.dataset.omegaMarketFlowStyles = 'true';
  style.textContent = panelStyles;
  document.head.append(style);
  panelStylesInstalled = true;
}

function createMarketFlowPanel(view: MarketFlowView, body: HTMLElement): SidePanelHandle {
  const isTimeSales = view === 'time-sales';
  const root = document.createElement('section');
  root.className = 'omega-market-flow';
  const status = document.createElement('div');
  status.className = 'omega-market-flow-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Select a live chart to load market data.';

  const tableWrap = document.createElement('div');
  tableWrap.className = 'omega-market-flow-table-wrap';
  const table = document.createElement('table');
  table.className = 'omega-market-flow-table';
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  const labels = isTimeSales ? ['Time', 'Price', 'Size', 'Side'] : ['Size', 'Price'];
  for (const [index, label] of labels.entries()) {
    const cell = createCell('th', label, isTimeSales && index === 1 ? 'omega-market-flow-price' : '');
    if (isTimeSales && index < labels.length - 1) cell.classList.add('omega-market-flow-column-boundary');
    heading.append(cell);
  }
  head.append(heading);
  const tableBody = document.createElement('tbody');
  table.append(head, tableBody);
  if (isTimeSales) installTimeSalesColumnResizers(table, heading);
  tableWrap.append(table);
  const spread = document.createElement('div');
  spread.className = 'omega-market-flow-spread';

  if (isTimeSales) {
    const note = document.createElement('div');
    note.className = 'omega-market-flow-note';
    note.textContent = 'Live trade or quote ticks; source depends on the connected feed.';
    root.append(status, note, tableWrap);
  } else {
    const note = document.createElement('div');
    note.className = 'omega-market-flow-note';
    note.textContent = 'Live order-book depth when the connected feed provides it.';
    root.append(status, note, spread, tableWrap);
  }

  let chart: Vela | null = null;
  let open = false;
  let generation = 0;
  let socket: WebSocket | null = null;
  let pollTimer: number | undefined;
  let unsubscribeMarket: (() => void) | null = null;
  const trades: MarketTrade[] = [];
  let visibilityObserver: MutationObserver | null = null;

  const closeSocket = () => {
    const current = socket;
    socket = null;
    if (current && current.readyState < WebSocket.CLOSING) current.close();
  };

  const stopPolling = () => {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  const streamMt5 = (ticker: string, activeChart: Vela, request: number) => {
    const bridge = window.velaMt5;
    if (!bridge) {
      status.dataset.state = 'error';
      status.textContent = 'MT5 tick data is available only in the connected Omega desktop app.';
      return;
    }
    status.dataset.state = 'connecting';
    status.textContent = `Connecting to MT5 ${isTimeSales ? 'ticks' : 'market depth'} for ${ticker}…`;
    if (!isTimeSales) {
      const pollBook = async () => {
        try {
          const depth = parseMt5Book(await bridge.marketBook(ticker));
          if (request !== generation || chart !== activeChart || !open) return;
          if (!depth) {
            status.dataset.state = 'error';
            status.textContent = `MT5 returned no usable market depth for ${ticker}.`;
            return;
          }
          status.dataset.state = 'live';
          status.textContent = `Live MT5 market depth · ${ticker}`;
          renderDepth(tableBody, spread, depth);
          pollTimer = window.setTimeout(() => { void pollBook(); }, 500);
        } catch (error) {
          if (request !== generation || chart !== activeChart || !open) return;
          status.dataset.state = 'error';
          status.textContent = `MT5 market depth unavailable for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      void pollBook();
      return;
    }

    let cursor = Date.now() - 2_000;
    let previousPrice = 0;
    let lastLiveTickAt = 0;
    const seen = new Set<string>();
    const pollTicks = async () => {
      try {
        const batch = await bridge.ticks({ ticker, fromMsc: Math.max(0, cursor - 1_000), limit: 2_000 });
        if (request !== generation || chart !== activeChart || !open) return;
        const parsed = parseMt5Ticks(batch, previousPrice);
        if (parsed.cursor) cursor = Math.max(cursor, parsed.cursor);
        const fresh = parsed.ticks.filter(tick => isRecentMt5Tick(tick.time)).filter(tick => {
          const id = tick.key ?? `${tick.time}:${tick.price}:${tick.quantity}:${tick.side}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        while (seen.size > 5_000) seen.delete(seen.values().next().value!);
        if (fresh.length) {
          previousPrice = fresh[fresh.length - 1].price;
          trades.unshift(...fresh.reverse());
          if (trades.length > 100) trades.length = 100;
          renderTrades(tableBody, trades);
          lastLiveTickAt = Date.now();
          status.dataset.state = 'live';
          status.textContent = `Live MT5 ticks · ${ticker}`;
        } else if (Date.now() - lastLiveTickAt > 10_000) {
          status.dataset.state = 'connecting';
          status.textContent = `Connected to MT5 · waiting for live ticks · ${ticker}`;
        }
      } catch (error) {
        if (request !== generation || chart !== activeChart || !open) return;
        status.dataset.state = 'error';
        status.textContent = `MT5 tick stream unavailable for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (request === generation && chart === activeChart && open) {
          pollTimer = window.setTimeout(() => { void pollTicks(); }, 250);
        }
      }
    };
    void pollTicks();
  };

  const connect = async () => {
    const request = ++generation;
    closeSocket();
    stopPolling();
    tableBody.replaceChildren();
    trades.length = 0;
    if (!open || !chart) return;

    const activeChart = chart;
    const chartSymbol = activeChart.market.symbol?.trim();
    if (!chartSymbol) {
      status.dataset.state = 'error';
      status.textContent = 'Select a chart symbol to load live market data.';
      return;
    }
    let resolved = activeChart.data.resolve(chartSymbol);
    if (!resolved) {
      status.dataset.state = 'connecting';
      status.textContent = `Resolving the active feed for ${chartSymbol}…`;
      try {
        await activeChart.data.ready();
      } catch (error) {
        if (request !== generation) return;
        status.dataset.state = 'error';
        status.textContent = `Could not resolve the active data feed: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (request !== generation || chart !== activeChart || !open) return;
      resolved = activeChart.data.resolve(chartSymbol);
    }
    const mt5Ticker = mt5SymbolForChart(activeChart);
    if (mt5Ticker) {
      streamMt5(mt5Ticker, activeChart, request);
      return;
    }
    const market = binanceStreamForSymbol(activeChart);
    if (!market) {
      status.dataset.state = 'error';
      status.textContent = resolved
        ? `The active ${resolved.provider} feed does not expose live ${isTimeSales ? 'trades' : 'order-book depth'} to this panel. No sample data is shown.`
        : 'The active chart symbol is not resolved by a live data provider.';
      return;
    }

    const ticker = chartSymbol;
    const baseUrl = market.futures ? 'wss://fstream.binance.com/ws/' : 'wss://stream.binance.com:9443/ws/';
    const stream = `${market.symbol}@${isTimeSales ? 'trade' : 'depth20@100ms'}`;
    status.dataset.state = 'connecting';
    status.textContent = `Connecting to Binance ${isTimeSales ? 'trades' : 'order book'} for ${ticker}…`;

    try {
      const nextSocket = new WebSocket(`${baseUrl}${stream}`);
      socket = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (request !== generation || chart !== activeChart) return;
        status.dataset.state = 'live';
        status.textContent = `Live Binance ${isTimeSales ? 'trades' : 'order book'} · ${ticker}`;
      });
      nextSocket.addEventListener('message', event => {
        if (request !== generation || chart !== activeChart || typeof event.data !== 'string') return;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          console.error('Binance sent an invalid market-flow message:', error);
          status.dataset.state = 'error';
          status.textContent = 'Binance returned an invalid live-data message.';
          return;
        }
        if (isTimeSales) {
          const trade = parseBinanceTrade(payload);
          if (!trade) return;
          trades.unshift(trade);
          if (trades.length > 100) trades.length = 100;
          renderTrades(tableBody, trades);
          return;
        }
        renderDepth(tableBody, spread, parseBinanceDepth(payload));
      });
      nextSocket.addEventListener('error', () => {
        if (request !== generation) return;
        status.dataset.state = 'error';
        status.textContent = 'Could not connect to the Binance live market-data stream.';
      });
      nextSocket.addEventListener('close', () => {
        if (request !== generation || !open) return;
        status.dataset.state = 'error';
        status.textContent = 'The Binance live market-data stream disconnected. Reopen the panel to reconnect.';
      });
    } catch (error) {
      console.error('Could not open the Binance market-data stream:', error);
      status.dataset.state = 'error';
      status.textContent = `Could not open the Binance stream: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const bindChart = (nextChart: Vela) => {
    unsubscribeMarket?.();
    chart = nextChart;
    unsubscribeMarket = nextChart.on('market:changed', () => { void connect(); });
    void connect();
  };

  installPanelStyles();
  const panelRoot = body.parentElement;
  if (panelRoot) {
    visibilityObserver = new MutationObserver(() => {
      if (panelRoot.hidden) {
        open = false;
        generation += 1;
        closeSocket();
        stopPolling();
      } else if (!open) {
        open = true;
        void connect();
      }
    });
    visibilityObserver.observe(panelRoot, { attributes: true, attributeFilter: ['hidden'] });
  }
  body.replaceChildren(root);
  applyMarketFlowStyle(view);
  return {
    onChart: bindChart,
    onOpen() {
      open = true;
      void connect();
    },
    destroy() {
      open = false;
      generation += 1;
      closeSocket();
      stopPolling();
      unsubscribeMarket?.();
      visibilityObserver?.disconnect();
      root.remove();
    },
  };
}

function registerMarketFlowPanel(id: MarketFlowView, title: string, icon: string, view: MarketFlowView): void {
  registerSidePanel({
    id: `omega-${id}`,
    title,
    icon,
    order: id === 'time-sales' ? 11 : 12,
    width: 340,
    resizable: true,
    minWidth: 260,
    maxWidth: 520,
    mount(_context, body) {
      return createMarketFlowPanel(view, body);
    },
  });
}

registerIcon(
  'omega-time-sales',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 10h10M4 15h16M4 20h10"/><path d="m17 8 3 2-3 2M7 13l-3 2 3 2"/></svg>',
);
registerIcon(
  'omega-dom',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v6H4zM4 14h16v6H4z"/><path d="M7 7h5M7 17h9"/></svg>',
);
registerMarketFlowPanel('time-sales', 'Time & Sales', 'omega-time-sales', 'time-sales');
registerMarketFlowPanel('dom', 'Depth of Market', 'omega-dom', 'dom');

export function placeMarketFlowButtonsAfterAlert(
  alertButton: HTMLButtonElement,
  buttons: readonly HTMLButtonElement[],
): void {
  const parent = alertButton.parentElement;
  if (!parent) return;
  const alreadyAdjacent = buttons.every((button, index) =>
    button.parentElement === parent
    && (index === 0 ? alertButton.nextElementSibling : buttons[index - 1].nextElementSibling) === button,
  );
  if (!alreadyAdjacent) alertButton.after(...buttons);
}
