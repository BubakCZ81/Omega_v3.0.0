import {
  registerNativeIndicator,
  registerRendererLayer,
  type IndicatorHandle,
  type NativeIndicatorContext,
  type RendererLayerArgs,
  type Vela,
} from '@luxalgo/vela';

const LAYER_ID = 'bid-ask-lines';
const REFRESH_INTERVAL_MS = 2_000;

interface BidAskQuote {
  bid: number;
  ask: number;
  updatedAt: number;
  bidColor: string;
  askColor: string;
  lineWidth: number;
  lineStyle: BidAskLineStyle['lineStyle'];
}

interface QuoteResponse {
  bid: number;
  ask: number;
}

export interface BidAskLineStyle {
  bidColor: string;
  askColor: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
}

export const BID_ASK_COLOR_OPTIONS = [
  ['#26a69a', 'Green'],
  ['#ef5350', 'Red'],
  ['#2962ff', 'Blue'],
  ['#ff9800', 'Orange'],
  ['#ab47bc', 'Purple'],
  ['#ffffff', 'White'],
] as const;

export const BID_ASK_WIDTH_OPTIONS = [1, 2, 3, 4, 5] as const;
export const BID_ASK_STYLE_OPTIONS = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
] as const;

const BID_COLOR_KEY = 'vela_bid_ask_bid_color';
const ASK_COLOR_KEY = 'vela_bid_ask_ask_color';
const WIDTH_KEY = 'vela_bid_ask_line_width';
const STYLE_KEY = 'vela_bid_ask_line_style';

export function loadBidAskLineStyle(): BidAskLineStyle {
  const colors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
  const storedBid = localStorage.getItem(BID_COLOR_KEY);
  const storedAsk = localStorage.getItem(ASK_COLOR_KEY);
  const storedWidth = Number(localStorage.getItem(WIDTH_KEY) ?? '1');
  const storedStyle = localStorage.getItem(STYLE_KEY);
  return {
    bidColor: storedBid && colors.includes(storedBid as typeof colors[number]) ? storedBid : BID_ASK_COLOR_OPTIONS[0][0],
    askColor: storedAsk && colors.includes(storedAsk as typeof colors[number]) ? storedAsk : BID_ASK_COLOR_OPTIONS[1][0],
    lineWidth: BID_ASK_WIDTH_OPTIONS.includes(storedWidth as typeof BID_ASK_WIDTH_OPTIONS[number]) ? storedWidth : 1,
    lineStyle: BID_ASK_STYLE_OPTIONS.some(([style]) => style === storedStyle)
      ? storedStyle as BidAskLineStyle['lineStyle']
      : 'dashed',
  };
}

function saveBidAskLineStyle(style: BidAskLineStyle) {
  localStorage.setItem(BID_COLOR_KEY, style.bidColor);
  localStorage.setItem(ASK_COLOR_KEY, style.askColor);
  localStorage.setItem(WIDTH_KEY, String(style.lineWidth));
  localStorage.setItem(STYLE_KEY, style.lineStyle);
}

export function isQuoteResponse(value: unknown): value is QuoteResponse {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Record<string, unknown>;
  return typeof quote.bid === 'number'
    && Number.isFinite(quote.bid)
    && typeof quote.ask === 'number'
    && Number.isFinite(quote.ask)
    && quote.bid > 0
    && quote.ask >= quote.bid;
}

export async function fetchBidAskQuote(provider: string, ticker: string, signal: AbortSignal): Promise<QuoteResponse | null> {
  const symbol = ticker.toUpperCase();
  let response: Response;

  if (provider === 'mt5') {
    if (!window.velaMt5) throw new Error('MetaTrader quotes are available only in the Omega desktop app.');
    const quote = await window.velaMt5.quote(ticker);
    return isQuoteResponse(quote) ? quote : null;
  }

  if (provider === 'binance') {
    const perpetual = /\.P$/i.test(symbol);
    const exchangeSymbol = symbol.replace(/\.P$/i, '');
    const baseUrl = perpetual ? 'https://fapi.binance.com/fapi/v1/ticker/bookTicker' : 'https://api.binance.com/api/v3/ticker/bookTicker';
    response = await fetch(`${baseUrl}?symbol=${encodeURIComponent(exchangeSymbol)}`, { signal });
    if (!response.ok) throw new Error(`Binance quote request failed (${response.status}).`);
    const data = await response.json() as { bidPrice?: string; askPrice?: string };
    const quote = { bid: Number(data.bidPrice), ask: Number(data.askPrice) };
    return isQuoteResponse(quote) ? quote : null;
  }

  if (provider === 'coinbase') {
    response = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`, { signal });
    if (!response.ok) throw new Error(`Coinbase quote request failed (${response.status}).`);
    const data = await response.json() as { bid?: string; ask?: string };
    const quote = { bid: Number(data.bid), ask: Number(data.ask) };
    return isQuoteResponse(quote) ? quote : null;
  }

  if (provider === 'hyperliquid') {
    response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin: symbol }),
      signal,
    });
    if (!response.ok) throw new Error(`Hyperliquid quote request failed (${response.status}).`);
    const data = await response.json() as { levels?: Array<Array<{ px?: string }>> };
    const quote = {
      bid: Number(data.levels?.[0]?.[0]?.px),
      ask: Number(data.levels?.[1]?.[0]?.px),
    };
    return isQuoteResponse(quote) ? quote : null;
  }

  return null;
}

function drawQuote(ctx: CanvasRenderingContext2D, args: RendererLayerArgs, quote: BidAskQuote) {
  const { coords, bounds, scale, theme } = args;
  const width = coords.width;
  const dpr = coords.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, coords.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bounds.top, width, bounds.height);
  ctx.clip();

  const lines = [
    { label: 'BID', price: quote.bid, color: quote.bidColor },
    { label: 'ASK', price: quote.ask, color: quote.askColor },
  ];
  const dash = quote.lineStyle === 'solid' ? [] : quote.lineStyle === 'dotted' ? [2, 3] : [5, 4];
  for (const line of lines) {
    const y = coords.priceToY(line.price, scale, bounds);
    if (!Number.isFinite(y)) continue;
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = quote.lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const text = `${line.label} ${line.price.toLocaleString(undefined, { maximumSignificantDigits: 8 })}`;
    ctx.font = '600 10px sans-serif';
    const labelWidth = ctx.measureText(text).width + 10;
    ctx.fillStyle = theme.background;
    ctx.fillRect(width - labelWidth - 4, y - 8, labelWidth, 16);
    ctx.fillStyle = line.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width - labelWidth + 1, y);
  }
  ctx.restore();
}

registerRendererLayer({
  id: LAYER_ID,
  placement: 'above-data',
  create: () => {
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null = null;
    return {
      mount: mountedCanvas => {
        canvas = mountedCanvas;
        ctx = canvas.getContext('2d');
      },
      render: args => {
        if (!ctx) return;
        const quote = args.data as BidAskQuote | null | undefined;
        if (!quote || Date.now() - quote.updatedAt > REFRESH_INTERVAL_MS * 3) {
          ctx.setTransform(args.coords.dpr, 0, 0, args.coords.dpr, 0, 0);
          ctx.clearRect(0, 0, args.coords.width, args.coords.height);
          return;
        }
        drawQuote(ctx, args, quote);
      },
    };
  },
});

registerNativeIndicator({
  type: LAYER_ID,
  title: 'Bid and Ask',
  shortTitle: 'Bid/Ask',
  paneHint: 'price',
  overlay: true,
  legend: false,
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    let timer: number | undefined;
    let request: AbortController | undefined;
    let warnedFor = '';
    let running = false;
    let generation = 0;

    const stopPolling = () => {
      running = false;
      generation++;
      window.clearTimeout(timer);
      request?.abort();
    };

    const poll = async (ctx: NativeIndicatorContext, currentGeneration: number) => {
      if (!running || currentGeneration !== generation) return;
      const resolved = ctx.data.resolve(ctx.symbol);
      if (!resolved) {
        ctx.pushData(null);
      } else {
        request?.abort();
        request = new AbortController();
        try {
          const quote = await fetchBidAskQuote(resolved.provider, resolved.ticker, request.signal);
          if (running && currentGeneration === generation) {
            ctx.pushData(quote ? { ...quote, ...loadBidAskLineStyle(), updatedAt: Date.now() } : null);
            warnedFor = '';
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            const key = `${resolved.provider}:${resolved.ticker}`;
            if (warnedFor !== key) {
              console.warn(`Bid/ask quote unavailable for ${key}:`, error);
              warnedFor = key;
            }
          }
          if (running && currentGeneration === generation) ctx.pushData(null);
        }
      }
      if (running && currentGeneration === generation) {
        timer = window.setTimeout(() => void poll(ctx, currentGeneration), REFRESH_INTERVAL_MS);
      }
    };

    return {
      start: ctx => {
        context = ctx;
        running = true;
        generation++;
        void poll(ctx, generation);
      },
      onBars: () => undefined,
      onViewport: () => undefined,
      setInputs: () => undefined,
      suspend: stopPolling,
      resume: () => {
        if (!running) {
          running = true;
          generation++;
          if (context) void poll(context, generation);
        }
      },
      stop: () => {
        stopPolling();
        context = undefined;
      },
    };
  },
});

export function createBidAskLinesController(chart: Pick<Vela, 'addNativeIndicator' | 'indicators'>) {
  let enabled = localStorage.getItem('vela_show_bid_ask_lines') === 'true';
  let handle: IndicatorHandle | null = null;

  const setEnabled = (next: boolean) => {
    enabled = next;
    localStorage.setItem('vela_show_bid_ask_lines', String(next));
    if (enabled && !handle) handle = chart.addNativeIndicator(LAYER_ID);
    if (!enabled && handle) {
      handle.remove();
      handle = null;
    }
  };

  const setStyle = (style: BidAskLineStyle) => {
    const colors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
    if (!colors.includes(style.bidColor as typeof colors[number]) || !colors.includes(style.askColor as typeof colors[number])) {
      throw new Error('Choose a supported bid/ask line color.');
    }
    if (!BID_ASK_WIDTH_OPTIONS.includes(style.lineWidth as typeof BID_ASK_WIDTH_OPTIONS[number])) {
      throw new Error('Choose a bid/ask line width from 1 to 5.');
    }
    if (!BID_ASK_STYLE_OPTIONS.some(([lineStyle]) => lineStyle === style.lineStyle)) {
      throw new Error('Choose a supported bid/ask line style.');
    }
    saveBidAskLineStyle(style);
    if (handle) {
      handle.remove();
      handle = chart.addNativeIndicator(LAYER_ID);
    }
  };

  if (enabled) {
    handle = chart.addNativeIndicator(LAYER_ID);
  } else {
    for (const indicator of chart.indicators()) {
      if (indicator.nativeType === LAYER_ID) indicator.remove();
    }
  }

  return {
    setEnabled,
    setStyle,
    destroy: () => {
      handle?.remove();
      handle = null;
    },
  };
}
