import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import {
  BID_ASK_COLOR_OPTIONS,
  BID_ASK_STYLE_OPTIONS,
  BID_ASK_WIDTH_OPTIONS,
  type BidAskLineStyle,
} from './bidAskLines';
import { getMarketFlowStyle, setMarketFlowStyle } from './marketFlowPane';
import { isOmegaTheme, type OmegaTheme } from './themeControls';
import type { ChartTabsState } from './chartTabs';
import type { TopPanelMode } from './topPanelMode';

export interface ChartRendererSettingsOptions {
  getWorkspace(): VelaWorkspace;
  chartTabsState: ChartTabsState;
  groupByCellId: Record<string, string>;
  isChartTabsLayout(layoutId: string): boolean;
  setChartTabsEnabled(enabled: boolean): void;
  setCellGroup(cellId: string, group: string): unknown;
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
  getTopPanelMode(): TopPanelMode;
  setTopPanelMode(mode: TopPanelMode): void;
  getBarThickness(): number;
  setBarThickness(value: number): void;
  getLockPriceToBarRatio(): boolean;
  setLockPriceToBarRatio(enabled: boolean): void;
  getShowBidAskLines(): boolean;
  setShowBidAskLines(enabled: boolean): void;
  getBidAskLineStyle(): BidAskLineStyle;
  setBidAskLineStyle(style: Partial<BidAskLineStyle>): void;
  setLoadedBars(cellId: string, bars: number): void;
}

const registeredCharts = new WeakSet<object>();

export function registerChartRendererSettings(
  chart: VelaWorkspace['chart'],
  options: ChartRendererSettingsOptions,
): void {
  if (registeredCharts.has(chart)) return;
  const {
    getWorkspace,
    chartTabsState,
    groupByCellId,
    isChartTabsLayout,
    setChartTabsEnabled,
    setCellGroup,
    getTheme,
    setTheme,
    getTopPanelMode,
    setTopPanelMode,
    getBarThickness,
    setBarThickness,
    getLockPriceToBarRatio,
    setLockPriceToBarRatio,
    getShowBidAskLines,
    setShowBidAskLines,
    getBidAskLineStyle,
    setBidAskLineStyle,
    setLoadedBars,
  } = options;
  const workspace = getWorkspace();
  const settingsCellId = () => workspace.cells().find(cell => cell.chart === chart)?.id ?? workspace.active.id;
  const bidAskColorOptions = BID_ASK_COLOR_OPTIONS.map(([color, label]) => [color, label] as const);
  const marketFlowFontOptions = [10, 11, 12, 13, 14, 16, 18].map(size => [String(size), `${size}px`] as const);
  const marketFlowSettings = (view: 'time-sales' | 'dom', title: string) => {
    const colorRows = [
      ['background', 'Panel background'],
      ['text', 'Text'],
      ['buy', 'Buy / bid'],
      ['sell', 'Sell / ask'],
      ['grid', 'Grid and separators'],
    ] as const;
    return {
      title,
      id: `omega-${view}-appearance`,
      rows: [
        {
          kind: 'select' as const,
          label: 'Font size',
          options: marketFlowFontOptions,
          get: () => String(getMarketFlowStyle(view).fontSize),
          set: (value: string) => setMarketFlowStyle(view, 'fontSize', value),
        },
        ...colorRows.map(([key, label]) => ({
          kind: 'color' as const,
          label,
          get: () => getMarketFlowStyle(view)[key],
          set: (value: string) => setMarketFlowStyle(view, key, value),
        })),
      ],
    };
  };
  const bidAskWidthOptions = BID_ASK_WIDTH_OPTIONS.map(width => [String(width), `${width}px`] as const);
  chart.renderer.setSettingsSections([
    {
      title: 'Workspace',
      id: 'omega-workspace',
      rows: [
        {
          kind: 'select',
          label: 'Layout',
          options: [['1', '1 chart'], ['2h', '2 charts — side by side'], ['2v', '2 charts — stacked'], ['4', '4 charts']],
          get: () => isChartTabsLayout(workspace.layout.id) ? '1' : workspace.layout.id,
          set: (layout: string) => {
            if (isChartTabsLayout(workspace.layout.id)) setChartTabsEnabled(false);
            workspace.setLayout(layout);
          },
        },
        {
          kind: 'toggle',
          label: 'Chart tabs',
          get: () => chartTabsState.enabled,
          set: (enabled: boolean) => setChartTabsEnabled(enabled),
        },
        {
          kind: 'select',
          label: 'Active chart group',
          options: [['', 'None'], ['red', 'Red'], ['blue', 'Blue'], ['green', 'Green'], ['yellow', 'Yellow'], ['purple', 'Purple']],
          get: () => groupByCellId[settingsCellId()] ?? '',
          set: (group: string) => { void setCellGroup(settingsCellId(), group); },
        },
        {
          kind: 'select',
          label: 'Workspace file',
          options: [['idle', 'Choose action…'], ['save', 'Save workspace…'], ['load', 'Load workspace…']],
          get: () => 'idle',
          set: (action: string) => {
            if (action === 'save') document.getElementById('workspace-save-profile')?.click();
            if (action === 'load') document.getElementById('workspace-load-profile')?.click();
          },
        },
      ],
    },
    {
      title: 'Appearance',
      id: 'omega-appearance',
      rows: [
        {
          kind: 'select',
          label: 'Platform theme',
          options: [['dark', 'Dark blue'], ['light', 'Light'], ['high-contrast', 'High contrast — light blue'], ['high-contrast-dark', 'High contrast — dark blue']],
          get: getTheme,
          set: (theme: string) => setTheme(isOmegaTheme(theme) ? theme : 'dark'),
        },
        {
          kind: 'select',
          label: 'Top panel size',
          options: [['classic', 'Classic — compact'], ['large', 'Large — readable controls']],
          get: getTopPanelMode,
          set: (mode: string) => setTopPanelMode(mode === 'large' ? 'large' : 'classic'),
        },
        {
          kind: 'color',
          label: 'Chart background',
          get: () => (chart.renderer.getConfig() as { layout?: { background?: string } }).layout?.background ?? '#101d30',
          set: (background: string) => chart.renderer.applyConfig({ layout: { background } }),
        },
      ],
    },
    marketFlowSettings('time-sales', 'Time & Sales'),
    marketFlowSettings('dom', 'DOM'),
    {
      title: 'Market data',
      id: 'market-data',
      rows: [{
        kind: 'select',
        label: 'Candles to load',
        options: [
          ['500', '500'], ['1000', '1,000'], ['3000', '3,000'], ['5000', '5,000'],
          ['10000', '10,000'], ['15000', '15,000'], ['20000', '20,000'], ['25000', '25,000'],
          ['30000', '30,000'], ['40000', '40,000'], ['50000', '50,000'],
        ],
        get: () => String(chart.market.bars ?? 3000),
        set: (value: string) => {
          const bars = Number.parseInt(value, 10);
          if (!Number.isSafeInteger(bars) || bars < 1 || bars > 50_000) return;
          setLoadedBars(settingsCellId(), bars);
          void chart.setMarket({ bars });
        },
      }],
    },
    {
      title: 'Bar thickness',
      id: 'bar-thickness',
      rows: [{
        kind: 'select',
        label: 'Candle body width',
        options: ['15%', '25%', '35%', '45%', '55%', '65%', '75%', '85%', '95%', '100%'].map(value => [value, value] as const),
        get: () => `${Math.round(getBarThickness() * 100)}%`,
        set: (value: string) => setBarThickness(Number.parseInt(value, 10) / 100),
      }],
    },
    {
      title: 'Scale',
      id: 'price-bar-ratio',
      rows: [{
        kind: 'toggle',
        label: 'Lock price to bar ratio',
        get: getLockPriceToBarRatio,
        set: setLockPriceToBarRatio,
      }],
    },
    {
      title: 'Price lines',
      id: 'price-lines',
      rows: [
        {
          kind: 'toggle',
          label: 'Show bid and ask lines',
          get: getShowBidAskLines,
          set: setShowBidAskLines,
        },
        {
          kind: 'select',
          label: 'Bid line color',
          options: bidAskColorOptions,
          get: () => getBidAskLineStyle().bidColor,
          set: (bidColor: string) => setBidAskLineStyle({ bidColor }),
        },
        {
          kind: 'select',
          label: 'Ask line color',
          options: bidAskColorOptions,
          get: () => getBidAskLineStyle().askColor,
          set: (askColor: string) => setBidAskLineStyle({ askColor }),
        },
        {
          kind: 'select',
          label: 'Line width',
          options: bidAskWidthOptions,
          get: () => String(getBidAskLineStyle().lineWidth),
          set: (lineWidth: string) => setBidAskLineStyle({ lineWidth: Number(lineWidth) }),
        },
        {
          kind: 'select',
          label: 'Line style',
          options: BID_ASK_STYLE_OPTIONS,
          get: () => getBidAskLineStyle().lineStyle,
          set: (lineStyle: string) => setBidAskLineStyle({ lineStyle: lineStyle as BidAskLineStyle['lineStyle'] }),
        },
      ],
    },
  ]);
  registeredCharts.add(chart);
}
