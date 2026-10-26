import './pineEditorStandalone.css';
import { createPineEditor, createPineModel, getPineReferenceNameAtPosition, getPineSyntaxDiagnostics, setPinePreviewDiagnostics, type PineEditor, type PineModel } from './pineEditorNext';
import { createPineAiAssistant } from './pineAiAssistant';
import { confirmAction, promptForText } from './pineDialog';
import { createPineReferencePanel } from './pineReferencePanel';
import { DEFAULT_SCRIPTS, getSavedScripts, saveScriptsToStorage } from './pineStorage';

type ChartAction = 'add' | 'update';

interface PineEditorBridge {
  open(): Promise<boolean>;
  openScript(name: string, source: string): Promise<boolean>;
  openDocked(): void;
  onOpenDocked(callback: () => void): () => void;
  publishScriptUpdate(script: { name: string; source: string; action: ChartAction }): void;
  onScriptUpdated(callback: (script: { name: string; source: string; action: ChartAction }) => void): () => void;
  onOpenScript(callback: (script: { name: string; source: string }) => void): () => void;
  onScriptResult(callback: (result: { name: string; action: ChartAction; ok: boolean; message: string }) => void): () => void;
  publishScriptResult(result: { name: string; action: ChartAction; ok: boolean; message: string }): void;
}

interface PineExportBridge {
  save(name: string, source: string): Promise<{ canceled: boolean; path?: string }>;
}

declare global {
  interface Window {
    velaPineEditorWindow?: PineEditorBridge;
    velaPineExport?: PineExportBridge;
  }
}

const scripts = getSavedScripts();
let currentScriptName = Object.keys(scripts)[0] ?? Object.keys(DEFAULT_SCRIPTS)[0];
let editor: PineEditor;
const models = new Map<string, PineModel>();
const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;
const status = document.getElementById('editor-status') as HTMLSpanElement;
const editorHost = document.getElementById('code-editor') as HTMLDivElement;
const reference = document.getElementById('pine-reference') as HTMLElement;
const referenceResize = document.getElementById('pine-reference-resize') as HTMLElement;
const referenceWidthKey = 'omega.pine-reference.standalone-width';
const referenceMinWidth = 250;
const referenceMaxRatio = 0.45;
const consoleHeightKey = 'omega.pine-console.standalone-height';
const consolePanel = document.getElementById('standalone-console-panel') as HTMLElement;
const consoleDivider = document.getElementById('standalone-console-divider') as HTMLElement;
const consoleErrors = document.getElementById('standalone-console-errors') as HTMLElement;
const consoleActions = document.getElementById('standalone-console-actions') as HTMLElement;
const consoleToggle = document.getElementById('toggle-console') as HTMLButtonElement;
let autosaveTimer: number | undefined;
let liveValidationTimer: number | undefined;
let liveValidationRevision = 0;
let isApplyingPineUpgrade = false;

function appendConsoleEntry(host: HTMLElement, message: string, type: 'error' | 'warning' | 'success' | 'info', diagnosticKey?: string): void {
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  if (diagnosticKey) line.dataset.diagnosticKey = diagnosticKey;
  const icon = document.createElement('span');
  icon.className = 'console-line-icon';
  icon.textContent = type === 'error' ? 'E' : type === 'warning' ? 'W' : type === 'success' ? 'OK' : 'i';
  const text = document.createElement('span');
  text.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  line.append(icon, text);
  host.append(line);
  while (host.childElementCount > 250) host.firstElementChild?.remove();
  host.scrollTop = host.scrollHeight;
}

function logAction(message: string, type: 'warning' | 'success' | 'info' = 'info'): void {
  appendConsoleEntry(consoleActions, message, type);
}

function clearConsoleErrors(diagnosticKey: string): void {
  consoleErrors.querySelectorAll<HTMLElement>('.console-line[data-diagnostic-key]').forEach(line => {
    if (line.dataset.diagnosticKey === diagnosticKey) line.remove();
  });
}

function setStatus(message: string, isError = false, logError = true): void {
  status.textContent = message;
  status.dataset.state = isError ? 'error' : '';
  if (isError && logError) appendConsoleEntry(consoleErrors, message, 'error');
}

function modelFor(name: string): PineModel {
  const existing = models.get(name);
  if (existing && !existing.isDisposed()) return existing;
  const model = createPineModel(`inmemory://pine/${encodeURIComponent(name)}.pine`, scripts[name] ?? '');
  models.set(name, model);
  return model;
}

function currentSource(): string {
  return editor.getValue();
}

function saveCurrent(showStatus = true): void {
  scripts[currentScriptName] = currentSource();
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  const message = `${showStatus ? 'Saved' : 'Auto-saved'} “${currentScriptName}”.`;
  if (showStatus) setStatus(message);
  logAction(message, 'success');
}

async function validatePineSource(code: string): Promise<Error | null> {
  try {
    const { PineTS } = await import('pinets');
    const validationBars = Array.from({ length: 120 }, (_, index) => {
      const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
      const open = close + Math.sin(index) * 0.3;
      return {
        open,
        high: Math.max(open, close) + 1,
        low: Math.min(open, close) - 1,
        close,
        volume: 100 + index % 17,
        openTime: 1_700_000_000_000 + index * 60_000,
      };
    });
    await new PineTS(validationBars).run(code);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
}

function validateEditorSource(): void {
  const model = editor.getModel();
  if (!model) return;

  const name = currentScriptName;
  const code = model.getValue();
  const revision = ++liveValidationRevision;
  const syntaxKey = `pine:syntax:${name}`;
  const runtimeKey = `pine:runtime-preview:${name}`;
  clearConsoleErrors(syntaxKey);
  clearConsoleErrors(runtimeKey);
  clearConsoleErrors(`pine:remote:${name}`);
  setPinePreviewDiagnostics(model, null);

  for (const diagnostic of getPineSyntaxDiagnostics(model)) {
    appendConsoleEntry(
      consoleErrors,
      `${diagnostic.source} · ${name}: Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
      diagnostic.severity,
      syntaxKey,
    );
  }

  window.clearTimeout(liveValidationTimer);
  liveValidationTimer = window.setTimeout(() => {
    void (async () => {
      const error = await validatePineSource(code);

      if (revision !== liveValidationRevision || currentScriptName !== name || editor.getModel() !== model) return;
      setPinePreviewDiagnostics(model, error);
      clearConsoleErrors(runtimeKey);
      if (error) {
        appendConsoleEntry(
          consoleErrors,
          `PineTS sample-data check (not TradingView compile) · ${name}: ${error.message}`,
          'warning',
          runtimeKey,
        );
      }
    })();
  }, 100);
}

function refreshScriptSelect(): void {
  scriptSelect.replaceChildren();
  for (const name of Object.keys(scripts)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === currentScriptName;
    scriptSelect.append(option);
  }
}

function selectScript(name: string): void {
  currentScriptName = name;
  refreshScriptSelect();
  editor.setModel(modelFor(name));
  validateEditorSource();
  editor.focus();
  setStatus(`Editing “${name}”.`);
  logAction(`Selected “${name}”.`);
}

const referencePanel = createPineReferencePanel(() => editor);
editor = createPineEditor(editorHost, modelFor(currentScriptName), 'dark');
createPineAiAssistant({
  getCurrentScriptName: () => currentScriptName,
  getEditorValue: currentSource,
  manageReferenceResize: false,
});
editor.onMouseDown(event => {
  if (event.event.browserEvent.detail !== 2 || !event.target.position) return;
  const model = editor.getModel();
  if (!model) return;
  const name = getPineReferenceNameAtPosition(model, event.target.position);
  if (name) referencePanel.open(name);
});
editor.onDidChangeModelContent(() => {
  if (isApplyingPineUpgrade) return;
  validateEditorSource();
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveCurrent(false), 650);
  setStatus('Unsaved changes');
});
refreshScriptSelect();
validateEditorSource();

const setReferenceWidth = (width: number) => {
  const content = reference.parentElement;
  if (!content) return;
  const maxWidth = Math.max(referenceMinWidth, Math.min(content.clientWidth * referenceMaxRatio, content.clientWidth - 420));
  const nextWidth = Math.round(Math.max(referenceMinWidth, Math.min(maxWidth, width)));
  reference.style.width = `${nextWidth}px`;
  referenceResize.setAttribute('aria-valuemax', String(Math.round(maxWidth)));
  referenceResize.setAttribute('aria-valuenow', String(nextWidth));
  localStorage.setItem(referenceWidthKey, String(nextWidth));
  editor.layout();
};

const storedReferenceWidth = Number(localStorage.getItem(referenceWidthKey));
if (Number.isFinite(storedReferenceWidth) && storedReferenceWidth >= referenceMinWidth) {
  reference.style.width = `${storedReferenceWidth}px`;
}
setReferenceWidth(reference.clientWidth);
referenceResize.addEventListener('pointerdown', event => {
  if (reference.hidden) return;
  event.preventDefault();
  referenceResize.classList.add('dragging');
  document.body.style.userSelect = 'none';
  referenceResize.setPointerCapture(event.pointerId);
});
referenceResize.addEventListener('pointermove', event => {
  if (!referenceResize.hasPointerCapture(event.pointerId)) return;
  const content = reference.parentElement;
  if (!content) return;
  setReferenceWidth(content.getBoundingClientRect().right - event.clientX);
});
const stopReferenceResize = () => {
  referenceResize.classList.remove('dragging');
  document.body.style.userSelect = '';
};
referenceResize.addEventListener('pointerup', stopReferenceResize);
referenceResize.addEventListener('pointercancel', stopReferenceResize);
referenceResize.addEventListener('lostpointercapture', stopReferenceResize);
referenceResize.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = event.key === 'ArrowLeft' ? 1 : -1;
  setReferenceWidth(reference.clientWidth + direction * 24);
});

function setConsoleVisible(visible: boolean): void {
  consolePanel.hidden = !visible;
  consoleDivider.hidden = !visible;
  consoleToggle.setAttribute('aria-expanded', String(visible));
  requestAnimationFrame(() => editor.layout());
}

consoleToggle.addEventListener('click', () => {
  setConsoleVisible(Boolean(consolePanel.hidden));
});
document.getElementById('clear-errors')?.addEventListener('click', () => {
  consoleErrors.replaceChildren();
});
document.getElementById('clear-actions')?.addEventListener('click', () => {
  consoleActions.replaceChildren();
});
document.getElementById('clear-console')?.addEventListener('click', () => {
  consoleErrors.replaceChildren();
  consoleActions.replaceChildren();
});

const storedConsoleHeight = Number(localStorage.getItem(consoleHeightKey));
if (Number.isFinite(storedConsoleHeight) && storedConsoleHeight >= 90) {
  consolePanel.style.height = `${storedConsoleHeight}px`;
}
const consoleDividerMin = 90;
let resizingConsole = false;
let consoleStartY = 0;
let consoleStartHeight = consolePanel.offsetHeight;
consoleDivider.addEventListener('pointerdown', event => {
  event.preventDefault();
  resizingConsole = true;
  consoleStartY = event.clientY;
  consoleStartHeight = consolePanel.offsetHeight;
  consoleDivider.classList.add('dragging');
  document.body.style.userSelect = 'none';
  consoleDivider.setPointerCapture(event.pointerId);
});
consoleDivider.addEventListener('pointermove', event => {
  if (!resizingConsole || !consoleDivider.hasPointerCapture(event.pointerId)) return;
  const maxHeight = Math.max(consoleDividerMin, Math.min(window.innerHeight * 0.5, window.innerHeight - 150));
  const height = Math.max(consoleDividerMin, Math.min(maxHeight, consoleStartHeight + consoleStartY - event.clientY));
  consolePanel.style.height = `${height}px`;
  consoleDivider.setAttribute('aria-valuenow', String(Math.round(height)));
  localStorage.setItem(consoleHeightKey, String(Math.round(height)));
  editor.layout();
});
const stopConsoleResize = () => {
  resizingConsole = false;
  consoleDivider.classList.remove('dragging');
  document.body.style.userSelect = '';
  requestAnimationFrame(() => editor.layout());
};
consoleDivider.addEventListener('pointerup', stopConsoleResize);
consoleDivider.addEventListener('pointercancel', stopConsoleResize);
consoleDivider.addEventListener('lostpointercapture', stopConsoleResize);
consoleDivider.addEventListener('keydown', event => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const direction = event.key === 'ArrowUp' ? 1 : -1;
  const maxHeight = Math.max(consoleDividerMin, Math.min(window.innerHeight * 0.5, window.innerHeight - 150));
  const height = Math.max(consoleDividerMin, Math.min(maxHeight, consolePanel.offsetHeight + direction * 24));
  consolePanel.style.height = `${height}px`;
  consoleDivider.setAttribute('aria-valuenow', String(Math.round(height)));
  localStorage.setItem(consoleHeightKey, String(Math.round(height)));
  editor.layout();
});

scriptSelect.addEventListener('change', () => selectScript(scriptSelect.value));
document.getElementById('save-script')?.addEventListener('click', () => saveCurrent());
document.getElementById('open-docked')?.addEventListener('click', () => {
  saveCurrent(false);
  window.velaPineEditorWindow?.openDocked();
});
async function createNewScript(): Promise<void> {
  const name = await promptForText({
    title: 'New Pine script',
    label: 'Script name',
    placeholder: 'e.g. My EMA strategy',
    confirmLabel: 'Create',
    validate: value => {
      if (!value) return 'Enter a script name.';
      if (value.length > 120) return 'Keep the name to 120 characters or fewer.';
      if (Object.hasOwn(scripts, value)) return `A script named “${value}” already exists.`;
      return null;
    },
  });
  if (!name) return;
  scripts[name] = `//@version=6\nindicator(${JSON.stringify(name)}, overlay = true)\n\nplot(ta.ema(close, 20), "EMA 20", color = color.yellow)\n`;
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  logAction(`Created “${name}”.`, 'success');
  selectScript(name);
}

document.getElementById('new-script')?.addEventListener('click', () => { void createNewScript(); });
document.getElementById('delete-script')?.addEventListener('click', () => {
  void (async () => {
    if (Object.keys(scripts).length <= 1) {
      setStatus('Keep at least one script.', true);
      return;
    }
    const name = currentScriptName;
    const confirmed = await confirmAction({
      title: 'Delete Pine script',
      message: `Delete “${name}”? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    models.get(name)?.dispose();
    models.delete(name);
    delete scripts[name];
    saveScriptsToStorage(scripts, message => setStatus(message, true));
    logAction(`Deleted “${name}”.`, 'warning');
    selectScript(Object.keys(scripts)[0]);
  })();
});
document.getElementById('export-script')?.addEventListener('click', async () => {
  saveCurrent(false);
  try {
    const result = await window.velaPineExport?.save(currentScriptName, currentSource());
    if (result && !result.canceled) {
      setStatus(`Exported “${currentScriptName}”.`);
      logAction(`Exported “${currentScriptName}”.`, 'success');
    }
  } catch (error) {
    setStatus(`Could not export: ${error instanceof Error ? error.message : String(error)}`, true);
  }
});
function sendToChart(action: ChartAction): void {
  saveCurrent(false);
  if (!window.velaPineEditorWindow) {
    setStatus('The main Omega window is not available.', true);
    return;
  }
  window.velaPineEditorWindow.publishScriptUpdate({ name: currentScriptName, source: currentSource(), action });
  const message = `${action === 'add' ? 'Adding' : 'Updating'} “${currentScriptName}” on the chart…`;
  setStatus(message);
  logAction(message);
}
document.getElementById('add-to-chart')?.addEventListener('click', () => sendToChart('add'));
document.getElementById('update-chart')?.addEventListener('click', () => sendToChart('update'));
document.getElementById('upgrade-to-v6')?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  window.clearTimeout(autosaveTimer);
  editor.updateOptions({ readOnly: true });
  try {
    const { convertPineScriptToV6 } = await import('./pineVersionConverter.mjs');
    const conversion = convertPineScriptToV6(currentSource());
    const error = await validatePineSource(conversion.source);
    if (error) throw error;

    window.clearTimeout(liveValidationTimer);
    liveValidationRevision += 1;
    isApplyingPineUpgrade = true;
    try {
      editor.setValue(conversion.source);
    } finally {
      isApplyingPineUpgrade = false;
    }
    scripts[currentScriptName] = conversion.source;
    let saveError: string | undefined;
    saveScriptsToStorage(scripts, message => { saveError = message; });
    if (saveError) throw new Error(saveError);
    validateEditorSource();
    const message = `Upgraded Pine v${conversion.version} to v6 (${conversion.changes} changes).`;
    setStatus(message);
    logAction(`${message} Saved “${currentScriptName}”.`, 'success');
  } catch (error) {
    const message = `Unable to upgrade script: ${error instanceof Error ? error.message : String(error)}`;
    setStatus(message, true);
  } finally {
    editor.updateOptions({ readOnly: false });
    button.disabled = false;
  }
});

window.velaPineEditorWindow?.onOpenScript(({ name, source }) => {
  if (!name || typeof source !== 'string') return;
  scripts[name] = source;
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  const model = models.get(name);
  if (model && !model.isDisposed() && model.getValue() !== source) model.setValue(source);
  selectScript(name);
});
window.velaPineEditorWindow?.onScriptResult(({ name, ok, message }) => {
  if (name !== currentScriptName) return;
  const diagnosticKey = `pine:remote:${name}`;
  clearConsoleErrors(diagnosticKey);
  setStatus(message, !ok, false);
  if (ok) {
    logAction(message, 'success');
  } else {
    appendConsoleEntry(consoleErrors, message, 'error', diagnosticKey);
  }
});

window.addEventListener('resize', () => editor.layout());
requestAnimationFrame(() => editor.focus());
