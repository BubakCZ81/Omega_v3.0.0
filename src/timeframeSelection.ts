export interface TimeframeChart {
  readonly market: { timeframe?: string };
  setMarket(market: { timeframe: string }): Promise<void>;
}

export interface TimeframeInputState {
  value: number;
  unit: 'minutes' | 'hours' | 'days' | 'ticks';
}

export function timeframeInputState(timeframe: string): TimeframeInputState | null {
  const tickMatch = /^T([1-9]\d{0,4})$/i.exec(timeframe);
  if (tickMatch) {
    const ticks = Number(tickMatch[1]);
    return Number.isSafeInteger(ticks) && ticks <= 10_000 ? { value: ticks, unit: 'ticks' } : null;
  }

  let minutes: number;
  if (timeframe === 'D' || timeframe === '1D' || timeframe === 'D1') minutes = 1440;
  else if (timeframe === 'W' || timeframe === '1W' || timeframe === 'W1') minutes = 10080;
  else if (/^\d+$/.test(timeframe)) minutes = Number(timeframe);
  else return null;

  if (!Number.isSafeInteger(minutes) || minutes < 1) return null;
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export async function applyTimeframe(chart: TimeframeChart, timeframe: string): Promise<string> {
  await chart.setMarket({ timeframe });
  let actual = chart.market.timeframe ?? '60';
  if (actual !== timeframe) {
    await chart.setMarket({ timeframe });
    actual = chart.market.timeframe ?? '60';
  }
  return actual;
}
