import { applyTimeframe, timeframeInputState } from './timeframeSelection';
import { formatTimeframeLabel } from './chartViewLabel';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

type PeriodChoice = { label: string; timeframe?: string; style: string; pips?: number; disabled?: boolean };

export function initializeChartTimeframeControls(workspace: VelaWorkspace): { sync(): void } {
  const customTimeframeMenu = document.getElementById('custom-timeframe-menu') as HTMLDetailsElement;
  const customTimeframeValue = document.getElementById('custom-timeframe-value') as HTMLInputElement;
  const customTimeframeUnit = document.getElementById('custom-timeframe-unit') as HTMLSelectElement;
  const timeframeHelp = document.getElementById('timeframe-help') as HTMLElement;
  const applyTimeframeButton = document.getElementById('apply-custom-timeframe') as HTMLButtonElement;
  const chartTypeSelect = document.getElementById('chart-type-select') as HTMLSelectElement;
  const ctraderTimeframeMenu = document.getElementById('ctrader-timeframe-menu') as HTMLDetailsElement;
  const ctraderTimeframeGrid = document.getElementById('ctrader-timeframe-grid') as HTMLElement;
  const selectedPipsByCell = new Map<string, number>();

  const sync = (): void => {
    const timeframe = workspace.chart.market.timeframe ?? '60';
    customTimeframeMenu.querySelector('summary')!.textContent = formatTimeframeLabel(timeframe);
    const input = timeframeInputState(timeframe);
    if (input) {
      customTimeframeValue.value = String(input.value);
      customTimeframeUnit.value = input.unit;
    }
    const style = workspace.chart.renderer.get('priceStyle');
    const styleLabel = typeof style === 'string' && style !== 'candles'
      ? (style === 'heikinashi' ? `Heikin ${formatTimeframeLabel(timeframe)}` : style[0].toUpperCase() + style.slice(1))
      : formatTimeframeLabel(timeframe);
    const summary = ctraderTimeframeMenu.querySelector('summary')!;
    summary.textContent = 'Timeframe';
    summary.title = `Chart timeframe: ${styleLabel}`;
    summary.setAttribute('aria-label', `Chart timeframe: ${styleLabel}. Choose a period or chart type.`);
    const rendererConfig = workspace.chart.renderer.getConfig() as { chartTypes?: Record<string, { brickPips?: string | number; customBrickPips?: number }> } | null;
    const persistedPips = Number(rendererConfig?.chartTypes?.[String(style)]?.customBrickPips || rendererConfig?.chartTypes?.[String(style)]?.brickPips || 0);
    for (const button of ctraderTimeframeGrid.querySelectorAll<HTMLButtonElement>('button[data-style]')) {
      const activePips = persistedPips > 0 ? persistedPips : selectedPipsByCell.get(workspace.active.id) ?? 5;
      const selected = button.dataset.style === style
        && (button.dataset.pips ? Number(button.dataset.pips) === activePips : button.dataset.timeframe === timeframe);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    if (typeof style === 'string' && Array.from(chartTypeSelect.options).some(option => option.value === style)) {
      chartTypeSelect.value = style;
    }
  };

  const setChartStyle = async (cell: ReturnType<typeof workspace.cell> | undefined, style: string): Promise<void> => {
    if (!cell) return;
    const chart = cell.chart;
    if ((style === 'renko' || style === 'range')
      && chart.market.symbol?.startsWith('MT5:')
      && (chart.market.timeframe ?? '').toUpperCase() !== 'T1') {
      const actualTimeframe = await applyTimeframe(chart, 'T1');
      if (actualTimeframe !== 'T1') {
        throw new Error(`Could not switch to tick input for ${style}; the chart is still showing ${formatTimeframeLabel(actualTimeframe)}.`);
      }
    }
    chart.renderer.set('priceStyle', style);
  };

  const updateChartStyleHelp = (cell: ReturnType<typeof workspace.cell> | undefined, style: string): void => {
    delete timeframeHelp.dataset.state;
    if (style === 'renko' || style === 'range') {
      timeframeHelp.textContent = cell?.chart.market.symbol?.startsWith('MT5:')
        ? `${style === 'renko' ? 'Renko' : 'Range'} uses MT5 one-tick input for more accurate price sequencing.`
        : `${style === 'renko' ? 'Renko' : 'Range'} uses this feed’s OHLC bars; intrabar price order is estimated without raw ticks.`;
    } else {
      timeframeHelp.textContent = '';
    }
  };

  const standardPeriods: PeriodChoice[] = [
    ['1 minute', '1'], ['2 minutes', '2'], ['3 minutes', '3'], ['4 minutes', '4'], ['5 minutes', '5'], ['6 minutes', '6'], ['7 minutes', '7'], ['8 minutes', '8'], ['10 minutes', '10'], ['15 minutes', '15'], ['20 minutes', '20'], ['30 minutes', '30'], ['45 minutes', '45'], ['1 hour', '60'], ['2 hours', '120'], ['3 hours', '180'], ['4 hours', '240'], ['6 hours', '360'], ['8 hours', '480'], ['12 hours', '720'], ['1 day', 'D'], ['1 week', 'W'],
  ].map(([label, timeframe]) => ({ label, timeframe, style: 'candles' }));
  const pipSizes = [
    1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 80, 100, 150,
    200, 300, 500, 800, 1000, 1200, 1500, 1800, 2000, 2500, 3000,
  ];
  const tickSizes = [
    1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 250, 300,
    400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000,
  ];

  const addPeriodColumn = (title: string, prefix: string, choices: PeriodChoice[]): void => {
    const column = document.createElement('section');
    column.className = 'ctrader-timeframe-column';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('div');
    list.className = 'ctrader-timeframe-list';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = Boolean(choice.disabled);
      button.dataset.style = choice.style;
      if (choice.timeframe) button.dataset.timeframe = choice.timeframe;
      if (choice.pips) button.dataset.pips = String(choice.pips);
      const key = document.createElement('kbd');
      key.textContent = choice.pips ? `${prefix}${choice.pips}` : prefix;
      button.append(key, document.createTextNode(choice.pips ? `${choice.pips} pips` : choice.label));
      button.addEventListener('click', async () => {
        const cell = workspace.cell(workspace.active.id);
        if (!cell) return;
        window.velaDiagnostics?.record({
          source: 'timeframe', type: 'selection', name: 'timeframe.selected', status: 'start',
          message: `${choice.style} ${choice.timeframe ?? `${choice.pips} pips`}`,
        });
        if (choice.timeframe?.startsWith('T') && !cell.chart.market.symbol?.startsWith('MT5:')) {
          timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
          timeframeHelp.dataset.state = 'error';
          return;
        }
        if (choice.timeframe) {
          try {
            const actualTimeframe = await applyTimeframe(cell.chart, choice.timeframe);
            if (actualTimeframe !== choice.timeframe) {
            timeframeHelp.textContent = `Could not load ${formatTimeframeLabel(choice.timeframe)} bars; the chart is still showing ${formatTimeframeLabel(actualTimeframe)}.`;
            timeframeHelp.dataset.state = 'error';
            window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.rejected', status: 'error', message: timeframeHelp.textContent });
            return;
            }
            timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
            delete timeframeHelp.dataset.state;
          } catch (error) {
            timeframeHelp.textContent = `Could not load timeframe: ${error instanceof Error ? error.message : String(error)}`;
            timeframeHelp.dataset.state = 'error';
            window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.failed', status: 'error', message: timeframeHelp.textContent });
            return;
          }
        }
        if (choice.pips) {
          cell.chart.renderer.applyConfig({ chartTypes: { [choice.style]: { mode: 'pips', brickPips: String(choice.pips), customBrickPips: 0 } } });
          selectedPipsByCell.set(cell.id, choice.pips);
        }
        try {
          await setChartStyle(cell, choice.style);
        } catch (error) {
          timeframeHelp.textContent = error instanceof Error ? error.message : String(error);
          timeframeHelp.dataset.state = 'error';
          return;
        }
        updateChartStyleHelp(cell, choice.style);
        chartTypeSelect.value = choice.style;
        ctraderTimeframeMenu.open = false;
        sync();
        window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.applied', status: 'ok', message: `${choice.style} ${cell.chart.market.timeframe ?? 'unknown'}` });
      });
      list.append(button);
    }
    column.append(heading, list);
    ctraderTimeframeGrid.append(column);
  };

  addPeriodColumn('Standard', 'M', standardPeriods);
  addPeriodColumn('Tick', 'T', tickSizes.map(value => ({
    label: `${value} ticks`, timeframe: `T${value}`, style: 'candles',
  })));
  addPeriodColumn('Renko', 'R', pipSizes.map(pips => ({ label: `${pips} pips`, style: 'renko', pips })));
  addPeriodColumn('Range', 'Ra', pipSizes.map(pips => ({ label: `${pips} pips`, style: 'range', pips })));
  addPeriodColumn('Heikin Ashi', 'H', standardPeriods.map(item => ({ ...item, style: 'heikinashi' })));

  applyTimeframeButton.addEventListener('click', async () => {
    const amount = Number(customTimeframeValue.value);
    const unit = customTimeframeUnit.value;
    if (!Number.isSafeInteger(amount) || amount < 1) {
      timeframeHelp.textContent = 'Enter a positive whole number.';
      return;
    }
    const targetCell = workspace.cell(workspace.active.id);
    if (!targetCell) {
      timeframeHelp.textContent = 'Could not find the active chart.';
      return;
    }
    let timeframe: string;
    if (unit === 'ticks') {
      if (!targetCell.chart.market.symbol?.startsWith('MT5:')) {
        timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      if (amount > 10_000) {
        timeframeHelp.textContent = 'Choose no more than 10,000 ticks per bar.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      timeframe = `T${amount}`;
    } else {
      const multiplier = unit === 'hours' ? 60 : unit === 'days' ? 1440 : 1;
      const maxMinutes = unit === 'days' ? 30 * 1440 : unit === 'hours' ? 24 * 60 : 1440;
      const minutes = amount * multiplier;
      if (!Number.isSafeInteger(minutes) || minutes > maxMinutes) {
        timeframeHelp.textContent = `Choose an interval no larger than ${unit === 'days' ? '30 days' : unit === 'hours' ? '24 hours' : '1,440 minutes'}.`;
        return;
      }
      timeframe = unit === 'days' && amount === 1 ? 'D' : String(minutes);
    }
    applyTimeframeButton.disabled = true;
    timeframeHelp.textContent = 'Loading timeframe…';
    try {
      const actualTimeframe = await applyTimeframe(targetCell.chart, timeframe);
      sync();
      if (actualTimeframe !== timeframe) {
        timeframeHelp.textContent = `Timeframe change did not complete. The chart is still showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
        timeframeHelp.dataset.state = 'error';
      } else {
        timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
        delete timeframeHelp.dataset.state;
        customTimeframeMenu.open = false;
      }
    } catch (error) {
      sync();
      timeframeHelp.textContent = `Could not load timeframe: ${error instanceof Error ? error.message : String(error)}`;
      timeframeHelp.dataset.state = 'error';
    } finally {
      applyTimeframeButton.disabled = false;
    }
  });

  chartTypeSelect.addEventListener('change', () => {
    const cell = workspace.cell(workspace.active.id);
    if (!cell) return;
    const style = chartTypeSelect.value;
    void setChartStyle(cell, style).then(() => {
      updateChartStyleHelp(cell, style);
      sync();
    }).catch(error => {
      timeframeHelp.textContent = error instanceof Error ? error.message : String(error);
      timeframeHelp.dataset.state = 'error';
      sync();
    });
  });

  workspace.chart.on('priceStyle:change', event => {
    if (Array.from(chartTypeSelect.options).some(option => option.value === event.to)) {
      chartTypeSelect.value = event.to;
    }
  });

  sync();
  return { sync };
}
