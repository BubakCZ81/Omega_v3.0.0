import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export interface TopPanelActions {
  onGroupChange(group: string): void;
  onChartTabsToggle(): void;
  onChartTabsAdd(): void;
  onReplayMenuOpen(): void;
  onVisualBacktest(): void;
  onNeuralNetwork(): void;
  onSettings(): void;
}

export function initializeTopPanel(workspace: VelaWorkspace, actions: TopPanelActions): void {
  const layoutSelect = document.getElementById('chart-layout-select') as HTMLSelectElement | null;
  const groupSelect = document.getElementById('chart-group-color') as HTMLSelectElement | null;
  const chartTabsToggle = document.getElementById('chart-tabs-toggle') as HTMLButtonElement | null;
  const chartTabsAdd = document.getElementById('chart-tabs-add') as HTMLButtonElement | null;
  const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement | null;
  const visualBacktestToggle = document.getElementById('visual-backtest-toggle');
  const neuralNetworkToggle = document.getElementById('neural-network-toggle');
  const settingsButton = document.getElementById('top-chart-settings');

  if (layoutSelect) {
    layoutSelect.value = workspace.layout.id;
    layoutSelect.addEventListener('change', () => workspace.setLayout(layoutSelect.value));
    workspace.on('layout:changed', event => { layoutSelect.value = event.layout; });
  }
  groupSelect?.addEventListener('change', () => actions.onGroupChange(groupSelect.value));
  chartTabsToggle?.addEventListener('click', actions.onChartTabsToggle);
  chartTabsAdd?.addEventListener('click', actions.onChartTabsAdd);
  replayMenu?.addEventListener('toggle', () => {
    if (replayMenu.open) actions.onReplayMenuOpen();
  });
  visualBacktestToggle?.addEventListener('click', actions.onVisualBacktest);
  neuralNetworkToggle?.addEventListener('click', actions.onNeuralNetwork);
  settingsButton?.addEventListener('click', actions.onSettings);
}
