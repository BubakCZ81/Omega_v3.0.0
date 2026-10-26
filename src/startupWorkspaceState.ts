const SCRIPT_INDICATOR_STATE_KEY = 'omega.scriptIndicators';

export function clearStartupIndicators(raw: string | null): string | null {
  if (!raw) return raw;

  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return raw;

  const document = state as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.charts)) return raw;

  const charts = document.charts.map(chart => {
    if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return chart;
    const entry = chart as Record<string, unknown>;
    const ext = entry.ext && typeof entry.ext === 'object' && !Array.isArray(entry.ext)
      ? { ...(entry.ext as Record<string, unknown>) }
      : null;
    if (ext) delete ext[SCRIPT_INDICATOR_STATE_KEY];

    const next: Record<string, unknown> = {
      ...entry,
      indicators: { manifest: [], natives: [] },
    };
    if (ext && Object.keys(ext).length) next.ext = ext;
    else delete next.ext;
    return next;
  });

  return JSON.stringify({ ...document, charts });
}
