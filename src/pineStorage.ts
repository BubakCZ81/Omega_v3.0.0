export const DEFAULT_SCRIPTS: Record<string, string> = {
  'Dual EMA Cross': `//@version=6
indicator("Dual EMA Cross", overlay = true)

fastLen = input.int(9, "Fast EMA")
slowLen = input.int(21, "Slow EMA")

fastEma = ta.ema(close, fastLen)
slowEma = ta.ema(close, slowLen)

bullish = ta.crossover(fastEma, slowEma)
bearish = ta.crossunder(fastEma, slowEma)

plot(fastEma, title = "Fast EMA", color = color.green, linewidth = 2)
plot(slowEma, title = "Slow EMA", color = color.red, linewidth = 2)

plotshape(bullish, title = "Bullish", style = shape.triangleup, location = location.belowbar, color = color.green, size = size.small)
plotshape(bearish, title = "Bearish", style = shape.triangledown, location = location.abovebar, color = color.red, size = size.small)
`,
};

const scriptsStorageKey = 'vela_user_scripts';

export function getSavedScripts(): Record<string, string> {
  try {
	const data = localStorage.getItem(scriptsStorageKey);
	if (!data) return { ...DEFAULT_SCRIPTS };
	const parsed = JSON.parse(data) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SCRIPTS };
	const scripts = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
	return Object.keys(scripts).length ? scripts : { ...DEFAULT_SCRIPTS };
  } catch {
	return { ...DEFAULT_SCRIPTS };
  }
}

export function saveScriptsToStorage(data: Record<string, string>, onError?: (message: string) => void): void {
  try {
	localStorage.setItem(scriptsStorageKey, JSON.stringify(data));
  } catch (error) {
	const message = `Could not save scripts: ${error instanceof Error ? error.message : String(error)}`;
	onError?.(message);
	console.error(message);
  }
}
