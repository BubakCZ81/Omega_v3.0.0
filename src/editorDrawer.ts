export {};

declare global {
  interface Window {
    isEditorOpen: boolean;
    toggleEditor(forceState?: boolean): void;
    showConsole(): void;
    addConsoleOutput?: (message: string, type?: string, diagnosticKey?: string) => void;
    addConsoleActivity?: (message: string, type?: string) => void;
    clearConsoleDiagnostics?: (diagnosticKey: string) => void;
    velaPineEditorWindow?: {
      open(): Promise<boolean>;
      openScript(name: string, source: string): Promise<boolean>;
      openDocked(): void;
      onOpenDocked(callback: () => void): () => void;
      publishScriptUpdate(script: { name: string; source: string; action: 'add' | 'update' }): void;
      onScriptUpdated(callback: (script: { name: string; source: string; action: 'add' | 'update' }) => void): () => void;
      publishScriptResult(result: { name: string; action: 'add' | 'update'; ok: boolean; message: string }): void;
      onScriptResult(callback: (result: { name: string; action: 'add' | 'update'; ok: boolean; message: string }) => void): () => void;
      onOpenScript(callback: (script: { name: string; source: string }) => void): () => void;
    };
  }
}

const standalonePineEditor = new URLSearchParams(window.location.search).get('window') === 'pine-editor';

window.isEditorOpen = standalonePineEditor;

function toggleEditor(forceState?: boolean): void {
  const drawer = document.getElementById('editor-drawer');
  const handle = document.getElementById('resize-handle');
  const button = document.getElementById('editor-toggle-btn');
  if (!drawer || !handle || !button) return;

  window.isEditorOpen = forceState ?? !window.isEditorOpen;
  drawer.style.display = window.isEditorOpen ? 'flex' : 'none';
  handle.style.display = window.isEditorOpen ? 'block' : 'none';
  button.classList.toggle('active', window.isEditorOpen);
  if (window.isEditorOpen) window.dispatchEvent(new CustomEvent('editor-opened'));
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

window.toggleEditor = toggleEditor;

document.addEventListener('omega:bottom-panel:editor-toggle', () => {
  toggleEditor();
});

if (standalonePineEditor) {
  document.body.dataset.pineEditorSurface = 'standalone';
  requestAnimationFrame(() => toggleEditor(true));
}

const resizeHandle = document.getElementById('resize-handle');
const editorDrawer = document.getElementById('editor-drawer');
if (resizeHandle && editorDrawer) {
  let dragging = false;
  let startY = 0;
  let startHeight = 320;

  resizeHandle.addEventListener('mousedown', event => {
    dragging = true;
    startY = event.clientY;
    startHeight = editorDrawer.offsetHeight;
    resizeHandle.classList.add('resizing');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', event => {
    if (!dragging) return;
    const height = Math.max(120, Math.min(window.innerHeight * 0.7, startHeight + startY - event.clientY));
    editorDrawer.style.height = `${height}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('resizing');
    document.body.style.userSelect = '';
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
}

const consoleDivider = document.getElementById('console-divider');
const consolePanel = document.getElementById('console-panel');
const consoleOutput = document.getElementById('console-output');
const consoleActivityOutput = document.getElementById('console-activity-output');

if (consoleDivider && consolePanel && document.getElementById('editor-top')) {
  let resizing = false;
  let startY = 0;
  let startHeight = 200;
  const savedHeight = Number(localStorage.getItem('vela_console_height'));
  if (savedHeight > 0) consolePanel.style.height = `${savedHeight}px`;

  consoleDivider.addEventListener('mousedown', event => {
    resizing = true;
    startY = event.clientY;
    startHeight = consolePanel.offsetHeight;
    consoleDivider.classList.add('resizing');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', event => {
    if (!resizing) return;
    const editorWorkspace = document.getElementById('editor-workspace');
    if (!editorWorkspace) return;
    const maxHeight = editorWorkspace.offsetHeight - 120;
    const height = Math.max(80, Math.min(maxHeight, startHeight + startY - event.clientY));
    consolePanel.style.height = `${height}px`;
    localStorage.setItem('vela_console_height', String(Math.round(height)));
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    consoleDivider.classList.remove('resizing');
    document.body.style.userSelect = '';
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
}

document.getElementById('console-errors-clear')?.addEventListener('click', () => {
  if (consoleOutput) consoleOutput.textContent = '';
});
document.getElementById('console-activity-clear')?.addEventListener('click', () => {
  if (consoleActivityOutput) consoleActivityOutput.textContent = '';
});
window.showConsole = () => {
  if (consolePanel) consolePanel.style.display = 'flex';
  if (consoleDivider) consoleDivider.style.display = 'block';
  window.dispatchEvent(new Event('resize'));
};

function appendConsoleLine(host: HTMLElement | null, message: string, type = 'info', diagnosticKey?: string): void {
  if (!host) return;
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  if (diagnosticKey) line.dataset.diagnosticKey = diagnosticKey;
  const icon = document.createElement('span');
  icon.className = 'console-line-icon';
  icon.textContent = type === 'error' ? 'E' : type === 'warning' ? 'W' : type === 'success' ? 'OK' : 'i';
  const text = document.createElement('span');
  text.textContent = message;
  line.append(icon, text);
  host.append(line);
  while (host.childElementCount > 250) host.firstElementChild?.remove();
  host.scrollTop = host.scrollHeight;
}

window.addConsoleOutput = (message, type = 'info', diagnosticKey) => {
  appendConsoleLine(consoleOutput, message, type, diagnosticKey);
  window.showConsole();
};

window.addConsoleActivity = (message, type = 'info') => {
  appendConsoleLine(consoleActivityOutput, message, type);
  window.showConsole();
};

window.clearConsoleDiagnostics = diagnosticKey => {
  consoleOutput?.querySelectorAll<HTMLElement>('.console-line[data-diagnostic-key]').forEach(line => {
    if (line.dataset.diagnosticKey === diagnosticKey) line.remove();
  });
};
