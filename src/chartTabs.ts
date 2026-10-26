import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export interface ChartTabsState {
  enabled: boolean;
  count: number;
  previousLayout: string;
}

export interface ChartTabsController {
  render(): void;
  toggle(): void;
  setEnabled(enabled: boolean): void;
  addTab(): void;
  closeTab(cellId: string): void;
}

interface ChartTabsOptions {
  workspace: VelaWorkspace;
  state: ChartTabsState;
  maxTabs: number;
  layoutId(count: number): string;
  isTabsLayout(layoutId: string): boolean;
  groupByCellId: Record<string, string>;
  groupColorHex: Record<string, string>;
  chartGridHost: HTMLElement;
  chartLayoutSelect: HTMLSelectElement;
  chartTabsBar: HTMLElement;
  chartTabsList: HTMLElement;
  chartTabsToggle: HTMLButtonElement;
  chartTabsAdd: HTMLButtonElement;
}

function chartTabTimeframe(timeframe: string | undefined): string {
  if (!timeframe) return '1h';
  if (timeframe === '60') return '1h';
  if (timeframe === 'D' || timeframe === '1D' || timeframe === '1440') return '1D';
  if (timeframe === 'W' || timeframe === '1W' || timeframe === '10080') return '1W';
  const minutes = Number(timeframe);
  return Number.isFinite(minutes) && minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : timeframe;
}

export function initializeChartTabs(options: ChartTabsOptions): ChartTabsController {
  const {
    workspace,
    state,
    maxTabs,
    layoutId,
    isTabsLayout,
    groupByCellId,
    groupColorHex,
    chartGridHost,
    chartLayoutSelect,
    chartTabsBar,
    chartTabsList,
    chartTabsToggle,
    chartTabsAdd,
  } = options;

  function persist(): void {
    localStorage.setItem('omega_chart_tabs_enabled', String(state.enabled));
    localStorage.setItem('omega_chart_tabs_count', String(state.count));
    localStorage.setItem('omega_chart_tabs_previous_layout', state.previousLayout);
    workspace.context().stateChanged();
  }

  function render(): void {
    const tabsMode = state.enabled && isTabsLayout(workspace.layout.id);
    chartTabsBar.hidden = !tabsMode;
    chartTabsToggle.setAttribute('aria-pressed', String(tabsMode));
    chartTabsToggle.classList.toggle('active', tabsMode);
    chartTabsToggle.textContent = tabsMode ? 'Hide tabs' : 'Tab View';
    chartTabsToggle.title = tabsMode ? 'Return to the chart grid layout' : 'Show one chart per tab';
    chartLayoutSelect.disabled = tabsMode;
    chartLayoutSelect.title = tabsMode ? 'Disable Tab View to change the grid layout.' : '';
    chartGridHost.classList.toggle('omega-tabs-mode', tabsMode);

    for (const cell of workspace.cells()) {
      if (tabsMode && cell.id === workspace.active?.id) cell.host.dataset.omegaTabActive = 'true';
      else delete cell.host.dataset.omegaTabActive;
    }
    if (!tabsMode) {
      chartTabsList.replaceChildren();
      return;
    }

    const cells = workspace.cells().slice(0, state.count);
    const fragment = document.createDocumentFragment();
    for (const [index, cell] of cells.entries()) {
      const tab = document.createElement('div');
      tab.className = 'chart-tab';
      tab.role = 'tab';
      const active = cell.id === workspace.active?.id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const group = groupByCellId[cell.id] ?? '';
      const timeframe = chartTabTimeframe(cell.chart.market.timeframe);
      tab.title = `Chart ${index + 1}: ${cell.chart.market.symbol || 'Chart'} · ${timeframe}${group ? ` · ${group} group` : ''}`;

      const swatch = document.createElement('span');
      swatch.className = 'chart-tab-group';
      if (group && groupColorHex[group]) {
        swatch.style.backgroundColor = groupColorHex[group];
        swatch.style.borderStyle = 'solid';
        swatch.style.borderColor = groupColorHex[group];
      }

      const label = document.createElement('span');
      label.className = 'chart-tab-label';
      label.textContent = `${cell.chart.market.symbol || `Chart ${index + 1}`} · ${timeframe}`;

      const activate = document.createElement('button');
      activate.className = 'chart-tab-activate';
      activate.type = 'button';
      activate.tabIndex = active ? 0 : -1;
      activate.append(swatch, label);
      activate.addEventListener('click', () => workspace.setActiveCell(cell.id));
      tab.append(activate);

      if (state.count > 1) {
        const close = document.createElement('button');
        close.className = 'chart-tab-close';
        close.type = 'button';
        close.title = `Close chart ${index + 1}`;
        close.setAttribute('aria-label', `Close chart ${index + 1}`);
        close.textContent = '×';
        close.addEventListener('click', event => {
          event.stopPropagation();
          closeTab(cell.id);
        });
        tab.append(close);
      }
      fragment.append(tab);
    }
    chartTabsList.replaceChildren(fragment);
    chartTabsAdd.disabled = state.count >= maxTabs;
    chartTabsAdd.title = chartTabsAdd.disabled ? `Maximum of ${maxTabs} chart tabs` : 'Open another chart tab';
  }

  function setEnabled(enabled: boolean): void {
    if (enabled === state.enabled && (enabled ? isTabsLayout(workspace.layout.id) : !isTabsLayout(workspace.layout.id))) {
      render();
      return;
    }
    if (enabled) {
      if (!isTabsLayout(workspace.layout.id)) {
        state.previousLayout = workspace.layout.id;
        state.count = Math.max(state.count, workspace.cells().length);
      }
      state.enabled = true;
      workspace.setLayout(layoutId(state.count));
    } else {
      state.enabled = false;
      workspace.setLayout(state.previousLayout || '1');
    }
    persist();
    render();
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function addTab(): void {
    if (!state.enabled) setEnabled(true);
    if (state.count >= maxTabs) return;
    state.count += 1;
    workspace.setLayout(layoutId(state.count));
    const cell = workspace.cells()[state.count - 1];
    if (cell) workspace.setActiveCell(cell.id);
    persist();
    render();
  }

  function closeTab(cellId: string): void {
    if (!state.enabled || state.count <= 1) return;
    const cells = workspace.cells();
    const closingCell = workspace.cell(cellId);
    const lastCell = cells[state.count - 1];
    if (!closingCell || !lastCell) return;
    if (closingCell.id !== lastCell.id) workspace.swapCells(closingCell.id, lastCell.id);
    state.count -= 1;
    workspace.setLayout(layoutId(state.count));
    const nextActive = workspace.cells()[Math.min(cells.indexOf(closingCell), state.count - 1)] ?? workspace.cells()[0];
    if (nextActive) workspace.setActiveCell(nextActive.id);
    persist();
    render();
  }

  workspace.on('cell:active', render);
  workspace.on('cell:created', render);
  return { render, toggle: () => setEnabled(!state.enabled), setEnabled, addTab, closeTab };
}
