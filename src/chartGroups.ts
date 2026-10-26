import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { ChartCellControlsManager } from './chartCellControls';

export const CHART_GROUP_COLORS: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
};

export interface ChartGroupsOptions {
  workspace: VelaWorkspace;
  chartGridHost: HTMLElement;
  groupByCellId: Record<string, string>;
  getInitialGroup(cellId: string): string;
  renderChartTabs(): void;
  isPropagating(): boolean;
  setPropagating(value: boolean): void;
}

export function initializeChartGroups(options: ChartGroupsOptions) {
  const { workspace, chartGridHost, groupByCellId } = options;
  const chartGroupColorSelect = document.getElementById('chart-group-color') as HTMLSelectElement;
  const chartGroupIndicator = document.getElementById('chart-group-indicator') as HTMLSpanElement | null;

  function updateTopGroupIndicator(group: string): void {
    if (!chartGroupIndicator) return;
    if (group && CHART_GROUP_COLORS[group]) {
      chartGroupIndicator.style.backgroundColor = CHART_GROUP_COLORS[group];
      chartGroupIndicator.style.border = 'none';
    } else {
      chartGroupIndicator.style.backgroundColor = 'transparent';
      chartGroupIndicator.style.border = '1px dashed #64748b';
    }
  }

  function paintCellGroup(cellId: string): void {
    const group = groupByCellId[cellId] ?? '';
    const color = group ? (CHART_GROUP_COLORS[group] ?? '') : '';
    const cell = workspace.cell(cellId);
    if (!cell) return;
    if (color) {
      cell.host.style.setProperty('--vela-cell-group-color', color);
      cell.host.dataset.groupColor = group;
    } else {
      cell.host.style.removeProperty('--vela-cell-group-color');
      delete cell.host.dataset.groupColor;
    }
  }

  function persistCellGroupState(): void {
    workspace.context().stateChanged();
  }

  function syncGroupSettings(): void {
    const syncGroups: Record<string, string> = {};
    for (const [id, group] of Object.entries(groupByCellId)) {
      if (group) syncGroups[id] = group;
    }
    workspace.sync.set('symbol', syncGroups);
    workspace.sync.set('timeframe', false);
    workspace.sync.set('style', syncGroups);
    workspace.sync.set('drawings', syncGroups);
    if (options.isPropagating()) return;
    options.setPropagating(true);
    try {
      const cells = workspace.cells();
      const groupedCells = new Map<string, typeof cells>();
      for (const cell of cells) {
        const group = groupByCellId[cell.id] ?? '';
        if (!group) continue;
        const members = groupedCells.get(group) ?? [];
        members.push(cell);
        groupedCells.set(group, members);
      }
      for (const members of groupedCells.values()) {
        const source = members.find(cell => cell.id === workspace.active?.id) ?? members[0];
        for (const target of members) {
          if (target.id === source.id) continue;
          for (const indicator of source.chart.indicators()) {
            if (indicator.source) {
              const existing = target.chart.indicators().find(item => item.id === indicator.id);
              if (existing) {
                if (existing.source !== indicator.source) void existing.updateCode(indicator.source);
              } else {
                void target.chart.runIndicator(indicator.source, {
                  id: indicator.id,
                  language: 'pine',
                  title: indicator.title,
                });
              }
            } else if (indicator.nativeType && !target.chart.presentNativeIndicators().includes(indicator.nativeType)) {
              target.chart.addNativeIndicator(indicator.nativeType);
            }
          }
          for (const indicator of target.chart.indicators()) {
            if (indicator.source && !source.chart.indicators().some(item => item.id === indicator.id)) indicator.remove();
            else if (indicator.nativeType && !source.chart.presentNativeIndicators().includes(indicator.nativeType)) indicator.remove();
          }
        }
      }
    } finally {
      options.setPropagating(false);
    }
  }

  async function setCellGroup(cellId: string, newGroup: string): Promise<void> {
    const targetCell = workspace.cell(cellId);
    if (!targetCell) return;
    const oldGroup = groupByCellId[cellId] ?? '';
    groupByCellId[cellId] = newGroup;

    if (newGroup && newGroup !== oldGroup) {
      const existing = workspace.cells().find(cell => cell.id !== cellId && groupByCellId[cell.id] === newGroup);
      if (existing) {
        const sourceSymbol = existing.chart.market.symbol;
        if (sourceSymbol && sourceSymbol !== targetCell.chart.market.symbol) {
          await targetCell.chart.setMarket({ symbol: sourceSymbol });
        }
        try {
          const sourceConfig = existing.chart.renderer.getConfig();
          if (sourceConfig) targetCell.chart.renderer.applyConfig(sourceConfig);
        } catch (error) {
          console.warn('Could not copy renderer config:', error);
        }
        try {
          for (const indicator of existing.chart.indicators()) {
            if (indicator.source) {
              const existingIndicator = targetCell.chart.indicators().find(item => item.id === indicator.id);
              if (existingIndicator) {
                if (existingIndicator.source !== indicator.source) await existingIndicator.updateCode(indicator.source);
              } else {
                await targetCell.chart.runIndicator(indicator.source, {
                  id: indicator.id,
                  language: 'pine',
                  title: indicator.title,
                });
              }
            } else if (indicator.nativeType && !targetCell.chart.presentNativeIndicators().includes(indicator.nativeType)) {
              targetCell.chart.addNativeIndicator(indicator.nativeType);
            }
          }
          for (const targetIndicator of targetCell.chart.indicators()) {
            if (targetIndicator.source && !existing.chart.indicators().some(item => item.id === targetIndicator.id)) {
              targetIndicator.remove();
            } else if (targetIndicator.nativeType && !existing.chart.presentNativeIndicators().includes(targetIndicator.nativeType)) {
              targetIndicator.remove();
            }
          }
          try {
            const drawings = existing.chart.drawings?.toJSON();
            if (Array.isArray(drawings) && drawings.length > 0) targetCell.chart.drawings.fromJSON(drawings);
          } catch (error) {
            console.warn('Could not copy drawings to grouped cell:', error);
          }
        } catch (error) {
          console.warn('Could not copy indicators to grouped cell:', error);
        }
      }
    }

    paintCellGroup(cellId);
    if (workspace.active?.id === cellId) {
      chartGroupColorSelect.value = newGroup;
      updateTopGroupIndicator(newGroup);
    }
    syncGroupSettings();
    cellControlsManager.updateAll();
    persistCellGroupState();
    options.renderChartTabs();
  }

  const cellControlsManager = new ChartCellControlsManager({
    getWorkspace: () => workspace,
    getGroupForCell: cellId => groupByCellId[cellId] ?? '',
    onSetCellGroup: setCellGroup,
  });

  chartGridHost.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const symbolButton = target.closest<HTMLElement>('.vela-widget-symbol, .vela-mb-symbol');
    if (!symbolButton) return;
    const activeCell = workspace.active;
    if (!activeCell) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cellControlsManager.openSymbolPickerForCell(activeCell.id, symbolButton);
  }, true);

  const keyboardTargetAcceptsText = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, [role="textbox"], button, [role="button"]'));
  };
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey
      || keyboardTargetAcceptsText(event.target)) return;
    const indicatorsButton = [...document.querySelectorAll<HTMLButtonElement>('.vela-widget-action-left, .vela-widget-action')]
      .find(button => button.textContent?.trim() === 'Indicators');
    if (!indicatorsButton || indicatorsButton.disabled) return;
    event.preventDefault();
    indicatorsButton.click();
  });

  let chartGridVisible = true;
  const applyChartGridVisibility = (visible: boolean): void => {
    for (const cell of workspace.cells()) {
      cell.chart.renderer.applyConfig({
        grid: {
          vertLines: { visible },
          horzLines: { visible },
        },
      });
    }
  };
  workspace.on('cell:created', ({ id }) => {
    if (!chartGridVisible) {
      workspace.cell(id)?.chart.renderer.applyConfig({
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false },
        },
      });
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'g' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || event.repeat || keyboardTargetAcceptsText(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    chartGridVisible = !chartGridVisible;
    applyChartGridVisibility(chartGridVisible);
  }, true);

  for (const cell of workspace.cells()) {
    groupByCellId[cell.id] = options.getInitialGroup(cell.id);
    paintCellGroup(cell.id);
    cellControlsManager.mountCell(cell.id);
  }
  const activeCellId = workspace.active?.id;
  const initialGroup = activeCellId ? (groupByCellId[activeCellId] ?? '') : '';
  chartGroupColorSelect.value = initialGroup;
  updateTopGroupIndicator(initialGroup);

  workspace.on('cell:active', event => {
    const group = groupByCellId[event.id] ?? '';
    chartGroupColorSelect.value = group;
    updateTopGroupIndicator(group);
    cellControlsManager.updateAll();
    syncGroupSettings();
  });
  workspace.on('cell:created', event => {
    groupByCellId[event.id] ??= '';
    paintCellGroup(event.id);
    cellControlsManager.mountCell(event.id);
    cellControlsManager.updateAll();
    syncGroupSettings();
  });
  workspace.on('cell:destroyed', event => {
    cellControlsManager.unmountCell(event.id);
    delete groupByCellId[event.id];
    cellControlsManager.updateAll();
    syncGroupSettings();
    options.renderChartTabs();
  });
  syncGroupSettings();
  cellControlsManager.updateAll();

  return { setCellGroup, paintCellGroup, cellControlsManager, syncGroupSettings };
}
