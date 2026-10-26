import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { IndicatorHandle } from '@luxalgo/vela';
import type { PineModel } from './pineEditorNext';

export interface PineScriptManagerOptions {
  getWorkspace: () => VelaWorkspace;
  getScripts: () => Record<string, string>;
  scriptHandles: Map<string, Map<string, IndicatorHandle>>;
  groupByCellId: Record<string, string>;
  editorModels: Map<string, PineModel>;
  getPineDiagnostics: () => ((model: PineModel, error: Error | null) => void) | null;
  getPineCompileDiagnostics: () => ((model: PineModel, error: Error | null) => void) | null;
  setEditorStatus: (message: string, state?: 'error' | 'success' | '') => void;
  isPropagating: () => boolean;
  setPropagating: (value: boolean) => void;
}

export interface PineScriptManager {
  scriptIndicatorId(name: string): string;
  displayDiagnosticsInConsole(error: Error | null, code?: string, name?: string): void;
  addScriptToChart(name: string, code: string): Promise<Error | null>;
  updateScriptOnChart(name: string, code: string): Promise<Error | null>;
  applyScriptToChart(name: string, code: string): Promise<Error | null>;
  loadSavedScriptsOnChart(): Promise<void>;
}

export function pineErrorLine(message: string): number | null {
  const match = message.match(/\bline\s+(\d+)\b/i)
    ?? message.match(/:(\d+):\d+\b/)
    ?? message.match(/\bat\s+(\d+):\d+\b/i)
    ?? message.match(/\((\d+)\s*[:;,]\s*\d+\)/)
    ?? message.match(/\bline\s*[:=]?\s*(\d+)\b/i)
    ?? message.match(/\((\d+)\)/);
  if (!match) return null;
  const line = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

export function createPineScriptManager(options: PineScriptManagerOptions): PineScriptManager {
  const scriptIndicatorId = (name: string): string => `local-script:${encodeURIComponent(name)}`;

  const displayDiagnosticsInConsole = (error: Error | null, code?: string, name?: string): void => {
	if (!error) return;
	const errorMessage = error.message;
	const diagnosticKey = name ? `pine:${name}` : undefined;
	let lineNumber = pineErrorLine(errorMessage);
	if (!lineNumber && code) {
	  const identifier = errorMessage.match(/(?:undeclared|unknown) identifier\s+["']([^"']+)["']/i)?.[1];
	  if (identifier) {
		const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const match = new RegExp(`\\b${escaped}\\b`).exec(code);
		if (match) lineNumber = code.slice(0, match.index).split('\n').length;
	  }
	}
	window.addConsoleOutput?.(lineNumber ? `Line ${lineNumber}: ${errorMessage}` : errorMessage, 'error', diagnosticKey);
	if (!lineNumber || !code) return;
	const sourceLines = code.split('\n');
	if (lineNumber > 0 && lineNumber <= sourceLines.length) {
	  const sourceLine = sourceLines[lineNumber - 1];
	  if (sourceLine) window.addConsoleOutput?.(`   ${lineNumber}: ${sourceLine.trim()}`, 'error', diagnosticKey);
	}
  };

  const isOnActiveChart = (name: string): boolean => options.getWorkspace().chart.indicators()
    .some(indicator => indicator.id === scriptIndicatorId(name));

  const applyScriptToChart = async (name: string, code: string, addMissingPeers = true): Promise<Error | null> => {
	const workspace = options.getWorkspace();
	const chart = workspace.chart;
	const targetHandles = options.scriptHandles.get(name) ?? new Map<string, IndicatorHandle>();
	const cachedHandle = targetHandles.get(workspace.active.id);
	const liveHandle = chart.indicators().find(indicator => indicator.id === scriptIndicatorId(name));
	const handle = liveHandle ?? (cachedHandle && chart.indicators().some(indicator => indicator.id === cachedHandle.id) ? cachedHandle : undefined);
	if (handle) {
	  targetHandles.set(workspace.active.id, handle);
	  options.scriptHandles.set(name, targetHandles);
	}

	if (handle) {
	  const result = await handle.updateCode(code);
	  const error = result.ok ? null : result.error ?? new Error('The script could not be updated.');
	  const model = options.editorModels.get(name);
	  if (model) options.getPineDiagnostics()?.(model, error);
	  displayDiagnosticsInConsole(error, code, name);
	  if (error) return error;

	  if (!options.isPropagating()) {
		options.setPropagating(true);
		try {
		  const activeGroup = options.groupByCellId[workspace.active.id];
		  for (const cell of workspace.cells()) {
			if (cell.id === workspace.active.id || options.groupByCellId[cell.id] !== activeGroup) continue;
			const peerHandle = cell.chart.indicators().find(indicator => indicator.id === scriptIndicatorId(name));
			if (peerHandle) {
			  await peerHandle.updateCode(code);
			} else if (addMissingPeers) {
			  const peerResult = await cell.chart.runIndicator(code, { id: scriptIndicatorId(name), language: 'pine', title: name });
			  if (peerResult.handle) {
				const peerHandles = options.scriptHandles.get(name) ?? new Map<string, IndicatorHandle>();
				peerHandles.set(cell.id, peerResult.handle);
				options.scriptHandles.set(name, peerHandles);
			  }
			}
		  }
		} finally {
		  options.setPropagating(false);
		}
	  }
	  return null;
	}

	targetHandles.delete(workspace.active.id);
	const result = await chart.runIndicator(code, { id: scriptIndicatorId(name), language: 'pine', title: name });
	if (!result.ok || !result.handle) {
	  const error = result.error ?? new Error('The script could not be added to the chart.');
	  const model = options.editorModels.get(name);
	  if (model) options.getPineDiagnostics()?.(model, error);
	  displayDiagnosticsInConsole(error, code, name);
	  return error;
	}

	targetHandles.set(workspace.active.id, result.handle);
	options.scriptHandles.set(name, targetHandles);
	if (!handle && !options.isPropagating()) {
	  options.setPropagating(true);
	  try {
		const sourceCellId = workspace.active.id;
		const sourceGroup = options.groupByCellId[sourceCellId];
		for (const cell of workspace.cells()) {
		  if (cell.id === sourceCellId || options.groupByCellId[cell.id] !== sourceGroup) continue;
		  const peerResult = await cell.chart.runIndicator(code, { id: scriptIndicatorId(name), language: 'pine', title: name });
		  if (peerResult.handle) {
			const peerHandles = options.scriptHandles.get(name) ?? new Map<string, IndicatorHandle>();
			peerHandles.set(cell.id, peerResult.handle);
			options.scriptHandles.set(name, peerHandles);
		  }
		}
	  } finally {
		options.setPropagating(false);
	  }
	}

	const model = options.editorModels.get(name);
	if (model) {
	  options.getPineCompileDiagnostics()?.(model, null);
	  options.getPineDiagnostics()?.(model, null);
	}
	return null;
  };

  const addScriptToChart = async (name: string, code: string): Promise<Error | null> => {
    if (!isOnActiveChart(name)) return applyScriptToChart(name, code);
    const error = new Error(`"${name}" is already on the active chart. Use Update to replace its code.`);
    window.addConsoleActivity?.(error.message, 'warning');
    return error;
  };

  const updateScriptOnChart = async (name: string, code: string): Promise<Error | null> => {
    if (isOnActiveChart(name)) return applyScriptToChart(name, code, false);
    const error = new Error(`"${name}" is not on the active chart. Use Add to Chart first.`);
    window.addConsoleActivity?.(error.message, 'warning');
    return error;
  };

  const loadSavedScriptsOnChart = async (): Promise<void> => {
	try {
	  await options.getWorkspace().chart.ready();
	  for (const [name, code] of Object.entries(options.getScripts())) {
		const error = await applyScriptToChart(name, code);
		if (error) {
		  console.error(`Could not load Pine script "${name}":`, error);
		  const model = options.editorModels.get(name);
		  if (model) options.getPineCompileDiagnostics()?.(model, error);
		}
	  }
	} catch (error) {
	  console.error('Could not load saved Pine scripts:', error);
	  options.setEditorStatus(`Chart script load failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
	}
  };

  return { scriptIndicatorId, displayDiagnosticsInConsole, addScriptToChart, updateScriptOnChart, applyScriptToChart, loadSavedScriptsOnChart };
}
