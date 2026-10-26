import { inferPipSize } from './orderFlowCharts.ts';

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function getMetadataValue(info: Record<string, unknown> | undefined, keys: string[]): number | null {
  for (const key of keys) {
    const value = positiveNumber(info?.[key]);
    if (value !== null) return value;
  }
  return null;
}

export function cleanPaperTradeSymbol(symbol: string | undefined | null): string {
  return (symbol ?? '').trim().toUpperCase();
}

export function getPaperTradeQuoteCurrency(symbol: string, info: Record<string, unknown> | undefined): string {
  const metadataCurrency = [
    info?.quoteCurrency,
    info?.quote_currency,
    info?.quoteCurrencyCode,
    info?.currency_code,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (metadataCurrency) return metadataCurrency.trim().toUpperCase();

  const ticker = symbol.split(':').at(-1)?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? '';
  for (const suffix of ['USDT', 'USDC', 'BUSD']) {
    if (ticker.endsWith(suffix)) return suffix;
  }
  return ticker.length >= 6 ? ticker.slice(-3) : 'USD';
}

export function getPaperTradeContractSize(
  ticker: string,
  info: Record<string, unknown> | undefined,
): number {
  const metadataSize = getMetadataValue(info, ['contractSize', 'contract_size', 'lotSize', 'lot_size']);
  if (metadataSize !== null) return metadataSize;
  return inferPipSize(ticker) === null ? 1 : 100_000;
}

export function getPaperTradeMinTick(ticker: string, info: Record<string, unknown> | undefined): number {
  return getMetadataValue(info, ['minTick', 'mintick', 'pipSize', 'pip_size'])
    ?? inferPipSize(ticker)
    ?? 0.01;
}

/**
 * Pip size used by the "pips" protection mode. On a 5-digit FX symbol the
 * broker's minimum tick is one tenth of a pip, so protection distances must not
 * be derived from the tick size.
 */
export function getPaperTradePipSize(ticker: string, info: Record<string, unknown> | undefined): number {
  return getMetadataValue(info, ['pipSize', 'pip_size', 'pointSize', 'point_size'])
    ?? inferPipSize(ticker)
    ?? getPaperTradeMinTick(ticker, info);
}

function decimalPlaces(value: number): number {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText ?? 0);
  const decimals = coefficient.includes('.') ? coefficient.length - coefficient.indexOf('.') - 1 : 0;
  return Math.max(0, Math.min(10, decimals - exponent));
}

export function formatPaperTradePrice(price: number, minTick: number): string {
  return price.toFixed(Math.max(2, decimalPlaces(minTick)));
}

export function formatPaperTradeLots(lots: number): string {
  return lots.toFixed(2);
}
