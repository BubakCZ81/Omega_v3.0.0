const path = require('node:path');
const { fileURLToPath } = require('node:url');

const APP_DOCUMENTS = ['index.html', 'pine-editor.html', 'visual-backtest.html'];

/**
 * True when the URL belongs to one of the application's own documents, either
 * loaded from the packaged `dist` directory or served by the dev server.
 * Used to gate IPC handlers that the renderer must not reach from other pages.
 */
function isTrustedAppDocument(rawUrl, { devServerUrl = '', distDirectory = '' } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol === 'file:') {
    if (!distDirectory) return false;
    let filePath;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      return false;
    }
    const resolved = path.resolve(filePath);
    return path.dirname(resolved) === path.resolve(distDirectory)
      && APP_DOCUMENTS.includes(path.basename(resolved));
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!isLoopback) return false;
    let devOrigin = null;
    try {
      devOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
    } catch {
      devOrigin = null;
    }
    if (devOrigin && parsed.origin !== devOrigin) return false;
    const documentName = path.basename(parsed.pathname);
    return parsed.pathname === '/' || APP_DOCUMENTS.includes(documentName);
  }

  return false;
}

module.exports = { APP_DOCUMENTS, isTrustedAppDocument };
