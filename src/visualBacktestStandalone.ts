import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { AlpacaDataProvider } from './alpacaFeed';
import { PersistentCandleProvider } from './persistentCandleCache';
import './visualBacktestStandalone.css';

type BacktestConfig = { symbol: string; timeframe: string; provider?: string };

const host = document.getElementById('visual-backtest-chart')!;
const market = document.getElementById('visual-backtest-market')!;
const status = document.getElementById('visual-backtest-status')!;
const chartType = document.getElementById('visual-backtest-chart-type') as HTMLSelectElement;
const reset = document.getElementById('visual-backtest-reset') as HTMLButtonElement;
const play = document.getElementById('visual-backtest-play') as HTMLButtonElement;
const step = document.getElementById('visual-backtest-step') as HTMLButtonElement;
const stop = document.getElementById('visual-backtest-stop') as HTMLButtonElement;
let workspace: VelaWorkspace | null = null;
let config: BacktestConfig | null = null;
let unsubscribeConfig: (() => void) | null = null;

function setStatus(message: string, state: 'ok' | 'error' | 'info' = 'info'): void {
  status.textContent = message;
  status.dataset.state = state;
  window.velaDiagnostics?.record({ source: 'visual-backtest', type: 'lifecycle', name: 'standalone', status: state === 'error' ? 'error' : 'ok', message });
}

function syncControls(): void {
  const state = workspace?.replay.state;
  const active = Boolean(state?.active);
  play.disabled = !active || state?.remaining === 0;
  step.disabled = !active || state?.remaining === 0;
  stop.disabled = !active;
  play.textContent = state?.playing ? 'Pause' : 'Play';
}

async function startAtBeginning(): Promise<void> {
  if (!workspace) return;
  workspace.replay.stop();
  const bounds = workspace.active.chart.replay.bounds;
  if (!bounds) { setStatus('Historical candles are still loading.'); return; }
  await workspace.replay.start({ from: bounds.first, cell: workspace.active.id });
  setStatus('Replay is ready at the first historical candle.', 'ok');
  syncControls();
}

async function applyChartType(): Promise<void> {
  if (!workspace) return;
  const style = chartType.value;
  const chart = workspace.active.chart;
  if (style === 'renko' || style === 'range') {
    chart.renderer.applyConfig({
      chartTypes: { [style]: { mode: 'pips', brickPips: '5', customBrickPips: 0 } },
    });
  }
  try {
    await chart.renderer.set('priceStyle', style);
    setStatus(`${chartType.options[chartType.selectedIndex]?.text ?? style} applied to the isolated chart.`, 'ok');
  } catch (error) {
    setStatus(`Could not apply chart type: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

async function open(configured: BacktestConfig): Promise<void> {
  config = { ...configured, symbol: configured.symbol.trim().toUpperCase(), timeframe: configured.timeframe.trim() || '60' };
  if (workspace) { workspace.destroy(); workspace = null; }
  host.replaceChildren();
  market.textContent = `${config.symbol} · ${config.timeframe}`;
  setStatus('Loading isolated chart and historical candles…');
  const bridge = window.velaBroker;
  const alpaca = bridge?.fetchHistoricalBars ? new AlpacaDataProvider(bridge) : null;
  alpaca?.setConnected(config.provider === 'alpaca');
  const symbol = config.provider === 'alpaca' ? `alpaca:${config.symbol}` : config.symbol;
  workspace = new VelaWorkspace(host, {
    layout: '1', symbol, timeframe: config.timeframe, live: false, volume: false,
    topbar: { left: [] },
    providers: {
      binance: () => new PersistentCandleProvider(new BinanceProvider()),
      ...(alpaca ? { alpaca: () => alpaca } : {}),
    },
  });
  workspace.replay.on('replay:start', syncControls);
  workspace.replay.on('replay:step', syncControls);
  workspace.replay.on('replay:pause', syncControls);
  workspace.replay.on('replay:end', syncControls);
  try {
    await workspace.active.chart.ready();
    await startAtBeginning();
  } catch (error) {
    setStatus(`Could not load isolated backtest chart: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

reset.addEventListener('click', () => void startAtBeginning());
chartType.addEventListener('change', () => void applyChartType());
step.addEventListener('click', () => { workspace?.replay.step(); syncControls(); });
play.addEventListener('click', () => {
  if (!workspace) return;
  if (workspace.replay.state.playing) workspace.replay.pause();
  else workspace.replay.play(1);
  syncControls();
});
stop.addEventListener('click', () => { workspace?.replay.stop(); syncControls(); });
window.addEventListener('beforeunload', () => { unsubscribeConfig?.(); workspace?.destroy(); });
unsubscribeConfig = window.velaVisualBacktestWindow?.onOpenConfig(next => void open(next)) ?? null;
if (!unsubscribeConfig) setStatus('This window must be opened from Omega.', 'error');
