import { timeframeToMs } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

type LoadedBarCount = { loaded: number; target: number };

export class LoadedBarsController {
  private readonly listeners = new Map<string, Array<() => void>>();
  private readonly counts = new Map<string, LoadedBarCount>();
  private readonly label = document.getElementById('bottom-loaded-bars');
  private readonly formatter = new Intl.NumberFormat();
  private readonly maxAutomaticHistoryBars = 50_000;

  constructor(private readonly workspace: VelaWorkspace) {}

  public render(): void {
    if (!this.label) return;
    const cellId = this.workspace.active?.id;
    const entry = cellId ? this.counts.get(cellId) : undefined;
    if (!entry) {
      this.label.textContent = 'Bars: loading…';
      this.label.title = 'Chart history is loading.';
      return;
    }
    const loaded = this.formatter.format(entry.loaded);
    const target = Math.max(0, entry.target);
    this.label.textContent = target > entry.loaded
      ? `Bars: ${loaded} / ${this.formatter.format(target)}`
      : `Bars: ${loaded}`;
    this.label.title = `${loaded} chart bars loaded${target > entry.loaded ? ` of ${this.formatter.format(target)} requested` : ''}.`;
  }

  public set(cellId: string, loaded: number, target?: number): void {
    const safeLoaded = Math.max(0, Math.floor(loaded));
    const existing = this.counts.get(cellId);
    const chart = this.workspace.cell(cellId)?.chart;
    this.counts.set(cellId, {
      loaded: safeLoaded,
      target: Math.max(safeLoaded, Math.floor(target ?? existing?.target ?? chart?.market.bars ?? safeLoaded)),
    });
    if (this.workspace.active?.id === cellId) this.render();
  }

  public watch(cellId: string): void {
    if (this.listeners.has(cellId)) return;
    const cell = this.workspace.cell(cellId);
    if (!cell) return;
    const target = Math.max(0, Number(cell.chart.market.bars) || 0);
    let extendingHistory = false;
    let lastExtensionBoundary = '';
    let currentViewport: { from: number; to: number } | null = null;
    const maybeExtendHistory = (range: { from: number; to: number }): void => {
      const market = cell.chart.market;
      const oldest = cell.chart.replay.bounds?.first;
      if (market.offline || !market.symbol || !market.timeframe || oldest === undefined || extendingHistory) return;
      const interval = timeframeToMs(market.timeframe);
      const visibleWidth = Math.max(0, range.to - range.from);
      const preloadMargin = Math.max(interval * 5, visibleWidth * 0.15);
      if (range.from > oldest + preloadMargin) return;
      const boundary = `${market.symbol}|${market.timeframe}|${oldest}`;
      if (boundary === lastExtensionBoundary) return;
      const loaded = this.counts.get(cellId)?.loaded ?? 0;
      const requested = Math.max(1, Number(market.bars) || 500);
      const nextTarget = Math.min(this.maxAutomaticHistoryBars, Math.max(requested + 500, loaded + 500));
      if (nextTarget <= requested) return;
      lastExtensionBoundary = boundary;
      extendingHistory = true;
      this.set(cellId, loaded, nextTarget);
      void cell.chart.setMarket({ bars: nextTarget })
        .then(() => cell.chart.historyComplete())
        .catch(error => {
          console.error(`Could not load older chart history for ${market.symbol}:`, error);
        })
        .finally(() => {
          extendingHistory = false;
          if (currentViewport) maybeExtendHistory(currentViewport);
        });
    };
    this.set(cellId, 0, target);
    this.listeners.set(cellId, [
      cell.chart.on('load:end', event => this.set(cellId, event.bars, Number(cell.chart.market.bars) || event.bars)),
      cell.chart.on('history:progress', event => this.set(cellId, event.loaded, event.target)),
      cell.chart.on('history:complete', event => this.set(cellId, event.barsLoaded, Number(cell.chart.market.bars) || event.barsLoaded)),
      cell.chart.on('load:error', () => {
        const loaded = this.counts.get(cellId)?.loaded ?? 0;
        this.set(cellId, loaded, Number(cell.chart.market.bars) || loaded);
      }),
      cell.chart.on('viewport:changed', range => {
        currentViewport = range;
        maybeExtendHistory(range);
      }),
    ]);
  }

  public unwatch(cellId: string): void {
    this.listeners.get(cellId)?.forEach(dispose => dispose());
    this.listeners.delete(cellId);
    this.counts.delete(cellId);
    this.render();
  }
}
