import {
  type IndicatorHandle,
  type Vela,
} from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import rightTradingPaneMarkup from './rightTradingPane.html?raw';
import { inferPipSize } from './orderFlowCharts';
import { placeMarketFlowButtonsAfterAlert } from './marketFlowPane';
import {
  calculatePaperTradePnl,
  createConfiguredProtectionLevels,
  formatPaperTradePnl,
  moveProtectionLevel,
  type PaperTradeSide,
  shouldTriggerPendingPaperOrder,
  type ProtectionConfig,
  type ProtectionMode,
} from './paperTradeMath';
import { calculatePaperAccount, type PaperLedgerTrade } from './paperTradingAnalytics';
import { createSingleFlightGate } from './singleFlight';
import {
  cleanPaperTradeSymbol as cleanSymbol,
  formatPaperTradeLots as formatLots,
  formatPaperTradePrice as formatPrice,
  getPaperTradeContractSize as getContractSize,
  getPaperTradeMinTick as getMinTick,
  getPaperTradePipSize as getPipSize,
  getPaperTradeQuoteCurrency as getQuoteCurrency,
} from './paperTradeInstrument';
import {
  QUICK_TRADE_LAYER_ID,
  setPaperTradeOverlayTransparency,
  type OverlayAction,
  type TradeLineRole,
  type TradeOverlayCanvas,
  type TradeOverlayAction,
  type TradeOverlayHit,
  type TradeOverlayLevel,
} from './paperTradeOverlay';

const STORAGE_KEY = 'omega-paper-trades-v1';
const PENDING_STORAGE_KEY = 'omega-paper-pending-orders-v1';
const HISTORY_STORAGE_KEY = 'omega-paper-trades-history-v1';
const SETTINGS_STORAGE_KEY = 'omega-paper-trade-settings-v1';
const PREFERENCES_STORAGE_KEY = 'omega-paper-trade-preferences-v1';
const DEFAULT_PAPER_CAPITAL = 100_000;
const POSITION_COLOR = '#2962ff';
const TARGET_COLOR = '#089981';
const STOP_COLOR = '#f23645';

// Get theme-aware colors for chart overlay
function getTradeLineColor(role: TradeLineRole): string {
  const configuredColor = role === 'entry' ? tradeRectangleAppearance.entryColor
    : role === 'stopLoss' ? tradeRectangleAppearance.stopLossColor
      : tradeRectangleAppearance.takeProfitColor;
  if (configuredColor) return configuredColor;
  const isLight = document.body.dataset.theme === 'light';
  if (role === 'entry') return isLight ? '#1d4ed8' : POSITION_COLOR;
  if (role === 'stopLoss') return isLight ? '#dc2626' : STOP_COLOR;
  return isLight ? '#059669' : TARGET_COLOR;
}

interface TradeRectangleAppearance {
  entryColor: string | null;
  stopLossColor: string | null;
  takeProfitColor: string | null;
  transparency: number;
}

interface PaperTradePreferences {
  defaultLots: number;
  quickLots: [number, number, number, number];
  soundsEnabled: boolean;
  soundVolume: number;
  confirmCloseActions: boolean;
  maxOpenTrades: number;
}

const DEFAULT_TRADE_PREFERENCES: PaperTradePreferences = {
  defaultLots: 0.01,
  quickLots: [0.01, 0.1, 1, 5],
  soundsEnabled: true,
  soundVolume: 50,
  confirmCloseActions: true,
  maxOpenTrades: 0,
};

interface BrokerChartPosition {
  positionId: string;
  symbol: string;
  side: string;
  volume: string;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ClosedPaperTrade extends PaperLedgerTrade {
  id: string;
  symbol: string;
  side: PaperTradeSide;
  lots: number;
  entryPrice: number;
  entryTime: number;
  closePrice: number;
  closeTime: number;
  pnl: number;
  currency: string;
  reason: string;
  minTick?: number;
}

interface PaperTrade {
  id: string;
  cellId: string;
  symbol: string;
  side: PaperTradeSide;
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  contractSize: number;
  currency: string;
  minTick: number;
  entryTime: number;
  labelTime: number;
  /** Last close seen for this trade's own symbol (not the cell's instrument). */
  lastKnownPrice?: number;
  drawingIds: Record<TradeLineRole, string>;
  labelIds: Record<TradeLineRole, string>;
}

interface PendingPaperOrder {
  id: string;
  cellId: string;
  symbol: string;
  side: PaperTradeSide;
  orderType: 'limit' | 'stop';
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  contractSize: number;
  currency: string;
  minTick: number;
  createdAt: number;
  createdAfterBarTime: number;
}

interface ChartState {
  cellId: string;
  chart: Vela;
  host: HTMLElement;
  lastPrice: number | null;
  lastBarTime: number | null;
  recentBars: Array<{ time: number; high: number; low: number; close: number }>;
  draggingLevel: { tradeId: string; role: 'stopLoss' | 'takeProfit' } | null;
  dragChanged: boolean;
  hoveredLevelId: string | null;
  hoveredControlId: string | null;
  tradeOverlay: IndicatorHandle;
  disposers: Array<() => void>;
}

const chartStates = new Map<string, ChartState>();
const trades = new Map<string, PaperTrade>();
const brokerChartPositions = new Map<string, BrokerChartPosition>();
const tradeCreationGate = createSingleFlightGate();
let overlayRenderFrame: number | null = null;
const restoredCells = new Set<string>();
let savedTrades: PaperTrade[] = [];
let pendingOrders = readPendingOrders();
let closedTradesHistory: ClosedPaperTrade[] = readClosedTrades();
let protectionSettings: ProtectionConfig = readProtectionSettings();
let tradeRectangleAppearance: TradeRectangleAppearance = readTradeRectangleAppearance();
let tradePreferences = readTradePreferences();
const paperInitialCapital = DEFAULT_PAPER_CAPITAL;
let pendingCloseTradeId: string | null = null;
let pendingTradeAction: TradeOverlayAction = 'close';
let pendingOrderContext: ChartState | null = null;
let pendingModalInitialized = false;
let refreshPendingProtectionPreview: (() => void) | null = null;
let previousFocus: HTMLElement | null = null;
let tradeClickAudioContext: AudioContext | null = null;
let refreshOpenTradesList: (() => void) | null = null;

setPaperTradeOverlayTransparency(() => tradeRectangleAppearance.transparency);

function readTradePreferences(): PaperTradePreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRADE_PREFERENCES, quickLots: [...DEFAULT_TRADE_PREFERENCES.quickLots] };
    const stored = JSON.parse(raw) as Partial<PaperTradePreferences>;
    const positiveLots = (value: unknown, fallback: number) => {
      const lots = Number(value);
      return Number.isFinite(lots) && lots >= 0.01 ? Math.min(lots, 100_000) : fallback;
    };
    const quickLots: PaperTradePreferences['quickLots'] = Array.isArray(stored.quickLots)
      ? [
        positiveLots(stored.quickLots[0], DEFAULT_TRADE_PREFERENCES.quickLots[0]),
        positiveLots(stored.quickLots[1], DEFAULT_TRADE_PREFERENCES.quickLots[1]),
        positiveLots(stored.quickLots[2], DEFAULT_TRADE_PREFERENCES.quickLots[2]),
        positiveLots(stored.quickLots[3], DEFAULT_TRADE_PREFERENCES.quickLots[3]),
      ]
      : [...DEFAULT_TRADE_PREFERENCES.quickLots];
    return {
      defaultLots: positiveLots(stored.defaultLots, DEFAULT_TRADE_PREFERENCES.defaultLots),
      quickLots,
      soundsEnabled: typeof stored.soundsEnabled === 'boolean' ? stored.soundsEnabled : true,
      soundVolume: Number.isFinite(stored.soundVolume) ? Math.max(0, Math.min(100, Number(stored.soundVolume))) : 50,
      confirmCloseActions: typeof stored.confirmCloseActions === 'boolean' ? stored.confirmCloseActions : true,
      maxOpenTrades: Number.isInteger(stored.maxOpenTrades) ? Math.max(0, Math.min(100_000, Number(stored.maxOpenTrades))) : 0,
    };
  } catch (error) {
    console.warn('Could not read paper-trade preferences; using defaults:', error);
    return { ...DEFAULT_TRADE_PREFERENCES, quickLots: [...DEFAULT_TRADE_PREFERENCES.quickLots] };
  }
}

function saveTradePreferences(): void {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(tradePreferences));
  } catch (error) {
    console.warn('Could not save paper-trade preferences:', error);
    setStatus(`Could not save trade preferences: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function readClosedTrades(): ClosedPaperTrade[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap(item => {
      const trade = item as Partial<ClosedPaperTrade>;
      const entryTime = Number.isFinite(trade.entryTime) ? trade.entryTime : trade.closeTime;
      if (typeof trade.id !== 'string'
        || (trade.side !== 'buy' && trade.side !== 'sell')
        || typeof trade.symbol !== 'string'
        || typeof trade.currency !== 'string'
        || !Number.isFinite(trade.lots) || (trade.lots as number) <= 0
        || !Number.isFinite(trade.entryPrice) || (trade.entryPrice as number) <= 0
        || !Number.isFinite(trade.closePrice) || (trade.closePrice as number) <= 0
        || !Number.isFinite(trade.pnl)
        || !Number.isFinite(entryTime)
        || !Number.isFinite(trade.closeTime)) return [];
      return [{ ...trade, entryTime, reason: typeof trade.reason === 'string' ? trade.reason : 'closed' } as ClosedPaperTrade];
    }) : [];
  } catch {
    return [];
  }
}

function saveClosedTrades(): void {
  try {
    // Keep a generous window so the list does not silently lose older trades
    // between sessions while still bounding localStorage usage.
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(closedTradesHistory.slice(0, 2000)));
  } catch (err) {
    console.warn('Could not save trade history:', err);
  }
}

function readProtectionSettings(): ProtectionConfig {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProtectionConfig>;
      if ((parsed.mode === 'pips' || parsed.mode === 'atr') && Number.isFinite(parsed.slValue) && Number.isFinite(parsed.tpValue)) {
        return {
          mode: parsed.mode,
          slValue: Math.max(0.1, Number(parsed.slValue)),
          tpValue: Math.max(0.1, Number(parsed.tpValue)),
        };
      }
    }
  } catch (error) {
    console.warn('Could not read paper-trade protection settings; using defaults:', error);
  }
  return { mode: 'pips', slValue: 20, tpValue: 40 };
}

function readTradeRectangleAppearance(): TradeRectangleAppearance {
  const defaults: TradeRectangleAppearance = {
    entryColor: null,
    stopLossColor: null,
    takeProfitColor: null,
    transparency: 18,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<TradeRectangleAppearance>;
    return {
      entryColor: typeof parsed.entryColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.entryColor) ? parsed.entryColor : null,
      stopLossColor: typeof parsed.stopLossColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.stopLossColor) ? parsed.stopLossColor : null,
      takeProfitColor: typeof parsed.takeProfitColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.takeProfitColor) ? parsed.takeProfitColor : null,
      transparency: Number.isFinite(parsed.transparency) ? Math.max(0, Math.min(80, Number(parsed.transparency))) : defaults.transparency,
    };
  } catch (error) {
    console.warn('Could not read trade rectangle appearance settings; using defaults:', error);
    return defaults;
  }
}

function saveProtectionSettings(): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...protectionSettings, ...tradeRectangleAppearance }));
  } catch (error) {
    console.warn('Could not save paper-trade settings:', error);
    setStatus(`Could not save paper-trade settings: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function computeAtr14(bars: Array<{ time: number; high: number; low: number; close: number }>): number | null {
  if (bars.length < 15) return null;
  const slice = bars.slice(-15);

  // Calculate True Range for each bar
  const trueRanges: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trueRanges.push(tr);
  }

  if (trueRanges.length < 14) return null;

  // Standard ATR(14) calculation using Wilder's Smoothing
  // First ATR = simple average of first 14 TR values
  let atr = trueRanges.slice(0, 14).reduce((sum, tr) => sum + tr, 0) / 14;

  // Apply Wilder's smoothing for remaining TR values
  for (let i = 14; i < trueRanges.length; i++) {
    atr = (atr * 13 + trueRanges[i]) / 14;
  }

  return atr;
}

function playTradeSound(kind: 'level' | 'protectionSaved' | 'tradeClosed' = 'level'): void {
  if (!tradePreferences.soundsEnabled || tradePreferences.soundVolume <= 0 || !window.AudioContext) return;
  const context = tradeClickAudioContext ?? (tradeClickAudioContext = new AudioContext());
  const play = () => {
    const now = context.currentTime;
    const notes = kind === 'protectionSaved' ? [880, 1320]
      : kind === 'tradeClosed' ? [660, 440] : [1040];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.085;
      oscillator.type = kind === 'tradeClosed' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.16 * tradePreferences.soundVolume / 100, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.11);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.11);
    });
  };

  if (context.state === 'suspended') {
    void context.resume()
      .then(play)
      .catch(error => console.warn('Paper-trade confirmation sound unavailable:', error));
  } else {
    play();
  }
}

const lotsInput = document.getElementById('paper-trade-lots') as HTMLInputElement;
const buyButton = document.getElementById('paper-trade-buy') as HTMLButtonElement;
const sellButton = document.getElementById('paper-trade-sell') as HTMLButtonElement;
const statusElement = document.getElementById('paper-trade-status') as HTMLSpanElement;
const totalPnlElement = document.getElementById('omega-top-right-pl') as HTMLDivElement | null;
const closeModal = document.getElementById('paper-trade-close-modal') as HTMLDivElement;
const closeTitle = document.getElementById('paper-trade-close-title') as HTMLElement;
const closeMessage = document.getElementById('paper-trade-close-message') as HTMLParagraphElement;
const closeYesButton = document.getElementById('paper-trade-close-yes') as HTMLButtonElement;
const closeNoButton = document.getElementById('paper-trade-close-no') as HTMLButtonElement;

function setStatus(message: string, state: 'error' | 'success' | '' = ''): void {
  // The compact Quick Trade bar stays quiet; all operational feedback belongs in
  // the persistent console so it does not cover the chart after an order is sent.
  statusElement.textContent = '';
  delete statusElement.dataset.state;
  writeActivity(message, state || 'info');
}

function hidePendingOrderModal(): void {
  const modal = document.getElementById('paper-pending-order-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  pendingOrderContext = null;
}

export function openPendingOrderDialog(chart: Vela, pointerPrice: number | null | undefined): void {
  const state = [...chartStates.values()].find(candidate => candidate.chart === chart);
  const price = Number(pointerPrice);
  const symbol = chart.market.symbol;
  if (!state || !symbol || !Number.isFinite(price) || price <= 0) {
    setStatus('Right-click a price on the chart to add a pending paper order.', 'error');
    return;
  }
  const modal = document.getElementById('paper-pending-order-modal') as HTMLDivElement | null;
  const symbolLabel = document.getElementById('paper-pending-order-symbol');
  const entryInput = document.getElementById('paper-pending-order-entry') as HTMLInputElement | null;
  const lotsField = document.getElementById('paper-pending-order-lots') as HTMLInputElement | null;
  const sideField = document.getElementById('paper-pending-order-side') as HTMLSelectElement | null;
  const protectionMode = document.getElementById('paper-pending-order-protection-mode') as HTMLSelectElement | null;
  const stopField = document.getElementById('paper-pending-order-sl-value') as HTMLInputElement | null;
  const targetField = document.getElementById('paper-pending-order-tp-value') as HTMLInputElement | null;
  const message = document.getElementById('paper-pending-order-message');
  if (!modal || !entryInput || !lotsField || !sideField || !protectionMode || !stopField || !targetField || !message) {
    setStatus('Pending-order form is unavailable.', 'error');
    return;
  }
  pendingOrderContext = state;
  const resolved = chart.data.resolve(symbol);
  const ticker = resolved?.ticker ?? symbol;
  const minTick = getMinTick(ticker, undefined);
  const initialSide: PaperTradeSide = 'buy';
  if (symbolLabel) symbolLabel.textContent = symbol;
  entryInput.value = formatPrice(price, minTick);
  // The dialog opens synchronously; refine the pre-filled price once the
  // provider's real tick size is known so it is not rounded to a coarse guess.
  void chart.data.symbolInfo(symbol).then(rawInfo => {
    if (pendingOrderContext !== state || modal.hidden) return;
    const preciseTick = getMinTick(ticker, rawInfo as Record<string, unknown> | undefined);
    const current = Number(entryInput.value);
    if (preciseTick === minTick || !Number.isFinite(current)) return;
    if (formatPrice(current, minTick) !== entryInput.value) return;
    entryInput.value = formatPrice(price, preciseTick);
    refreshPendingProtectionPreview?.();
  }).catch(() => undefined);
  lotsField.value = lotsInput.value || '0.10';
  sideField.value = initialSide;
  protectionMode.value = protectionSettings.mode;
  stopField.value = String(protectionSettings.slValue);
  targetField.value = String(protectionSettings.tpValue);
  message.textContent = '';
  delete message.dataset.state;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  refreshPendingProtectionPreview?.();
  entryInput.focus();
}

function findPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): PendingPaperOrder | undefined {
  const state = [...chartStates.values()].find(candidate => candidate.chart === chart);
  const price = Number(pointerPrice);
  if (!state || !Number.isFinite(price) || price <= 0) return undefined;
  const candidates = pendingOrders
    .filter(order => order.cellId === state.cellId && cleanSymbol(order.symbol) === cleanSymbol(chart.market.symbol))
    .map(order => ({ order, distance: Math.abs(order.entryPrice - price) }))
    .filter(({ order, distance }) => distance <= Math.max(order.minTick * 4, order.entryPrice * 1e-8))
    .sort((left, right) => left.distance - right.distance);
  return candidates[0]?.order;
}

export function hasPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): boolean {
  return Boolean(findPendingPaperOrderAtPrice(chart, pointerPrice));
}

export function cancelPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): boolean {
  const match = findPendingPaperOrderAtPrice(chart, pointerPrice);
  if (!match) return false;
  return cancelPendingPaperOrder(match);
}

function cancelPendingPaperOrder(order: PendingPaperOrder): boolean {
  if (!pendingOrders.some(candidate => candidate.id === order.id)) return false;
  pendingOrders = pendingOrders.filter(candidate => candidate.id !== order.id);
  savePendingOrders();
  updateAllTradeOverlays();
  setStatus(`${order.side.toUpperCase()} pending paper order at ${formatPrice(order.entryPrice, order.minTick)} cancelled.`, 'success');
  return true;
}

function initializePendingOrderModal(): void {
  if (pendingModalInitialized) return;
  const modal = document.getElementById('paper-pending-order-modal') as HTMLDivElement | null;
  const form = document.getElementById('paper-pending-order-form') as HTMLFormElement | null;
  const closeButton = document.getElementById('paper-pending-order-close') as HTMLButtonElement | null;
  const cancelButton = document.getElementById('paper-pending-order-cancel') as HTMLButtonElement | null;
  const sideField = document.getElementById('paper-pending-order-side') as HTMLSelectElement | null;
  const entryField = document.getElementById('paper-pending-order-entry') as HTMLInputElement | null;
  const protectionMode = document.getElementById('paper-pending-order-protection-mode') as HTMLSelectElement | null;
  const stopField = document.getElementById('paper-pending-order-sl-value') as HTMLInputElement | null;
  const targetField = document.getElementById('paper-pending-order-tp-value') as HTMLInputElement | null;
  const lotsField = document.getElementById('paper-pending-order-lots') as HTMLInputElement | null;
  const message = document.getElementById('paper-pending-order-message');
  const submitButton = document.getElementById('paper-pending-order-submit') as HTMLButtonElement | null;
  const stopLabel = document.getElementById('paper-pending-order-sl-label');
  const targetLabel = document.getElementById('paper-pending-order-tp-label');
  const preview = document.getElementById('paper-pending-order-protection-preview');
  if (!modal || !form || !closeButton || !cancelButton || !sideField || !entryField || !protectionMode || !stopField || !targetField || !lotsField || !message || !submitButton) return;
  pendingModalInitialized = true;
  const submissionGate = createSingleFlightGate();

  const close = () => hidePendingOrderModal();
  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  const updateProtectionPreview = () => {
    const state = pendingOrderContext;
    const entry = Number(entryField.value);
    const mode: ProtectionMode = protectionMode.value === 'atr' ? 'atr' : 'pips';
    const unit = mode === 'atr' ? 'ATR multiplier' : 'pips';
    if (stopLabel) stopLabel.textContent = `Stop loss (${unit})`;
    if (targetLabel) targetLabel.textContent = `Take profit (${unit})`;
    if (!state || !Number.isFinite(entry) || entry <= 0) return;
    try {
      const symbol = state.chart.market.symbol ?? '';
      const ticker = state.chart.data.resolve(symbol)?.ticker ?? symbol;
      const minTick = getMinTick(ticker, undefined);
      const levels = createConfiguredProtectionLevels(sideField.value as PaperTradeSide, entry, minTick, {
        mode,
        slValue: Number(stopField.value),
        tpValue: Number(targetField.value),
      }, computeAtr14(state.recentBars), getPipSize(ticker, undefined));
      if (preview) preview.textContent = `Protection prices: SL ${formatPrice(levels.stopLoss, minTick)} · TP ${formatPrice(levels.takeProfit, minTick)}.`;
      message.textContent = '';
      delete message.dataset.state;
    } catch (error) {
      if (preview) preview.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  refreshPendingProtectionPreview = updateProtectionPreview;
  sideField.addEventListener('change', updateProtectionPreview);
  entryField.addEventListener('input', updateProtectionPreview);
  protectionMode.addEventListener('change', updateProtectionPreview);
  stopField.addEventListener('input', updateProtectionPreview);
  targetField.addEventListener('input', updateProtectionPreview);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = pendingOrderContext;
    if (!state) return;
    const symbol = state.chart.market.symbol;
    const side = sideField.value as PaperTradeSide;
    const lots = Number(lotsField.value);
    const entryPrice = Number(entryField.value);
    const mode: ProtectionMode = protectionMode.value === 'atr' ? 'atr' : 'pips';
    const slValue = Number(stopField.value);
    const tpValue = Number(targetField.value);
    const marketPrice = state.lastPrice;
    if (!symbol || !state.chart.data.resolve(symbol)) {
      message.textContent = 'The chart symbol has no available market-data provider.';
      message.dataset.state = 'error';
      return;
    }
    if (!Number.isFinite(lots) || lots < 0.01 || !Number.isFinite(entryPrice) || entryPrice <= 0
      || !Number.isFinite(slValue) || !Number.isFinite(tpValue) || slValue <= 0 || tpValue <= 0) {
      message.textContent = 'Enter a valid volume, entry price, stop-loss and take-profit protection values.';
      message.dataset.state = 'error';
      return;
    }
    if (marketPrice === null || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      message.textContent = 'Waiting for a current chart price.';
      message.dataset.state = 'error';
      return;
    }
    if (Math.abs(entryPrice - marketPrice) < Number.EPSILON) {
      message.textContent = 'Pending entry must be above or below the current market price.';
      message.dataset.state = 'error';
      return;
    }

    const releaseSubmission = submissionGate.acquire();
    if (!releaseSubmission) return;
    submitButton.disabled = true;
    message.textContent = 'Validating symbol details…';
    delete message.dataset.state;
    try {
      const info = await state.chart.data.symbolInfo(symbol) as Record<string, unknown> | undefined;
      if (state.chart.market.symbol !== symbol) throw new Error('The chart symbol changed before the pending order was saved.');
      const resolved = state.chart.data.resolve(symbol);
      if (!resolved) throw new Error(`No market-data provider is available for ${symbol}.`);
      const ticker = resolved.ticker;
      const minTick = getMinTick(ticker, info);
      const protection = createConfiguredProtectionLevels(side, entryPrice, minTick, {
        mode,
        slValue,
        tpValue,
      }, computeAtr14(state.recentBars), getPipSize(ticker, info));
      if (Math.abs(entryPrice - marketPrice) < minTick * 0.5) {
        throw new Error('Entry or protection prices are invalid for this instrument.');
      }
      const orderType: PendingPaperOrder['orderType'] = side === 'buy'
        ? entryPrice < marketPrice ? 'limit' : 'stop'
        : entryPrice > marketPrice ? 'limit' : 'stop';
      const order: PendingPaperOrder = {
        id: crypto.randomUUID(),
        cellId: state.cellId,
        symbol,
        side,
        orderType,
        lots,
        entryPrice,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        contractSize: getContractSize(ticker, info),
        currency: getQuoteCurrency(symbol, info),
        minTick,
        createdAt: Date.now(),
        createdAfterBarTime: state.lastBarTime ?? 0,
      };
      pendingOrders.push(order);
      savePendingOrders();
      updateAllTradeOverlays();
      close();
      setStatus(`${side.toUpperCase()} ${orderType} pending paper order placed: ${formatLots(lots)} lots at ${formatPrice(entryPrice, minTick)}.`, 'success');
    } catch (error) {
      console.error('Could not place pending paper order:', error);
      message.textContent = error instanceof Error ? error.message : String(error);
      message.dataset.state = 'error';
    } finally {
      releaseSubmission();
      submitButton.disabled = false;
    }
  });
}

function playTradeLevelSetClick(): void {
  playTradeSound('level');
}

type ActivityState = 'error' | 'success' | 'info';
const activityEntries: Array<{ time: number; message: string; state: ActivityState }> = [];

function writeActivity(message: string, state: ActivityState = 'info'): void {
  const entry = { time: Date.now(), message, state };
  activityEntries.unshift(entry);
  if (activityEntries.length > 200) activityEntries.pop();
  const list = document.getElementById('activity-console-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = `activity-console-entry ${state}`;
  row.textContent = `[${new Date(entry.time).toLocaleTimeString()}] ${message}`;
  list.prepend(row);
  while (list.childElementCount > 200) list.lastElementChild?.remove();
}

/**
 * Price used to value an open trade.
 *
 * A chart cell can be switched to another instrument, so the cell's last price
 * is only valid while it still shows the trade's symbol. Otherwise fall back to
 * a cell showing the same symbol, then to the last price observed for it.
 */
function paperTradeMarketPrice(trade: PaperTrade): number | null {
  const wanted = cleanSymbol(trade.symbol);
  const ownState = chartStates.get(trade.cellId);
  if (ownState && cleanSymbol(ownState.chart.market.symbol) === wanted && Number.isFinite(ownState.lastPrice)) {
    return ownState.lastPrice;
  }
  for (const state of chartStates.values()) {
    if (cleanSymbol(state.chart.market.symbol) === wanted && Number.isFinite(state.lastPrice)) return state.lastPrice;
  }
  return Number.isFinite(trade.lastKnownPrice) ? trade.lastKnownPrice ?? null : null;
}

function updateTotalPnl(): void {
  refreshOpenTradesList?.();
  if (!totalPnlElement) return;
  const totals = new Map<string, number>();
  for (const trade of trades.values()) {
    const price = paperTradeMarketPrice(trade);
    if (price === null) continue;
    const pnl = calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize);
    totals.set(trade.currency, (totals.get(trade.currency) ?? 0) + pnl);
  }
  if (totals.size === 0) {
    totalPnlElement.textContent = 'P/L: $0.00';
    totalPnlElement.dataset.state = 'zero';
    return;
  }
  const values = [...totals];
  totalPnlElement.textContent = values.map(([currency, amount]) => `P/L: ${formatPaperTradePnl(amount, currency)}`).join(' · ');
  const net = values.reduce((sum, [, amount]) => sum + amount, 0);
  totalPnlElement.dataset.state = net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero';
}

function openPaperLedger(): PaperLedgerTrade[] {
  const ledger: PaperLedgerTrade[] = [];
  for (const trade of trades.values()) {
    const price = paperTradeMarketPrice(trade);
    if (price === null) continue;
    ledger.push({
      id: trade.id,
      side: trade.side,
      lots: trade.lots,
      entryPrice: trade.entryPrice,
      entryTime: trade.entryTime,
      currency: trade.currency,
      pnl: calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize),
    });
  }
  return ledger;
}

function paperAccount() {
  const accountCurrency = 'USD';
  const open = openPaperLedger();
  const closedInAccountCurrency = closedTradesHistory.filter(trade => trade.currency.trim().toUpperCase() === accountCurrency);
  const openInAccountCurrency = open.filter(trade => trade.currency?.trim().toUpperCase() === accountCurrency);
  return {
    currency: accountCurrency,
    omittedTrades: closedTradesHistory.length - closedInAccountCurrency.length + open.length - openInAccountCurrency.length,
    account: calculatePaperAccount(paperInitialCapital, closedInAccountCurrency, openInAccountCurrency),
  };
}

let getActiveTradeState: () => ChartState | undefined = () => undefined;

function updateTradingPaneMarketData(): void {
  const state = getActiveTradeState();
  const price = state?.lastPrice;
  const symbol = state?.chart.market.symbol ?? '—';
  const symbolLabel = document.getElementById('omega-tp-symbol');
  const buyPrice = document.getElementById('omega-tp-buy-price');
  const sellPrice = document.getElementById('omega-tp-sell-price');
  if (symbolLabel) symbolLabel.textContent = symbol.split(':').at(-1) || '—';
  const text = Number.isFinite(price) ? Number(price).toFixed(5).replace(/0+$/, '').replace(/\.$/, '') : '—';
  if (buyPrice) buyPrice.textContent = text;
  if (sellPrice) sellPrice.textContent = text;
  const spreadSource = document.querySelector<HTMLElement>('[data-omega-spread-readout] .vela-dw-value');
  const spread = document.getElementById('omega-tp-spread');
  if (spread) spread.textContent = spreadSource?.textContent?.trim() || '—';
}

function initializeTradingPane(workspace: VelaWorkspace): void {
  const pane = document.getElementById('omega-trading-pane');
  const toggle = document.getElementById('trading-pane-toggle') as HTMLButtonElement | null;
  const close = document.getElementById('trading-pane-close') as HTMLButtonElement | null;
  const buy = document.getElementById('omega-tp-buy') as HTMLButtonElement | null;
  const sell = document.getElementById('omega-tp-sell') as HTMLButtonElement | null;
  const trade = document.getElementById('omega-tp-trade') as HTMLButtonElement | null;
  const paneLots = document.getElementById('omega-tp-lots') as HTMLInputElement | null;
  const sl = document.getElementById('omega-tp-sl') as HTMLInputElement | null;
  const tp = document.getElementById('omega-tp-tp') as HTMLInputElement | null;
  const protectionMode = document.getElementById('omega-tp-protection-mode') as HTMLSelectElement | null;
  const slUnit = document.getElementById('omega-tp-sl-unit');
  const tpUnit = document.getElementById('omega-tp-tp-unit');
  const atrReadout = document.getElementById('omega-tp-atr-readout');
  if (!pane || !toggle || !close || !buy || !sell || !trade || !paneLots || !sl || !tp) return;
  lotsInput.value = formatLots(tradePreferences.defaultLots);
  paneLots.value = lotsInput.value;

  const placeTradeLauncher = () => {
    const shortPanelLabels: Record<string, string> = {
      'open trading panel': 'Trading Panel',
      'depth of market': 'Depth',
      'data window': 'Data',
      'object tree': 'Objects',
      'strategy backtest': 'Backtest',
      'market news': 'News',
      'download screenshot': 'Screenshot',
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      '.vela-widget-panels .vela-widget-tool, button[class*="vela-widget-panel-"], #trading-pane-toggle',
    )) {
      const label = button.getAttribute('aria-label')?.trim();
      if (!label) continue;
      let labelElement = button.querySelector<HTMLSpanElement>(':scope > .omega-panel-button-label');
      if (!labelElement) {
        labelElement = document.createElement('span');
        labelElement.className = 'omega-panel-button-label';
        labelElement.setAttribute('aria-hidden', 'true');
        button.append(labelElement);
      }
      const visibleLabel = shortPanelLabels[label.toLowerCase()] ?? label;
      if (labelElement.textContent !== visibleLabel) labelElement.textContent = visibleLabel;
    }
    const alertButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => {
      const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`.toLowerCase();
      return button !== toggle && label.includes('alert');
    });
    if (!alertButton?.parentElement) return;
    const marketFlowButtons = [
      document.getElementById('vela-tool-vela-widget-panel-omega-time-sales'),
      document.getElementById('vela-tool-vela-widget-panel-omega-dom'),
    ].filter((button): button is HTMLButtonElement => button instanceof HTMLButtonElement);
    placeMarketFlowButtonsAfterAlert(alertButton, [toggle, ...marketFlowButtons]);
  };
  placeTradeLauncher();
  const toolbarObserver = new MutationObserver(placeTradeLauncher);
  toolbarObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['aria-label'],
    childList: true,
    subtree: true,
  });

  let side: PaperTradeSide = 'buy';
  let paneInstrument: { symbol: string; contractSize: number; pipSize: number; currency: string } | null = null;
  let paneInstrumentRequest = '';
  const setSide = (next: PaperTradeSide) => {
    side = next;
    const isBuy = side === 'buy';
    buy.classList.toggle('active', isBuy);
    sell.classList.toggle('active', !isBuy);
    buy.setAttribute('aria-pressed', String(isBuy));
    sell.setAttribute('aria-pressed', String(!isBuy));
    trade.classList.toggle('buy', isBuy);
    trade.classList.toggle('sell', !isBuy);
    trade.textContent = `Place ${isBuy ? 'BUY' : 'SELL'} order`;
  };
  const syncLots = (source: HTMLInputElement) => {
    const value = Math.max(0.01, Number(source.value) || 0.01);
    lotsInput.value = value.toFixed(2);
    paneLots.value = value.toFixed(2);
    updateProtectionEstimate();
  };
  const updateProtectionEstimate = () => {
    const lots = Math.max(0.01, Number(paneLots.value) || 0.01);
    const state = getActiveTradeState();
    const activeSymbol = cleanSymbol(state?.chart.market.symbol);
    const firstTrade = [...trades.values()].find(item => item.cellId === state?.cellId
      && cleanSymbol(item.symbol) === activeSymbol);
    const contractSize = firstTrade?.contractSize ?? paneInstrument?.contractSize;
    const pipSize = firstTrade ? (inferPipSize(firstTrade.symbol) ?? firstTrade.minTick) : paneInstrument?.pipSize;
    const currency = firstTrade?.currency ?? paneInstrument?.currency;
    const atr14 = state ? computeAtr14(state.recentBars) : null;
    const isAtr = protectionSettings.mode === 'atr';
    if (atrReadout) {
      atrReadout.hidden = !isAtr;
      atrReadout.textContent = atr14 ? `ATR(14): ${atr14.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}` : 'ATR(14) needs 15 loaded bars';
      atrReadout.dataset.state = atr14 ? 'ready' : 'waiting';
    }
    const estimate = (input: HTMLInputElement, targetId: string) => {
      const target = document.getElementById(targetId);
      const distance = Math.abs(Number(input.value) || 0) * (isAtr ? (atr14 ?? 0) : (pipSize ?? 0));
      if (target) target.textContent = contractSize && currency && (atr14 || !isAtr)
        ? formatPaperTradePnl(distance * lots * contractSize, currency)
        : 'Loading…';
    };
    estimate(sl, 'omega-tp-sl-estimate');
    estimate(tp, 'omega-tp-tp-estimate');
  };
  const loadPaneInstrument = () => {
    const state = getActiveTradeState();
    const symbol = state?.chart.market.symbol ?? '';
    if (!state || !symbol || paneInstrumentRequest === symbol) return;
    paneInstrumentRequest = symbol;
    paneInstrument = null;
    updateProtectionEstimate();
    void state.chart.data.symbolInfo(symbol).then(raw => {
      if (paneInstrumentRequest !== symbol) return;
      const info = raw as Record<string, unknown> | undefined;
      const ticker = state.chart.data.resolve(symbol)?.ticker ?? symbol;
      paneInstrument = {
        symbol,
        contractSize: getContractSize(ticker, info),
        pipSize: inferPipSize(ticker) ?? getMinTick(ticker, info),
        currency: getQuoteCurrency(symbol, info),
      };
      updateProtectionEstimate();
    }).catch(() => updateProtectionEstimate());
  };
  const open = () => { pane.classList.add('open'); pane.setAttribute('aria-hidden', 'false'); toggle.classList.add('active'); updateTradingPaneMarketData(); loadPaneInstrument(); updateProtectionEstimate(); };
  const hide = () => { pane.classList.remove('open'); pane.setAttribute('aria-hidden', 'true'); toggle.classList.remove('active'); };
  document.addEventListener('omega:paper-trading:toggle-right-panel', () => {
    pane.classList.contains('open') ? hide() : open();
  });
  close.addEventListener('click', hide);
  buy.addEventListener('click', () => setSide('buy'));
  sell.addEventListener('click', () => setSide('sell'));
  paneLots.addEventListener('input', () => syncLots(paneLots));
  lotsInput.addEventListener('input', () => syncLots(lotsInput));
  pane.querySelectorAll<HTMLButtonElement>('[data-lot-step]').forEach(button => button.addEventListener('click', () => {
    paneLots.value = String(Math.max(0.01, (Number(paneLots.value) || 0.01) + Number(button.dataset.lotStep)));
    syncLots(paneLots);
  }));
  const quickLotButtons = [...pane.querySelectorAll<HTMLButtonElement>('[data-lots]')];
  quickLotButtons.forEach((button, index) => {
    button.dataset.lots = String(tradePreferences.quickLots[index] ?? DEFAULT_TRADE_PREFERENCES.quickLots[index]);
    button.textContent = formatLots(Number(button.dataset.lots));
    button.addEventListener('click', () => { paneLots.value = button.dataset.lots || '0.01'; syncLots(paneLots); });
  });
  const savePaneProtection = () => {
    protectionSettings = { mode: protectionMode?.value === 'atr' ? 'atr' : 'pips', slValue: Math.max(0.1, Number(sl.value) || 20), tpValue: Math.max(0.1, Number(tp.value) || 40) };
    saveProtectionSettings();
    updateProtectionEstimate();
  };
  const syncProtectionMode = () => {
    const isAtr = protectionMode?.value === 'atr';
    if (slUnit) slUnit.textContent = isAtr ? '× ATR' : 'Pips';
    if (tpUnit) tpUnit.textContent = isAtr ? '× ATR' : 'Pips';
    sl.step = '0.1';
    tp.step = '0.1';
    savePaneProtection();
  };
  sl.addEventListener('input', savePaneProtection);
  tp.addEventListener('input', savePaneProtection);
  sl.addEventListener('change', () => playTradeSound('protectionSaved'));
  tp.addEventListener('change', () => playTradeSound('protectionSaved'));
  protectionMode?.addEventListener('change', () => { syncProtectionMode(); playTradeSound('protectionSaved'); });
  trade.addEventListener('click', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, side);
  });
  sl.value = String(protectionSettings.slValue);
  tp.value = String(protectionSettings.tpValue);
  if (protectionMode) protectionMode.value = protectionSettings.mode;
  getActiveTradeState = () => chartStates.get(workspace.active?.id);
  document.addEventListener('omega:spread-updated', updateTradingPaneMarketData as EventListener);
  setSide('buy');
  syncProtectionMode();
}

function readPendingOrders(): PendingPaperOrder[] {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Saved pending paper orders are not an array.');
    return parsed.filter((item): item is PendingPaperOrder => {
      if (!item || typeof item !== 'object') return false;
      const order = item as Partial<PendingPaperOrder>;
      return typeof order.id === 'string'
        && typeof order.cellId === 'string'
        && typeof order.symbol === 'string'
        && (order.side === 'buy' || order.side === 'sell')
        && (order.orderType === 'limit' || order.orderType === 'stop')
        && [order.lots, order.entryPrice, order.stopLoss, order.takeProfit, order.contractSize, order.minTick, order.createdAt]
          .every(value => Number.isFinite(value))
        && Number.isFinite(order.createdAfterBarTime)
        && Number(order.lots) > 0
        && Number(order.entryPrice) > 0
        && Number(order.stopLoss) > 0
        && Number(order.takeProfit) > 0
        && Number(order.contractSize) > 0
        && Number(order.minTick) > 0
        && typeof order.currency === 'string';
    });
  } catch (error) {
    console.error('Could not restore pending paper orders:', error);
    localStorage.removeItem(PENDING_STORAGE_KEY);
    return [];
  }
}

function savePendingOrders(): void {
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pendingOrders));
  } catch (error) {
    console.error('Could not save pending paper orders:', error);
    setStatus(`Could not save pending orders: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function getTradeLevel(trade: PaperTrade, role: TradeLineRole): number {
  return role === 'entry' ? trade.entryPrice
    : role === 'stopLoss' ? trade.stopLoss : trade.takeProfit;
}

function updateTradeOverlay(state: ChartState): void {
  const levels: TradeOverlayLevel[] = [];
  const stateSym = cleanSymbol(state.chart.market.symbol);
  for (const trade of trades.values()) {
    if (cleanSymbol(trade.symbol) !== stateSym) continue;
    for (const role of ['entry', 'stopLoss', 'takeProfit'] as const) {
      const price = getTradeLevel(trade, role);
      const label = role === 'entry'
        ? `${trade.side.toUpperCase()} ${formatLots(trade.lots)} lots`
        : `${role === 'stopLoss' ? 'SL' : 'TP'} ${formatPaperTradePnl(
          calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize),
          trade.currency,
        )}`;
      levels.push({
        tradeId: trade.id,
        role,
        price,
        label,
        color: getTradeLineColor(role),
        lineWidth: role === 'entry' || state.hoveredLevelId === `${trade.id}:${role}` ? 2 : 1,
        hoveredAction: role === 'entry'
          ? (state.hoveredControlId === `${trade.id}:reverse` ? 'reverse'
            : state.hoveredControlId === `${trade.id}:close` ? 'close' : undefined)
          : undefined,
      });
    }
  }
  for (const position of brokerChartPositions.values()) {
    if (cleanSymbol(position.symbol) !== stateSym) continue;
    const side = position.side.toUpperCase();
    const color = side === 'BUY' ? '#26a69a' : '#ef5350';
    const id = `broker:${position.positionId}`;
    levels.push({
      tradeId: id,
      role: 'entry',
      price: position.entryPrice,
      label: `${side} ${position.volume} units · cTrader`,
      color,
      lineWidth: 2,
      readonly: true,
    });
    const stopLoss = position.stopLoss;
    if (stopLoss !== undefined && Number.isFinite(stopLoss) && stopLoss > 0) {
      levels.push({
        tradeId: `${id}:sl`,
        role: 'stopLoss',
        price: stopLoss,
        label: `cTrader SL ${stopLoss}`,
        color: '#ef5350',
        lineWidth: 1,
        readonly: true,
      });
    }
    const takeProfit = position.takeProfit;
    if (takeProfit !== undefined && Number.isFinite(takeProfit) && takeProfit > 0) {
      levels.push({
        tradeId: `${id}:tp`,
        role: 'takeProfit',
        price: takeProfit,
        label: `cTrader TP ${takeProfit}`,
        color: '#26a69a',
        lineWidth: 1,
        readonly: true,
      });
    }
  }
  for (const order of pendingOrders) {
    if (order.cellId !== state.cellId || cleanSymbol(order.symbol) !== stateSym) continue;
    levels.push({
      tradeId: order.id,
      role: 'entry',
      price: order.entryPrice,
      label: `${order.side.toUpperCase()} LIMIT/STOP ${formatLots(order.lots)} · PENDING`,
      color: getTradeLineColor('entry'),
      lineWidth: 1,
      pending: true,
      hoveredAction: state.hoveredControlId === `${order.id}:cancel` ? 'cancel' : undefined,
    });
  }
  state.tradeOverlay.setInputs({ levels: JSON.stringify(levels) });
}

function updateAllTradeOverlays(): void {
  if (overlayRenderFrame !== null) return;
  overlayRenderFrame = window.requestAnimationFrame(() => {
    overlayRenderFrame = null;
    for (const state of chartStates.values()) {
      updateTradeOverlay(state);
    }
  });
}

function removeLegacyTradeDrawings(state: ChartState, trade: PaperTrade): void {
  const existingIds = new Set(state.chart.drawings.all().map(drawing => drawing.id));
  for (const id of [...Object.values(trade.drawingIds), ...Object.values(trade.labelIds)]) {
    if (id && existingIds.has(id)) state.chart.drawings.remove(id);
  }
  trade.drawingIds = { entry: '', stopLoss: '', takeProfit: '' };
  trade.labelIds = { entry: '', stopLoss: '', takeProfit: '' };
}

function readSavedTrades(): PaperTrade[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error('Saved paper-trade state is not an array.');
    const validTrades = parsed.filter((item): item is PaperTrade => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<PaperTrade>;
      return typeof candidate.id === 'string'
        && typeof candidate.cellId === 'string'
        && typeof candidate.symbol === 'string'
        && (candidate.side === 'buy' || candidate.side === 'sell')
        && Number.isFinite(candidate.lots) && Number(candidate.lots) > 0
        && Number.isFinite(candidate.entryPrice) && Number(candidate.entryPrice) > 0
        && Number.isFinite(candidate.stopLoss) && Number(candidate.stopLoss) > 0
        && Number.isFinite(candidate.takeProfit) && Number(candidate.takeProfit) > 0
        && Number.isFinite(candidate.contractSize) && Number(candidate.contractSize) > 0
        && typeof candidate.currency === 'string'
        && Number.isFinite(candidate.minTick) && Number(candidate.minTick) > 0
        && Number.isFinite(candidate.entryTime)
        && Number.isFinite(candidate.labelTime)
        && !!candidate.drawingIds
        && ['entry', 'stopLoss', 'takeProfit'].every(role =>
          typeof candidate.drawingIds?.[role as TradeLineRole] === 'string');
    });
    return validTrades.map(trade => ({
      ...trade,
      labelIds: {
        entry: trade.labelIds?.entry ?? '',
        stopLoss: trade.labelIds?.stopLoss ?? '',
        takeProfit: trade.labelIds?.takeProfit ?? '',
      },
    }));
  } catch (error) {
    console.error('Could not restore saved paper trades:', error);
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

function saveTrades(): void {
  try {
    const pending = savedTrades.filter(trade => !restoredCells.has(trade.cellId) && !trades.has(trade.id));
    const merged = new Map(pending.map(trade => [trade.id, trade]));
    for (const trade of trades.values()) merged.set(trade.id, trade);
    savedTrades = [...merged.values()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTrades));
  } catch (error) {
    console.error('Could not save paper-trade state:', error);
    setStatus(`Could not save paper-trade state: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function restoreTradesForCell(state: ChartState): void {
  for (const savedTrade of savedTrades) {
    const trade = trades.get(savedTrade.id) ?? savedTrade;
    trades.set(trade.id, trade);
    try {
      removeLegacyTradeDrawings(state, trade);
    } catch (error) {
      console.error(`Could not restore paper trade ${trade.id}:`, error);
    }
  }
  updateAllTradeOverlays();
  restoredCells.add(state.cellId);
  saveTrades();
  updateTotalPnl();
}

function removeTrade(trade: PaperTrade, state: ChartState, reason: string, exitPrice?: number): void {
  const closePrice = exitPrice ?? paperTradeMarketPrice(trade) ?? trade.entryPrice;
  const pnl = calculatePaperTradePnl(trade.side, trade.entryPrice, closePrice, trade.lots, trade.contractSize);
  const closedTrade: ClosedPaperTrade = {
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    lots: trade.lots,
    entryPrice: trade.entryPrice,
    entryTime: trade.entryTime,
    closePrice,
    // Chart time (epoch ms) keeps replayed trades on the replayed timeline
    // instead of stamping them with today's wall clock.
    closeTime: state.lastBarTime ?? Date.now(),
    pnl,
    currency: trade.currency,
    reason,
    minTick: trade.minTick,
  };
  closedTradesHistory.unshift(closedTrade);
  saveClosedTrades();

  trades.delete(trade.id);
  updateAllTradeOverlays();
  saveTrades();
  updateTotalPnl();
  playTradeSound('tradeClosed');
  const pnlFormatted = formatPaperTradePnl(pnl, trade.currency);
  if (reason) setStatus(`${trade.side === 'buy' ? 'Buy' : 'Sell'} paper trade closed: ${reason} (P&L: ${pnlFormatted}).`, pnl >= 0 ? 'success' : 'error');
}

function handleBar(state: ChartState, bar: { time: number; high: number; low: number; close: number }): void {
  if (![bar.time, bar.high, bar.low, bar.close].every(Number.isFinite) || bar.close <= 0) return;
  state.lastPrice = bar.close;
  state.lastBarTime = bar.time;

  // `bar` fires on every tick of the forming candle. Keep one sample per bar
  // time, otherwise ATR(14) is computed from copies of a single candle.
  const previous = state.recentBars.at(-1);
  if (previous && previous.time === bar.time) {
    state.recentBars[state.recentBars.length - 1] = bar;
  } else {
    state.recentBars.push(bar);
    if (state.recentBars.length > 50) state.recentBars.shift();
  }

  const currentSym = cleanSymbol(state.chart.market.symbol);
  for (const trade of trades.values()) {
    if (cleanSymbol(trade.symbol) === currentSym) trade.lastKnownPrice = bar.close;
  }
  let pendingOrderFilled = false;
  for (const order of [...pendingOrders]) {
    if (order.cellId !== state.cellId || cleanSymbol(order.symbol) !== currentSym
      || bar.time <= order.createdAfterBarTime
      || (tradePreferences.maxOpenTrades > 0 && trades.size >= tradePreferences.maxOpenTrades)) continue;
    const triggered = shouldTriggerPendingPaperOrder(order.side, order.orderType, order.entryPrice, bar);
    if (!triggered) continue;
    const range = state.chart.getVisibleRange();
    const trade: PaperTrade = {
      id: order.id,
      cellId: order.cellId,
      symbol: order.symbol,
      side: order.side,
      lots: order.lots,
      entryPrice: order.entryPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      contractSize: order.contractSize,
      currency: order.currency,
      minTick: order.minTick,
      entryTime: bar.time,
      labelTime: range && range.to > range.from ? range.from + (range.to - range.from) * 0.88 : bar.time,
      drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
      labelIds: { entry: '', stopLoss: '', takeProfit: '' },
    };
    trades.set(trade.id, trade);
    pendingOrders = pendingOrders.filter(item => item.id !== order.id);
    pendingOrderFilled = true;
    setStatus(`${order.side === 'buy' ? 'Buy' : 'Sell'} pending paper order filled at ${formatPrice(order.entryPrice, order.minTick)}.`, 'success');
  }
  if (pendingOrderFilled) savePendingOrders();

  for (const trade of [...trades.values()]) {
    if (cleanSymbol(trade.symbol) !== currentSym) continue;
    if (bar.time <= trade.entryTime) continue;

    const stopHit = trade.side === 'buy' ? bar.low <= trade.stopLoss : bar.high >= trade.stopLoss;
    const targetHit = trade.side === 'buy' ? bar.high >= trade.takeProfit : bar.low <= trade.takeProfit;
    if (stopHit) removeTrade(trade, state, 'stop loss hit', trade.stopLoss);
    else if (targetHit) removeTrade(trade, state, 'take profit hit', trade.takeProfit);
  }
  if (pendingOrderFilled) {
    updateAllTradeOverlays();
    saveTrades();
  }
  updateTotalPnl();
  updateTradingPaneMarketData();
}

function getTradeAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
  roles: readonly TradeLineRole[],
  labelOnly = false,
): { trade: PaperTrade; role: TradeLineRole } | null {
  const canvas = state.host.querySelector<HTMLCanvasElement>('canvas[data-omega-trade-overlay="true"]');
  const hitData = canvas?.dataset.omegaTradeLevels;
  if (!canvas || !hitData) return null;

  const rect = canvas.getBoundingClientRect();
  const pointerX = clientX - rect.left;
  const pointerY = clientY - rect.top;
  const hits = (JSON.parse(hitData) as TradeOverlayHit[])
    .filter(hit => roles.includes(hit.role))
    .filter(hit => !labelOnly || (
      pointerX >= hit.x && pointerX <= hit.x + hit.width
      && pointerY >= hit.y - hit.height / 2 && pointerY <= hit.y + hit.height / 2
    ))
    .map(hit => ({ hit, distance: Math.abs(hit.y - pointerY) }))
    .filter(item => item.distance <= 10)
    .sort((a, b) => a.distance - b.distance);
  const chartSym = cleanSymbol(state.chart.market.symbol);
  for (const { hit } of hits) {
    const trade = trades.get(hit.tradeId);
    if (trade && cleanSymbol(trade.symbol) === chartSym) {
      return { trade, role: hit.role };
    }
  }
  return null;
}

function getTradeActionAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
): { id: string; trade?: PaperTrade; pendingOrder?: PendingPaperOrder; action: OverlayAction } | null {
  const canvas = state.host.querySelector<HTMLCanvasElement>('canvas[data-omega-trade-overlay="true"]');
  const hitData = canvas?.dataset.omegaTradeLevels;
  if (!canvas || !hitData) return null;

  const rect = canvas.getBoundingClientRect();
  const pointerX = clientX - rect.left;
  const pointerY = clientY - rect.top;
  const chartSym = cleanSymbol(state.chart.market.symbol);
  const hits = (JSON.parse(hitData) as TradeOverlayHit[])
    .filter((hit): hit is TradeOverlayHit & { action: OverlayAction } => Boolean(hit.action))
    .filter(hit => pointerX >= hit.x && pointerX <= hit.x + hit.width
      && pointerY >= (hit.top ?? hit.y - hit.height / 2)
      && pointerY <= (hit.top ?? hit.y - hit.height / 2) + hit.height);
  for (const hit of hits) {
    const trade = trades.get(hit.tradeId);
    if (trade && cleanSymbol(trade.symbol) === chartSym && (hit.action === 'close' || hit.action === 'reverse')) {
      return { id: trade.id, trade, action: hit.action };
    }
    const pendingOrder = pendingOrders.find(order => order.id === hit.tradeId
      && order.cellId === state.cellId && cleanSymbol(order.symbol) === chartSym);
    if (pendingOrder && hit.action === 'cancel') return { id: pendingOrder.id, pendingOrder, action: hit.action };
  }
  return null;
}

function getProtectionLevelAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
): { trade: PaperTrade; role: 'stopLoss' | 'takeProfit' } | null {
  const match = getTradeAtPointer(state, clientX, clientY, ['stopLoss', 'takeProfit'], true);
  if (!match || match.role === 'entry') return null;
  return { trade: match.trade, role: match.role };
}

function moveTradeLevel(trade: PaperTrade, role: 'stopLoss' | 'takeProfit', price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  trade[role] = moveProtectionLevel(trade.side, role, trade.entryPrice, price, trade.minTick);
}

function setHoveredLevel(
  state: ChartState,
  match: { trade: PaperTrade; role: 'stopLoss' | 'takeProfit' } | null,
): void {
  const nextId = match ? `${match.trade.id}:${match.role}` : null;
  if (state.hoveredLevelId === nextId) return;
  state.hoveredLevelId = nextId;
  updateTradeOverlay(state);
}

function setTradeCursor(state: ChartState, mode: 'default' | 'hover' | 'dragging' | 'action'): void {
  const cursor = mode === 'dragging' ? 'grabbing'
    : mode === 'hover' ? 'ns-resize'
      : mode === 'action' ? 'pointer' : 'crosshair';
  const canvas = state.host.querySelector<HTMLCanvasElement>('canvas[data-omega-trade-overlay="true"]');
  state.host.classList.toggle('omega-trade-level-hover', mode === 'hover' || mode === 'action');
  state.host.classList.toggle('omega-trade-level-dragging', mode === 'dragging');
  if (mode === 'default') state.host.style.removeProperty('cursor');
  else state.host.style.setProperty('cursor', cursor, 'important');
  if (canvas) {
    if (mode === 'default') canvas.style.removeProperty('cursor');
    else canvas.style.setProperty('cursor', cursor, 'important');
  }
}

function showCloseConfirmation(trade: PaperTrade): void {
  showTradeActionConfirmation(trade, 'close');
}

function showTradeActionConfirmation(trade: PaperTrade, action: TradeOverlayAction): void {
  if (!tradePreferences.confirmCloseActions) {
    const state = chartStates.get(trade.cellId);
    if (!state) {
      setStatus(`Could not ${action} paper trade: its chart is no longer available.`, 'error');
      return;
    }
    try {
      if (action === 'reverse') reverseTrade(trade, state);
      else removeTrade(trade, state, 'manually closed');
    } catch (error) {
      console.error(`Could not ${action} paper trade:`, error);
      setStatus(`Could not ${action} paper trade: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    return;
  }
  pendingCloseTradeId = trade.id;
  pendingTradeAction = action;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const direction = trade.side === 'buy' ? 'Buy' : 'Sell';
  closeTitle.textContent = action === 'reverse' ? 'Reverse paper trade?' : 'Close paper trade?';
  closeYesButton.textContent = action === 'reverse' ? 'Yes, reverse' : 'Yes, close';
  closeMessage.textContent = action === 'reverse'
    ? `Close the ${direction} paper trade and open a ${trade.side === 'buy' ? 'Sell' : 'Buy'} trade of ${formatLots(trade.lots)} lots in ${trade.symbol}?`
    : `Close the ${direction} paper trade of ${formatLots(trade.lots)} lots in ${trade.symbol}?`;
  closeModal.hidden = false;
  closeModal.setAttribute('aria-hidden', 'false');
  closeNoButton.focus();
}

function hideCloseConfirmation(): void {
  closeModal.hidden = true;
  closeModal.setAttribute('aria-hidden', 'true');
  pendingCloseTradeId = null;
  pendingTradeAction = 'close';
  closeTitle.textContent = 'Close paper trade?';
  closeYesButton.textContent = 'Yes';
  previousFocus?.focus();
  previousFocus = null;
}

function reverseTrade(trade: PaperTrade, state: ChartState): void {
  if (!trades.has(trade.id)) return;
  const entryPrice = state.lastPrice && Number.isFinite(state.lastPrice) && state.lastPrice > 0
    ? state.lastPrice
    : trade.entryPrice;
  const side: PaperTradeSide = trade.side === 'buy' ? 'sell' : 'buy';
  const protection = createConfiguredProtectionLevels(
    side,
    entryPrice,
    trade.minTick,
    protectionSettings,
    computeAtr14(state.recentBars),
  );
  const range = state.chart.getVisibleRange();
  const reversedTrade: PaperTrade = {
    ...trade,
    id: crypto.randomUUID(),
    side,
    entryPrice,
    stopLoss: protection.stopLoss,
    takeProfit: protection.takeProfit,
    entryTime: state.lastBarTime ?? Date.now(),
    labelTime: range && range.to > range.from
      ? range.from + (range.to - range.from) * 0.88
      : state.lastBarTime ?? Date.now(),
    drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
    labelIds: { entry: '', stopLoss: '', takeProfit: '' },
  };
  removeTrade(trade, state, 'reversed', entryPrice);
  trades.set(reversedTrade.id, reversedTrade);
  updateAllTradeOverlays();
  saveTrades();
  updateTotalPnl();
  setStatus(`${side === 'buy' ? 'Buy' : 'Sell'} paper trade opened after reversing ${formatLots(trade.lots)} lots.`, 'success');
}

async function openTrade(state: ChartState, side: PaperTradeSide): Promise<void> {
  const lots = Number(lotsInput.value);
  if (!Number.isFinite(lots) || lots < 0.01) {
    lotsInput.setAttribute('aria-invalid', 'true');
    setStatus('Enter a lot size of at least 0.01.', 'error');
    return;
  }
  lotsInput.removeAttribute('aria-invalid');
  if (tradePreferences.maxOpenTrades > 0 && trades.size >= tradePreferences.maxOpenTrades) {
    setStatus(`Cannot open another paper trade: the configured limit is ${tradePreferences.maxOpenTrades}.`, 'error');
    return;
  }

  const entryPrice = state.lastPrice;
  if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    setStatus('Waiting for a live or replay price before opening a paper trade.', 'error');
    return;
  }

  const symbol = state.chart.market.symbol;
  if (!symbol) {
    setStatus('The active chart does not have a selected symbol.', 'error');
    return;
  }
  const resolved = state.chart.data.resolve(symbol);
  if (!resolved) {
    setStatus(`No market-data provider is available for ${symbol}.`, 'error');
    return;
  }

  const releaseTradeCreation = tradeCreationGate.acquire();
  if (!releaseTradeCreation) return;
  buyButton.disabled = true;
  sellButton.disabled = true;
  setStatus('Creating paper trade...');
  try {
    const info = await state.chart.data.symbolInfo(symbol) as Record<string, unknown> | undefined;
    if (state.chart.market.symbol !== symbol) {
      throw new Error('The chart symbol changed before the paper trade could be created.');
    }
    const ticker = resolved.ticker;
    const minTick = getMinTick(ticker, info);
    const atr14 = computeAtr14(state.recentBars);
    const protection = createConfiguredProtectionLevels(
      side,
      entryPrice,
      minTick,
      protectionSettings,
      atr14,
      getPipSize(ticker, info),
    );

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      cellId: state.cellId,
      symbol,
      side,
      lots,
      entryPrice,
      stopLoss: protection.stopLoss,
      takeProfit: protection.takeProfit,
      contractSize: getContractSize(ticker, info),
      currency: getQuoteCurrency(symbol, info),
      minTick,
      entryTime: state.lastBarTime ?? state.chart.getVisibleRange()?.to ?? Date.now(),
      labelTime: (() => {
        const range = state.chart.getVisibleRange();
        return range && range.to > range.from
          ? range.from + (range.to - range.from) * 0.88
          : state.lastBarTime ?? Date.now();
      })(),
      drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
      labelIds: { entry: '', stopLoss: '', takeProfit: '' },
    };

    trades.set(trade.id, trade);
    updateAllTradeOverlays();
    saveTrades();
    updateTotalPnl();
    const modeDesc = protectionSettings.mode === 'atr' ? `ATR(14) SL:${protectionSettings.slValue}x TP:${protectionSettings.tpValue}x` : `Pips SL:${protectionSettings.slValue} TP:${protectionSettings.tpValue}`;
    setStatus(`${side === 'buy' ? 'Buy' : 'Sell'} paper trade added (${modeDesc}). Drag SL/TP to adjust; use the entry controls to close or reverse.`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Could not create paper trade:', error);
    setStatus(`Could not create paper trade: ${message}`, 'error');
  } finally {
    releaseTradeCreation();
    buyButton.disabled = false;
    sellButton.disabled = false;
  }
}

function attachChart(cellId: string, chart: Vela, host: HTMLElement): void {
  if (chartStates.has(cellId)) return;
  const tradeOverlay = chart.addNativeIndicator(QUICK_TRADE_LAYER_ID, { inputs: { levels: '[]' } });
  const state: ChartState = {
    cellId, chart, host, lastPrice: null, lastBarTime: null,
    recentBars: [],
    draggingLevel: null, dragChanged: false, hoveredLevelId: null, hoveredControlId: null, tradeOverlay,
    disposers: [],
  };
  chartStates.set(cellId, state);

  state.disposers.push(
    chart.on('bar', bar => handleBar(state, bar)),
    chart.on('market:changed', () => {
      // Prices and candles belong to the previous instrument; never carry them
      // over to the new symbol (they would be used as entry prices and as ATR
      // samples).
      state.lastPrice = null;
      state.lastBarTime = null;
      state.recentBars = [];
      state.hoveredLevelId = null;
      state.hoveredControlId = null;
      updateAllTradeOverlays();
      updateTradingPaneMarketData();
      updateTotalPnl();
    }),
  );

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const action = getTradeActionAtPointer(state, event.clientX, event.clientY);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      if (action.pendingOrder) cancelPendingPaperOrder(action.pendingOrder);
      else if (action.trade && (action.action === 'close' || action.action === 'reverse')) {
        showTradeActionConfirmation(action.trade, action.action);
      }
      return;
    }
    const match = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    if (!match) return;
    state.draggingLevel = { tradeId: match.trade.id, role: match.role };
    state.dragChanged = false;
    setTradeCursor(state, 'dragging');
    const target = event.target;
    if (event.isTrusted && target instanceof Element && 'setPointerCapture' in target) {
      (target as Element & { setPointerCapture(pointerId: number): void }).setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (state.draggingLevel) {
      const canvas = host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
      const rect = canvas?.getBoundingClientRect();
      const priceAtY = canvas?.omegaTradePriceAtY;
      const trade = trades.get(state.draggingLevel.tradeId);
      if (rect && priceAtY && trade) {
        const previousPrice = trade[state.draggingLevel.role];
        moveTradeLevel(trade, state.draggingLevel.role, priceAtY(event.clientY - rect.top));
        if (trade[state.draggingLevel.role] !== previousPrice) state.dragChanged = true;
        updateAllTradeOverlays();
      }
      setTradeCursor(state, 'dragging');
      return;
    }
    const action = getTradeActionAtPointer(state, event.clientX, event.clientY);
    const nextControlId = action ? `${action.id}:${action.action}` : null;
    if (state.hoveredControlId !== nextControlId) {
      state.hoveredControlId = nextControlId;
      updateTradeOverlay(state);
    }
    if (action) {
      setHoveredLevel(state, null);
      setTradeCursor(state, 'action');
      return;
    }
    const match = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    setHoveredLevel(state, match);
    setTradeCursor(state, match ? 'hover' : 'default');
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!state.draggingLevel) return;
    const didChangeLevel = state.dragChanged;
    state.draggingLevel = null;
    state.dragChanged = false;
    saveTrades();
    updateAllTradeOverlays();
    if (didChangeLevel) playTradeLevelSetClick();
    const hovered = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    setHoveredLevel(state, hovered);
    setTradeCursor(state, hovered ? 'hover' : 'default');
  };
  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('pointermove', onPointerMove, true);
  host.addEventListener('pointerup', onPointerUp, true);
  host.addEventListener('pointercancel', onPointerUp, true);
  state.disposers.push(() => {
    host.removeEventListener('pointerdown', onPointerDown, true);
    host.removeEventListener('pointermove', onPointerMove, true);
    host.removeEventListener('pointerup', onPointerUp, true);
    host.removeEventListener('pointercancel', onPointerUp, true);
    setTradeCursor(state, 'default');
  });

  const onContextMenu = (event: MouseEvent): void => {
    const match = getTradeAtPointer(state, event.clientX, event.clientY, ['entry'], true);
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    showCloseConfirmation(match.trade);
  };
  host.addEventListener('contextmenu', onContextMenu);
  state.disposers.push(() => host.removeEventListener('contextmenu', onContextMenu));

  void chart.ready().then(() => restoreTradesForCell(state)).catch(error => {
    console.error(`Could not restore paper trades for chart ${cellId}:`, error);
    setStatus(`Could not restore paper trades: ${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

export function initializeChartPaperTrading(workspace: VelaWorkspace): () => void {
  if (!document.getElementById('omega-trading-pane')) {
    const tradeControls = document.getElementById('chart-paper-trade-controls');
    if (!tradeControls) throw new Error('Paper trading controls are missing from the chart view.');
    const template = document.createElement('template');
    template.innerHTML = rightTradingPaneMarkup.trim();
    tradeControls.after(template.content);
  }
  initializePendingOrderModal();
  savedTrades = readSavedTrades();
  for (const cell of workspace.cells()) attachChart(cell.id, cell.chart, cell.host);
  initializeTradingPane(workspace);
  const onBrokerPositionsUpdated = (event: Event) => {
    const positions = (event as CustomEvent<BrokerChartPosition[]>).detail;
    brokerChartPositions.clear();
    if (Array.isArray(positions)) {
      for (const position of positions) {
        if (!position || !position.positionId || !position.symbol
          || !Number.isFinite(position.entryPrice) || position.entryPrice <= 0
          || !Number.isFinite(Number(position.volume)) || Number(position.volume) <= 0
          || typeof position.side !== 'string'
          || !['BUY', 'SELL'].includes(position.side.toUpperCase())) continue;
        brokerChartPositions.set(position.positionId, position);
      }
    }
    updateAllTradeOverlays();
  };
  document.addEventListener('omega:ctrader-positions-updated', onBrokerPositionsUpdated);
  const openTradesModal = document.getElementById('paper-open-trades-modal') as HTMLDivElement | null;
  const openTradesList = document.getElementById('paper-open-trades-list') as HTMLDivElement | null;
  const openTradesClose = document.getElementById('paper-open-trades-close') as HTMLButtonElement | null;
  const renderOpenTrades = () => {
    if (!openTradesList) return;
    openTradesList.replaceChildren();
    const openTrades = [...trades.values()];
    if (openTrades.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'omega-open-trades-empty';
      empty.textContent = 'There are no open paper trades.';
      openTradesList.append(empty);
      return;
    }

    const headings = document.createElement('div');
    headings.className = 'omega-open-trade-row omega-open-trade-head';
    for (const label of ['Symbol / side', 'Volume', 'Entry', 'Current', 'Unrealized P/L']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      headings.append(cell);
    }
    headings.append(document.createElement('span'));
    openTradesList.append(headings);

    for (const trade of openTrades) {
      const currentPrice = chartStates.get(trade.cellId)?.lastPrice;
      const pnl = Number.isFinite(currentPrice)
        ? calculatePaperTradePnl(trade.side, trade.entryPrice, currentPrice!, trade.lots, trade.contractSize)
        : null;
      const row = document.createElement('div');
      row.className = 'omega-open-trade-row';
      row.setAttribute('role', 'listitem');
      const symbol = document.createElement('strong');
      symbol.className = trade.side === 'buy' ? 'omega-open-trade-side-buy' : 'omega-open-trade-side-sell';
      symbol.textContent = `${trade.symbol} · ${trade.side.toUpperCase()}`;
      const volume = document.createElement('span');
      volume.textContent = `${formatLots(trade.lots)} lots`;
      const entry = document.createElement('span');
      entry.textContent = formatPrice(trade.entryPrice, trade.minTick);
      const current = document.createElement('span');
      current.textContent = Number.isFinite(currentPrice) ? formatPrice(currentPrice!, trade.minTick) : '—';
      const result = document.createElement('strong');
      result.className = pnl === null ? '' : pnl >= 0 ? 'omega-open-trade-positive' : 'omega-open-trade-negative';
      result.textContent = pnl === null ? '—' : formatPaperTradePnl(pnl, trade.currency);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'omega-open-trade-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${trade.side} paper trade in ${trade.symbol}`);
      close.title = 'Close trade';
      close.addEventListener('click', () => {
        const activeTrade = trades.get(trade.id);
        if (activeTrade) showCloseConfirmation(activeTrade);
      });
      row.append(symbol, volume, entry, current, result, close);
      openTradesList.append(row);
    }
  };
  refreshOpenTradesList = renderOpenTrades;
  const openTrades = () => {
    if (!openTradesModal) return;
    renderOpenTrades();
    openTradesModal.hidden = false;
    openTradesModal.setAttribute('aria-hidden', 'false');
  };
  const closeOpenTrades = () => {
    if (!openTradesModal) return;
    openTradesModal.hidden = true;
    openTradesModal.setAttribute('aria-hidden', 'true');
  };
  document.addEventListener('omega:paper-trading:open-trades', openTrades);
  openTradesClose?.addEventListener('click', closeOpenTrades);
  openTradesModal?.addEventListener('click', event => {
    if (event.target === openTradesModal) closeOpenTrades();
  });
  updateTotalPnl();
  const consolePanel = document.getElementById('activity-console') as HTMLElement | null;
  const consoleToggle = document.getElementById('activity-console-toggle') as HTMLButtonElement | null;
  const consoleClose = document.getElementById('activity-console-close') as HTMLButtonElement | null;
  const consoleClear = document.getElementById('activity-console-clear') as HTMLButtonElement | null;
  const setConsoleOpen = (open: boolean) => {
    if (!consolePanel || !consoleToggle) return;
    consolePanel.hidden = !open;
    consoleToggle.classList.toggle('active', open);
  };
  document.addEventListener('omega:paper-trading:activity-console', () => setConsoleOpen(consolePanel?.hidden !== false));
  consoleClose?.addEventListener('click', () => setConsoleOpen(false));
  consoleClear?.addEventListener('click', () => {
    activityEntries.length = 0;
    document.getElementById('activity-console-list')?.replaceChildren();
  });
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button || button.closest('#activity-console')) return;
    const label = button.getAttribute('aria-label') || button.textContent?.trim();
    if (label) writeActivity(`Action: ${label}`);
  }, true);
  writeActivity('Paper trading console ready.');
  const unsubscribeCells = workspace.on('cell:created', event => {
    const cell = workspace.cell(event.id);
    if (cell) {
      attachChart(cell.id, cell.chart, cell.host);
      const state = chartStates.get(cell.id);
      if (state) attachMeasurementTool(state);
    }
    updateTradingPaneMarketData();
  });
  const unsubscribeDestroyed = workspace.on('cell:destroyed', event => {
    const state = chartStates.get(event.id);
    if (!state) return;
    state.disposers.forEach(dispose => dispose());
    state.tradeOverlay.remove();
    chartStates.delete(event.id);
    saveTrades();
    updateTotalPnl();
  });

  document.addEventListener('omega:paper-trading:buy', () => {
    const state = chartStates.get(workspace.active?.id);
    if (state) void openTrade(state, 'buy');
  });
  document.addEventListener('omega:paper-trading:sell', () => {
    const state = chartStates.get(workspace.active?.id);
    if (state) void openTrade(state, 'sell');
  });
  closeYesButton.addEventListener('click', () => {
    const trade = pendingCloseTradeId ? trades.get(pendingCloseTradeId) : undefined;
    const tradeState = trade ? chartStates.get(trade.cellId) : undefined;
    try {
      if (trade && tradeState) {
        if (pendingTradeAction === 'reverse') reverseTrade(trade, tradeState);
        else removeTrade(trade, tradeState, 'manually closed');
      }
    } catch (error) {
      console.error(`Could not ${pendingTradeAction} paper trade:`, error);
      setStatus(`Could not ${pendingTradeAction} paper trade: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    hideCloseConfirmation();
  });
  closeNoButton.addEventListener('click', hideCloseConfirmation);
  closeModal.addEventListener('click', event => {
    if (event.target === closeModal) hideCloseConfirmation();
  });

  // Settings Modal wiring
  const settingsBtn = document.getElementById('paper-trade-settings-btn') as HTMLButtonElement | null;
  const settingsModal = document.getElementById('paper-trade-settings-modal') as HTMLDivElement | null;
  const settingsClose = document.getElementById('paper-trade-settings-close') as HTMLButtonElement | null;
  const settingsSave = document.getElementById('paper-trade-settings-save') as HTMLButtonElement | null;
  const settingsMode = document.getElementById('paper-trade-settings-mode') as HTMLSelectElement | null;
  const settingsSl = document.getElementById('paper-trade-settings-sl') as HTMLInputElement | null;
  const settingsTp = document.getElementById('paper-trade-settings-tp') as HTMLInputElement | null;
  const entryColor = document.getElementById('paper-trade-entry-color') as HTMLInputElement | null;
  const stopLossColor = document.getElementById('paper-trade-sl-color') as HTMLInputElement | null;
  const takeProfitColor = document.getElementById('paper-trade-tp-color') as HTMLInputElement | null;
  const transparency = document.getElementById('paper-trade-transparency') as HTMLInputElement | null;
  const transparencyValue = document.getElementById('paper-trade-transparency-value') as HTMLOutputElement | null;
  const defaultLotsField = document.getElementById('paper-trade-default-lots') as HTMLInputElement | null;
  const quickLotsFields = [1, 2, 3, 4].map(index => document.getElementById(`paper-trade-quick-lots-${index}`) as HTMLInputElement | null);
  const maxOpenTradesField = document.getElementById('paper-trade-max-open') as HTMLInputElement | null;
  const confirmCloseField = document.getElementById('paper-trade-confirm-close') as HTMLInputElement | null;
  const soundsEnabledField = document.getElementById('paper-trade-sounds-enabled') as HTMLInputElement | null;
  const soundVolumeField = document.getElementById('paper-trade-sound-volume') as HTMLInputElement | null;
  const soundVolumeValue = document.getElementById('paper-trade-sound-volume-value') as HTMLOutputElement | null;
  const slLabel = document.getElementById('paper-trade-sl-label') as HTMLSpanElement | null;
  const tpLabel = document.getElementById('paper-trade-tp-label') as HTMLSpanElement | null;
  const settingsHint = document.getElementById('paper-trade-settings-hint') as HTMLElement | null;

  const updateSettingsFields = () => {
    if (!settingsMode || !slLabel || !tpLabel || !settingsHint) return;
    if (settingsMode.value === 'atr') {
      slLabel.textContent = 'Stop Loss (ATR multiplier):';
      tpLabel.textContent = 'Take Profit (ATR multiplier):';
      settingsHint.textContent = 'ATR(14) uses Wilder\'s smoothing. Enter multiplier (e.g., 1.5 = 1.5× ATR, 3.0 = 3× ATR).';
    } else {
      slLabel.textContent = 'Stop Loss (pips):';
      tpLabel.textContent = 'Take Profit (pips):';
      settingsHint.textContent = 'Pip distance. e.g. 20 pips SL / 40 pips TP.';
    }
  };

  const openSettingsModal = () => {
    if (!settingsModal || !settingsMode || !settingsSl || !settingsTp) return;
    settingsMode.value = protectionSettings.mode;
    settingsSl.value = String(protectionSettings.slValue);
    settingsTp.value = String(protectionSettings.tpValue);
    if (entryColor) entryColor.value = getTradeLineColor('entry');
    if (stopLossColor) stopLossColor.value = getTradeLineColor('stopLoss');
    if (takeProfitColor) takeProfitColor.value = getTradeLineColor('takeProfit');
    if (transparency) transparency.value = String(tradeRectangleAppearance.transparency);
    if (transparencyValue && transparency) transparencyValue.value = `${transparency.value}%`;
    if (defaultLotsField) defaultLotsField.value = formatLots(tradePreferences.defaultLots);
    quickLotsFields.forEach((field, index) => {
      if (field) field.value = formatLots(tradePreferences.quickLots[index]);
    });
    if (maxOpenTradesField) maxOpenTradesField.value = String(tradePreferences.maxOpenTrades);
    if (confirmCloseField) confirmCloseField.checked = tradePreferences.confirmCloseActions;
    if (soundsEnabledField) soundsEnabledField.checked = tradePreferences.soundsEnabled;
    if (soundVolumeField) soundVolumeField.value = String(tradePreferences.soundVolume);
    if (soundVolumeValue && soundVolumeField) soundVolumeValue.value = `${soundVolumeField.value}%`;
    updateSettingsFields();
    settingsModal.hidden = false;
    settingsModal.setAttribute('aria-hidden', 'false');
  };

  const closeSettingsModal = () => {
    if (!settingsModal) return;
    settingsModal.hidden = true;
    settingsModal.setAttribute('aria-hidden', 'true');
  };

  settingsBtn?.addEventListener('click', openSettingsModal);
  settingsClose?.addEventListener('click', closeSettingsModal);
  settingsMode?.addEventListener('change', updateSettingsFields);
  transparency?.addEventListener('input', () => {
    if (transparencyValue) transparencyValue.value = `${transparency.value}%`;
  });
  soundVolumeField?.addEventListener('input', () => {
    if (soundVolumeValue) soundVolumeValue.value = `${soundVolumeField.value}%`;
  });
  settingsSave?.addEventListener('click', () => {
    if (!settingsMode || !settingsSl || !settingsTp) return;
    const defaultLots = Number(defaultLotsField?.value);
    const quickLots = quickLotsFields.map(field => Number(field?.value));
    const maxOpenTrades = Number(maxOpenTradesField?.value);
    if (!Number.isFinite(defaultLots) || defaultLots < 0.01 || defaultLots > 100_000
      || quickLots.some(value => !Number.isFinite(value) || value < 0.01 || value > 100_000)
      || !Number.isInteger(maxOpenTrades) || maxOpenTrades < 0 || maxOpenTrades > 100_000) {
      if (settingsHint) {
        settingsHint.textContent = 'Enter valid lot sizes from 0.01 to 100,000 and a whole-number trade limit (0 = unlimited).';
        settingsHint.dataset.state = 'error';
      }
      return;
    }
    if (settingsHint) delete settingsHint.dataset.state;
    updateSettingsFields();
    const mode = (settingsMode.value === 'atr' ? 'atr' : 'pips') as ProtectionMode;
    const quickLotsTuple: PaperTradePreferences['quickLots'] = [
      quickLots[0], quickLots[1], quickLots[2], quickLots[3],
    ];
    const slValue = Math.max(0.1, Number(settingsSl.value) || 20);
    const tpValue = Math.max(0.1, Number(settingsTp.value) || 40);
    protectionSettings = { mode, slValue, tpValue };
    tradePreferences = {
      defaultLots,
      quickLots: quickLotsTuple,
      maxOpenTrades,
      confirmCloseActions: confirmCloseField?.checked ?? true,
      soundsEnabled: soundsEnabledField?.checked ?? true,
      soundVolume: Math.max(0, Math.min(100, Number(soundVolumeField?.value ?? 50))),
    };
    lotsInput.value = formatLots(tradePreferences.defaultLots);
    const paneLots = document.getElementById('omega-tp-lots') as HTMLInputElement | null;
    if (paneLots) paneLots.value = lotsInput.value;
    const quickButtons = document.querySelectorAll<HTMLButtonElement>('#omega-trading-pane [data-lots]');
    quickButtons.forEach((button, index) => {
      const value = tradePreferences.quickLots[index];
      button.dataset.lots = String(value);
      button.textContent = formatLots(value);
    });
    if (entryColor && stopLossColor && takeProfitColor) {
      tradeRectangleAppearance = {
        entryColor: entryColor.value,
        stopLossColor: stopLossColor.value,
        takeProfitColor: takeProfitColor.value,
        transparency: Math.max(0, Math.min(80, Number(transparency?.value ?? 18))),
      };
    }
    saveProtectionSettings();
    saveTradePreferences();
    updateAllTradeOverlays();
    closeSettingsModal();
    playTradeSound('protectionSaved');
    setStatus(`Protection settings saved: ${mode.toUpperCase()} (SL: ${slValue}, TP: ${tpValue})`, 'success');
  });
  settingsModal?.addEventListener('click', event => {
    if (event.target === settingsModal) closeSettingsModal();
  });

  // History Modal wiring
  const historyModal = document.getElementById('paper-trade-history-modal') as HTMLDivElement | null;
  const historyClose = document.getElementById('paper-trade-history-close') as HTMLButtonElement | null;
  const historyClear = document.getElementById('paper-trade-history-clear') as HTMLButtonElement | null;
  const historyList = document.getElementById('paper-trade-history-list') as HTMLDivElement | null;

  const renderHistoryTable = () => {
    if (!historyList) return;
    historyList.replaceChildren();
    if (closedTradesHistory.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.style.cssText = 'color:var(--omega-muted); text-align:center; padding:32px 16px; font-size:12px; margin:0;';
      emptyMsg.textContent = 'No closed paper trades recorded yet.';
      historyList.appendChild(emptyMsg);
      return;
    }

    const { account, currency: accountCurrency, omittedTrades } = paperAccount();
    const summary = document.createElement('div');
    summary.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:0 0 10px;';
    const addMetric = (label: string, value: string, color = '') => {
      const card = document.createElement('div');
      card.style.cssText = 'padding:7px;border:1px solid var(--omega-border);border-radius:5px;background:var(--omega-elevated);min-width:0;';
      const caption = document.createElement('span'); caption.textContent = label;
      caption.style.cssText = 'display:block;color:var(--omega-muted);font-size:10px;';
      const result = document.createElement('strong'); result.textContent = value;
      result.style.cssText = `display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;${color ? `color:${color};` : ''}`;
      card.append(caption, result); summary.append(card);
    };
    addMetric('Equity', formatPaperTradePnl(account.equity, accountCurrency).replace(/^\+/, ''));
    addMetric('Net P&L', formatPaperTradePnl(account.realisedPnl, accountCurrency), account.realisedPnl >= 0 ? 'var(--omega-success)' : 'var(--omega-error)');
    addMetric('Max drawdown', formatPaperTradePnl(-account.analytics.maxDrawdown, accountCurrency), 'var(--omega-error)');
    addMetric('Win rate', account.analytics.winRate === null ? '—' : `${account.analytics.winRate.toFixed(1)}%`);
    addMetric('Profit factor', account.analytics.profitFactor === null ? '—' : Number.isFinite(account.analytics.profitFactor) ? account.analytics.profitFactor.toFixed(2) : '∞');
    addMetric('Closed trades', String(account.analytics.ledgerClosedTrades));
    historyList.append(summary);
    if (omittedTrades > 0) {
      const note = document.createElement('p');
      note.style.cssText = 'margin:0 0 10px;color:var(--omega-muted);font-size:11px;';
      note.textContent = `${omittedTrades} trade(s) in another quote currency are listed below but excluded from the USD account summary. No FX conversion is assumed.`;
      historyList.append(note);
    }

    const table = document.createElement('table');
    table.className = 'omega-history-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th>Lots</th>
          <th>Entry</th>
          <th>Close</th>
          <th>P&L</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody')!;
    const historyCell = (text: string, className?: string, color?: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (className) cell.className = className;
      if (color) cell.style.color = color;
      return cell;
    };
    for (const trade of closedTradesHistory) {
      const row = document.createElement('tr');
      const timeStr = new Date(trade.closeTime).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC',
      });
      const minTick = trade.minTick ?? inferPipSize(trade.symbol) ?? 0.01;
      const symbolCell = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = trade.symbol;
      symbolCell.append(strong);
      const sideCell = document.createElement('td');
      const sideStrong = document.createElement('strong');
      sideStrong.style.color = trade.side === 'buy' ? 'var(--omega-success)' : 'var(--omega-error)';
      sideStrong.textContent = trade.side.toUpperCase();
      sideCell.append(sideStrong);
      row.append(
        historyCell(timeStr, undefined, 'var(--omega-muted)'),
        symbolCell,
        sideCell,
        historyCell(formatLots(trade.lots)),
        historyCell(formatPrice(trade.entryPrice, minTick)),
        historyCell(formatPrice(trade.closePrice, minTick)),
        historyCell(formatPaperTradePnl(trade.pnl, trade.currency), trade.pnl >= 0 ? 'omega-history-positive' : 'omega-history-negative'),
        historyCell(trade.reason, undefined, 'var(--omega-muted)'),
      );
      tbody.appendChild(row);
    }
    historyList.appendChild(table);
  };

  const openHistoryModal = () => {
    if (!historyModal) return;
    renderHistoryTable();
    historyModal.hidden = false;
    historyModal.setAttribute('aria-hidden', 'false');
  };

  const closeHistoryModal = () => {
    if (!historyModal) return;
    historyModal.hidden = true;
    historyModal.setAttribute('aria-hidden', 'true');
  };

  document.addEventListener('omega:paper-trading:trade-history', openHistoryModal);
  historyClose?.addEventListener('click', closeHistoryModal);
  historyClear?.addEventListener('click', () => {
    if (confirm('Clear all paper trade history?')) {
      closedTradesHistory = [];
      saveClosedTrades();
      renderHistoryTable();
    }
  });
  historyModal?.addEventListener('click', event => {
    if (event.target === historyModal) closeHistoryModal();
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!closeModal.hidden) hideCloseConfirmation();
      if (settingsModal && !settingsModal.hidden) closeSettingsModal();
      if (historyModal && !historyModal.hidden) closeHistoryModal();
      if (openTradesModal && !openTradesModal.hidden) closeOpenTrades();
    }
  });

  // Custom measurement overlay for paper trading
  function createMeasurementOverlay(): void {
    document.getElementById('omega-measurement-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'omega-measurement-overlay';
    overlay.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      background: var(--omega-surface);
      border: 1px solid var(--omega-border);
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 12px;
      color: var(--omega-text);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 22;
      display: none;
      min-width: 220px;
    `;
    // Keep the card inside the chart workspace: a body-level element would
    // always paint above Vela's menu layers (which live in the workspace).
    (document.querySelector('.vela-workspace') ?? document.body).appendChild(overlay);
  }

  type MeasurementAnchor = {
    time: number;
    price: number;
    symbol: string;
    contractSize: number;
    minTick: number;
    currency: string;
  };
  let measurementStartPoint: MeasurementAnchor | null = null;
  let measurementEnd: { time: number; price: number } | null = null;
  let measurementModeActive = false;
  let measurementDragging = false;
  let measurementChart: ChartState | null = null;
  let measurementStartX = 0;
  let measurementStartY = 0;
  let measurementPeriods = 1;
  let measurementGesture = 0;
  let measurementLastPointer: { clientX: number; clientY: number } | null = null;
  let measurementVisual: { container: HTMLDivElement; horizontal: HTMLDivElement; vertical: HTMLDivElement; line: SVGLineElement } | null = null;

  function ensureMeasurementVisual(state: ChartState) {
    measurementVisual?.container.remove();
    const container = document.createElement('div');
    container.className = 'omega-measure-container';
    const horizontal = document.createElement('div');
    horizontal.className = 'omega-measure-cross-h';
    const vertical = document.createElement('div');
    vertical.className = 'omega-measure-cross-v';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'omega-measure-svg');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'omega-measure-line');
    svg.append(line);
    container.append(svg, horizontal, vertical);
    state.host.append(container);
    measurementVisual = { container, horizontal, vertical, line };
    return measurementVisual;
  }

  function updateMeasurementVisual(state: ChartState, event: PointerEvent): void {
    const visual = measurementVisual ?? ensureMeasurementVisual(state);
    const rect = state.host.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    visual.horizontal.style.top = `${y}px`;
    visual.vertical.style.left = `${x}px`;
    visual.horizontal.style.display = 'block';
    visual.vertical.style.display = 'block';
    visual.line.setAttribute('x1', String(measurementStartX));
    visual.line.setAttribute('y1', String(measurementStartY));
    visual.line.setAttribute('x2', String(x));
    visual.line.setAttribute('y2', String(y));
    visual.line.style.display = measurementStartPoint ? 'block' : 'none';
  }

  function positionMeasurementCard(event: { clientX: number; clientY: number }): void {
    const overlay = document.getElementById('omega-measurement-overlay');
    if (!overlay) return;
    const parent = overlay.offsetParent instanceof HTMLElement ? overlay.offsetParent : document.body;
    const rect = parent.getBoundingClientRect();
    const width = 200;
    const height = 190;
    const maxLeft = Math.max(8, rect.width - width - 8);
    const maxTop = Math.max(8, rect.height - height - 8);
    overlay.style.left = `${Math.min(maxLeft, Math.max(8, event.clientX - rect.left + 18))}px`;
    overlay.style.top = `${Math.min(maxTop, Math.max(8, event.clientY - rect.top + 18))}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  function updateMeasurementOverlay(
    startPoint: MeasurementAnchor | null,
    endPoint: { time: number; price: number } | null,
    lots: number,
  ): void {
    const overlay = document.getElementById('omega-measurement-overlay');
    if (!overlay || !startPoint || !endPoint) {
      overlay?.style.setProperty('display', 'none');
      return;
    }

    const priceDiff = Math.abs(endPoint.price - startPoint.price);
    const pipSize = inferPipSize(startPoint.symbol) ?? startPoint.minTick;
    const pips = priceDiff / pipSize;
    const selectedLots = Number.isFinite(lots) && lots > 0 ? lots : 0.01;
    const monetaryValue = priceDiff * selectedLots * startPoint.contractSize;

    overlay.innerHTML = `
      <div style="font-weight: 700; margin-bottom: 8px; color: var(--omega-accent);">📏 Measurement (${startPoint.symbol})</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <div>
          <div style="color: var(--omega-muted); font-size: 10px;">Price distance</div>
          <div style="font-weight: 600;">${priceDiff.toFixed(startPoint.minTick < 0.01 ? 5 : 2)}</div>
        </div>
        <div>
          <div style="color: var(--omega-muted); font-size: 10px;">Pips distance</div>
          <div style="font-weight: 600;">${pips.toFixed(1)}</div>
        </div>
        <div>
          <div style="color: var(--omega-muted); font-size: 10px;">Lots</div>
          <div style="font-weight: 600;">${lots.toFixed(2)}</div>
        </div>
        <div>
          <div style="color: var(--omega-muted); font-size: 10px;">Gross P&amp;L</div>
          <div style="font-weight: 600; color: ${monetaryValue >= 0 ? 'var(--omega-success)' : 'var(--omega-error)'};">${monetaryValue >= 0 ? '+' : ''}${monetaryValue.toFixed(2)}</div>
        </div>
      </div>
      <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--omega-border); font-size: 10px; color: var(--omega-muted);">
        Shift+click to set point, Escape to cancel
      </div>
    `;
    // Replace the older compact card with the cTrader-like vertical readout.
    overlay.className = 'omega-ctrader-measure-card';
    overlay.innerHTML = `
      <div class="omega-measure-header">${startPoint.symbol}</div>
      <div class="omega-measure-divider"></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Price</span><strong class="omega-measure-value">${formatPrice(endPoint.price, startPoint.minTick)}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Periods</span><strong class="omega-measure-value">${measurementPeriods}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Pips</span><strong class="omega-measure-value">${pips.toFixed(1)}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Change</span><strong class="omega-measure-value positive">${startPoint.price === 0 ? '0.00' : ((priceDiff / startPoint.price) * 100).toFixed(2)} %</strong></div>
      <div class="omega-measure-divider"></div>
      <div class="omega-measure-sublabel">Quick Trade size</div>
      <div class="omega-measure-row"><span class="omega-measure-label">Volume</span><strong class="omega-measure-value">${formatLots(selectedLots)} lots</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Estimated move value</span><strong class="omega-measure-value positive">${formatPaperTradePnl(monetaryValue, startPoint.currency)}</strong></div>
      <div class="omega-measure-sublabel">Estimate uses Quick Trade volume; fees and currency conversion are excluded.</div>
    `;
    overlay.style.setProperty('display', 'block');
  }

  // Add click listener for measurement
  for (const state of chartStates.values()) {
    const unsubscribeClick = state.chart.renderer.onClick((data) => {
      if (measurementModeActive) return;
      if (!data || !data.time || !data.price) return;

      const lots = parseFloat(lotsInput?.value || '0.01');
      const symbol = state.chart.market.symbol ?? '';
      if (!symbol) return;

      // Check if Shift key is held
      if (!window.event || !(window.event as KeyboardEvent).shiftKey) {
        // If not shift, cancel measurement
        measurementStartPoint = null;
        measurementEnd = null;
        const overlay = document.getElementById('omega-measurement-overlay');
        overlay?.style.setProperty('display', 'none');
        return;
      }

      // Get contract size from metadata
      state.chart.data.symbolInfo(symbol).then((info: Record<string, unknown> | undefined) => {
        const contractSize = getContractSize(symbol, info);
        const minTick = getMinTick(symbol, info);

        if (!measurementStartPoint && data.time !== null && data.price !== null) {
          // Set start point
          measurementStartPoint = {
            time: data.time,
            price: data.price,
            symbol,
            contractSize,
            minTick,
            currency: getQuoteCurrency(symbol, info),
          };
          setStatus('Measurement: First point set. Shift+click to set second point.', '');
        } else if (measurementStartPoint && data.time !== null && data.price !== null) {
          // Set end point and show measurement
          measurementEnd = { time: data.time, price: data.price };
          updateMeasurementOverlay(measurementStartPoint, measurementEnd, lots);
          setStatus('Measurement complete. Shift+click to start new measurement.', 'success');
        }
      });
    });

    const unsubscribeCrosshair = state.chart.renderer.onCrosshairMove((data) => {
      if (measurementModeActive) return;
      if (!measurementStartPoint || !data || data.time === null || data.price === null) return;

      const lots = parseFloat(lotsInput?.value || '0.01');
      measurementEnd = { time: data.time, price: data.price };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, lots);
    });

    state.disposers.push(unsubscribeClick, unsubscribeCrosshair);
  }

  const cancelMeasurement = () => {
    measurementGesture += 1;
    measurementStartPoint = null;
    measurementEnd = null;
    measurementDragging = false;
    measurementPeriods = 1;
    measurementModeActive = false;
    if (measurementChart) measurementChart.host.classList.remove('omega-measure-active');
    measurementVisual?.container.remove();
    measurementVisual = null;
    measurementChart = null;
    measurementLastPointer = null;
    document.getElementById('omega-measurement-overlay')?.style.setProperty('display', 'none');
  };

  const deactivateMeasurementMode = () => {
    measurementGesture += 1;
    measurementModeActive = false;
    measurementDragging = false;
    measurementChart?.host.classList.remove('omega-measure-active');
    measurementVisual?.container.remove();
    measurementVisual = null;
    measurementStartPoint = null;
    measurementEnd = null;
    measurementPeriods = 1;
    measurementChart = null;
    measurementLastPointer = null;
    // The measurement is finished: close the result panel as soon as the
    // mouse button is released.
    document.getElementById('omega-measurement-overlay')?.style.setProperty('display', 'none');
  };

  const attachMeasurementTool = (state: ChartState): void => {
    const priceAtPointer = (event: PointerEvent): number | null => {
      const canvas = state.host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
      const rect = canvas?.getBoundingClientRect();
      const price = rect && canvas?.omegaTradePriceAtY ? canvas.omegaTradePriceAtY(event.clientY - rect.top) : NaN;
      return Number.isFinite(price) && price > 0 ? price : null;
    };
    const stopChartGesture = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMeasurePointerDown = (event: PointerEvent) => {
      if (event.button === 1) {
        if (measurementModeActive) {
          cancelMeasurement();
          stopChartGesture(event);
          writeActivity('Measurement tool deactivated.');
          return;
        }
        measurementModeActive = true;
        measurementChart = state;
        measurementGesture += 1;
        measurementStartPoint = null;
        measurementEnd = null;
        measurementPeriods = 1;
        measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
        document.getElementById('omega-measurement-overlay')?.style.setProperty('display', 'none');
        state.host.classList.add('omega-measure-active');
        ensureMeasurementVisual(state);
        updateMeasurementVisual(state, event);
        stopChartGesture(event);
        writeActivity('Measurement tool activated. Drag with the left mouse button; releasing it completes and exits measurement mode.');
        return;
      }
      if (!measurementModeActive || measurementChart !== state || event.button !== 0) return;
      // Lock chart panning for the whole gesture, even if no price can be read
      // (for example before the first quote) — the tool must not move the chart.
      stopChartGesture(event);
      const price = priceAtPointer(event);
      const symbol = state.chart.market.symbol ?? '';
      if (!price || !symbol) return;
      measurementDragging = true;
      measurementStartY = event.clientY - state.host.getBoundingClientRect().top;
      measurementStartX = event.clientX - state.host.getBoundingClientRect().left;
      measurementPeriods = 1;
      const gesture = ++measurementGesture;
      measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
      measurementStartPoint = {
        time: Date.now(),
        price,
        symbol,
        contractSize: getContractSize(symbol, undefined),
        minTick: getMinTick(symbol, undefined),
        currency: getQuoteCurrency(symbol, undefined),
      };
      measurementEnd = { time: Date.now(), price };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
      positionMeasurementCard(event);
      state.chart.data.symbolInfo(symbol).then((info: Record<string, unknown> | undefined) => {
        if (measurementGesture !== gesture || measurementChart !== state || !measurementStartPoint) return;
        measurementStartPoint = {
          ...measurementStartPoint,
          contractSize: getContractSize(symbol, info),
          minTick: getMinTick(symbol, info),
          currency: getQuoteCurrency(symbol, info),
        };
        updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
        if (measurementLastPointer) positionMeasurementCard(measurementLastPointer);
      }).catch(error => {
        if (measurementGesture === gesture && measurementChart === state) {
          writeActivity(`Could not load symbol details for the measurement: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      const target = event.target;
      try {
        if (target instanceof Element && 'setPointerCapture' in target) (target as Element & { setPointerCapture(pointerId: number): void }).setPointerCapture(event.pointerId);
      } catch {
        // The pointer can already be gone (cancelled gesture or synthetic event).
      }
      stopChartGesture(event);
    };
    const onMeasurePointerMove = (event: PointerEvent) => {
      if (!measurementModeActive || measurementChart !== state) return;
      measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
      updateMeasurementVisual(state, event);
      if (!measurementDragging || !measurementStartPoint) return;
      const price = priceAtPointer(event);
      if (!price) return;
      measurementPeriods = Math.max(1, Math.round(Math.abs((event.clientX - state.host.getBoundingClientRect().left) - measurementStartX) / 8));
      measurementEnd = { time: Date.now(), price };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
      positionMeasurementCard(event);
      stopChartGesture(event);
    };
    const onMeasurePointerUp = (event: PointerEvent) => {
      if (!measurementModeActive || measurementChart !== state) return;
      if (event.type !== 'pointercancel' && event.button !== 0) return;
      if (event.type === 'pointercancel') {
        cancelMeasurement();
        stopChartGesture(event);
        return;
      }
      if (!measurementDragging) return;
      deactivateMeasurementMode();
      writeActivity('Measurement complete. Middle-click again to measure.');
      stopChartGesture(event);
    };
    const onMeasureAuxClick = (event: MouseEvent) => {
      if (event.button === 1) stopChartGesture(event);
    };
    const onMeasureWheel = (event: WheelEvent) => {
      if (measurementModeActive && measurementChart === state) stopChartGesture(event);
    };
    state.host.addEventListener('pointerdown', onMeasurePointerDown, true);
    state.host.addEventListener('pointermove', onMeasurePointerMove, true);
    state.host.addEventListener('pointerup', onMeasurePointerUp, true);
    state.host.addEventListener('pointercancel', onMeasurePointerUp, true);
    state.host.addEventListener('auxclick', onMeasureAuxClick, true);
    state.host.addEventListener('wheel', onMeasureWheel, { capture: true, passive: false });
    state.disposers.push(() => {
      state.host.removeEventListener('pointerdown', onMeasurePointerDown, true);
      state.host.removeEventListener('pointermove', onMeasurePointerMove, true);
      state.host.removeEventListener('pointerup', onMeasurePointerUp, true);
      state.host.removeEventListener('pointercancel', onMeasurePointerUp, true);
      state.host.removeEventListener('auxclick', onMeasureAuxClick, true);
      state.host.removeEventListener('wheel', onMeasureWheel, true);
    });
  };

  for (const state of chartStates.values()) attachMeasurementTool(state);

  const onMeasurementKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && measurementModeActive) cancelMeasurement();
  };
  window.addEventListener('keydown', onMeasurementKeyDown);

  createMeasurementOverlay();

  return () => {
    if (overlayRenderFrame !== null) window.cancelAnimationFrame(overlayRenderFrame);
    overlayRenderFrame = null;
    unsubscribeCells();
    unsubscribeDestroyed();
    document.removeEventListener('omega:ctrader-positions-updated', onBrokerPositionsUpdated);
    window.removeEventListener('keydown', onMeasurementKeyDown);
    cancelMeasurement();
    document.getElementById('omega-measurement-overlay')?.remove();
    for (const state of chartStates.values()) {
      state.disposers.forEach(dispose => dispose());
      state.tradeOverlay.remove();
    }
    chartStates.clear();
    brokerChartPositions.clear();
    restoredCells.clear();
    refreshOpenTradesList = null;
  };
}
