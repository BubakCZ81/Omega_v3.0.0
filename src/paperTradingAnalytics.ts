import type { StrategyState, StrategyTrade } from '@luxalgo/vela';
import { calculateBacktestAnalytics, type BacktestAnalytics } from './backtestStats.ts';

export interface PaperLedgerTrade {
  id: string;
  side: 'buy' | 'sell';
  lots: number;
  entryPrice: number;
  entryTime: number;
  closePrice?: number;
  closeTime?: number;
  pnl?: number;
  commission?: number;
  currency?: string;
}

export interface PaperAccountSnapshot {
  initialCapital: number;
  equity: number;
  realisedPnl: number;
  openPnl: number;
  analytics: BacktestAnalytics;
}

/**
 * Normalises manual paper trades to the same ledger contract as the PineTS/Vela
 * strategy output. Execution stays independent; only accounting is shared.
 */
export function calculatePaperAccount(
  initialCapital: number,
  closedTrades: readonly PaperLedgerTrade[],
  openTrades: readonly PaperLedgerTrade[],
): PaperAccountSnapshot {
  const safeCapital = Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 100_000;
  const toStrategyTrade = (trade: PaperLedgerTrade, open: boolean): StrategyTrade => ({
    id: trade.id,
    side: trade.side === 'buy' ? 'long' : 'short',
    qty: trade.lots,
    entry: { id: `${trade.id}:entry`, time: trade.entryTime, price: trade.entryPrice },
    ...(open ? {} : { exit: { id: `${trade.id}:exit`, time: trade.closeTime ?? trade.entryTime, price: trade.closePrice ?? trade.entryPrice } }),
    open,
    ...(typeof trade.pnl === 'number' ? { pnl: trade.pnl } : {}),
    ...(typeof trade.commission === 'number' ? { commission: trade.commission } : {}),
  });
  const ledger = [...closedTrades.map(trade => toStrategyTrade(trade, false)), ...openTrades.map(trade => toStrategyTrade(trade, true))];
  const realisedPnl = closedTrades.reduce((sum, trade) => sum + (Number.isFinite(trade.pnl) ? trade.pnl as number : 0), 0);
  const openPnl = openTrades.reduce((sum, trade) => sum + (Number.isFinite(trade.pnl) ? trade.pnl as number : 0), 0);
  let runningEquity = safeCapital;
  let peak = safeCapital;
  let trough = safeCapital;
  let maxDrawdown = 0;
  let maxRunup = 0;
  for (const trade of [...closedTrades].sort((left, right) => (left.closeTime ?? 0) - (right.closeTime ?? 0))) {
    runningEquity += Number.isFinite(trade.pnl) ? trade.pnl as number : 0;
    peak = Math.max(peak, runningEquity);
    trough = Math.min(trough, runningEquity);
    maxDrawdown = Math.max(maxDrawdown, peak - runningEquity);
    maxRunup = Math.max(maxRunup, runningEquity - trough);
  }
  const state: StrategyState = {
    position: 0,
    avgPrice: 0,
    equity: safeCapital + realisedPnl + openPnl,
    openPnl,
    netPnl: realisedPnl,
    grossProfit: closedTrades.reduce((sum, trade) => sum + Math.max(0, trade.pnl ?? 0), 0),
    grossLoss: closedTrades.reduce((sum, trade) => sum + Math.abs(Math.min(0, trade.pnl ?? 0)), 0),
    wins: closedTrades.filter(trade => (trade.pnl ?? 0) > 0).length,
    losses: closedTrades.filter(trade => (trade.pnl ?? 0) < 0).length,
    even: closedTrades.filter(trade => (trade.pnl ?? 0) === 0).length,
    maxDrawdown,
    maxRunup,
    initialCapital: safeCapital,
  };
  const analytics = calculateBacktestAnalytics(state, ledger);
  return { initialCapital: safeCapital, equity: state.equity, realisedPnl, openPnl, analytics };
}
