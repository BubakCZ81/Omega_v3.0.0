const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fsSync = require('node:fs');
const fs = require('fs/promises');
const { CTraderIntegration } = require('./ctrader.cjs');
const { Mt5Bridge, validateBarsRequest } = require('./mt5.cjs');
const { AlpacaMarketData } = require('./alpaca.cjs');
const { searchYahooNews, safeNewsLink } = require('./news.cjs');
const { LocalAiAssistant } = require('./local-ai.cjs');
const { isTrustedAppDocument: isTrustedPageUrl } = require('./trusted-pages.cjs');

const devServerUrl = process.env.OMEGA_DEV_SERVER_URL || `http://127.0.0.1:${process.env.OMEGA_DEV_PORT || '5173'}`;

let mainWindow = null;
let pineEditorWindow = null;
let visualBacktestWindow = null;
let splashWindow = null;
let startupFallbackTimer = null;
let activeBroker = null;
let brokerSdk = null;
let providerConnectionRevision = 0;
let localAiAssistant = null;
let diagnosticsWindow = null;
const diagnosticsEntries = [];
const DIAGNOSTICS_LIMIT = 2_000;
const DIAGNOSTICS_FILE_LIMIT = 10 * 1024 * 1024;
const diagnosticsFile = path.join(app.getPath('userData'), 'diagnostics.jsonl');
const diagnosticsReady = fs.readFile(diagnosticsFile, 'utf8').then(contents => {
  for (const line of contents.split(/\r?\n/).filter(Boolean).slice(-DIAGNOSTICS_LIMIT)) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.time !== 'string') continue;
      diagnosticsEntries.push({
        time: boundedText(entry.time, 40),
        source: boundedText(entry.source, 32),
        type: boundedText(entry.type, 32),
        name: boundedText(entry.name, 120),
        target: boundedText(entry.target, 160),
        status: boundedText(entry.status, 16),
        message: boundedText(entry.message, 400),
        durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : undefined,
      });
    } catch (error) {
      console.warn('Skipping an invalid Omega diagnostic log entry:', error instanceof Error ? error.name : 'Unknown error');
    }
  }
  diagnosticsEntries.sort((left, right) => left.time.localeCompare(right.time));
}).catch(error => {
  if (error?.code !== 'ENOENT') console.error('Could not load the previous Omega diagnostic log:', error);
});
let diagnosticsWriteQueue = diagnosticsReady;
const cTrader = new CTraderIntegration({ openExternal: (url) => shell.openExternal(url) });
const mt5BridgeScript = app.isPackaged
  ? path.join(process.resourcesPath, 'mt5_bridge.py')
  : path.join(__dirname, 'mt5_bridge.py');
const mt5 = new Mt5Bridge({ scriptPath: mt5BridgeScript });
const alpaca = new AlpacaMarketData({
  safeStorage: require('electron').safeStorage,
  storagePath: path.join(app.getPath('userData'), 'alpaca-market-data.json'),
});

function boundedText(value, limit = 240) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, limit) : undefined;
}

function safeDiagnosticMessage(value) {
  if (typeof value !== 'string') return undefined;
  return boundedText(value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?(?:key|secret)|authorization|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*)["']?[^,\s"'&]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|api[_-]?secret|token|access_token|refresh_token|signature|authorization)=)[^&\s]+/gi, '$1[REDACTED]'), 400);
}

function appendDiagnostic(record, persist = true) {
  const entry = {
    time: new Date().toISOString(),
    source: boundedText(record?.source, 32) || 'app',
    type: boundedText(record?.type, 32) || 'event',
    name: boundedText(record?.name, 120),
    target: boundedText(record?.target, 160),
    status: boundedText(record?.status, 16),
    message: safeDiagnosticMessage(record?.message),
    durationMs: Number.isFinite(record?.durationMs) ? Math.max(0, Math.round(record.durationMs)) : undefined,
  };
  diagnosticsEntries.push(entry);
  if (diagnosticsEntries.length > DIAGNOSTICS_LIMIT) diagnosticsEntries.splice(0, diagnosticsEntries.length - DIAGNOSTICS_LIMIT);
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) diagnosticsWindow.webContents.send('diagnostics:entry', entry);

  if (!persist) return entry;
  diagnosticsWriteQueue = diagnosticsWriteQueue.then(async () => {
    await fs.mkdir(path.dirname(diagnosticsFile), { recursive: true });
    const current = await fs.stat(diagnosticsFile).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (current && current.size >= DIAGNOSTICS_FILE_LIMIT) {
      const previous = `${diagnosticsFile}.1`;
      await fs.rm(previous, { force: true });
      await fs.rename(diagnosticsFile, previous);
    }
    await fs.appendFile(diagnosticsFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }).catch(error => {
    console.error('Could not persist Omega diagnostic event:', error);
  });
  return entry;
}

function appendFatalDiagnostic(record) {
  const entry = appendDiagnostic(record, false);
  try {
    fsSync.mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
    fsSync.appendFileSync(diagnosticsFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Could not persist fatal Omega diagnostic event:', error);
  }
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  appendFatalDiagnostic({
    source: 'electron-main',
    type: 'process',
    name: 'uncaught-exception',
    status: 'error',
    message: `${origin}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
  });
});

function describeBarFetch(request, bars) {
  if (!request || typeof request !== 'object') return 'Invalid Alpaca history request metadata.';
  if (bars === null) return 'No bars returned: there is no active Alpaca history connection.';
  if (!Array.isArray(bars)) return `Invalid bars response: expected an array, received ${typeof bars}.`;
  const isoTime = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : 'invalid timestamp';
  };
  const symbol = typeof request.symbol === 'string' ? request.symbol.trim().toUpperCase() : 'unknown symbol';
  const timeframe = typeof request.timeframe === 'string' ? request.timeframe.trim() : 'unknown timeframe';
  const first = Number.isFinite(bars[0]?.time) ? isoTime(bars[0].time) : null;
  const lastBar = bars[bars.length - 1];
  const last = Number.isFinite(lastBar?.time) ? isoTime(lastBar.time) : null;
  const requestFrom = Number.isFinite(request.from) ? isoTime(request.from) : 'unspecified';
  const requestTo = Number.isFinite(request.to) ? isoTime(request.to) : 'unspecified';
  const returnedRange = first && last ? `, ${first} to ${last}` : '';
  return `${symbol} ${timeframe}: ${bars.length} bars for ${requestFrom} to ${requestTo}${returnedRange}`;
}

function createDiagnosticsWindow() {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow.show();
    diagnosticsWindow.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 720,
    minHeight: 420,
    title: 'Omega Diagnostic Console',
    backgroundColor: '#101720',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  diagnosticsWindow = win;
  win.on('closed', () => {
    appendDiagnostic({ source: 'electron-main', type: 'window', name: 'diagnostics.closed' });
    if (diagnosticsWindow === win) diagnosticsWindow = null;
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omega Diagnostic Console</title>
  <style>
    :root{color-scheme:dark;font:13px/1.4 "Segoe UI",sans-serif;background:#101720;color:#e6edf5}
    *{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column}
    header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #2b3746;background:#17212e}
    h1{font-size:15px;margin:0}.hint{color:#9aabba;font-size:11px;flex:1}
    button{background:#26364a;color:#e6edf5;border:1px solid #43566e;border-radius:4px;padding:6px 10px;cursor:pointer}
    #rows{overflow:auto;flex:1;padding:6px 10px;font:12px/1.45 Consolas,monospace}
    .row{display:grid;grid-template-columns:155px 100px 115px 1fr;gap:10px;padding:4px 6px;border-bottom:1px solid #202c39;white-space:pre-wrap;overflow-wrap:anywhere}
    .time,.source{color:#93a7bd}.status{color:#7dd3a5}.error{color:#ff7b86}
    footer{padding:7px 12px;color:#9aabba;border-top:1px solid #2b3746;font-size:11px;overflow-wrap:anywhere}
  </style></head><body><header><h1>Omega Diagnostic Console</h1><span class="hint">Local clicks, dialogs, window lifecycle, and IPC method trace. Typed values and request payloads are not recorded.</span><button id="pause">Pause</button><button id="bottom">Latest</button></header><main id="rows" aria-live="polite"></main><footer id="location">Loading local log location…</footer>
  <script>
    const rows=document.getElementById('rows');let paused=false;let queued=[];
    function add(entry){const row=document.createElement('div');row.className='row';const time=document.createElement('span');time.className='time';time.textContent=entry.time||'';const source=document.createElement('span');source.className='source';source.textContent=entry.source||'';const method=document.createElement('span');method.textContent=[entry.type,entry.name].filter(Boolean).join(' · ');const detail=document.createElement('span');detail.className=entry.status==='error'?'error':'status';detail.textContent=[entry.status,entry.target,entry.message,Number.isFinite(entry.durationMs)?entry.durationMs+' ms':''].filter(Boolean).join(' · ');row.append(time,source,method,detail);rows.append(row);if(!paused)rows.scrollTop=rows.scrollHeight}
    document.getElementById('pause').addEventListener('click',event=>{paused=!paused;event.currentTarget.textContent=paused?'Resume':'Pause';if(!paused){queued.forEach(add);queued=[]}});
    document.getElementById('bottom').addEventListener('click',()=>{rows.scrollTop=rows.scrollHeight});
    window.velaDiagnostics.getRecent().then(result=>{result.entries.forEach(add);document.getElementById('location').textContent='Saved locally: '+result.file;});
    window.velaDiagnostics.onEntry(entry=>{if(paused)queued.push(entry);else add(entry)});
  </script></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  appendDiagnostic({ source: 'electron-main', type: 'window', name: 'diagnostics.open' });
  return true;
}

const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalIpcHandle(channel, async (...args) => {
  if (String(channel).startsWith('diagnostics:')) return listener(...args);
  const event = args[0];
  const source = event?.sender === mainWindow?.webContents
    ? 'main-window'
    : event?.sender === pineEditorWindow?.webContents ? 'pine-editor'
      : event?.sender === visualBacktestWindow?.webContents ? 'visual-backtest'
        : 'renderer';
  const startedAt = Date.now();
  appendDiagnostic({ source, type: 'method', name: String(channel), status: 'start' });
  try {
    const result = await listener(...args);
    const barFetch = channel === 'broker:fetch-bars';
    const emptyBars = barFetch && (!Array.isArray(result) || result.length === 0);
    appendDiagnostic({
      source: 'electron-main',
      type: 'method',
      name: String(channel),
      status: emptyBars ? 'empty' : 'ok',
      message: barFetch ? describeBarFetch(args[1], result) : undefined,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    appendDiagnostic({
      source: 'electron-main',
      type: 'method',
      name: String(channel),
      status: 'error',
      message: error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
});

ipcMain.on('diagnostics:event', (event, record) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow, diagnosticsWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) return;
  appendDiagnostic(record);
});

ipcMain.handle('diagnostics:get-recent', async (event) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow, diagnosticsWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) throw new Error('Diagnostics are available only to Omega windows.');
  await diagnosticsReady;
  return { entries: diagnosticsEntries, file: diagnosticsFile };
});

ipcMain.handle('diagnostics:open', (event) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) throw new Error('Diagnostics are available only to Omega windows.');
  return createDiagnosticsWindow();
});

app.on('browser-window-created', (_event, window) => {
  const title = window.getTitle() || 'Untitled window';
  appendDiagnostic({ source: 'electron-main', type: 'window', name: `created: ${title}` });
  for (const eventName of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'maximize', 'unmaximize', 'close']) {
    window.on(eventName, () => appendDiagnostic({
      source: 'electron-main',
      type: 'window',
      name: `${eventName}: ${title}`,
    }));
  }
  window.on('closed', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `closed: ${title}`,
  }));
  window.on('unresponsive', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `unresponsive: ${title}`,
    status: 'error',
  }));
  window.on('responsive', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `responsive: ${title}`,
    status: 'ok',
  }));
  window.webContents.on('render-process-gone', (_event, details) => appendDiagnostic({
    source: 'electron-main',
    type: 'process',
    name: `renderer-gone: ${title}`,
    status: 'error',
    message: `reason=${details.reason}; exitCode=${details.exitCode}`,
  }));
});

cTrader.on('quote', (quote) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ctrader:quote', quote);
});
function getBrokerSdk() {
  brokerSdk ??= require('@luxalgo/broker-sdk');
  return brokerSdk;
}

async function disconnectAllConnections() {
  const revision = ++providerConnectionRevision;
  activeBroker = null;
  await Promise.all([cTrader.disconnect(), mt5.disconnect(), alpaca.disconnect()]);
  return revision;
}

function isTrustedAppDocument(rawUrl) {
  return isTrustedPageUrl(rawUrl, {
    devServerUrl,
    distDirectory: path.join(__dirname, '../dist'),
  });
}

function assertTrustedBrokerRequest(event) {
  const trustedWindow = [mainWindow, pineEditorWindow, visualBacktestWindow].find(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trustedWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Broker access is available only to the application window.');
  }
  if (!isTrustedAppDocument(event.senderFrame.url)) throw new Error('Broker access is blocked for this page.');
}

function assertTrustedWorkspaceRequest(event) {
  assertTrustedBrokerRequest(event);
}

function dialogOwnerFor(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function workspaceFileName(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'omega-workspace';
}

function getLocalAiAssistant() {
  localAiAssistant ??= new LocalAiAssistant({
    safeStorage: require('electron').safeStorage,
    storagePath: path.join(app.getPath('userData'), 'ai-api-keys.json'),
    localConfigPath: path.join(app.getPath('userData'), 'ai-local-endpoint.json'),
  });
  return localAiAssistant;
}

const workspaceStatePath = () => path.join(app.getPath('userData'), 'workspace.json');

async function loadWorkspaceState() {
  const target = workspaceStatePath();
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const legacy = path.join(app.getPath('appData'), 'vela-desktop-app', 'workspace.json');
  if (legacy === target) return null;
  try {
    const state = await fs.readFile(legacy, 'utf8');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(legacy, target, fs.constants.COPYFILE_EXCL).catch(async (error) => {
      if (!error || error.code !== 'EEXIST') throw error;
      await fs.access(target);
    });
    return state;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

ipcMain.handle('workspace:load', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return loadWorkspaceState();
});

ipcMain.handle('workspace:save', async (event, state) => {
  assertTrustedWorkspaceRequest(event);
  if (typeof state !== 'string' || state.length > 25_000_000) throw new Error('Invalid workspace state.');
  const parsed = JSON.parse(state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Invalid workspace document.');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const target = workspaceStatePath();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, state, 'utf8');
  await fs.rename(temporary, target);
});

ipcMain.handle('workspace:save-profile', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request.state !== 'string' || request.state.length > 25_000_000) throw new Error('Invalid workspace state.');
  const name = typeof request.name === 'string' ? request.name.trim().slice(0, 80) : '';
  const result = await dialog.showSaveDialog(dialogOwnerFor(event), {
    title: 'Save Chart Workspace',
    defaultPath: `${workspaceFileName(name)}.json`,
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const parsed = JSON.parse(request.state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Invalid workspace document.');
  await fs.writeFile(result.filePath, request.state, 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('workspace:load-profile', async (event) => {
  assertTrustedWorkspaceRequest(event);
  const result = await dialog.showOpenDialog(dialogOwnerFor(event), {
    title: 'Load Chart Workspace',
    properties: ['openFile'],
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const state = await fs.readFile(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Selected file is not a valid Vela workspace.');
  return { canceled: false, state, path: result.filePaths[0] };
});

ipcMain.handle('pine:export', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request.source !== 'string' || request.source.length > 2_000_000) {
    throw new Error('Invalid Pine script.');
  }
  const name = typeof request.name === 'string' ? request.name.trim().slice(0, 160) : 'pine-script';
  const result = await dialog.showSaveDialog(dialogOwnerFor(event), {
    title: 'Export Pine Script',
    defaultPath: `${workspaceFileName(name)}.pine`,
    filters: [{ name: 'Pine Script', extensions: ['pine'] }, { name: 'Text file', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, request.source, 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('news:search', async (event, symbol) => {
  assertTrustedWorkspaceRequest(event);
  return searchYahooNews(symbol);
});

ipcMain.handle('news:open', async (event, target) => {
  assertTrustedWorkspaceRequest(event);
  const url = safeNewsLink(target);
  if (!url) throw new Error('The news link is not a valid secure URL.');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('ai:providers', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().configuredProviders();
});

ipcMain.handle('ai:save-key', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid AI key request.');
  return getLocalAiAssistant().saveKey(request.provider, request.apiKey);
});

ipcMain.handle('ai:clear-key', async (event, provider) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().clearKey(provider);
});

ipcMain.handle('ai:test-key', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid AI key test request.');
  return getLocalAiAssistant().testKey(request.provider, request.apiKey);
});

ipcMain.handle('ai:local-config', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().localConfig();
});

ipcMain.handle('ai:save-local-config', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().saveLocalConfig(request);
});

ipcMain.handle('ai:test-local-config', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().testLocalConfig(request);
});

ipcMain.handle('ai:complete', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().complete(request);
});

function toBrokerSnapshot(snapshot) {
  return {
    broker: snapshot.broker,
    fetchedAt: snapshot.fetchedAt,
    accounts: snapshot.accounts.map((account) => ({
      name: account.name,
      currency: account.currency,
      equity: account.equity,
      cash: account.cash,
      environment: account.environment,
      positions: account.positions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        marketValue: position.marketValue,
        assetClass: position.assetClass,
      })),
    })),
  };
}

ipcMain.handle('broker:list', (event) => {
  assertTrustedBrokerRequest(event);
  return [...getBrokerSdk().listBrokers().map(({ id, displayName, credentials, readOnlySetup }) => ({
    id,
    displayName,
    credentials,
    readOnlySetup,
  })), {
    id: 'ctrader',
    displayName: 'cTrader Open API',
    credentials: [
      { key: 'clientId', label: 'Open API Client ID', secret: false },
      { key: 'clientSecret', label: 'Open API Client Secret', secret: true },
    ],
    readOnlySetup: 'First create a cTrader Open API app and use its Client ID and Client Secret here (redirect URI: http://127.0.0.1:17863/ctrader/callback). Then Omega opens cTrader ID sign-in in your system browser; use Google there only if cTrader offers it for your account. Omega never accepts your Google/cTrader password.',
  }];
});

ipcMain.handle('broker:connect-read-only', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request.brokerId !== 'string' || !request.credentials || typeof request.credentials !== 'object') {
    throw new Error('Choose a broker and enter its required credentials.');
  }
  if (request.brokerId === 'ctrader') throw new Error('Use the cTrader authorization flow for this broker.');

  const sdk = getBrokerSdk();
  const brokerInfo = sdk.listBrokers().find(({ id }) => id === request.brokerId);
  if (!brokerInfo) throw new Error('That broker is not supported by the installed SDK.');

  const suppliedCredentials = { ...request.credentials };
  if (request.brokerId === 'alpaca') {
    const apiKey = suppliedCredentials.apiKey;
    const apiSecret = suppliedCredentials.apiSecret;
    if (!apiKey && !apiSecret) {
      const saved = await alpaca.readBrokerCredentials();
      if (!saved) throw new Error('Enter and save the Alpaca API key ID and secret key first.');
      Object.assign(suppliedCredentials, saved);
    } else if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || !apiKey.trim() || !apiSecret.trim()) {
      throw new Error('Enter both Alpaca API credentials, or leave both blank to use the saved encrypted credentials.');
    }
  }

  const credentials = {};
  for (const field of brokerInfo.credentials) {
    const value = suppliedCredentials[field.key];
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
      throw new Error(`Enter a valid value for ${field.label}.`);
    }
    credentials[field.key] = value.trim();
  }

  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('Broker connection was superseded by a newer provider request.');
  const connection = sdk.connect({ broker: brokerInfo.id, credentials });
  const snapshot = await connection.fetchSnapshot();
  if (revision !== providerConnectionRevision) throw new Error('Broker connection was superseded by a newer provider request.');
  activeBroker = connection;
  return toBrokerSnapshot(snapshot);
});

ipcMain.handle('broker:save-alpaca-credentials', async (event, credentials) => {
  assertTrustedBrokerRequest(event);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Enter valid Alpaca credentials.');
  return alpaca.saveBrokerCredentials(credentials);
});

ipcMain.handle('broker:has-saved-alpaca-credentials', async (event) => {
  assertTrustedBrokerRequest(event);
  return (await alpaca.status()).configured;
});

ipcMain.handle('ctrader:authorize', async (event, credentials) => {
  assertTrustedBrokerRequest(event);
  if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string'
    || (credentials.allowTrading !== undefined && typeof credentials.allowTrading !== 'boolean')) {
    throw new Error('Enter the cTrader Open API Client ID and Client Secret.');
  }
  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('cTrader authorization was superseded by a newer provider request.');
  const authorization = await cTrader.authorize(credentials);
  if (revision !== providerConnectionRevision) throw new Error('cTrader authorization was superseded by a newer provider request.');
  return authorization;
});

ipcMain.handle('ctrader:select-account', async (event, accountId) => {
  assertTrustedBrokerRequest(event);
  if (typeof accountId !== 'string' || !accountId) throw new Error('Choose a cTrader account.');
  return cTrader.selectAccount(accountId);
});

ipcMain.handle('ctrader:subscribe-symbol', async (event, symbolId) => {
  assertTrustedBrokerRequest(event);
  if (typeof symbolId !== 'string' || !symbolId) throw new Error('Choose a cTrader symbol.');
  return cTrader.subscribeSymbol(symbolId);
});

ipcMain.handle('ctrader:place-demo-market-order', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid demo order request.');
  return cTrader.placeDemoMarketOrder(request);
});

ipcMain.handle('ctrader:reconcile-account', async (event) => {
  assertTrustedBrokerRequest(event);
  return cTrader.reconcileActiveAccount();
});

ipcMain.handle('broker:fetch-snapshot', async (event) => {
  assertTrustedBrokerRequest(event);
  if (!activeBroker) throw new Error('Connect to a broker first.');
  return toBrokerSnapshot(await activeBroker.fetchSnapshot());
});

ipcMain.handle('broker:fetch-bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!activeBroker || activeBroker.broker !== 'alpaca' || typeof activeBroker.fetchBars !== 'function') return null;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid Alpaca history request.');
  }
  if (typeof request.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,19}$/i.test(request.symbol.trim())) {
    throw new Error('Enter a valid Alpaca stock ticker.');
  }
  const timeframes = { '1': '1m', '1m': '1m', '5': '5m', '5m': '5m', '15': '15m', '15m': '15m', '60': '1h', '1h': '1h', D: '1d', '1D': '1d', '1d': '1d' };
  const timeframe = timeframes[String(request.timeframe).trim()];
  if (!timeframe) throw new Error(`The Alpaca Broker SDK does not support "${request.timeframe}" bars.`);
  const from = Number(request.from);
  const to = Number(request.to);
  const limit = request.limit === undefined ? 10_000 : Number(request.limit);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error('Choose a valid Alpaca history date range.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Alpaca Broker SDK history requests must be between 1 and 10,000 bars.');
  }
  return activeBroker.fetchBars(request.symbol.trim().toUpperCase(), { timeframe, from, to, limit });
});

ipcMain.handle('broker:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  await disconnectAllConnections();
  return true;
});

ipcMain.handle('mt5:connect', async (event, pythonExecutable) => {
  assertTrustedBrokerRequest(event);
  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('MetaTrader connection was superseded by a newer provider request.');
  const connection = await mt5.connect(pythonExecutable);
  if (revision !== providerConnectionRevision) throw new Error('MetaTrader connection was superseded by a newer provider request.');
  return connection;
});

ipcMain.handle('mt5:bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5.bars(validateBarsRequest(request));
});

ipcMain.handle('mt5:quote', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5.quote(request);
});

ipcMain.handle('mt5:ticks', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5.ticks(request);
});

ipcMain.handle('mt5:market-book', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  return mt5.marketBook(ticker);
});

ipcMain.handle('mt5:symbols', async (event) => {
  assertTrustedBrokerRequest(event);
  return mt5.symbols();
});

ipcMain.handle('mt5:info', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  if (typeof ticker !== 'string' || !ticker.trim() || ticker.length > 100) throw new Error('Enter a valid MetaTrader symbol.');
  return mt5.request('info', { ticker: ticker.trim() });
});

ipcMain.handle('mt5:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  return mt5.disconnect();
});

function closeSplash() {
  if (startupFallbackTimer) {
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function showMainWindow() {
  closeSplash();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 420,
    height: 230,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0e14',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e8edf5;font-family:Segoe UI,Arial,sans-serif}
    main{text-align:center}.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#2962ff,#00a5ff);font-size:24px;font-weight:800;box-shadow:0 12px 34px #2962ff44}
    h1{margin:0;font-size:22px;letter-spacing:.04em}p{margin:8px 0 22px;color:#92a0b5;font-size:13px}.bar{width:170px;height:3px;margin:auto;overflow:hidden;border-radius:8px;background:#202938}.bar:after{content:'';display:block;width:45%;height:100%;border-radius:inherit;background:#3b82f6;animation:load 1.1s ease-in-out infinite}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(280%)}}
  </style></head><body><main><div class="mark">Ω</div><h1>OMEGA</h1><p>Preparing your trading workspace…</p><div class="bar"></div></main></body></html>`)}`);
  splashWindow = splash;
  splash.on('closed', () => { if (splashWindow === splash) splashWindow = null; });
}

function createWindow() {
  createSplashWindow();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Omega Trading Desktop Terminal',
    backgroundColor: '#0b0e14',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    closeSplash();
    activeBroker = null;
    // Auxiliary windows talk to the main window over IPC; they cannot work
    // without it, so close them instead of leaving orphaned, unresponsive
    // Pine Editor / Visual Backtest windows behind.
    for (const auxiliary of [pineEditorWindow, visualBacktestWindow]) {
      if (auxiliary && !auxiliary.isDestroyed()) auxiliary.close();
    }
    void cTrader.disconnect();
    void mt5.disconnect();
    void alpaca.disconnect();
    mainWindow = null;
  });

  // If running in development, load the Vite dev server
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.once('did-fail-load', showMainWindow);
  // The renderer keeps its own startup screen visible. Reveal the native window
  // quickly instead of holding the whole app behind a splash while feeds connect.
  startupFallbackTimer = setTimeout(showMainWindow, 1200);
}

function createPineEditorWindow() {
  if (pineEditorWindow && !pineEditorWindow.isDestroyed()) {
    pineEditorWindow.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: 'Omega Pine Editor',
    backgroundColor: '#17202c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  pineEditorWindow = win;
  win.on('closed', () => { pineEditorWindow = null; });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) {
    void win.loadURL(new URL('pine-editor.html', `${devServerUrl}/`).href);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/pine-editor.html'));
  }
  return true;
}

function createVisualBacktestWindow() {
  if (visualBacktestWindow && !visualBacktestWindow.isDestroyed()) {
    visualBacktestWindow.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1000, minHeight: 680,
    title: 'Omega Visual Backtest', backgroundColor: '#0b0e14', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  visualBacktestWindow = win;
  win.on('closed', () => { if (visualBacktestWindow === win) visualBacktestWindow = null; });
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) void win.loadURL(new URL('visual-backtest.html', `${devServerUrl}/`).href);
  else void win.loadFile(path.join(__dirname, '../dist/visual-backtest.html'));
  return true;
}

ipcMain.handle('visual-backtest:open-window', (event, config) => {
  assertTrustedWorkspaceRequest(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (!config || typeof config.symbol !== 'string' || typeof config.timeframe !== 'string'
    || config.symbol.length > 80 || config.timeframe.length > 20
    || (config.provider !== undefined && typeof config.provider !== 'string')) return false;
  createVisualBacktestWindow();
  if (!visualBacktestWindow || visualBacktestWindow.isDestroyed()) return false;
  const send = () => {
    if (visualBacktestWindow && !visualBacktestWindow.isDestroyed()) {
      visualBacktestWindow.webContents.send('visual-backtest:open-config', { symbol: config.symbol, timeframe: config.timeframe, provider: config.provider || '' });
      visualBacktestWindow.focus();
    }
  };
  if (visualBacktestWindow.webContents.isLoading()) visualBacktestWindow.webContents.once('did-finish-load', send); else send();
  appendDiagnostic({ source: 'visual-backtest', type: 'window', name: 'opened', status: 'ok', message: `${config.symbol} ${config.timeframe}` });
  return true;
});

ipcMain.handle('pine-editor:open-window', (event) => {
  assertTrustedWorkspaceRequest(event);
  return createPineEditorWindow();
});

ipcMain.handle('neural:save-model', async (event, profile) => {
  assertTrustedWorkspaceRequest(event);
  if (!profile || profile.version !== 1 || typeof profile.name !== 'string' || typeof profile.symbol !== 'string'
    || typeof profile.timeframe !== 'string' || !Array.isArray(profile.featureKeys)) throw new Error('Invalid neural model profile.');
  const serialized = JSON.stringify(profile);
  if (serialized.length > 5 * 1024 * 1024) throw new Error('Neural model is too large to save.');
  const directory = path.join(app.getPath('userData'), 'neural-models');
  await fs.mkdir(directory, { recursive: true });
  const safeName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${profile.symbol}-${profile.timeframe}`.replace(/[^a-z0-9_-]/gi, '_').slice(0, 180);
  const file = `${safeName}.json`;
  const target = path.join(directory, file);
  await fs.writeFile(`${target}.tmp`, serialized, 'utf8');
  await fs.rename(`${target}.tmp`, target);
  appendDiagnostic({ source: 'neural-network', type: 'storage', name: 'model.save', status: 'ok', message: file });
  return { file };
});

ipcMain.handle('pine-editor:open-script', (event, script) => {
  assertTrustedWorkspaceRequest(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (!script || typeof script.name !== 'string' || typeof script.source !== 'string'
    || script.name.length > 200 || script.source.length > 2_000_000) return false;
  createPineEditorWindow();
  if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return false;
  const send = () => {
    if (pineEditorWindow && !pineEditorWindow.isDestroyed()) {
      pineEditorWindow.webContents.send('pine-editor:open-script', script);
      pineEditorWindow.focus();
    }
  };
  if (pineEditorWindow.webContents.isLoading()) pineEditorWindow.webContents.once('did-finish-load', send);
  else send();
  return true;
});

ipcMain.on('pine-editor:open-docked', (event) => {
  if (!pineEditorWindow || event.sender !== pineEditorWindow.webContents) return;
  pineEditorWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pine-editor:open-docked');
});

ipcMain.on('pine-editor:script-updated', (event, script) => {
  if (!pineEditorWindow || event.sender !== pineEditorWindow.webContents) return;
  if (!script || typeof script.name !== 'string' || typeof script.source !== 'string' || !['add', 'update'].includes(script.action) || script.name.length > 200 || script.source.length > 2_000_000) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pine-editor:script-updated', script);
});

ipcMain.on('pine-editor:script-result', (event, result) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return;
  if (!result || typeof result.name !== 'string' || typeof result.message !== 'string'
    || !['add', 'update'].includes(result.action) || typeof result.ok !== 'boolean') return;
  pineEditorWindow.webContents.send('pine-editor:script-result', result);
});

ipcMain.on('app:ready', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  showMainWindow();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void mt5.disconnect();
  void cTrader.disconnect();
  void alpaca.disconnect();
});
