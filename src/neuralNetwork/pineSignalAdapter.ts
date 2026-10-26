export const neuralSignalPlotKeys = ['NN_LONG_SIGNAL', 'NN_SHORT_SIGNAL'] as const;
export type NeuralSignalCompatibility = { ok: boolean; message: string; featureKeys: string[] };
export type NeuralTrainingSample = { features: number[]; label: 0 | 1 };

export function validateNeuralSignalSource(source: string | undefined): NeuralSignalCompatibility {
  if (!source) return { ok: false, message: 'Select a Pine indicator with source code.', featureKeys: [] };
  const plotNames = [...source.matchAll(/["'](NN_(?:LONG_SIGNAL|SHORT_SIGNAL|FEATURE_[A-Z0-9_]+))["']/gi)].map(match => match[1].toUpperCase());
  const missing = neuralSignalPlotKeys.filter(key => !plotNames.includes(key));
  const featureKeys = [...new Set(plotNames.filter(key => key.startsWith('NN_FEATURE_')))];
  if (missing.length) return { ok: false, message: `Missing required plot: ${missing.join(', ')}.`, featureKeys };
  if (!featureKeys.length) return { ok: false, message: 'Add at least one NN_FEATURE_* plot.', featureKeys };
  if (!featureKeys.includes('NN_FEATURE_CLOSE')) return { ok: false, message: 'Add NN_FEATURE_CLOSE to create settled training labels.', featureKeys };
  return { ok: true, message: `Ready: ${featureKeys.length} feature plots.`, featureKeys };
}

export interface NeuralSignalSeriesHandle { series(key: string): Promise<ReadonlyArray<{ time: number; value: number | null }>>; }
export async function loadNeuralSignalSeries(handle: NeuralSignalSeriesHandle, featureKeys: readonly string[]) {
  const keys = [...neuralSignalPlotKeys, ...featureKeys];
  return Object.fromEntries(await Promise.all(keys.map(async key => [key, await handle.series(key)]))) as Record<string, Awaited<ReturnType<NeuralSignalSeriesHandle['series']>>>;
}

export function buildNeuralTrainingSamples(series: Record<string, ReadonlyArray<{ time: number; value: number | null }>>, featureKeys: readonly string[], horizonBars = 12): NeuralTrainingSample[] {
  const longs = series.NN_LONG_SIGNAL ?? [], shorts = series.NN_SHORT_SIGNAL ?? [], close = series.NN_FEATURE_CLOSE ?? [];
  const length = Math.min(longs.length, shorts.length, close.length, ...featureKeys.map(key => (series[key] ?? []).length));
  const samples: NeuralTrainingSample[] = [];
  for (let index = 0; index + horizonBars < length; index += 1) {
    const long = Number(longs[index]?.value ?? 0) !== 0, short = Number(shorts[index]?.value ?? 0) !== 0;
    const entry = close[index]?.value, future = close[index + horizonBars]?.value;
    const values = featureKeys.map(key => series[key]?.[index]?.value);
    if (long === short || !Number.isFinite(entry) || !Number.isFinite(future) || values.some(value => !Number.isFinite(value))) continue;
    samples.push({ features: values as number[], label: (long ? 1 : -1) * (future! - entry!) > 0 ? 1 : 0 });
  }
  return samples;
}
