import {
  registerChartType,
  registerRendererLayer,
  type ChartTypeDefinition,
  type RendererLayerArgs,
  type SeriesDataEngine,
  type SeriesDataEngineHost,
} from '@luxalgo/vela';

export interface RenkoBrick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PositionedRenkoBrick {
  brick: RenkoBrick;
  logical: number;
  width: number;
}

const MAX_BRICKS_PER_BAR = 500;
const FX_CURRENCIES = new Set([
  'AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD',
]);
const RENKO_PIP_OPTIONS = [
  ...Array.from({ length: 50 }, (_, index) => index + 1),
  ...Array.from({ length: 10 }, (_, index) => 55 + index * 5),
  ...Array.from({ length: 8 }, (_, index) => 150 + index * 50),
  ...Array.from({ length: 25 }, (_, index) => 600 + index * 100),
].map(value => [String(value), `${value} pips`] as [string, string]);

function finiteSetting(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function averageTrueRange(bars: readonly { high: number; low: number; close: number }[], length: number): number {
  const start = Math.max(0, bars.length - Math.max(1, Math.floor(length)));
  let total = 0;
  let count = 0;
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1]?.close ?? bar.close;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

export function inferPipSize(symbol: string): number | null {
  const normalized = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  for (let index = 0; index <= normalized.length - 6; index += 1) {
    const base = normalized.slice(index, index + 3);
    const quote = normalized.slice(index + 3, index + 6);
    if (FX_CURRENCIES.has(base) && FX_CURRENCIES.has(quote)) {
      return quote === 'JPY' ? 0.01 : 0.0001;
    }
  }
  return null;
}

export function buildRenkoBricks(
  bars: readonly { time: number; open: number; high: number; low: number; close: number }[],
  options: { mode?: unknown; source?: unknown; boxSize?: unknown; atrLength?: unknown; brickPips?: unknown; customBrickPips?: unknown; pipSize?: unknown; symbol?: string } = {},
): RenkoBrick[] {
  if (bars.length < 2) return [];
  const atrLength = Math.max(1, Math.floor(finiteSetting(options.atrLength, 14)));
  const inferredPipSize = inferPipSize(options.symbol ?? '');
  const configuredPipSize = finiteSetting(options.pipSize, 0);
  const pipSize = configuredPipSize > 0 ? configuredPipSize : inferredPipSize ?? 0.01;
  const customBrickPips = finiteSetting(options.customBrickPips, 0);
  const brickPips = customBrickPips > 0 ? customBrickPips : finiteSetting(options.brickPips, 5);
  if (options.mode === 'pips' && (!Number.isSafeInteger(brickPips) || brickPips < 1 || brickPips > 3000)) return [];
  const boxSize = options.mode === 'fixed'
    ? finiteSetting(options.boxSize, 1)
    : options.mode === 'pips'
      ? brickPips * pipSize
      : averageTrueRange(bars, atrLength);
  if (!(boxSize > 0) || !Number.isFinite(boxSize)) return [];

  let anchor = bars[0].close;
  let direction = 0;
  const bricks: RenkoBrick[] = [];
  const processTarget = (target: number, source: typeof bars[number]) => {
    let barBrickCount = 0;
    while (barBrickCount < MAX_BRICKS_PER_BAR && bricks.length < 100_000) {
      let nextDirection = direction;
      let open = anchor;
      let close = anchor;
      // Price arithmetic is binary floating point, so an exact one-box move can
      // land a few ulps short. Compare with a tiny relative tolerance.
      const tolerance = Math.max(boxSize, Math.abs(anchor)) * 1e-9;

      if (direction === 0) {
        if (target >= anchor + boxSize - tolerance) nextDirection = 1;
        else if (target <= anchor - boxSize + tolerance) nextDirection = -1;
        else break;
        close = anchor + nextDirection * boxSize;
      } else if ((target - anchor) * direction >= boxSize - tolerance) {
        nextDirection = direction;
        close = anchor + direction * boxSize;
      } else if ((target - anchor) * direction <= -2 * boxSize + tolerance) {
        // A reversal needs a two-brick move, and the first brick turns at the
        // previous brick's edge. The loop then draws any further bricks as a
        // normal continuation, keeping every brick the same size and connected.
        nextDirection = -direction;
        close = anchor + nextDirection * boxSize;
      } else {
        break;
      }

      bricks.push({
        time: source.time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
      });
      anchor = close;
      direction = nextDirection;
      barBrickCount += 1;
    }
  };

  for (let index = 1; index < bars.length && bricks.length < 100_000; index += 1) {
    const bar = bars[index];
    // Tick data is required for an exact non-time-based chart.  With OHLC data
    // this is the deterministic intrabar approximation used by the UI.
    const path = options.source === 'close'
      ? [bar.close]
      : bar.close >= bar.open
        ? [bar.open, bar.low, bar.high, bar.close]
        : [bar.open, bar.high, bar.low, bar.close];
    for (const target of path) processTarget(target, bar);
  }
  return bricks;
}

/**
 * Range bars are not Renko: a completed bar has High - Low exactly equal to
 * the selected range and closes at the High or Low.  There is no two-box
 * reversal rule.  With candle OHLC input this follows a documented, stable
 * intrabar path; live tick input can later replace that approximation.
 */
export function buildRangeBars(
  bars: readonly { time: number; open: number; high: number; low: number; close: number }[],
  options: { brickPips?: unknown; customBrickPips?: unknown; pipSize?: unknown; symbol?: string } = {},
): RenkoBrick[] {
  if (bars.length < 2) return [];
  const pipSize = finiteSetting(options.pipSize, 0) || inferPipSize(options.symbol ?? '') || 0.01;
  const configured = finiteSetting(options.customBrickPips, 0) || finiteSetting(options.brickPips, 5);
  const size = configured * pipSize;
  if (!(size > 0) || !Number.isFinite(size)) return [];
  const out: RenkoBrick[] = [];
  let current: RenkoBrick = {
    time: bars[0].time,
    open: bars[0].open,
    high: bars[0].open,
    low: bars[0].open,
    close: bars[0].open,
  };
  for (const bar of bars.slice(1)) {
    const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
    for (const target of path) {
      while (out.length < 100_000) {
        current.close = target;
        current.high = Math.max(current.high, target);
        current.low = Math.min(current.low, target);
        // Same floating-point caveat as Renko: allow an exact range to compare
        // equal even when the subtraction lands a few ulps short.
        const tolerance = Math.max(size, Math.abs(current.high), Math.abs(current.low)) * 1e-9;
        if (current.high - current.low < size - tolerance) break;

        // The tick that completes a range is necessarily one of its extremes.
        // Preserve the actual opening price and the opposite wick.
        const closesUp = target >= current.low + size - tolerance;
        const close = closesUp ? current.low + size : current.high - size;
        const completed: RenkoBrick = closesUp
          ? { ...current, time: bar.time, high: close, close }
          : { ...current, time: bar.time, low: close, close };
        out.push(completed);
        current = { time: bar.time, open: close, high: close, low: close, close };

        // A gap can cross several ranges. Feed the same target into the next
        // bar until its remaining price movement is fully consumed.
        if (Math.abs(target - close) <= tolerance) break;
      }
    }
  }
  return out;
}

function clearLayer(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
}

function renderRenko(args: RendererLayerArgs, _canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const bricks = isRenkoPayload(args.data) ? args.data : [];
  if (bricks.length === 0) return;
  const logicalByTime = new Map<number, number>();
  args.bars.forEach((bar, index) => {
    if (!logicalByTime.has(bar.time)) logicalByTime.set(bar.time, index);
  });
  const pitch = Math.max(1, args.coords.pxPerBar());
  const range = args.coords.visibleLogicalRange();
  const positioned = layoutRenkoBricks(bricks.map(brick => ({
    brick,
    logical: logicalByTime.get(brick.time) ?? args.coords.timeToLogical(brick.time),
  })), range, pitch);
  for (const { brick, logical, width } of positioned) {
    const x = args.coords.logicalToX(logical);
    const openY = args.coords.priceToY(brick.open, args.scale, args.bounds);
    const closeY = args.coords.priceToY(brick.close, args.scale, args.bounds);
    const rising = brick.close >= brick.open;
    const color = rising ? args.theme.upColor : args.theme.downColor;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const highY = args.coords.priceToY(brick.high, args.scale, args.bounds);
    const lowY = args.coords.priceToY(brick.low, args.scale, args.bounds);
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();
    const top = Math.min(openY, closeY);
    const height = Math.max(1, Math.abs(closeY - openY));
    ctx.fillRect(x - width / 2, top, width, height);
    ctx.strokeRect(x - width / 2, top, width, height);
  }
}

export function layoutRenkoBricks(
  entries: readonly { brick: RenkoBrick; logical: number }[],
  visibleRange: { from: number; to: number },
  pitch: number,
): PositionedRenkoBrick[] {
  if (!(pitch > 0) || !Number.isFinite(pitch)) return [];
  const sourceVisible = entries.filter(entry => Number.isFinite(entry.logical)
    && entry.logical >= visibleRange.from - 1 && entry.logical <= visibleRange.to + 1);
  // A Renko/Range bar has its own sequential x-axis.  Vela supplies the host
  // candle viewport to layers, so use it only as a window selector, then lay
  // synthetic bars into consecutive columns (never into time gaps).
  const capacity = Math.max(1, Math.ceil(visibleRange.to - visibleRange.from) + 2);
  const visible = sourceVisible.slice(-capacity);
  const firstLogical = visibleRange.to - visible.length + 0.5;
  const width = Math.max(2, Math.min(12, pitch * 0.72));
  return visible.map((entry, index) => ({
    brick: entry.brick,
    logical: firstLogical + index,
    width,
  }));
}

function isRenkoPayload(value: unknown): value is RenkoBrick[] {
  return Array.isArray(value) && value.every((brick: unknown) => {
    if (!brick || typeof brick !== 'object') return false;
    const item = brick as RenkoBrick;
    return [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite);
  });
}

class PipBarDataEngine implements SeriesDataEngine {
  private host: SeriesDataEngineHost | null = null;
  private settings: Record<string, unknown> = {};
  private symbolPipSize: number | null = null;
  private readonly build: typeof buildRenkoBricks;
  constructor(build: typeof buildRenkoBricks) { this.build = build; }

  start(host: SeriesDataEngineHost) {
    this.host = host;
    const inferredPipSize = inferPipSize(host.symbol);
    if (inferredPipSize !== null) {
      this.symbolPipSize = inferredPipSize;
    } else {
      void host.data.symbolInfo(host.symbol).then(info => {
        if (this.host !== host || !info) return;
        const candidate = Number(info.pipSize ?? info.pip_size ?? info.minTick ?? info.mintick);
        if (Number.isFinite(candidate) && candidate > 0) {
          this.symbolPipSize = candidate;
          this.recompute();
        }
      }).catch(error => {
        if (this.host !== host) return;
        console.warn(`Could not resolve Renko pip size for "${host.symbol}":`, error);
      });
    }
    this.recompute();
  }

  suspend() {}
  resume() { this.recompute(); }
  stop() {
    this.host = null;
    this.symbolPipSize = null;
  }
  onBars() { this.recompute(); }
  onSettings(settings: Record<string, unknown>) {
    this.settings = settings;
    this.recompute();
  }

  private recompute() {
    if (!this.host) return;
    const pipSize = finiteSetting(this.settings.pipSize, 0) > 0
      ? this.settings.pipSize
      : this.symbolPipSize ?? undefined;
    this.host.pushData(this.build(this.host.bars(), {
      ...this.settings,
      pipSize,
      symbol: this.host.symbol,
    }));
  }
}

function layer(id: string, render: (args: RendererLayerArgs, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void) {
  registerRendererLayer({
    id,
    placement: 'above-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      return {
        mount(target) {
          canvas = target;
        },
        render(args) {
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          clearLayer(ctx, canvas, args.coords.dpr);
          if (args.priceStyle === id) render(args, canvas, ctx);
        },
      };
    },
  });
}

const renko: ChartTypeDefinition = {
  id: 'renko',
  label: 'Renko',
  basePainting: 'none',
  dataEngine: () => new PipBarDataEngine(buildRenkoBricks),
  settings: {
    title: 'Renko',
    rows: [
      { kind: 'select', key: 'mode', label: 'Brick size mode', options: [['pips', 'Pips (cTrader style)'], ['atr', 'ATR'], ['fixed', 'Fixed price']], defval: 'pips' },
      { kind: 'select', key: 'source', label: 'Price source', options: [['close', 'Close only (standard)'], ['ohlc', 'OHLC (intrabar approximation)']], defval: 'close' },
      { kind: 'select', key: 'brickPips', label: 'Brick size', options: RENKO_PIP_OPTIONS, defval: '5', when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'customBrickPips', label: 'Custom brick size (1–3,000; 0 = preset)', defval: 0, min: 0, max: 3000, step: 1, when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'pipSize', label: 'Pip size override (price units, 0 = auto)', defval: 0, min: 0, step: 0.00001, when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'boxSize', label: 'Fixed brick size', defval: 1, min: 0.000001, step: 0.01, when: { key: 'mode', equals: 'fixed' } },
      { kind: 'number', key: 'atrLength', label: 'ATR length', defval: 14, min: 1, max: 500, step: 1, when: { key: 'mode', equals: 'atr' } },
    ],
  },
};

const range: ChartTypeDefinition = {
  id: 'range',
  label: 'Range',
  basePainting: 'none',
  dataEngine: () => new PipBarDataEngine(buildRangeBars),
  settings: {
    title: 'Range bars',
    rows: [
      { kind: 'select', key: 'brickPips', label: 'Range size', options: RENKO_PIP_OPTIONS, defval: '5' },
      { kind: 'number', key: 'customBrickPips', label: 'Custom range (pips, 0 = preset)', defval: 0, min: 0, max: 3000, step: 1 },
      { kind: 'number', key: 'pipSize', label: 'Pip size override (price units, 0 = auto)', defval: 0, min: 0, step: 0.00001 },
    ],
  },
};

export function registerOrderFlowChartTypes() {
  if (registered) return;
  registered = true;
  registerChartType(renko);
  registerChartType(range);
  layer('renko', renderRenko);
  layer('range', renderRenko);
}

let registered = false;
