/**
 * Human-readable labels for chart periods and chart styles.
 *
 * The toolbar selector is labelled simply "Timeframe"; the active period and
 * style are rendered on the chart itself (for example "Heikin 1m").
 */

export function formatTimeframeLabel(timeframe: string): string {
  const tickMatch = /^T([1-9]\d{0,4})$/i.exec(timeframe);
  if (tickMatch) return `${tickMatch[1]}T`;
  if (/^\d+$/.test(timeframe)) {
    const minutes = Number(timeframe);
    if (minutes % 1440 === 0) return `${minutes / 1440}D`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return ({ D: '1D', W: '1W', M: '1M' } as Record<string, string>)[timeframe] ?? timeframe;
}

export function chartViewLabel(style: string, timeframe: string, pips = 5): string {
  const period = formatTimeframeLabel(timeframe);
  if (style === 'heikinashi') return `Heikin ${period}`;
  if (style === 'renko') return `Renko ${pips} pips`;
  if (style === 'range') return `Range ${pips} pips`;
  if (style && style !== 'candles') return `${style.charAt(0).toUpperCase()}${style.slice(1)} · ${period}`;
  return period;
}

export function chartStyleName(style: string): string {
  const names: Record<string, string> = {
    candles: 'Candles',
    heikinashi: 'Heikin Ashi',
    renko: 'Renko',
    range: 'Range',
    line: 'Line',
    area: 'Area',
    bars: 'Bars',
    baseline: 'Baseline',
    hollow: 'Hollow candles',
  };
  if (names[style]) return names[style];
  return style.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^[a-z]/, character => character.toUpperCase());
}

/**
 * Compact per-chart statusline code: Hm5 (Heikin Ashi 5m), Re50 (Renko
 * 50 pips), Ra200 (Range 200 pips), 5m (candles).
 */
export function chartStyleCode(style: string, timeframe: string, pips = 5): string {
  const period = formatTimeframeLabel(timeframe);
  const compactPeriod = period.endsWith('m') ? period.slice(0, -1) : period;
  if (style === 'heikinashi') return `Hm${compactPeriod}`;
  if (style === 'renko') return `Re${pips}`;
  if (style === 'range') return `Ra${pips}`;
  if (!style || style === 'candles') return period;
  const prefixes: Record<string, string> = {
    line: 'Li',
    area: 'Ar',
    bars: 'Ba',
    baseline: 'Bl',
    hollow: 'Ho',
  };
  const prefix = prefixes[style] ?? style.slice(0, 2).replace(/^[a-z]/, character => character.toUpperCase());
  return `${prefix}${compactPeriod}`;
}
