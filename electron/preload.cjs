const { contextBridge, ipcRenderer } = require('electron');

function safeDiagnosticMessage(value) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?(?:key|secret)|authorization|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*)["']?[^,\s"'&]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|api[_-]?secret|token|access_token|refresh_token|signature|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 400);
}

const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = async (channel, ...args) => {
  if (!String(channel).startsWith('diagnostics:')) {
    const startedAt = Date.now();
    ipcRenderer.send('diagnostics:event', { source: 'preload', type: 'method', name: String(channel), status: 'start' });
    try {
      const result = await originalInvoke(channel, ...args);
      ipcRenderer.send('diagnostics:event', { source: 'preload', type: 'method', name: String(channel), status: 'ok', durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      ipcRenderer.send('diagnostics:event', {
        source: 'preload',
        type: 'method',
        name: String(channel),
        status: 'error',
        message: error instanceof Error ? `${error.name}: ${safeDiagnosticMessage(error.message) || 'Unknown error'}` : 'Unknown error',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
  return originalInvoke(channel, ...args);
};

function recordDiagnostic(type, fields = {}) {
  ipcRenderer.send('diagnostics:event', { source: 'renderer', type, ...fields });
}

function describeTarget(target) {
  if (!(target instanceof Element)) return undefined;
  const element = target.closest('button,a,input,select,textarea,[role="button"],[role="menuitem"],summary,[tabindex]') || target;
  const id = element.id ? `#${element.id}` : '';
  const role = element.getAttribute('role');
  const label = element.getAttribute('aria-label');
  return `${element.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ''}${label ? `[aria=${label.slice(0, 60)}]` : ''}`.slice(0, 160);
}

window.addEventListener('click', event => {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  recordDiagnostic('click', { target: describeTarget(path[0] || event.target) });
}, true);
window.addEventListener('change', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
    recordDiagnostic('change', { target: describeTarget(event.target) });
  }
}, true);
window.addEventListener('error', event => recordDiagnostic('error', {
  name: 'window.error',
  message: safeDiagnosticMessage(event.message),
}), true);
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason instanceof Error
    ? `${event.reason.name}: ${event.reason.message}`
    : typeof event.reason === 'string' ? event.reason : undefined;
  recordDiagnostic('error', { name: 'window.unhandledrejection', message: safeDiagnosticMessage(reason) });
}, true);
document.addEventListener('toggle', event => {
  if (event.target instanceof HTMLDetailsElement) {
    recordDiagnostic('window', { name: event.target.open ? 'details.open' : 'details.close', target: describeTarget(event.target) });
  }
}, true);
const dialogVisibility = new WeakMap();
function observeDialog(element) {
  if (!(element instanceof Element) || !element.matches('dialog,[role="dialog"]')) return;
  const isOpen = element instanceof HTMLDialogElement
    ? element.open
    : !element.hidden && element.getAttribute('aria-hidden') !== 'true'
      && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
  const previous = dialogVisibility.get(element);
  dialogVisibility.set(element, isOpen);
  if (previous !== undefined && previous !== isOpen) {
    recordDiagnostic('window', { name: isOpen ? 'dialog.open' : 'dialog.close', target: describeTarget(element) });
  }
}
const dialogObserver = new MutationObserver(records => {
  for (const record of records) {
    if (record.attributeName === 'aria-expanded' && record.target instanceof Element) {
      recordDiagnostic('window', {
        name: record.target.getAttribute('aria-expanded') === 'true' ? 'popup.open' : 'popup.close',
        target: describeTarget(record.target),
      });
      continue;
    }
    if (record.target instanceof Element) observeDialog(record.target.closest('dialog,[role="dialog"]'));
    for (const node of record.addedNodes || []) {
      if (!(node instanceof Element)) continue;
      observeDialog(node);
      node.querySelectorAll('dialog,[role="dialog"]').forEach(observeDialog);
    }
  }
});
dialogObserver.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['open', 'hidden', 'aria-hidden', 'aria-expanded'],
});
document.querySelectorAll('dialog,[role="dialog"]').forEach(observeDialog);
window.addEventListener('beforeunload', () => recordDiagnostic('window', { name: 'document.beforeunload' }));
window.addEventListener('pageshow', () => recordDiagnostic('window', { name: 'document.pageshow' }));

let pendingPineOpenScript = null;
const pineOpenScriptCallbacks = new Set();
ipcRenderer.on('pine-editor:open-script', (_event, script) => {
  if (pineOpenScriptCallbacks.size === 0) pendingPineOpenScript = script;
  else for (const callback of pineOpenScriptCallbacks) callback(script);
});

let pendingVisualBacktestConfig = null;
const visualBacktestConfigCallbacks = new Set();
ipcRenderer.on('visual-backtest:open-config', (_event, config) => {
  if (visualBacktestConfigCallbacks.size === 0) pendingVisualBacktestConfig = config;
  else for (const callback of visualBacktestConfigCallbacks) callback(config);
});

contextBridge.exposeInMainWorld('velaApp', {
  ready: () => ipcRenderer.send('app:ready'),
});

contextBridge.exposeInMainWorld('velaDiagnostics', {
  openConsole: () => ipcRenderer.invoke('diagnostics:open'),
  getRecent: () => ipcRenderer.invoke('diagnostics:get-recent'),
  record: (record) => ipcRenderer.send('diagnostics:event', record),
  onEntry: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('diagnostics:entry', listener);
    return () => ipcRenderer.removeListener('diagnostics:entry', listener);
  },
});

contextBridge.exposeInMainWorld('velaNeural', {
  saveModel: (profile) => ipcRenderer.invoke('neural:save-model', profile),
});

contextBridge.exposeInMainWorld('velaBroker', {
  listBrokers: () => ipcRenderer.invoke('broker:list'),
  connectReadOnly: (brokerId, credentials) => ipcRenderer.invoke('broker:connect-read-only', { brokerId, credentials }),
  saveAlpacaCredentials: (credentials) => ipcRenderer.invoke('broker:save-alpaca-credentials', credentials),
  hasSavedAlpacaCredentials: () => ipcRenderer.invoke('broker:has-saved-alpaca-credentials'),
  fetchSnapshot: () => ipcRenderer.invoke('broker:fetch-snapshot'),
  fetchHistoricalBars: (request) => ipcRenderer.invoke('broker:fetch-bars', request),
  authorizeCTrader: (credentials) => ipcRenderer.invoke('ctrader:authorize', credentials),
  selectCTraderAccount: (accountId) => ipcRenderer.invoke('ctrader:select-account', accountId),
  subscribeCTraderSymbol: (symbolId) => ipcRenderer.invoke('ctrader:subscribe-symbol', symbolId),
  placeDemoCTraderMarketOrder: (order) => ipcRenderer.invoke('ctrader:place-demo-market-order', order),
  reconcileCTraderAccount: () => ipcRenderer.invoke('ctrader:reconcile-account'),
  onCTraderQuote: (callback) => {
    const listener = (_event, quote) => callback(quote);
    ipcRenderer.on('ctrader:quote', listener);
    return () => ipcRenderer.removeListener('ctrader:quote', listener);
  },
  disconnect: () => ipcRenderer.invoke('broker:disconnect'),
});

contextBridge.exposeInMainWorld('velaMt5', {
  connect: (pythonExecutable) => ipcRenderer.invoke('mt5:connect', pythonExecutable),
  symbols: () => ipcRenderer.invoke('mt5:symbols'),
  bars: (request) => ipcRenderer.invoke('mt5:bars', request),
  quote: (ticker) => ipcRenderer.invoke('mt5:quote', { ticker }),
  ticks: (request) => ipcRenderer.invoke('mt5:ticks', request),
  marketBook: (ticker) => ipcRenderer.invoke('mt5:market-book', ticker),
  info: (ticker) => ipcRenderer.invoke('mt5:info', ticker),
  disconnect: () => ipcRenderer.invoke('mt5:disconnect'),
});

contextBridge.exposeInMainWorld('velaWorkspaceFiles', {
  load: () => ipcRenderer.invoke('workspace:load'),
  save: (state) => ipcRenderer.invoke('workspace:save', state),
  saveProfile: (name, state) => ipcRenderer.invoke('workspace:save-profile', { name, state }),
  loadProfile: () => ipcRenderer.invoke('workspace:load-profile'),
});

contextBridge.exposeInMainWorld('velaNews', {
  search: (symbol) => ipcRenderer.invoke('news:search', symbol),
  open: (url) => ipcRenderer.invoke('news:open', url),
});

contextBridge.exposeInMainWorld('velaAi', {
  providers: () => ipcRenderer.invoke('ai:providers'),
  saveKey: (provider, apiKey) => ipcRenderer.invoke('ai:save-key', { provider, apiKey }),
  clearKey: (provider) => ipcRenderer.invoke('ai:clear-key', provider),
  testKey: (provider, apiKey) => ipcRenderer.invoke('ai:test-key', { provider, apiKey }),
  localConfig: () => ipcRenderer.invoke('ai:local-config'),
  saveLocalConfig: (request) => ipcRenderer.invoke('ai:save-local-config', request),
  testLocalConfig: (request) => ipcRenderer.invoke('ai:test-local-config', request),
  complete: (request) => ipcRenderer.invoke('ai:complete', request),
});

contextBridge.exposeInMainWorld('velaPineExport', {
  save: (name, source) => ipcRenderer.invoke('pine:export', { name, source }),
});

contextBridge.exposeInMainWorld('velaPineEditorWindow', {
  open: () => ipcRenderer.invoke('pine-editor:open-window'),
  openScript: (name, source) => ipcRenderer.invoke('pine-editor:open-script', { name, source }),
  openDocked: () => ipcRenderer.send('pine-editor:open-docked'),
  onOpenDocked: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('pine-editor:open-docked', listener);
    return () => ipcRenderer.removeListener('pine-editor:open-docked', listener);
  },
  publishScriptUpdate: (script) => ipcRenderer.send('pine-editor:script-updated', script),
  onScriptUpdated: (callback) => {
    const listener = (_event, script) => callback(script);
    ipcRenderer.on('pine-editor:script-updated', listener);
    return () => ipcRenderer.removeListener('pine-editor:script-updated', listener);
  },
  publishScriptResult: (result) => ipcRenderer.send('pine-editor:script-result', result),
  onScriptResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('pine-editor:script-result', listener);
    return () => ipcRenderer.removeListener('pine-editor:script-result', listener);
  },
  onOpenScript: (callback) => {
    pineOpenScriptCallbacks.add(callback);
    if (pendingPineOpenScript) {
      const script = pendingPineOpenScript;
      pendingPineOpenScript = null;
      callback(script);
    }
    return () => pineOpenScriptCallbacks.delete(callback);
  },
});

contextBridge.exposeInMainWorld('velaVisualBacktestWindow', {
  open: (config) => ipcRenderer.invoke('visual-backtest:open-window', config),
  onOpenConfig: (callback) => {
    visualBacktestConfigCallbacks.add(callback);
    if (pendingVisualBacktestConfig) {
      const config = pendingVisualBacktestConfig;
      pendingVisualBacktestConfig = null;
      queueMicrotask(() => callback(config));
    }
    return () => visualBacktestConfigCallbacks.delete(callback);
  },
});
