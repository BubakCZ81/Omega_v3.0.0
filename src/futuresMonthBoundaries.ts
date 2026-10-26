import {
  registerNativeIndicator,
  registerRendererLayer,
  type NativeIndicatorContext,
  type RendererLayerArgs,
  type Vela,
} from '@luxalgo/vela';

const LAYER_ID = 'omega-futures-month-boundaries';

export interface FuturesMonthBoundary {
  time: number;
  label: string;
}

export function buildFuturesMonthBoundaries(from: number, to: number): FuturesMonthBoundary[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  const start = new Date(from);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  let time = Date.UTC(year, month, 1);
  if (time < from) {
    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
    time = Date.UTC(year, month, 1);
  }

  const boundaries: FuturesMonthBoundary[] = [];
  while (time <= to) {
    const currentMonth = new Date(time).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    const previousMonth = new Date(time - 1).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    boundaries.push({ time, label: `${currentMonth} START / ${previousMonth} END` });
    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
    time = Date.UTC(year, month, 1);
  }
  return boundaries;
}

function clearCanvas(ctx: CanvasRenderingContext2D, args: RendererLayerArgs) {
  ctx.setTransform(args.coords.dpr, 0, 0, args.coords.dpr, 0, 0);
  ctx.clearRect(0, 0, args.coords.width, args.coords.height);
}

registerRendererLayer({
  id: LAYER_ID,
  placement: 'above-data',
  create: () => {
    let ctx: CanvasRenderingContext2D | null = null;
    return {
      mount: canvas => {
        ctx = canvas.getContext('2d');
      },
      render: args => {
        if (!ctx) return;
        clearCanvas(ctx, args);
        const range = args.coords.visibleTimeRange();
        const boundaries = buildFuturesMonthBoundaries(range.from, range.to);
        if (!boundaries.length) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, args.bounds.top, args.coords.width, args.bounds.height);
        ctx.clip();
        ctx.font = '600 10px sans-serif';
        ctx.textBaseline = 'top';
        ctx.setLineDash([4, 4]);
        for (const boundary of boundaries) {
          const x = args.coords.timeToX(boundary.time);
          if (!Number.isFinite(x) || x < 0 || x > args.coords.width) continue;
          ctx.strokeStyle = 'rgba(255, 176, 64, 0.65)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, args.bounds.top);
          ctx.lineTo(x, args.bounds.top + args.bounds.height);
          ctx.stroke();

          ctx.setLineDash([]);
          const padding = 5;
          const labelWidth = ctx.measureText(boundary.label).width + padding * 2;
          const labelX = Math.max(0, Math.min(args.coords.width - labelWidth, x + 4));
          const labelY = args.bounds.top + 4;
          ctx.fillStyle = args.theme.background;
          ctx.globalAlpha = 0.88;
          ctx.fillRect(labelX, labelY, labelWidth, 16);
          ctx.globalAlpha = 1;
          ctx.fillStyle = args.theme.textColor;
          ctx.fillText(boundary.label, labelX + padding, labelY + 3);
          ctx.setLineDash([4, 4]);
        }
        ctx.restore();
      },
    };
  },
});

registerNativeIndicator({
  type: LAYER_ID,
  title: 'Futures Month Boundaries',
  shortTitle: 'Month Boundaries',
  paneHint: 'price',
  overlay: true,
  legend: false,
  reactsToViewport: true,
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    const publish = () => context?.pushData({ enabled: true });
    return {
      start: ctx => {
        context = ctx;
        publish();
      },
      onBars: () => undefined,
      onViewport: () => publish(),
      setInputs: () => undefined,
      suspend: () => undefined,
      resume: publish,
      stop: () => {
        publish();
        context = undefined;
      },
    };
  },
});

const chartControllers = new WeakMap<Vela, () => void>();

function isFuturesSymbol(chart: Vela): boolean {
  const symbol = chart.market.symbol?.trim();
  const resolved = symbol ? chart.data.resolve(symbol) : null;
  if (!resolved) return false;
  return chart.data.symbols(resolved.provider).some(descriptor =>
    descriptor.ticker.toUpperCase() === resolved.ticker.toUpperCase()
      && descriptor.type?.toLowerCase() === 'futures');
}

export function attachFuturesMonthBoundaries(chart: Vela): () => void {
  const existing = chartControllers.get(chart);
  if (existing) return existing;

  let handle: ReturnType<Vela['addNativeIndicator']> | null = null;
  let generation = 0;
  let disposed = false;
  const sync = async () => {
    const request = ++generation;
    try {
      await chart.data.ready();
      if (disposed || request !== generation) return;
      if (isFuturesSymbol(chart)) {
        handle ??= chart.addNativeIndicator(LAYER_ID);
      } else if (handle) {
        handle.remove();
        handle = null;
      }
    } catch (error) {
      console.error('Could not update futures month-boundary markers:', error);
    }
  };
  const unsubscribe = chart.on('market:changed', () => { void sync(); });
  void sync();
  const dispose = () => {
    disposed = true;
    generation += 1;
    unsubscribe();
    handle?.remove();
    handle = null;
    chartControllers.delete(chart);
  };
  chartControllers.set(chart, dispose);
  return dispose;
}
