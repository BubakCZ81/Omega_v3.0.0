type InputValue = string | number | boolean;

export interface ScriptIndicatorSnapshot {
  id: string;
  name: string;
  script: string;
  language: 'pine';
  inputs?: Record<string, InputValue>;
  props?: Record<string, InputValue>;
  hidden?: boolean;
}

interface ScriptIndicatorLike {
  id: string;
  title: string;
  source?: string;
  visible?: boolean;
  inputValues?: () => Record<string, unknown>;
  propValues?: () => Record<string, unknown>;
}

interface ScriptIndicatorChart {
  indicators(): Array<ScriptIndicatorLike & { remove(): void }>;
}

interface ScriptIndicatorContext {
  chart: ScriptIndicatorChart;
  addIndicator(entry: ScriptIndicatorSnapshot): void;
}

const APP_SCRIPT_ID_PREFIXES = ['local-script:', 'browser:'];

function isAppScriptIndicator(id: string): boolean {
  return APP_SCRIPT_ID_PREFIXES.some(prefix => id.startsWith(prefix));
}

function scalarValues(value: unknown): Record<string, InputValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, InputValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result[key] = item;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function snapshotWorkspaceScriptIndicators(indicators: readonly ScriptIndicatorLike[]): ScriptIndicatorSnapshot[] {
  return indicators.flatMap(indicator => {
    if (!isAppScriptIndicator(indicator.id) || typeof indicator.source !== 'string') return [];
    const inputs = scalarValues(indicator.inputValues?.());
    const props = scalarValues(indicator.propValues?.());
    return [{
      id: indicator.id,
      name: indicator.title,
      script: indicator.source,
      language: 'pine' as const,
      ...(inputs ? { inputs } : {}),
      ...(props ? { props } : {}),
      ...(indicator.visible === false ? { hidden: true } : {}),
    }];
  });
}

function isSnapshot(value: unknown): value is ScriptIndicatorSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && entry.id.length <= 512
    && isAppScriptIndicator(entry.id)
    && typeof entry.name === 'string'
    && entry.name.length <= 500
    && typeof entry.script === 'string'
    && entry.script.length <= 2_000_000
    && entry.language === 'pine'
    && (entry.hidden === undefined || typeof entry.hidden === 'boolean');
}

export function restoreWorkspaceScriptIndicators(payload: unknown, context: ScriptIndicatorContext): void {
  const entries = Array.isArray(payload) ? payload.filter(isSnapshot) : [];
  for (const indicator of context.chart.indicators()) {
    if (isAppScriptIndicator(indicator.id)) indicator.remove();
  }
  for (const entry of entries) {
    const inputs = scalarValues(entry.inputs);
    const props = scalarValues(entry.props);
    context.addIndicator({
      id: entry.id,
      name: entry.name,
      script: entry.script,
      language: 'pine',
      ...(inputs ? { inputs } : {}),
      ...(props ? { props } : {}),
      ...(entry.hidden === true ? { hidden: true } : {}),
    });
  }
}
