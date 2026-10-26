const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SYMBOL_LENGTH = 100;
const MAX_TIMEFRAME_LENGTH = 16;

function validateBarsRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid MetaTrader bars request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  const timeframe = typeof request.timeframe === 'string' ? request.timeframe.trim() : '';
  if (!ticker || ticker.length > MAX_SYMBOL_LENGTH) throw new Error('Enter a valid MetaTrader symbol.');
  if (!timeframe || timeframe.length > MAX_TIMEFRAME_LENGTH) throw new Error('Enter a valid chart timeframe.');
  const range = request.range && typeof request.range === 'object' && !Array.isArray(request.range) ? request.range : {};
  const limit = range.limit === undefined ? 1000 : Number(range.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) throw new Error('MetaTrader history request must be between 1 and 50,000 bars.');
  const from = range.from === undefined ? undefined : Number(range.from);
  const to = range.to === undefined ? undefined : Number(range.to);
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
    throw new Error('MetaTrader history range contains an invalid date.');
  }
  if (from !== undefined && to !== undefined && from > to) throw new Error('MetaTrader history range is reversed.');
  return { ticker, timeframe, range: { from, to, limit } };
}

function validateQuoteRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid MetaTrader quote request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  if (!ticker || ticker.length > MAX_SYMBOL_LENGTH) throw new Error('Enter a valid MetaTrader symbol.');
  return { ticker };
}

function validateTicksRequest(request) {
  const { ticker } = validateQuoteRequest(request);
  const fromMsc = Number(request.fromMsc);
  const limit = request.limit === undefined ? 1000 : Number(request.limit);
  if (!Number.isFinite(fromMsc) || fromMsc < 0) throw new Error('Enter a valid MetaTrader tick start time.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('MetaTrader tick request must be between 1 and 10,000 ticks.');
  return { ticker, fromMsc, limit };
}

class Mt5Bridge {
  constructor({ spawnImpl = spawn, scriptPath = path.join(__dirname, 'mt5_bridge.py') } = {}) {
    this.spawnImpl = spawnImpl;
    this.scriptPath = scriptPath;
    this.child = null;
    this.pythonExecutable = '';
    this.pending = new Map();
    this.output = '';
    this.errorOutput = '';
    this.closing = false;
    this.disconnectPromise = null;
  }

  async connect(pythonExecutable) {
    if (pythonExecutable !== undefined && (typeof pythonExecutable !== 'string' || pythonExecutable.trim().length > 1024)) {
      throw new Error('Enter a valid Python executable path.');
    }
    const executable = pythonExecutable?.trim() || process.env.OMEGA_MT5_PYTHON || 'python';
    if (this.child && executable !== this.pythonExecutable) await this.disconnect();
    this.start(executable);
    try {
      return await this.request('connect');
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async symbols() {
    return this.request('symbols');
  }

  async bars(request) {
    return this.request('bars', validateBarsRequest(request));
  }

  async quote(request) {
    return this.request('quote', validateQuoteRequest(request));
  }

  async ticks(request) {
    return this.request('ticks', validateTicksRequest(request));
  }

  async marketBook(ticker) {
    return this.request('market_book', validateQuoteRequest({ ticker }));
  }

  start(executable) {
    if (this.child) return;
    this.pythonExecutable = executable;
    this.closing = false;
    let child;
    try {
      child = this.spawnImpl(executable, ['-u', this.scriptPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw this.executableError(error, executable);
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.handleStdout(chunk));
    child.stderr.on('data', chunk => {
      this.errorOutput = `${this.errorOutput}${chunk}`.slice(-2000);
    });
    child.on('error', error => this.handleChildFailure(this.executableError(error, executable)));
    child.on('exit', code => {
      const detail = this.errorOutput.trim();
      const suffix = detail ? ` ${detail.slice(-1000)}` : '';
      this.handleChildFailure(new Error(`MetaTrader bridge exited (${code ?? 'unknown'}).${suffix}`));
    });
  }

  executableError(error, executable) {
    if (error?.code === 'ENOENT') {
      return new Error(`Python executable "${executable}" was not found. Install Python 3.10–3.14, or enter its full path. The MetaTrader5 Python package must also be installed for that interpreter.`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  handleStdout(chunk) {
    this.output += chunk;
    let newline;
    while ((newline = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.handleChildFailure(new Error(`MetaTrader bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'MetaTrader bridge request failed.'));
    }
  }

  handleChildFailure(error) {
    const child = this.child;
    this.child = null;
    this.output = '';
    if (child && !this.closing) {
      try {
        child.kill();
      } catch (killError) {
        console.error('Could not stop the failed MetaTrader bridge process:', killError);
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(action, payload = {}) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new Error('MetaTrader is not connected. Open the MT5 Feed panel and connect first.'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MetaTrader did not respond to "${action}" within ${REQUEST_TIMEOUT_MS / 1000} seconds.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async disconnect() {
    if (this.disconnectPromise) return this.disconnectPromise;
    const child = this.child;
    if (!child) return true;
    this.closing = true;
    this.disconnectPromise = (async () => {
      try {
        await this.request('disconnect');
      } catch (error) {
        console.error('MetaTrader bridge did not shut down cleanly:', error);
      } finally {
        if (this.child === child) {
          this.child = null;
          child.kill();
        }
        this.pending.clear();
        this.output = '';
        this.errorOutput = '';
        this.closing = false;
        this.disconnectPromise = null;
      }
      return true;
    })();
    return this.disconnectPromise;
  }
}

module.exports = { Mt5Bridge, validateBarsRequest, validateQuoteRequest, validateTicksRequest };
