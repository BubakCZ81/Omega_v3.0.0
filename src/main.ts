import { registerLayout, VelaWorkspace } from '@luxalgo/vela/workspace';
import './styles.css';
import './editorDrawer';
import { ensureIndicatorBrowserRegistration, isIndicatorBrowserRegistered } from './indicatorBrowser';
import { appAssetUrl } from './appPaths';
import { registerRendererLayer, registerStatePersistence, type IndicatorHandle } from '@luxalgo/vela';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { initializeCTraderFeed } from './ctraderFeed';
import type { PineModel } from './pineEditorNext';
import { getSavedScripts, saveScriptsToStorage } from './pineStorage';
import { createPineScriptManager } from './pineScriptManager';
import { createPineEditorLifecycle } from './pineEditorLifecycle';
import { initializePineScriptControls } from './pineScriptControls';
import { createPriceBarRatioController, type PriceBarRatioController } from './priceBarRatio';
import {
  BID_ASK_COLOR_OPTIONS,
  BID_ASK_WIDTH_OPTIONS,
  createBidAskLinesController,
  loadBidAskLineStyle,
  type BidAskLineStyle,
} from './bidAskLines';
import { clearStartupIndicators } from './startupWorkspaceState';
import { restoreWorkspaceScriptIndicators, snapshotWorkspaceScriptIndicators } from './workspaceScriptIndicators';
import { initializeChartTimeframeControls } from './chartTimeframeControls';
import { registerOrderFlowChartTypes } from './orderFlowCharts';
import { initializeSpreadReadout } from './spreadReadout';
import { initializeColorPickerDismissal } from './colorPickerDismissal';
import { initializeQuickTradeToggle } from './quickTradeToggle';
import { CHART_GROUP_COLORS, initializeChartGroups } from './chartGroups';
import './favoriteDrawingTools';
import { loadOptionalModule, type OptionalModule, type OptionalModuleId } from './featureModules';
import { createReplayAwareEngine } from './replayStreamingEngine';
import { refreshMarketFlowStyles } from './marketFlowPane';
import { attachFuturesMonthBoundaries } from './futuresMonthBoundaries';
import { formatTradingSessionStatus, getOpenTradingSessions } from './tradingSessions';
import { PersistentCandleProvider } from './persistentCandleCache';
import { initializeWorkspaceProfiles } from './workspaceProfiles';
import type { ChartTabsState } from './chartTabs';
import { createWorkspaceFeatureLoaders } from './workspaceFeatureLoaders';
import { initializePlatformZoom } from './platformZoom';
import { initializePaperTradeDrag } from './paperTradeDrag';
import { applyThemeUi, initializeTheme, isOmegaTheme, velaTheme, type OmegaTheme } from './themeControls';
import { LoadedBarsController } from './loadedBars';
import { initializeTradingAccounts } from './tradingAccounts';
import { initializeChartSettingsActions } from './chartSettingsActions';
import { registerPaperTradeOverlay } from './paperTradeOverlay';
import { initializeChartContextActions } from './chartContextActions';
import { registerChartRendererSettings } from './chartRendererSettings';
import type { ScriptingEngine } from '@luxalgo/vela/plugin';
import { StartupModuleIndex } from './startupModuleIndex';
import { applyTopPanelMode, getTopPanelMode, type TopPanelMode } from './topPanelMode';
// createWindow will be loaded lazily inside openTauriStandaloneEditor

const startupScreen = document.getElementById('omega-startup-screen');
const startupStatus = document.getElementById('omega-startup-status');
const rendererStartupStartedAt = performance.now();

type DiagnosticEntry = {
  time: string;
  source?: string;
  type?: string;
  name?: string;
  target?: string;
  status?: string;
  message?: string;
  durationMs?: number;
};

declare global {
  interface Window {
    velaDiagnostics?: {
      openConsole(): Promise<boolean>;
      getRecent(): Promise<{ entries: DiagnosticEntry[]; file: string }>;
      record(entry: Omit<DiagnosticEntry, 'time'>): void;
      onEntry(callback: (entry: DiagnosticEntry) => void): () => void;
    };
    velaNeural?: {
      saveModel(profile: unknown): Promise<{ file: string }>;
    };
    velaVisualBacktestWindow?: {
      open(config: { symbol: string; timeframe: string; provider?: string }): Promise<boolean>;
      onOpenConfig(callback: (config: { symbol: string; timeframe: string; provider?: string }) => void): () => void;
    };
  }
}

function setStartupStatus(message: string, state?: 'error'): void {
  if (startupStatus) {
    startupStatus.textContent = message;
    if (state) startupStatus.dataset.state = state;
  }
}

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Platform startup failed:', error);
  setStartupStatus(`Omega could not finish starting: ${message}`, 'error');
  const retry = document.getElementById('omega-startup-retry');
  if (retry instanceof HTMLButtonElement) {
    retry.hidden = false;
    retry.addEventListener('click', () => window.location.reload(), { once: true });
  }
}

window.addEventListener('error', event => showStartupFailure(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => showStartupFailure(event.reason));

setStartupStatus('Loading chart tools and market data providers…');

const standalonePineEditor = new URLSearchParams(window.location.search).get('window') === 'pine-editor';
const standaloneEditorModules = standalonePineEditor
  ? Promise.all([import('./pineEditorNext'), import('./pineReferencePanel')])
  : null;


const optionalModuleLoads = Promise.all([
  loadStartupModule('broker', () => import('./brokerPanel')),
  loadStartupModule('mt5-feed', () => import('./mt5Feed')),
  loadStartupModule('alpaca-feed', () => import('./alpacaFeed')),
  loadStartupModule('pine-editor', () => import('./pineAiAssistant')),
  loadStartupModule('price-bar-ratio', () => import('./priceBarRatioMenu')),
  loadStartupModule('backtest', () => import('./backtestPanel')),
  loadStartupModule('news', () => import('./newsPanel')),
  loadStartupModule('update-checker', () => import('./updateChecker')),
]);

function loadStartupModule<T>(id: OptionalModuleId, loader: () => Promise<T>): Promise<OptionalModule<T>> {
  if (standalonePineEditor && id !== 'pine-editor' && id !== 'pinets') {
    return Promise.resolve({ enabled: false });
  }
  return loadOptionalModule(id, loader);
}

// PineTS is large. The chart starts candle-only and the runtime is attached just
// after first interactive paint (or on the first validation request).
setStartupStatus('Restoring your charts and workspace settings…');

// ---------------------------------------------------------------------------
// 1. Script Storage
// ---------------------------------------------------------------------------
let scripts = getSavedScripts();
const requestedPineScript = new URLSearchParams(window.location.search).get('script');
let currentScriptName = requestedPineScript && scripts[requestedPineScript]
  ? requestedPineScript
  : Object.keys(scripts)[0] || 'Dual EMA Cross';
const savedTheme = localStorage.getItem('vela_theme');
let currentTheme: OmegaTheme = isOmegaTheme(savedTheme) ? savedTheme : 'dark';
let topPanelMode: TopPanelMode = getTopPanelMode();
applyTopPanelMode(topPanelMode);
let workspace: VelaWorkspace;
let loadedBarsController: LoadedBarsController;
let workspaceInitialized = false;
type PaperTradingModule = typeof import('./chartPaperTrading');
let paperTradingModule: PaperTradingModule | null = null;
let paperTradingInitialization: Promise<PaperTradingModule> | null = null;
let barThickness = Math.max(0.15, Math.min(1, Number(localStorage.getItem('vela_bar_thickness') ?? 1)));

function ensurePaperTrading(): Promise<PaperTradingModule> {
  if (paperTradingModule) return Promise.resolve(paperTradingModule);
  if (!paperTradingInitialization) {
    paperTradingInitialization = import('./rightTradingPanel')
      .then(({ initializeRightTradingPanel }) => initializeRightTradingPanel(workspace))
      .then(module => {
        paperTradingModule = module;
        return module;
      })
      .catch(error => {
        paperTradingInitialization = null;
        throw error;
      });
  }
  return paperTradingInitialization;
}

async function loadIndicatorManifest() {
  try {
    const response = await fetch(appAssetUrl('/indicators/catalog.json'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const message = `Indicator catalog failed to load: ${error instanceof Error ? error.message : String(error)}`;
    const status = document.getElementById('editor-status');
    if (status) {
      status.textContent = message;
      status.dataset.state = 'error';
    }
    console.error(message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Vela Workspace
// ---------------------------------------------------------------------------
let replayActive = false;
// PineEngine is used deliberately here. It executes the same PineTS runtime as
// the worker but avoids Electron's Blob-worker parser path, which can reject
// valid Pine v6 source with a JavaScript "Unterminated regular expression" error.
let pineEngine: ScriptingEngine | null = null;
let pineRuntimeLoading: Promise<void> | null = null;
function ensurePineRuntime(): Promise<void> {
  if (pineEngine) return Promise.resolve();
  if (!pineRuntimeLoading) {
    pineRuntimeLoading = loadStartupModule('pinets', () => import('@luxalgo/vela-pinets')).then(module => {
      const PineEngine = module.value?.PineEngine;
      if (!PineEngine) throw new Error('PineTS is disabled or unavailable.');
      pineEngine = createReplayAwareEngine(new PineEngine(), () => replayActive);
      for (const cell of workspace.cells()) cell.chart.registerEngine('pine', pineEngine!);
      window.velaDiagnostics?.record({ source: 'startup', type: 'performance', name: 'pine-runtime-ready', status: 'ok' });
    }).catch(error => { pineRuntimeLoading = null; console.error('Pine runtime could not be loaded:', error); throw error; });
  }
  return pineRuntimeLoading;
}
const scriptHandles = new Map<string, Map<string, IndicatorHandle>>();
const chartGroupColors = ['red', 'blue', 'green', 'yellow', 'purple'] as const;
const groupByCellId: Record<string, string> = {};
const OMEGA_TABS_LAYOUT_PREFIX = 'omega-tabs-';
const OMEGA_TABS_MAX = 8;
const storedChartTabCount = Number(localStorage.getItem('omega_chart_tabs_count'));
const chartTabsState: ChartTabsState = {
  enabled: localStorage.getItem('omega_chart_tabs_enabled') === 'true',
  count: Number.isInteger(storedChartTabCount) ? Math.max(1, Math.min(OMEGA_TABS_MAX, storedChartTabCount)) : 1,
  previousLayout: localStorage.getItem('omega_chart_tabs_previous_layout') || '1',
};
const chartTabsLayoutId = (count: number) => `${OMEGA_TABS_LAYOUT_PREFIX}${count}`;
const isChartTabsLayout = (layoutId: string) => /^omega-tabs-[1-8]$/.test(layoutId);
if (isChartTabsLayout(chartTabsState.previousLayout)) chartTabsState.previousLayout = '1';

// Each tab count has its own overlapping layout. Reducing the count therefore makes
// Vela destroy the removed cells instead of merely hiding live chart instances.
for (let count = 1; count <= OMEGA_TABS_MAX; count += 1) {
  registerLayout({
    id: chartTabsLayoutId(count),
    label: 'Chart tabs',
    cols: [1],
    rows: [1],
    areas: ['main'],
    cells: Array.from({ length: count }, (_, index) => ({ id: `tab-${index + 1}`, area: 'main' })),
  });
}
const priceBarRatioControllers = new Set<PriceBarRatioController>();
const bidAskLinesControllers = new Map<string, ReturnType<typeof createBidAskLinesController>>();
const futuresMonthBoundaryDisposers = new Map<string, () => void>();
let lockPriceToBarRatio = localStorage.getItem('vela_lock_price_to_bar_ratio') === 'true';
let showBidAskLines = localStorage.getItem('vela_show_bid_ask_lines') === 'true';
let bidAskLineStyle = loadBidAskLineStyle();
let propagatingGroupState = false;

interface WorkspaceFileBridge {
  load(): Promise<string | null>;
  save(state: string): Promise<void>;
  saveProfile(name: string, state: string): Promise<{ canceled: boolean; path?: string }>;
  loadProfile(): Promise<{ canceled: boolean; state?: string; path?: string }>;
}

interface ProfileBridge extends WorkspaceFileBridge {}

interface PineExportBridge {
  save(name: string, source: string): Promise<{ canceled: boolean; path?: string }>;
}

declare global {
  interface Window {
    velaWorkspaceFiles?: ProfileBridge;
    velaPineExport?: PineExportBridge;
    velaApp?: {
      ready(): void;
    };
  }
}

initializePlatformZoom();

function getWorkspaceStorage() {
  if (window.velaWorkspaceFiles) {
    return {
      get: (key: string) => key === 'vela-workspace' ? clearStartupIndicators(savedWorkspaceRaw) : null,
      set: (key: string, value: string) => key === 'vela-workspace' ? window.velaWorkspaceFiles!.save(value) : undefined,
    };
  }
  return {
    get: (key: string) => Promise.resolve(key === 'vela-workspace'
      ? clearStartupIndicators(localStorage.getItem(key))
      : localStorage.getItem(key)),
    set: (key: string, value: string) => localStorage.setItem(key, value),
  };
}

const barThicknessStorageKey = 'vela_bar_thickness';

registerStatePersistence({
  key: 'vela.chartPreferences',
  scope: 'global',
  serialize: () => ({ barThickness }),
  restore: payload => {
    if (payload && typeof payload === 'object' && 'barThickness' in payload) {
      const value = Number((payload as { barThickness: unknown }).barThickness);
      if (Number.isFinite(value)) setBarThickness(value, false);
    }
  },
});

registerStatePersistence({
  key: 'vela.chartGroup',
  scope: 'cell',
  serialize: ctx => ({ color: groupByCellId[ctx.cellId] ?? '' }),
  restore: (payload, ctx) => {
    const color = payload && typeof payload === 'object' && 'color' in payload
      ? String((payload as { color: unknown }).color)
      : '';
    if (chartGroupColors.includes(color as typeof chartGroupColors[number])) groupByCellId[ctx.cellId] = color;
  },
});

registerStatePersistence({
  key: 'omega.scriptIndicators',
  scope: 'cell',
  serialize: ctx => snapshotWorkspaceScriptIndicators(ctx.chart.indicators()),
  restore: (payload, ctx) => restoreWorkspaceScriptIndicators(payload, ctx),
});

registerStatePersistence({
  key: 'omega.chartPreferences',
  scope: 'global',
  serialize: () => ({
    theme: currentTheme,
    barThickness,
    lockPriceToBarRatio,
    showBidAskLines,
    bidAskLineStyle,
    chartTabsEnabled: chartTabsState.enabled,
    chartTabCount: chartTabsState.count,
    chartTabsPreviousLayout: chartTabsState.previousLayout,
  }),
  restore: payload => {
    if (!payload || typeof payload !== 'object') return;
    const preferences = payload as Record<string, unknown>;
    if (isOmegaTheme(preferences.theme)) {
      currentTheme = preferences.theme;
      localStorage.setItem('vela_theme', currentTheme);
      if (workspaceInitialized) {
        workspace.setTheme(velaTheme(currentTheme));
        pineEditorLifecycle.setTheme(currentTheme === 'light' || currentTheme === 'high-contrast' ? 'light' : 'dark');
        applyThemeUi(currentTheme);
      }
    }
    if (typeof preferences.barThickness === 'number' && Number.isFinite(preferences.barThickness)) {
      setBarThickness(preferences.barThickness, false);
    }
    if (typeof preferences.lockPriceToBarRatio === 'boolean') {
      lockPriceToBarRatio = preferences.lockPriceToBarRatio;
      localStorage.setItem('vela_lock_price_to_bar_ratio', String(lockPriceToBarRatio));
      for (const controller of priceBarRatioControllers) controller.setEnabled(lockPriceToBarRatio);
    }
    if (typeof preferences.showBidAskLines === 'boolean') {
      showBidAskLines = preferences.showBidAskLines;
      localStorage.setItem('vela_show_bid_ask_lines', String(showBidAskLines));
    }
    if (typeof preferences.chartTabsEnabled === 'boolean') chartTabsState.enabled = preferences.chartTabsEnabled;
    if (typeof preferences.chartTabCount === 'number' && Number.isInteger(preferences.chartTabCount)) {
      chartTabsState.count = Math.max(1, Math.min(OMEGA_TABS_MAX, preferences.chartTabCount));
    }
    if (typeof preferences.chartTabsPreviousLayout === 'string' && !isChartTabsLayout(preferences.chartTabsPreviousLayout)) {
      chartTabsState.previousLayout = preferences.chartTabsPreviousLayout;
    }
    if (preferences.bidAskLineStyle && typeof preferences.bidAskLineStyle === 'object') {
      const style = preferences.bidAskLineStyle as Partial<BidAskLineStyle>;
      const supportedColors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
      const supportedWidths = BID_ASK_WIDTH_OPTIONS as readonly number[];
      if (typeof style.bidColor === 'string' && supportedColors.includes(style.bidColor as typeof supportedColors[number])) {
        bidAskLineStyle.bidColor = style.bidColor;
      }
      if (typeof style.askColor === 'string' && supportedColors.includes(style.askColor as typeof supportedColors[number])) {
        bidAskLineStyle.askColor = style.askColor;
      }
      if (typeof style.lineWidth === 'number' && supportedWidths.includes(style.lineWidth)) {
        bidAskLineStyle.lineWidth = style.lineWidth;
      }
      if (style.lineStyle === 'solid' || style.lineStyle === 'dashed' || style.lineStyle === 'dotted') {
        bidAskLineStyle.lineStyle = style.lineStyle;
      }
      localStorage.setItem('vela_bid_ask_bid_color', bidAskLineStyle.bidColor);
      localStorage.setItem('vela_bid_ask_ask_color', bidAskLineStyle.askColor);
      localStorage.setItem('vela_bid_ask_line_width', String(bidAskLineStyle.lineWidth));
      localStorage.setItem('vela_bid_ask_line_style', bidAskLineStyle.lineStyle);
    }
    for (const controller of bidAskLinesControllers.values()) {
      controller.setEnabled(showBidAskLines);
      controller.setStyle(bidAskLineStyle);
    }
  },
});

registerRendererLayer({
  id: 'vela-bar-thickness',
  placement: 'below-data',
  create: () => ({
    mount: () => undefined,
    render: () => undefined,
    modulateBase: () => ({ candleBodyScale: barThickness }),
  }),
});

function setBarThickness(value: number, notifyWorkspace = true) {
  barThickness = Math.max(0.15, Math.min(1, value));
  localStorage.setItem(barThicknessStorageKey, String(barThickness));
  if (workspaceInitialized) {
    for (const cell of workspace.cells()) {
      const config = cell.chart.renderer.getConfig() as { layout?: { fontSize?: number } } | null;
      if (config?.layout) cell.chart.renderer.applyConfig({ layout: { fontSize: config.layout.fontSize } });
    }
    if (notifyWorkspace) workspace.context().stateChanged();
  }
}

const chartRendererSettingsOptions = {
  getWorkspace: () => workspace,
  chartTabsState,
  groupByCellId,
  isChartTabsLayout,
  setChartTabsEnabled: (enabled: boolean) => setChartTabsEnabled(enabled),
  setCellGroup: (cellId: string, group: string) => setCellGroup(cellId, group),
  getTheme: () => currentTheme,
  setTheme,
  getTopPanelMode: () => topPanelMode,
  setTopPanelMode: (mode: TopPanelMode) => {
    topPanelMode = mode;
    applyTopPanelMode(mode);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  getBarThickness: () => barThickness,
  setBarThickness: (value: number) => setBarThickness(value),
  getLockPriceToBarRatio: () => lockPriceToBarRatio,
  setLockPriceToBarRatio: (enabled: boolean) => {
    lockPriceToBarRatio = enabled;
    localStorage.setItem('vela_lock_price_to_bar_ratio', String(enabled));
    for (const controller of priceBarRatioControllers) controller.setEnabled(enabled);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  getShowBidAskLines: () => showBidAskLines,
  setShowBidAskLines: (enabled: boolean) => {
    showBidAskLines = enabled;
    for (const controller of bidAskLinesControllers.values()) controller.setEnabled(enabled);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  getBidAskLineStyle: () => bidAskLineStyle,
  setBidAskLineStyle: (next: Partial<BidAskLineStyle>) => {
    bidAskLineStyle = { ...bidAskLineStyle, ...next };
    for (const controller of bidAskLinesControllers.values()) controller.setStyle(bidAskLineStyle);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  setLoadedBars: (cellId: string, bars: number) => loadedBarsController.set(cellId, 0, bars),
};

function configureChartRenderer(chart: VelaWorkspace['chart'], cellId: string) {
  if (pineEngine) chart.registerEngine('pine', pineEngine);
  chart.renderer.set('zoomAnchor', 'cursor');
  const priceBarRatio = createPriceBarRatioController(chart.renderer);
  priceBarRatioControllers.add(priceBarRatio);
  const syncPriceBarRatio = () => {
    const style = chart.renderer.get('priceStyle');
    const compatible = style !== 'renko' && style !== 'range';
    priceBarRatio.setEnabled(lockPriceToBarRatio && compatible);
    if (!compatible && lockPriceToBarRatio) {
      window.velaDiagnostics?.record({
        source: 'chart-style', type: 'compatibility', name: 'price-bar-ratio', status: 'ok',
        message: `Price-to-bar ratio is suspended for ${style}; it resumes for time-based candles.`,
      });
    }
  };
  syncPriceBarRatio();
  chart.on('priceStyle:change', syncPriceBarRatio);
  const bidAskLines = createBidAskLinesController(chart);
  bidAskLinesControllers.set(cellId, bidAskLines);
  futuresMonthBoundaryDisposers.get(cellId)?.();
  futuresMonthBoundaryDisposers.set(cellId, attachFuturesMonthBoundaries(chart));
  registerChartRendererSettings(chart, chartRendererSettingsOptions);
}

const workspaceStorage = getWorkspaceStorage();
registerOrderFlowChartTypes();
let savedWorkspaceRaw: string | null = null;
let restoredWorkspaceState: any = null;
try {
  savedWorkspaceRaw = window.velaWorkspaceFiles
    ? await window.velaWorkspaceFiles.load()
    : localStorage.getItem('vela-workspace');
  if (savedWorkspaceRaw) {
    const parsed = JSON.parse(savedWorkspaceRaw);
    restoredWorkspaceState = parsed && parsed.version === 1 && Array.isArray(parsed.charts) ? parsed : null;
  }
} catch (error) {
  console.error('Could not load saved chart workspace:', error);
}

const restoredLayout = restoredWorkspaceState?.layout;
const initialWorkspaceLayout = chartTabsState.enabled
  ? '1'
  : (restoredLayout && !isChartTabsLayout(restoredLayout) ? restoredLayout : '1');
const chartGridHost = document.createElement('div');
chartGridHost.id = 'chart-grid';
Object.assign(chartGridHost.style, { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' });
document.getElementById('chart')!.append(chartGridHost);

setStartupStatus('Building your trading workspace…');
// Vela snapshots its renderer-layer list when a chart mounts. Register the
// paper-trade overlay first so the measurement tool always has its canvas.
registerPaperTradeOverlay();
try {
  workspace = new VelaWorkspace(chartGridHost, {
    layout: initialWorkspaceLayout, symbol: 'BTCUSDT', timeframe: '60', live: true, volume: false, theme: velaTheme(currentTheme), persist: 'vela-workspace', storage: workspaceStorage,
    cells: restoredWorkspaceState?.charts?.length ? Object.fromEntries(restoredWorkspaceState.charts.map((chart: { id: string; symbol?: string; timeframe?: string }) => [chart.id, { symbol: chart.symbol, timeframe: chart.timeframe }])) : (window.velaWorkspaceFiles ? { primary: { symbol: 'BTCUSDT', timeframe: '60' } } : undefined),
    sync: restoredWorkspaceState?.sync,
    topbar: { left: ['symbol', 'indicators', 'omega-favorite-drawing-tools'] },
    providers: {
      binance: () => new PersistentCandleProvider(new BinanceProvider()),
    },
    engines: {},
    indicators: loadIndicatorManifest,
  });
  console.log('Vela Workspace loaded.');
} catch (err) {
  console.error('Workspace init error:', err);
  showStartupFailure(err);
  throw err;
}
loadedBarsController = new LoadedBarsController(workspace);
const [
  brokerModule,
  mt5FeedModule,
  alpacaSdkFeedModule,
  pineEditorModule,
  priceBarRatioModule,
  // Backtest and news are loaded for their side effects (panel registration);
  // their module values are not needed here.
  ,
  ,
  updateCheckerModule,
] = await optionalModuleLoads;

function hideFeatureElements(enabled: boolean, ...ids: string[]) {
  if (enabled) return;
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  }
}

hideFeatureElements(brokerModule.enabled, 'broker-toggle', 'broker-modal');
hideFeatureElements(mt5FeedModule.enabled, 'mt5-feed-toggle', 'mt5-feed-modal');
hideFeatureElements(mt5FeedModule.enabled, 'local-feeds-toggle', 'local-feeds-modal');
hideFeatureElements(pineEditorModule.enabled, 'editor-toggle-btn', 'editor-drawer', 'resize-handle');
initializeTradingAccounts();
if (updateCheckerModule.enabled && updateCheckerModule.value) {
  updateCheckerModule.value.initializeUpdateChecker();
}

workspaceInitialized = true;
workspace.setTheme(velaTheme(currentTheme));

mt5FeedModule.value?.initializeMt5Feed(() => workspace);
alpacaSdkFeedModule.value?.initializeAlpacaSdkFeed(() => workspace);
initializeCTraderFeed(() => workspace);

function waitForAlpacaProvider(): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      document.removeEventListener('omega:alpaca-provider-ready', ready);
      resolve(false);
    }, 4_000);
    const ready = () => {
      window.clearTimeout(timeout);
      document.removeEventListener('omega:alpaca-provider-ready', ready);
      resolve(true);
    };
    document.addEventListener('omega:alpaca-provider-ready', ready, { once: true });
  });
}

async function autoConnectPreferredDataFeed(): Promise<void> {
  const providerReady = waitForAlpacaProvider();
  const alpacaConnected = await brokerModule.value?.autoConnectSavedAlpaca?.() ?? false;
  if (!alpacaConnected) {
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'binance-fallback', status: 'ok',
      message: 'No usable saved Alpaca account; using Binance BTCUSDT.',
    });
    return;
  }
  if (!await providerReady) {
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'alpaca-provider', status: 'error',
      message: 'Alpaca connected but its chart provider did not become ready in time.',
    });
    return;
  }
  const chart = workspace.active?.chart;
  if (chart?.market.symbol?.toUpperCase() === 'BTCUSDT') {
    await chart.setMarket({ symbol: 'alpaca:AAPL', timeframe: chart.market.timeframe ?? '60' });
  }
  window.velaDiagnostics?.record({
    source: 'broker-autoconnect', type: 'connection', name: 'alpaca', status: 'ok',
    message: 'Saved Alpaca account connected read-only.',
  });
}

priceBarRatioModule.value?.initializePriceBarRatioMenu(
  () => lockPriceToBarRatio,
  enabled => {
    lockPriceToBarRatio = enabled;
    localStorage.setItem('vela_lock_price_to_bar_ratio', String(enabled));
    for (const controller of priceBarRatioControllers) controller.setEnabled(enabled);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
);
initializeSpreadReadout(() => workspace.chart);
initializeColorPickerDismissal();
initializeQuickTradeToggle();

for (const cell of workspace.cells()) configureChartRenderer(cell.chart, cell.id);
workspace.on('cell:created', event => {
  const chart = workspace.cell(event.id)?.chart;
  if (chart) configureChartRenderer(chart, event.id);
});
workspace.on('cell:destroyed', event => {
  const controller = bidAskLinesControllers.get(event.id);
  controller?.destroy();
  bidAskLinesControllers.delete(event.id);
  futuresMonthBoundaryDisposers.get(event.id)?.();
  futuresMonthBoundaryDisposers.delete(event.id);
  for (const [scriptName, handles] of scriptHandles) {
    handles.delete(event.id);
    if (handles.size === 0) scriptHandles.delete(scriptName);
  }
});

// ---------------------------------------------------------------------------
// 3. Pine Editor
// ---------------------------------------------------------------------------
const editorHost = document.getElementById('code-editor') as HTMLDivElement;
const editorStatus = document.getElementById('editor-status') as HTMLSpanElement;
const editorModels = new Map<string, PineModel>();
let pineScriptManager: ReturnType<typeof createPineScriptManager>;
const pineEditorLifecycle = createPineEditorLifecycle({
  editorHost,
  editorStatus,
  editorModels,
  scriptSelect: document.getElementById('script-select') as HTMLSelectElement,
  getScripts: () => scripts,
  getCurrentScriptName: () => currentScriptName,
  getTheme: () => currentTheme === 'dark' ? 'dark' : 'light',
  isEnabled: () => pineEditorModule.enabled && Boolean(pineEditorModule.value),
  standalone: standalonePineEditor,
  standaloneModules: standaloneEditorModules,
  saveScripts: saveScriptsToStorage,
  validateSource: validatePineSource,
  displayDiagnostics: (error, code, name) => pineScriptManager.displayDiagnosticsInConsole(error, code, name),
});
const setEditorStatus = pineEditorLifecycle.setStatus;
const loadScriptIntoEditor = pineEditorLifecycle.loadScript;
const refreshDropdown = pineEditorLifecycle.refreshDropdown;

pineScriptManager = createPineScriptManager({
  getWorkspace: () => workspace,
  getScripts: () => scripts,
  scriptHandles,
  groupByCellId,
  editorModels,
  getPineDiagnostics: pineEditorLifecycle.getDiagnostics,
  getPineCompileDiagnostics: pineEditorLifecycle.getCompileDiagnostics,
  setEditorStatus,
  isPropagating: () => propagatingGroupState,
  setPropagating: value => { propagatingGroupState = value; },
});
const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;
pineEditorLifecycle.attach();
refreshDropdown();
loadScriptIntoEditor(currentScriptName);

pineEditorModule.value?.createPineAiAssistant({
  getCurrentScriptName: () => currentScriptName,
  getEditorValue: pineEditorLifecycle.getValue,
});

async function validatePineSource(code: string): Promise<Error | null> {
  try {
    await ensurePineRuntime();
    const { PineTS } = await import('pinets');
    const validationBars = Array.from({ length: 120 }, (_, index) => {
      const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
      return {
        open: close + Math.sin(index) * 0.3,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100 + index % 17,
        openTime: 1_700_000_000_000 + index * 60_000,
      };
    });
    await new PineTS(validationBars).run(code);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
}

const pineScriptControls = initializePineScriptControls({
  workspace,
  scripts,
  getCurrentScriptName: () => currentScriptName,
  setCurrentScriptName: name => { currentScriptName = name; },
  editorModels,
  scriptHandles,
  groupByCellId,
  scriptSelect,
  editorLifecycle: pineEditorLifecycle,
  scriptManager: pineScriptManager,
  standalone: standalonePineEditor,
  pineEditorEnabled: pineEditorModule.enabled && Boolean(pineEditorModule.value),
  isPineTsEnabled: () => Boolean(pineEngine),
  saveScripts: saveScriptsToStorage,
  validateSource: validatePineSource,
});
export const openScriptInEditor = pineScriptControls.openScriptInEditor;
(window as any).openScriptInEditor = openScriptInEditor;

// ---------------------------------------------------------------------------
const { sync: syncChartControls } = initializeChartTimeframeControls(workspace);

const marketChangeListeners = new Map<string, () => void>();
function watchCellMarketChanges(cellId: string) {
  if (marketChangeListeners.has(cellId)) return;
  const cell = workspace.cell(cellId);
  if (!cell) return;
  marketChangeListeners.set(cellId, cell.chart.on('market:changed', () => {
    if (workspace.active.id === cellId) syncChartControls();
    renderChartTabs();
  }));
}
for (const cell of workspace.cells()) {
  watchCellMarketChanges(cell.id);
  loadedBarsController.watch(cell.id);
}
workspace.on('cell:created', event => {
  watchCellMarketChanges(event.id);
  loadedBarsController.watch(event.id);
});
workspace.on('cell:destroyed', event => {
  marketChangeListeners.get(event.id)?.();
  marketChangeListeners.delete(event.id);
  loadedBarsController.unwatch(event.id);
});
workspace.on('cell:active', () => {
  syncChartControls();
  loadedBarsController.render();
});
loadedBarsController.render();
syncChartControls();

const chartLayoutSelect = document.getElementById('chart-layout-select') as HTMLSelectElement;
chartLayoutSelect.value = workspace.layout.id;

const workspaceFeatureLoaders = createWorkspaceFeatureLoaders({
  workspace,
  tabsState: chartTabsState,
  maxTabs: OMEGA_TABS_MAX,
  layoutId: chartTabsLayoutId,
  isTabsLayout: isChartTabsLayout,
  groupByCellId,
  groupColorHex: CHART_GROUP_COLORS,
  chartGridHost,
  chartLayoutSelect,
  onReplayActiveChange: active => { replayActive = active; },
});
const {
  ensureChartTabs,
  renderChartTabs,
  setChartTabsEnabled,
  ensureReplayControls,
  openReplayControls,
  startReplayAt,
  openVisualBacktest,
} = workspaceFeatureLoaders;

const chartGroups = initializeChartGroups({
  workspace,
  chartGridHost,
  groupByCellId,
  getInitialGroup: cellId => {
    const chartState = restoredWorkspaceState?.charts?.find((entry: { id: string }) => entry.id === cellId);
    const savedGroup = chartState?.ext?.['vela.chartGroup'];
    return savedGroup && typeof savedGroup === 'object' && 'color' in savedGroup
      ? String(savedGroup.color)
      : '';
  },
  renderChartTabs: () => workspaceFeatureLoaders.renderChartTabs(),
  isPropagating: () => propagatingGroupState,
  setPropagating: value => { propagatingGroupState = value; },
});
const { setCellGroup } = chartGroups;


initializePaperTradeDrag();

function applyWorkspaceState(state: unknown) {
  workspace.applyState(state);
  syncChartControls();
  chartLayoutSelect.value = workspace.layout.id;
}

initializeWorkspaceProfiles(workspace, applyWorkspaceState);

workspace.on('state:changed', () => {
  const state = workspace.getState();
  chartLayoutSelect.value = workspace.layout.id;
  void state;
});

function setTheme(theme: OmegaTheme) {
  const changed = theme !== currentTheme;
  currentTheme = theme;
  localStorage.setItem('vela_theme', currentTheme);
  applyThemeUi(currentTheme);
  refreshMarketFlowStyles();
  try {
    workspace.setTheme(velaTheme(currentTheme));
  } catch (error) {
    console.error('Could not apply the selected theme to the chart workspace:', error);
  }
  try {
    pineEditorLifecycle.setTheme(currentTheme === 'light' || currentTheme === 'high-contrast' ? 'light' : 'dark');
  } catch (error) {
    console.error('Could not apply the selected theme to the Pine editor:', error);
  }
  if (changed) workspace.context().stateChanged();
}

initializeTheme(() => currentTheme);

const { openChartSettings } = initializeChartSettingsActions({
  workspace,
  openReplayControls,
  getTheme: () => currentTheme,
  setTheme,
  updatesEnabled: updateCheckerModule.enabled,
});

initializeChartContextActions({
  workspace,
  ensurePaperTrading,
  hasPendingPaperOrderAtPrice: (chart, price) => Boolean(paperTradingModule?.hasPendingPaperOrderAtPrice(chart, price)),
  getBidAskLinesVisible: () => showBidAskLines,
  setBidAskLinesVisible: visible => {
    showBidAskLines = visible;
    localStorage.setItem('vela_show_bid_ask_lines', String(visible));
    for (const controller of bidAskLinesControllers.values()) controller.setEnabled(visible);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  getTheme: () => currentTheme,
  setTheme,
  openReplayControls,
  startReplayAt,
});

const bottomClock = document.getElementById('bottom-clock');
if (bottomClock) {
  const updateClock = () => {
    const now = new Date();
    bottomClock.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  updateClock();
  setInterval(updateClock, 1000);
}

const tradingSessionStatus = document.getElementById('trading-session-status');
const tradingSessionLabel = document.getElementById('trading-session-label');
if (tradingSessionStatus && tradingSessionLabel) {
  const updateTradingSessions = () => {
    const sessions = getOpenTradingSessions(new Date());
    tradingSessionLabel.textContent = formatTradingSessionStatus(sessions);
    tradingSessionStatus.dataset.open = String(sessions.length > 0);
  };
  updateTradingSessions();
  setInterval(updateTradingSessions, 60_000);
}

const { initializeTopPanel } = await import('./topPanel');
const { initializeBottomPanel } = await import('./bottomPanel');
initializeBottomPanel({
  mt5Enabled: mt5FeedModule.enabled,
  onPaperTradingAction: async action => {
    await ensurePaperTrading();
    document.dispatchEvent(new CustomEvent(`omega:paper-trading:${action}`));
  },
});
initializeTopPanel(workspace, {
  onGroupChange: group => {
    if (workspace.active) void chartGroups.setCellGroup(workspace.active.id, group);
  },
  onChartTabsToggle: () => {
    void ensureChartTabs().then(controller => controller.toggle()).catch(error => {
      console.error('Could not initialize chart tabs:', error);
      workspace.toast('Chart tabs could not be loaded.', 'error');
    });
  },
  onChartTabsAdd: () => {
    void ensureChartTabs().then(controller => controller.addTab()).catch(error => {
      console.error('Could not initialize chart tabs:', error);
      workspace.toast('Chart tabs could not be loaded.', 'error');
    });
  },
  onReplayMenuOpen: () => {
    void ensureReplayControls().catch(error => {
      console.error('Could not initialize Replay:', error);
      workspace.toast('Replay could not be loaded.', 'error');
    });
  },
  onVisualBacktest: () => {
    void openVisualBacktest().catch(() => undefined);
  },
  onNeuralNetwork: () => {
    void loadOptionalModule('neural-network', () => import('./neuralNetwork/neuralNetworkLab'))
      .then(result => result.value?.openNeuralNetworkLab(workspace))
      .catch(error => {
        console.error('Could not open Neural Network Lab:', error);
        workspace.toast('Neural Network Lab could not be loaded.', 'error');
      });
  },
  onSettings: openChartSettings,
});

// Electron keeps the main window hidden until all core UI wiring and the first
// workspace chart are ready, so users never see controls assembling in stages.
setStartupStatus('Loading charts and finalizing your workspace…');
let startupTimeout: number | undefined;
const startupChart = workspace.active?.chart;
const startupReady = startupChart
  ? startupChart.ready().then(() => true).catch(error => {
      console.error('Chart startup readiness failed:', error);
      return false;
  })
  : Promise.resolve(false);
const fullStartupTimeout = new Promise<false>(resolve => {
  // Market data may take longer, but it must never block the usable platform.
  startupTimeout = window.setTimeout(() => resolve(false), 900);
});
const chartsReady = await Promise.race([startupReady, fullStartupTimeout]);
window.clearTimeout(startupTimeout);
if (!chartsReady) {
  setStartupStatus('Market data is still connecting. The platform will continue loading it in the background.');
  console.warn('The startup screen is closing while chart data continues to load.');
} else {
  setStartupStatus('Workspace ready');
}
if (chartTabsState.enabled) {
  const controller = await ensureChartTabs();
  controller.setEnabled(true);
}
await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
startupScreen?.setAttribute('data-state', 'leaving');
window.setTimeout(() => startupScreen?.remove(), 300);
window.velaApp?.ready();
const rendererStartupDuration = Math.round(performance.now() - rendererStartupStartedAt);
window.velaDiagnostics?.record({
  source: 'startup', type: 'performance', name: 'first-interactive', status: 'ok', durationMs: rendererStartupDuration,
  message: chartsReady ? 'Chart ready' : 'Chart continues loading in background',
});
console.info(`Omega first interactive UI: ${rendererStartupDuration}ms`);
void ensurePineRuntime().catch(() => undefined);
window.setTimeout(() => {
  void autoConnectPreferredDataFeed().catch(error => {
    console.error('Could not auto-connect the preferred market-data feed:', error);
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'startup', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}, 0);

// The cTrader-style meter is a chart interaction, not a Trade-panel feature.
// Load it only after the first usable frame so middle-click works even before
// the trader opens the panel, without delaying platform startup.
window.setTimeout(() => {
  window.velaDiagnostics?.record({
    source: 'measurement', type: 'lifecycle', name: 'load', status: 'start',
    message: 'Preparing middle-click measurement tool.',
  });
  void ensurePaperTrading().then(() => {
    window.velaDiagnostics?.record({
      source: 'measurement', type: 'lifecycle', name: 'ready', status: 'ok',
      message: 'Middle-click measurement tool is ready.',
    });
  }).catch(error => {
    console.error('Could not initialize middle-click measurement tool:', error);
    window.velaDiagnostics?.record({
      source: 'measurement', type: 'lifecycle', name: 'ready', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}, 0);

const startupModuleIndex = new StartupModuleIndex(entry => window.velaDiagnostics?.record(entry));
startupModuleIndex.register({
  id: 'chart-workspace',
  label: 'Chart workspace',
  isReady: () => Boolean(workspace.active?.chart && workspace.active.host.isConnected),
});
startupModuleIndex.register({
  id: 'indicator-browser',
  label: 'Indicators panel',
  isReady: () => isIndicatorBrowserRegistered(),
  recover: () => ensureIndicatorBrowserRegistration(),
});
startupModuleIndex.register({
  id: 'chart-timeframe-controls',
  label: 'Timeframe and chart-style controls',
  isReady: () => Boolean(document.getElementById('chart-type-select') && document.getElementById('ctrader-timeframe-menu')),
});
startupModuleIndex.register({
  id: 'theme-controls',
  label: 'Theme controls',
  isReady: () => document.body.dataset.theme === currentTheme,
  recover: () => setTheme(currentTheme),
});
startupModuleIndex.register({
  id: 'middle-click-measurement',
  label: 'Middle-click measurement',
  isReady: () => paperTradingModule !== null,
  recover: async () => { await ensurePaperTrading(); },
});
startupModuleIndex.register({
  id: 'pine-runtime',
  label: 'Pine runtime',
  isReady: () => pineEngine !== null,
  recover: async () => { await ensurePineRuntime(); },
});

// Let deferred modules settle first, then perform one bounded health pass.
window.setTimeout(() => {
  void startupModuleIndex.verifyAndRecover().then(result => {
    const unhealthy = Object.entries(result).filter(([, state]) => state === 'missing' || state === 'failed');
    window.velaDiagnostics?.record({
      source: 'startup-index', type: 'summary', name: 'platform-health',
      status: unhealthy.length ? 'error' : 'ok',
      message: unhealthy.length ? `Unavailable: ${unhealthy.map(([id]) => id).join(', ')}` : 'All indexed platform modules are ready.',
    });
  });
}, 750);
