import type { StrategyState, StrategyTrade } from '@luxalgo/vela';

export interface BacktestMetrics {
  closedTrades: number;
  openTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  equity: number;
  initialCapital: number;
  netProfit: number;
  openProfit: number;
  returnPercent: number | null;
  maxDrawdown: number;
  drawdownPercent: number | null;
}

export interface RealizedEquityPoint {
  time: number;
  equity: number;
  drawdown: number;
}

export interface MonthlyBacktestResult {
  month: string;
  netProfit: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface BacktestAnalytics extends BacktestMetrics {
  ledgerClosedTrades: number;
  totalCommission: number;
  grossProfit: number;
  grossLoss: number;
  averageTrade: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  payoffRatio: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  maxRunup: number;
  longTrades: number;
  shortTrades: number;
  longProfit: number;
  shortProfit: number;
  longestWinStreak: number;
  longestLossStreak: number;
  realizedEquity: readonly RealizedEquityPoint[];
  monthly: readonly MonthlyBacktestResult[];
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function monthFor(time: number): string {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  // Chart timestamps are UTC epoch milliseconds; bucket months in UTC so the
  // monthly table lines up with the chart's time axis.
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function calculateBacktestMetrics(state: StrategyState, trades: readonly StrategyTrade[]): BacktestMetrics {
  const closedTrades = trades.filter(trade => !trade.open);
  const openTrades = trades.filter(trade => trade.open);
  const realizedOutcomes = closedTrades.flatMap(trade => (
    typeof trade.pnl === 'number' && Number.isFinite(trade.pnl) ? [trade.pnl] : []
  ));
  const grossProfit = realizedOutcomes.reduce((sum, pnl) => sum + Math.max(0, pnl), 0);
  const grossLoss = realizedOutcomes.reduce((sum, pnl) => sum + Math.abs(Math.min(0, pnl)), 0);
  const closedCount = state.wins + state.losses + state.even;
  const initialCapital = state.initialCapital;

  return {
    closedTrades: closedCount,
    openTrades: openTrades.length,
    winRate: closedCount > 0 ? state.wins / closedCount * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
    equity: state.equity,
    initialCapital,
    netProfit: state.netPnl,
    openProfit: state.openPnl,
    returnPercent: initialCapital > 0 ? state.netPnl / initialCapital * 100 : null,
    maxDrawdown: state.maxDrawdown,
    drawdownPercent: initialCapital > 0 ? state.maxDrawdown / initialCapital * 100 : null,
  };
}

/**
 * Extends the engine account state with transparent, ledger-derived analytics.
 * The equity series is intentionally realised-only: Vela exposes trade events,
 * not a complete per-bar equity history.
 */
export function calculateBacktestAnalytics(state: StrategyState, trades: readonly StrategyTrade[]): BacktestAnalytics {
  const metrics = calculateBacktestMetrics(state, trades);
  const closed = trades
    .filter(trade => !trade.open && finite(trade.pnl) !== null)
    .sort((left, right) => (left.exit?.time ?? left.entry.time) - (right.exit?.time ?? right.entry.time));
  const pnls = closed.map(trade => trade.pnl as number);
  const wins = pnls.filter(pnl => pnl > 0);
  const losses = pnls.filter(pnl => pnl < 0);
  const totalCommission = trades.reduce((sum, trade) => sum + (finite(trade.commission) ?? 0), 0);
  const longTrades = closed.filter(trade => trade.side === 'long');
  const shortTrades = closed.filter(trade => trade.side === 'short');
  let equity = state.initialCapital;
  let peak = equity;
  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  const realizedEquity = closed.map(trade => {
    const pnl = trade.pnl as number;
    equity += pnl;
    peak = Math.max(peak, equity);
    if (pnl > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (pnl < 0) {
      lossStreak += 1;
      winStreak = 0;
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
    longestWinStreak = Math.max(longestWinStreak, winStreak);
    longestLossStreak = Math.max(longestLossStreak, lossStreak);
    return { time: trade.exit?.time ?? trade.entry.time, equity, drawdown: peak - equity };
  });
  const months = new Map<string, MonthlyBacktestResult>();
  for (const trade of closed) {
    const key = monthFor(trade.exit?.time ?? trade.entry.time);
    const current = months.get(key) ?? { month: key, netProfit: 0, trades: 0, wins: 0, losses: 0 };
    const pnl = trade.pnl as number;
    current.netProfit += pnl;
    current.trades += 1;
    if (pnl > 0) current.wins += 1;
    if (pnl < 0) current.losses += 1;
    months.set(key, current);
  }
  const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    ...metrics,
    ledgerClosedTrades: closed.length,
    totalCommission,
    grossProfit: state.grossProfit,
    grossLoss: state.grossLoss,
    averageTrade: average(pnls),
    averageWin: average(wins),
    averageLoss: average(losses),
    payoffRatio: wins.length && losses.length ? (average(wins) as number) / Math.abs(average(losses) as number) : null,
    largestWin: wins.length ? Math.max(...wins) : null,
    largestLoss: losses.length ? Math.min(...losses) : null,
    maxRunup: state.maxRunup,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longProfit: longTrades.reduce((sum, trade) => sum + (trade.pnl as number), 0),
    shortProfit: shortTrades.reduce((sum, trade) => sum + (trade.pnl as number), 0),
    longestWinStreak,
    longestLossStreak,
    realizedEquity,
    monthly: [...months.values()].sort((left, right) => left.month.localeCompare(right.month)),
  };
}
