import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { applyTimeframe } from './timeframeSelection';
import { chartStyleCode, chartStyleName } from './chartViewLabel';

export const GROUP_COLOR_HEX: Record<string, string> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
};

export function formatTimeframeLabel(tf: string | undefined): string {
  if (!tf) return '1h';
  if (tf === '60') return '1h';
  if (tf === '120') return '2h';
  if (tf === '240') return '4h';
  if (tf === 'D' || tf === '1D' || tf === '1440') return '1D';
  if (tf === 'W' || tf === '1W' || tf === '10080') return '1W';
  if (/^\d+$/.test(tf)) {
    const mins = Number(tf);
    if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`;
    return `${mins}m`;
  }
  return tf;
}

function providerFromTradingAccount(accountId: string | null): string {
  if (!accountId) return '';
  const separator = accountId.indexOf(':');
  return separator > 0 ? accountId.slice(0, separator).trim().toLowerCase() : '';
}

export interface CellControlsDeps {
  getWorkspace: () => VelaWorkspace;
  getGroupForCell: (cellId: string) => string;
  onSetCellGroup: (cellId: string, group: string) => Promise<void>;
}

export class ChartCellControlsManager {
  private readonly mountedCells = new Set<string>();
  private readonly observers = new Map<string, MutationObserver>();
  private readonly marketSubscriptions = new Map<string, () => void>();
  private readonly styleSubscriptions = new Map<string, () => void>();
  private readonly activationHandlers = new Map<string, (event: PointerEvent) => void>();
  private activePopup: HTMLElement | null = null;
  private readonly deps: CellControlsDeps;
  private preferredDataProvider = providerFromTradingAccount(localStorage.getItem('omega.selected-trading-account'));

  constructor(deps: CellControlsDeps) {
    this.deps = deps;
    document.addEventListener('omega:trading-account-selected', event => {
      const detail = (event as CustomEvent<{ provider?: string }>).detail;
      this.preferredDataProvider = detail?.provider?.trim().toLowerCase() ?? '';
      const source = this.activePopup?.querySelector<HTMLSelectElement>('.omega-symbol-source-select');
      if (!source) return;
      if (this.preferredDataProvider) this.selectPreferredProvider(source);
      else source.value = '';
      source.dispatchEvent(new Event('change'));
    });
    document.addEventListener('pointerdown', event => {
      if (this.activePopup && !this.activePopup.contains(event.target as Node)) {
        this.closePopup();
      }
    });
  }

  public mountCell(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell || !cell.host) return;

    if (this.mountedCells.has(cellId)) {
      this.updateCell(cellId);
      return;
    }

    const host = cell.host;
    host.style.position = 'relative';

    const activateCell = (event: PointerEvent) => {
      // The chart renderer can stop bubbling pointer events, so close its asset
      // picker here in capture phase rather than relying only on the document handler.
      if (this.activePopup?.classList.contains('omega-symbol-picker')
        && !this.activePopup.contains(event.target as Node)) {
        this.closePopup();
      }
      // Keep top-toolbar menus from obscuring the chart after the trader returns
      // to it. Capture phase is required because Vela can stop pointer bubbling.
      const timeframeMenu = document.getElementById('ctrader-timeframe-menu') as HTMLDetailsElement | null;
      if (timeframeMenu?.open && !timeframeMenu.contains(event.target as Node)) {
        timeframeMenu.open = false;
      }
      const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement | null;
      if (replayMenu?.open && !replayMenu.contains(event.target as Node)) {
        replayMenu.open = false;
      }
      workspace.setActiveCell(cellId);
      this.updateAll();
    };
    host.addEventListener('pointerdown', activateCell, true);
    this.activationHandlers.set(cellId, activateCell);

    this.mountedCells.add(cellId);

    // Attach single set of controls directly to the upper-left status line (.vela-statusline)
    this.attachStatuslineIntegration(cellId);

    // Observe statusline changes to maintain interactive upper-left controls
    const observer = new MutationObserver(() => {
      this.attachStatuslineIntegration(cellId);
    });
    observer.observe(host, { childList: true, subtree: true });
    this.observers.set(cellId, observer);

    this.marketSubscriptions.set(cellId, cell.chart.on('market:changed', () => {
      this.attachStatuslineIntegration(cellId);
    }));
    this.styleSubscriptions.set(cellId, cell.chart.on('priceStyle:change', () => {
      this.attachStatuslineIntegration(cellId);
    }));

    this.updateCell(cellId);
  }

  public unmountCell(cellId: string): void {
    this.mountedCells.delete(cellId);
    const obs = this.observers.get(cellId);
    if (obs) {
      obs.disconnect();
      this.observers.delete(cellId);
    }
    this.marketSubscriptions.get(cellId)?.();
    this.marketSubscriptions.delete(cellId);
    this.styleSubscriptions.get(cellId)?.();
    this.styleSubscriptions.delete(cellId);
    const handler = this.activationHandlers.get(cellId);
    const host = this.deps.getWorkspace().cell(cellId)?.host;
    if (handler && host) host.removeEventListener('pointerdown', handler, true);
    this.activationHandlers.delete(cellId);
  }

  public attachStatuslineIntegration(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell || !cell.host) return;

    const statusline = cell.host.querySelector<HTMLElement>('.vela-statusline');
    if (!statusline) return;

    const row = statusline.querySelector<HTMLElement>('.vela-sl-row');
    const symbolEl = statusline.querySelector<HTMLElement>('.vela-sl-symbol');
    if (!row || !symbolEl) return;

    const group = this.deps.getGroupForCell(cellId) || '';
    const color = group ? (GROUP_COLOR_HEX[group] ?? '') : '';

    // 1. Group Square inside upper-left statusline
    let groupSquare = row.querySelector<HTMLSpanElement>('.omega-statusline-group-square');
    if (!groupSquare) {
      groupSquare = document.createElement('span');
      groupSquare.className = 'omega-statusline-group-square';
      groupSquare.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openGroupMenu(cellId, groupSquare!);
      });
      row.insertBefore(groupSquare, symbolEl);
    }

    if (color) {
      groupSquare.style.backgroundColor = color;
      groupSquare.style.borderColor = 'rgba(255, 255, 255, 0.4)';
      groupSquare.title = `Group: ${group.toUpperCase()} (Click to change)`;
    } else {
      groupSquare.style.backgroundColor = 'transparent';
      groupSquare.style.borderColor = 'rgba(148, 163, 184, 0.5)';
      groupSquare.title = 'No Group (Click to assign)';
    }

    // 2. Make upper-left symbol interactive and clickable
    if (!symbolEl.dataset.omegaSymbolInteractive) {
      symbolEl.dataset.omegaSymbolInteractive = 'true';
      symbolEl.style.cursor = 'pointer';
      symbolEl.title = 'Click to change asset for this chart';
      symbolEl.classList.add('omega-statusline-symbol');

      symbolEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openSymbolPickerForCell(cellId, symbolEl);
      });
    }

    // 3. Make upper-left timeframe interactive
    const metaEl = statusline.querySelector<HTMLElement>('.vela-sl-meta');
    if (metaEl && !metaEl.dataset.omegaMetaInteractive) {
      metaEl.dataset.omegaMetaInteractive = 'true';
      metaEl.style.cursor = 'pointer';
      metaEl.title = 'Click to change timeframe for this chart';
      metaEl.classList.add('omega-statusline-meta');
      metaEl.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.openTimeframeMenu(cellId, metaEl);
      });
    }

    // 4. Compact chart-type + period code inside every chart's own statusline:
    //    Hm5 (Heikin 5m), Re50 (Renko 50 pips), Ra200 (Range 200 pips), 5m.
    if (metaEl) {
      let styleChip = row.querySelector<HTMLElement>('.omega-statusline-style');
      if (!styleChip) {
        styleChip = document.createElement('span');
        styleChip.className = 'omega-statusline-style';
        styleChip.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          this.openTimeframeMenu(cellId, styleChip!);
        });
        metaEl.insertAdjacentElement('afterend', styleChip);
      }
      const style = String(cell.chart.renderer.get('priceStyle') ?? 'candles');
      const timeframe = cell.chart.market.timeframe ?? '60';
      const config = cell.chart.renderer.getConfig() as { chartTypes?: Record<string, { brickPips?: string | number; customBrickPips?: number }> } | null;
      const persistedPips = Number(config?.chartTypes?.[style]?.customBrickPips || config?.chartTypes?.[style]?.brickPips || 0);
      const pips = persistedPips > 0 ? persistedPips : 5;
      const code = chartStyleCode(style, timeframe, pips);
      if (styleChip.textContent !== code) styleChip.textContent = code;
      styleChip.title = `${chartStyleName(style)} · ${formatTimeframeLabel(timeframe)} — click to change`;
    }
  }

  public updateCell(cellId: string): void {
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    const group = this.deps.getGroupForCell(cellId) || '';
    const color = group ? (GROUP_COLOR_HEX[group] ?? '') : '';

    this.attachStatuslineIntegration(cellId);

    // Active outline state
    const isActive = workspace.active?.id === cellId;
    if (isActive) {
      cell.host.dataset.omegaActive = 'true';
      cell.host.dataset.active = '1';
    } else {
      delete cell.host.dataset.omegaActive;
      if (workspace.active?.id !== cellId) {
        delete cell.host.dataset.active;
      }
    }
    const borderColor = color || '#4778ffff';
    cell.host.style.setProperty('--active-chart-border', borderColor);
    cell.host.style.setProperty('--active-chart-glow', color ? `${color}66` : 'rgba(41, 98, 255, 0.35)');
    if (color) {
      cell.host.style.setProperty('--vela-cell-group-color', color);
      cell.host.dataset.groupColor = group;
    } else {
      cell.host.style.removeProperty('--vela-cell-group-color');
      delete cell.host.dataset.groupColor;
    }
  }

  public updateAll(): void {
    const workspace = this.deps.getWorkspace();
    for (const cell of workspace.cells()) {
      this.updateCell(cell.id);
    }
  }

  private closePopup(): void {
    if (this.activePopup) {
      this.activePopup.remove();
      this.activePopup = null;
    }
  }

  private openGroupMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();

    const currentGroup = this.deps.getGroupForCell(cellId) || '';
    const menu = document.createElement('div');
    menu.className = 'omega-cell-popup omega-group-menu';

    const title = document.createElement('div');
    title.className = 'omega-popup-title';
    title.textContent = 'Chart Grouping';
    menu.appendChild(title);

    const options: Array<{ id: string; label: string; color: string }> = [
      { id: '', label: 'None (Unlink)', color: 'transparent' },
      { id: 'red', label: 'Red Group', color: GROUP_COLOR_HEX.red },
      { id: 'blue', label: 'Blue Group', color: GROUP_COLOR_HEX.blue },
      { id: 'green', label: 'Green Group', color: GROUP_COLOR_HEX.green },
      { id: 'yellow', label: 'Yellow Group', color: GROUP_COLOR_HEX.yellow },
      { id: 'purple', label: 'Purple Group', color: GROUP_COLOR_HEX.purple },
    ];

    for (const opt of options) {
      const item = document.createElement('button');
      item.className = 'omega-group-item';
      if (opt.id === currentGroup) item.classList.add('selected');

      const swatch = document.createElement('span');
      swatch.className = 'omega-group-item-swatch';
      swatch.style.backgroundColor = opt.color;
      if (!opt.id) {
        swatch.style.border = '1px dashed #94a3b8';
      }

      const text = document.createElement('span');
      text.textContent = opt.label;

      item.append(swatch, text);

      item.addEventListener('click', async () => {
        this.closePopup();
        await this.deps.onSetCellGroup(cellId, opt.id);
        this.updateAll();
      });

      menu.appendChild(item);
    }

    this.positionPopup(menu, anchor);
  }

  public openSymbolPickerForCell(cellId: string, anchor: HTMLElement): void {
    if (!this.deps.getWorkspace().cell(cellId)) return;
    this.closePopup();
    this.openSymbolFallback(cellId, anchor);
  }

  private openSymbolFallback(cellId: string, anchor: HTMLElement): void {
    const picker = document.createElement('div');
    picker.className = 'omega-cell-popup omega-symbol-picker';

    const search = document.createElement('input');
    search.className = 'omega-symbol-search-input';
    search.type = 'search';
    search.placeholder = 'Search or enter a symbol';
    search.setAttribute('aria-label', 'Search assets');
    const source = document.createElement('select');
    source.className = 'omega-symbol-source-select';
    source.setAttribute('aria-label', 'Market data source');
    const list = document.createElement('div');
    list.className = 'omega-symbol-list';
    picker.append(source, search, list);

    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;
    const providers = cell.chart.data.providers();
    const currentProvider = cell.chart.market.symbol
      ? cell.chart.data.resolve(cell.chart.market.symbol)?.provider?.toLowerCase() ?? ''
      : '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All connected feeds';
    source.append(all);
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider.name.toLowerCase();
      option.textContent = provider.displayName ?? provider.name;
      source.append(option);
    }
    const preferredProvider = this.preferredDataProvider || currentProvider;
    if (preferredProvider && !providers.some(provider => provider.name.toLowerCase() === preferredProvider)) {
      source.add(new Option(`${preferredProvider} (not connected)`, preferredProvider));
    }
    source.value = preferredProvider || '';
    source.disabled = providers.length === 0;

    const selectedProvider = () => source.value.trim().toLowerCase();

    const render = () => {
      const query = search.value.trim().toUpperCase();
      list.replaceChildren();
      const provider = selectedProvider();
      const symbols = provider
        ? cell.chart.data.symbols(provider)
        : cell.chart.data.symbols();
      const matches = symbols.filter(item => !query
        || item.ticker.toUpperCase().includes(query)
        || item.description?.toUpperCase().includes(query)
        || item.type?.toUpperCase().includes(query)).slice(0, 200);
      const connected = providers.some(item => item.name.toLowerCase() === provider);
      if (query && (!provider || connected) && !matches.some(item => item.ticker.toUpperCase() === query)) {
        const custom = document.createElement('button');
        custom.type = 'button';
        custom.className = 'omega-symbol-item custom-match';
        const target = provider ? `${provider}:${query}` : query;
        custom.textContent = `Use ${target}`;
        custom.addEventListener('click', () => this.applySymbol(cellId, target));
        list.append(custom);
      }
      if (!matches.length && !query) {
        const empty = document.createElement('div');
        empty.className = 'omega-symbol-empty';
        empty.textContent = provider && !connected
          ? `${provider} is selected as the trading account, but its market-data feed is not connected. Connect it from the Broker or Local Feeds panel.`
          : provider
            ? 'This feed has no loaded symbols yet.'
            : 'No connected feeds are available.';
        list.append(empty);
      }
      for (const item of matches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'omega-symbol-item';
        const main = document.createElement('span');
        main.className = 'omega-symbol-main';
        const symbol = document.createElement('strong');
        symbol.textContent = item.ticker;
        const name = document.createElement('small');
        name.textContent = item.description ?? item.ticker;
        main.append(symbol, name);
        const category = document.createElement('span');
        category.className = 'omega-symbol-cat';
        category.textContent = item.provider ?? provider ?? item.type ?? '';
        button.append(main, category);
        const target = `${(item.provider ?? provider ?? '').toLowerCase()}:${item.ticker}`;
        button.addEventListener('click', () => this.applySymbol(cellId, target.startsWith(':') ? item.ticker : target));
        list.append(button);
      }
    };
    search.addEventListener('input', render);
    source.addEventListener('change', () => {
      search.value = '';
      render();
      search.focus();
    });
    search.addEventListener('keydown', event => {
      if (event.key === 'Enter' && search.value.trim()) {
        const ticker = search.value.trim().toUpperCase();
        const provider = selectedProvider();
        this.applySymbol(cellId, provider ? `${provider}:${ticker}` : ticker);
      }
    });
    render();
    this.positionPopup(picker, anchor);
    search.focus();
  }

  private selectPreferredProvider(source: HTMLSelectElement): void {
    if (![...source.options].some(option => option.value === this.preferredDataProvider)) {
      source.add(new Option(`${this.preferredDataProvider} (not connected)`, this.preferredDataProvider));
    }
    source.value = this.preferredDataProvider;
  }

  private openTimeframeMenu(cellId: string, anchor: HTMLElement): void {
    this.closePopup();

    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    const popup = document.createElement('div');
    popup.className = 'omega-cell-popup omega-tf-menu';

    // The chart statusline opens the SAME full period/type selector as the
    // toolbar (standard periods, ticks, Renko, Range, Heikin Ashi) instead of a
    // reduced list. Activate the clicked cell first: the toolbar handlers apply
    // to the active chart.
    const fullGrid = document.getElementById('ctrader-timeframe-grid');
    if (fullGrid) {
      if (workspace.active?.id !== cellId) workspace.setActiveCell(cellId);
      popup.classList.add('omega-tf-full');
      const clone = fullGrid.cloneNode(true) as HTMLElement;
      clone.removeAttribute('id');
      clone.querySelectorAll<HTMLElement>('[id]').forEach(element => element.removeAttribute('id'));
      // Tick periods need MetaTrader's one-tick input; explain instead of
      // silently ignoring the click.
      if (!cell.chart.market.symbol?.startsWith('MT5:')) {
        for (const tickButton of clone.querySelectorAll<HTMLButtonElement>('button[data-timeframe^="T"]')) {
          tickButton.disabled = true;
          tickButton.title = 'Tick bars require a connected MetaTrader 5 symbol.';
        }
      }
      clone.addEventListener('click', event => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-style]');
        if (!button) return;
        event.preventDefault();
        const match = [...fullGrid.querySelectorAll<HTMLButtonElement>('button[data-style]')].find(candidate =>
          candidate.dataset.style === button.dataset.style
          && (button.dataset.timeframe ? candidate.dataset.timeframe === button.dataset.timeframe : !candidate.dataset.timeframe)
          && (button.dataset.pips ? candidate.dataset.pips === button.dataset.pips : !candidate.dataset.pips));
        this.closePopup();
        match?.click();
        this.updateCell(cellId);
      });
      popup.append(clone);

      const custom = this.buildCustomTimeframeForm((timeframe) => {
        void applyTimeframe(cell.chart, timeframe).then(() => {
          this.closePopup();
          this.updateCell(cellId);
        });
      });
      popup.append(custom);
      this.positionPopup(popup, anchor);
      return;
    }

    const currentTf = cell.chart.market.timeframe ?? '60';
    const sections = [
      { title: 'Minutes', options: [['1m', '1'], ['2m', '2'], ['3m', '3'], ['5m', '5'], ['10m', '10'], ['15m', '15'], ['30m', '30']] },
      { title: 'Hours', options: [['1h', '60'], ['2h', '120'], ['3h', '180'], ['4h', '240'], ['6h', '360'], ['8h', '480'], ['12h', '720']] },
      { title: 'Days', options: [['1D', 'D'], ['2D', '2880'], ['3D', '4320'], ['1W', 'W'], ['1M', 'M']] },
    ] as const;

    const choose = async (timeframe: string) => {
      await applyTimeframe(cell.chart, timeframe);
      this.closePopup();
      this.updateCell(cellId);
    };

    for (const section of sections) {
      const heading = document.createElement('span');
      heading.className = 'omega-tf-heading';
      heading.textContent = section.title;
      popup.appendChild(heading);
      for (const [label, value] of section.options) {
      const btn = document.createElement('button');
      btn.className = 'omega-tf-item';
      if (value === currentTf) {
        btn.classList.add('selected');
      }
      btn.textContent = label;

      btn.addEventListener('click', () => {
        void choose(value);
      });

      popup.appendChild(btn);
      }
    }

    popup.append(this.buildCustomTimeframeForm((timeframe) => { void choose(timeframe); }));

    this.positionPopup(popup, anchor);
  }

  private buildCustomTimeframeForm(onApply: (timeframe: string) => void): HTMLFormElement {
    const custom = document.createElement('form');
    custom.className = 'omega-tf-custom';
    const customInput = document.createElement('input');
    customInput.type = 'number';
    customInput.min = '1';
    customInput.max = '1440';
    customInput.placeholder = 'Custom minutes';
    customInput.inputMode = 'numeric';
    const apply = document.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    custom.append(customInput, apply);
    custom.addEventListener('submit', event => {
      event.preventDefault();
      const minutes = Number(customInput.value);
      if (Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 1440) onApply(String(minutes));
      else customInput.setCustomValidity('Enter whole minutes from 1 to 1440.');
    });
    return custom;
  }

  private applySymbol(cellId: string, symbol: string): void {
    this.closePopup();
    const workspace = this.deps.getWorkspace();
    const cell = workspace.cell(cellId);
    if (!cell) return;

    // Apply symbol ONLY (preserves existing timeframe)
    void cell.chart.setMarket({ symbol });
    this.updateCell(cellId);

    // If part of group, also update symbol on same-group cells (each preserves its OWN timeframe!)
    const group = this.deps.getGroupForCell(cellId);
    if (group) {
      for (const other of workspace.cells()) {
        if (other.id !== cellId && this.deps.getGroupForCell(other.id) === group) {
          void other.chart.setMarket({ symbol });
          this.updateCell(other.id);
        }
      }
    }
  }

  private positionPopup(popup: HTMLElement, anchor: HTMLElement): void {
    document.body.appendChild(popup);
    this.activePopup = popup;

    const rect = anchor.getBoundingClientRect();
    const popupWidth = popup.offsetWidth || 240;

    let left = rect.left;
    let top = rect.bottom + 4;

    // Boundary protection
    if (left + popupWidth > window.innerWidth - 10) {
      left = window.innerWidth - popupWidth - 10;
    }
    if (left < 10) left = 10;

    const popupHeight = popup.offsetHeight || 0;
    if (top + popupHeight > window.innerHeight - 10) {
      top = Math.max(10, window.innerHeight - popupHeight - 10);
    }

    popup.style.position = 'fixed';
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }
}
