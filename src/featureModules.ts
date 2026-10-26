export const optionalModuleIds = [
  'broker',
  'mt5-feed',
  'alpaca-feed',
  'pine-editor',
  'pinets',
  'indicator-browser',
  'price-bar-ratio',
  'backtest',
  'neural-network',
  'news',
  'update-checker',
] as const;

export type OptionalModuleId = typeof optionalModuleIds[number];

export interface OptionalModule<T> {
  enabled: boolean;
  value?: T;
}

export function isOptionalModuleEnabled(id: OptionalModuleId, search = globalThis.location?.search ?? ''): boolean {
  const disabled = new Set(new URLSearchParams(search).getAll('disableModules')
    .flatMap(value => value.split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean));
  return !disabled.has(id);
}

export async function loadOptionalModule<T>(
  id: OptionalModuleId,
  loader: () => Promise<T>,
  search = globalThis.location?.search ?? '',
  reportError: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): Promise<OptionalModule<T>> {
  if (!isOptionalModuleEnabled(id, search)) return { enabled: false };
  try {
    return { enabled: true, value: await loader() };
  } catch (error) {
    reportError(`Optional ${id} module failed to load:`, error);
    return { enabled: false };
  }
}

export async function bootWithOptionalModules<T>(
  modules: Promise<unknown>[],
  startCore: () => T | Promise<T>,
): Promise<T> {
  await Promise.all(modules);
  return startCore();
}
