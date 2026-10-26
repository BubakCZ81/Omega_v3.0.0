import { registerIcon, registerWidgetAction, timeframeToMs } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

type PaperTradingModule = typeof import('./chartPaperTrading');

interface ChartContextActionsOptions {
  workspace: VelaWorkspace;
  ensurePaperTrading(): Promise<PaperTradingModule>;
  hasPendingPaperOrderAtPrice(chart: VelaWorkspace['chart'], price: number | null | undefined): boolean;
  getBidAskLinesVisible(): boolean;
  setBidAskLinesVisible(visible: boolean): void;
  getTheme(): string;
  setTheme(theme: 'dark' | 'light'): void;
  openReplayControls(): void;
  startReplayAt(time: number, cellId: string): Promise<unknown>;
}

const contextActionIcons: Record<string, string> = {
  'omega-context-cancel-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="m17 3 4 4m0-4-4 4"/>',
  'omega-context-add-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M19 14v7m-3.5-3.5h7"/>',
  'omega-context-volume': '<path d="M3 10v4h4l5 4V6l-5 4z"/><path d="M16 9a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/>',
  'omega-context-bid-ask': '<path d="M3 7h18M3 17h18"/><path d="m7 4-4 3 4 3m10 4 4 3-4 3"/>',
  'omega-context-reset-view': '<path d="M4 11a8 8 0 1 1 2 6"/><path d="M4 4v7h7"/><path d="M12 7v5l3 2"/>',
  'omega-context-background': '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 2 2 0 0 1 1-3.8h2a3 3 0 0 0 3-3c0-4.1-4-7.5-9-7.5z"/><path d="M7.5 10h.01M11 7h.01M15.5 8.5h.01"/>',
  'omega-context-theme-light': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  'omega-context-theme-dark': '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z"/>',
  'omega-context-pine': '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-2-15-4 16"/>',
  'omega-context-replay': '<path d="M4 5v6h6"/><path d="M5.5 15a7 7 0 1 0 1-7"/><path d="m10 8 6 4-6 4z"/>',
  'omega-context-replay-panel': '<path d="M3 4h18v16H3z"/><path d="M3 9h18m-6-5v5"/><path d="m8 12 5 3-5 3z"/>',
};

export function initializeChartContextActions(options: ChartContextActionsOptions): void {
  const {
    workspace,
    ensurePaperTrading,
    hasPendingPaperOrderAtPrice,
    getBidAskLinesVisible,
    setBidAskLinesVisible,
    getTheme,
    setTheme,
    openReplayControls,
    startReplayAt,
  } = options;

  for (const [id, pathData] of Object.entries(contextActionIcons)) {
    registerIcon(id, `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathData}</svg>`);
  }

  registerWidgetAction({
    id: 'omega-context-cancel-pending-paper-order',
    target: 'context:body',
    label: 'Cancel pending paper order',
    icon: 'omega-context-cancel-order',
    order: -21,
    when: context => context.pointer?.paneKind === 'price'
      && Number.isFinite(context.pointer.price)
      && hasPendingPaperOrderAtPrice(context.chart, context.pointer?.price),
    run: async context => {
      const paperTrading = await ensurePaperTrading();
      if (!paperTrading.cancelPendingPaperOrderAtPrice(context.chart, context.pointer?.price)) {
        context.toast('No pending paper order was found at that price.', 'error');
      }
    },
  });
  registerWidgetAction({
    id: 'omega-context-add-pending-paper-order',
    target: 'context:body',
    label: 'Add pending paper order…',
    icon: 'omega-context-add-order',
    order: -20,
    when: context => context.pointer?.paneKind === 'price'
      && Number.isFinite(context.pointer.price)
      && Number(context.pointer.price) > 0
      && Boolean(context.symbol)
      && Boolean(context.chart.data.resolve(context.symbol)),
    run: async context => {
      const paperTrading = await ensurePaperTrading();
      paperTrading.openPendingOrderDialog(context.chart, context.pointer?.price);
    },
  });
  registerWidgetAction({
    id: 'omega-context-show-real-volumes',
    target: 'context:body',
    label: 'Show real volumes',
    icon: 'omega-context-volume',
    order: -28,
    when: context => !context.chart.presentNativeIndicators().includes('volume'),
    run: context => {
      context.addNativeIndicator('volume');
    },
  });
  registerWidgetAction({
    id: 'omega-context-hide-real-volumes',
    target: 'context:body',
    label: 'Hide real volumes',
    icon: 'omega-context-volume',
    order: -28,
    when: context => context.chart.presentNativeIndicators().includes('volume'),
    run: context => {
      const volume = context.chart.indicators().find(indicator => indicator.nativeType === 'volume');
      if (!volume) {
        context.toast('Real volumes could not be disabled because the volume indicator is unavailable.', 'error');
        return;
      }
      volume.remove();
    },
  });
  registerWidgetAction({
    id: 'omega-context-show-bid-ask-lines',
    target: 'context:body',
    label: 'Show bid/ask lines',
    icon: 'omega-context-bid-ask',
    order: -27,
    when: () => !getBidAskLinesVisible(),
    run: () => setBidAskLinesVisible(true),
  });
  registerWidgetAction({
    id: 'omega-context-hide-bid-ask-lines',
    target: 'context:body',
    label: 'Hide bid/ask lines',
    icon: 'omega-context-bid-ask',
    order: -27,
    when: () => getBidAskLinesVisible(),
    run: () => setBidAskLinesVisible(false),
  });
  registerWidgetAction({
    id: 'omega-context-reset-view',
    target: 'context:body',
    label: 'Reset chart view (50 bars)',
    icon: 'omega-context-reset-view',
    order: -29,
    run: context => {
      workspace.active.resetView();
      const fullRange = context.chart.getVisibleRange();
      const barDuration = timeframeToMs(context.timeframe);
      if (fullRange) {
        const requestedBars = Math.max(0, Number(context.chart.market.bars) || 0);
        const averageLoadedBarDuration = requestedBars > 50
          ? (fullRange.to - fullRange.from) / Math.max(1, requestedBars - 1)
          : 0;
        const resetDuration = averageLoadedBarDuration > 0 ? averageLoadedBarDuration : barDuration;
        if (!Number.isFinite(resetDuration) || resetDuration <= 0) return;
        context.chart.setVisibleRange({
          from: fullRange.to - resetDuration * 49,
          to: fullRange.to,
        });
      }
      context.toast('Chart view reset to the latest 50 bars.', 'success');
    },
  });
  registerWidgetAction({
    id: 'omega-context-background',
    target: 'context:body',
    label: 'Chart background color…',
    icon: 'omega-context-background',
    order: 120,
    run: context => {
      context.chart.renderer.openSettings('Canvas');
    },
  });
  registerWidgetAction({
    id: 'omega-context-theme-light',
    target: 'context:body',
    label: 'Switch to Light theme',
    icon: 'omega-context-theme-light',
    order: 121,
    when: () => getTheme() !== 'light',
    run: context => {
      setTheme('light');
      context.toast('Switched to Light theme.', 'success');
    },
  });
  registerWidgetAction({
    id: 'omega-context-theme-dark',
    target: 'context:body',
    label: 'Switch to Dark blue theme',
    icon: 'omega-context-theme-dark',
    order: 121,
    when: () => getTheme() !== 'dark',
    run: context => {
      setTheme('dark');
      context.toast('Switched to Dark blue theme.', 'success');
    },
  });
  registerWidgetAction({
    id: 'omega-context-pine-window',
    target: 'context:body',
    label: 'Open Pine Editor in new window',
    icon: 'omega-context-pine',
    order: 122,
    run: context => {
      const button = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;
      if (button && !button.hidden) {
        button.click();
        return;
      }
      context.toast('The separate Pine Editor is available only in the Omega desktop app.', 'info');
    },
  });
  registerWidgetAction({
    id: 'omega-context-start-replay',
    target: 'context:body',
    label: 'Start replay from here',
    icon: 'omega-context-replay',
    order: 123,
    when: context => Number.isFinite(context.pointer?.time),
    run: context => {
      const from = context.pointer?.time;
      if (from == null || !Number.isFinite(from)) return;
      const cell = workspace.cells().find(candidate => candidate.chart === context.chart);
      if (!cell) {
        context.toast('Could not identify the chart for replay.', 'error');
        return;
      }
      openReplayControls();
      void startReplayAt(from, cell.id);
    },
  });
  registerWidgetAction({
    id: 'omega-context-open-replay',
    target: 'context:body',
    label: 'Open Replay',
    icon: 'omega-context-replay-panel',
    order: 124,
    run: openReplayControls,
  });
}
