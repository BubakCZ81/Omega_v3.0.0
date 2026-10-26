export type PaperTradeSide = 'buy' | 'sell';
export type PendingPaperOrderType = 'limit' | 'stop';

export function shouldTriggerPendingPaperOrder(
  side: PaperTradeSide,
  orderType: PendingPaperOrderType,
  entryPrice: number,
  bar: { high: number; low: number },
): boolean {
  if (![entryPrice, bar.high, bar.low].every(Number.isFinite)
    || entryPrice <= 0 || bar.low <= 0 || bar.high < bar.low) {
    return false;
  }
  if (orderType === 'limit') return side === 'buy' ? bar.low <= entryPrice : bar.high >= entryPrice;
  return side === 'buy' ? bar.high >= entryPrice : bar.low <= entryPrice;
}

export interface ProtectionLevels {
  stopLoss: number;
  takeProfit: number;
}

export type PaperTradeLevel = 'entry' | 'stopLoss' | 'takeProfit';

export function moveProtectionLevel(
  side: PaperTradeSide,
  level: Exclude<PaperTradeLevel, 'entry'>,
  entryPrice: number,
  price: number,
  minTick: number,
): number {
  if (![entryPrice, price, minTick].every(Number.isFinite)
    || entryPrice <= 0 || price <= 0 || minTick <= 0) {
    throw new RangeError('Entry price, level price, and minimum tick must be positive finite numbers.');
  }
  if (level === 'stopLoss') {
    return side === 'buy'
      ? Math.min(price, entryPrice - minTick)
      : Math.max(price, entryPrice + minTick);
  }
  return side === 'buy'
    ? Math.max(price, entryPrice + minTick)
    : Math.min(price, entryPrice - minTick);
}

export type ProtectionMode = 'pips' | 'atr';

export interface ProtectionConfig {
  mode: ProtectionMode;
  slValue: number;
  tpValue: number;
}

export function createConfiguredProtectionLevels(
  side: PaperTradeSide,
  entryPrice: number,
  minTick: number,
  config: ProtectionConfig,
  atr14?: number | null,
  pipSize: number = minTick,
): ProtectionLevels {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(minTick) || minTick <= 0) {
    throw new RangeError('Entry price and minTick must be positive finite numbers.');
  }

  const slVal = Number.isFinite(config.slValue) && config.slValue > 0 ? config.slValue : 20;
  const tpVal = Number.isFinite(config.tpValue) && config.tpValue > 0 ? config.tpValue : 40;
  const pipDistance = Number.isFinite(pipSize) && pipSize > 0 ? pipSize : minTick;

  let slDist: number;
  let tpDist: number;

  if (config.mode === 'atr') {
    if (typeof atr14 !== 'number' || !Number.isFinite(atr14) || atr14 <= 0) {
      throw new RangeError('ATR(14) is unavailable. Load at least 15 valid price bars before using ATR protection.');
    }
    const atr = atr14;
    slDist = slVal * atr;
    tpDist = tpVal * atr;
  } else {
    // "Pips" are the conventional pip distance, not the broker tick size.
    slDist = slVal * pipDistance;
    tpDist = tpVal * pipDistance;
  }

  slDist = Math.max(slDist, minTick);
  tpDist = Math.max(tpDist, minTick);

  return side === 'buy'
    ? { stopLoss: entryPrice - slDist, takeProfit: entryPrice + tpDist }
    : { stopLoss: entryPrice + slDist, takeProfit: entryPrice - tpDist };
}

export function calculatePaperTradePnl(
  side: PaperTradeSide,
  entryPrice: number,
  currentPrice: number,
  lots: number,
  contractSize: number,
): number {
  if (![entryPrice, currentPrice, lots, contractSize].every(Number.isFinite)
    || entryPrice <= 0 || currentPrice <= 0 || lots <= 0 || contractSize <= 0) {
    throw new RangeError('Prices, lot size, and contract size must be positive finite numbers.');
  }

  const movement = side === 'buy' ? currentPrice - entryPrice : entryPrice - currentPrice;
  return movement * lots * contractSize;
}

export function formatPaperTradePnl(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) throw new RangeError('P&L must be a finite number.');

  const sign = amount >= 0 ? '+' : '-';
  const absoluteAmount = Math.abs(amount);
  const normalizedCurrency = currency.trim().toUpperCase();
  const formattedAmount = absoluteAmount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  if (/^[A-Z]{3}$/.test(normalizedCurrency)) {
    const formattedCurrency = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(absoluteAmount);
    return `${sign}${formattedCurrency}`;
  }

  return `${sign}${formattedAmount}${normalizedCurrency ? ` ${normalizedCurrency}` : ''}`;
}
