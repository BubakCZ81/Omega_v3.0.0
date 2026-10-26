import type { Vela } from '@luxalgo/vela';
import { fetchBidAskQuote } from './bidAskLines';
import { inferPipSize } from './orderFlowCharts';
import { formatSpreadByPriceDigits, resolveSpreadDigits } from './spreadFormatting';

const POLL_INTERVAL_MS = 1_000;
const EMPTY_VALUE = '0.0';
let lastValidSpreadText = '';

interface SpreadReadoutRow {
  row: HTMLDivElement;
  value: HTMLSpanElement;
}

function findVolumeRow(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('.vela-dw-row'))
    .find(row => row.querySelector('.vela-dw-label')?.textContent?.trim().toLowerCase() === 'volume') ?? null;
}

function ensureSpreadReadout(): SpreadReadoutRow | null {
  const volumeRow = findVolumeRow();
  if (!volumeRow) return null;

  const existing = volumeRow.parentElement?.querySelector<HTMLElement>('[data-omega-spread-readout]');
  if (existing instanceof HTMLDivElement) {
    const value = existing.querySelector<HTMLSpanElement>('.vela-dw-value');
    if (value) {
      if (lastValidSpreadText && (value.textContent === EMPTY_VALUE || !value.textContent)) {
        value.textContent = lastValidSpreadText;
      }
      return { row: existing, value };
    }
  }

  const row = document.createElement('div');
  row.className = 'vela-dw-row';
  row.dataset.omegaSpreadReadout = 'true';
  row.title = 'Current bid/ask spread in pips';

  const label = document.createElement('span');
  label.className = 'vela-dw-label';
  label.textContent = 'Spread';

  const value = document.createElement('span');
  value.className = 'vela-dw-value';
  value.dir = 'ltr';
  value.textContent = lastValidSpreadText || EMPTY_VALUE;
  row.append(label, value);
  volumeRow.after(row);
  return { row, value };
}

export function initializeSpreadReadout(getChart: () => Vela): () => void {
  let disposed = false;
  let timer: number | undefined;
  let request: AbortController | undefined;
  let currentSymbol = '';
  let metadataPromise: Promise<Record<string, unknown> | undefined> | null = null;
  let metadataSymbol = '';
  let warnedFor = '';
  let polling = false;

  const poll = async () => {
    if (disposed || polling) return;
    polling = true;
    const startedAt = Date.now();
    timer = undefined;
    const scheduleNextPoll = () => {
      if (!disposed) {
        timer = window.setTimeout(
          () => void poll(),
          Math.max(0, startedAt + POLL_INTERVAL_MS - Date.now()),
        );
      }
    };
    const readout = ensureSpreadReadout();
    if (!readout || readout.row.getClientRects().length === 0) {
      request?.abort();
      polling = false;
      scheduleNextPoll();
      return;
    }

    const chart = getChart();
    const symbol = chart.market.symbol ?? '';
    const resolved = symbol ? chart.data.resolve(symbol) : null;
    const requestKey = resolved ? `${symbol}:${resolved.provider}:${resolved.ticker}` : symbol;
    if (requestKey !== currentSymbol) {
      request?.abort();
      currentSymbol = requestKey;
      metadataSymbol = '';
      metadataPromise = null;
      lastValidSpreadText = '';
      readout.value.textContent = EMPTY_VALUE;
    }

    if (!symbol || !resolved) {
      lastValidSpreadText = '';
      readout.value.textContent = EMPTY_VALUE;
      polling = false;
      scheduleNextPoll();
      return;
    }

    if (symbol !== metadataSymbol) {
      metadataSymbol = symbol;
      metadataPromise = chart.data.symbolInfo(symbol)
        .then(info => info as Record<string, unknown> | undefined)
        .catch(error => {
          const key = `${resolved.provider}:${resolved.ticker}`;
          if (warnedFor !== key) {
            console.warn(`Could not read price precision for ${key}:`, error);
            warnedFor = key;
          }
          return undefined;
        });
    }

    request?.abort();
    request = new AbortController();
    const activeRequest = request;
    try {
      const [quote, info] = await Promise.all([
        fetchBidAskQuote(resolved.provider, resolved.ticker, activeRequest.signal),
        metadataPromise ?? Promise.resolve(undefined),
      ]);
      if (disposed || activeRequest.signal.aborted || currentSymbol !== requestKey) return;
      if (quote) {
        const digits = resolveSpreadDigits(info, quote.bid, quote.ask, inferPipSize(resolved.ticker));
        const formatted = formatSpreadByPriceDigits(quote.bid, quote.ask, digits);
        lastValidSpreadText = formatted;
        readout.value.textContent = formatted;
        document.dispatchEvent(new CustomEvent('omega:spread-updated'));
        warnedFor = '';
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const key = `${resolved.provider}:${resolved.ticker}`;
        if (warnedFor !== key) {
          console.warn(`Could not update the data-window spread for ${key}:`, error);
          warnedFor = key;
        }
      }
    } finally {
      polling = false;
      if (currentSymbol === requestKey) scheduleNextPoll();
    }
  };

  const observer = new MutationObserver(() => {
    const readout = ensureSpreadReadout();
    if (!readout) return;
    if (lastValidSpreadText && readout.value.textContent !== lastValidSpreadText) {
      readout.value.textContent = lastValidSpreadText;
    }
    if (timer === undefined) void poll();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (ensureSpreadReadout()) void poll();

  return () => {
    disposed = true;
    observer.disconnect();
    window.clearTimeout(timer);
    request?.abort();
  };
}
