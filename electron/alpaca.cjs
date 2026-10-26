const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_KEY_LENGTH = 4096;
const MAX_BARS = 50_000;
const ALPACA_LIVE_API = 'https://api.alpaca.markets';
const ALPACA_PAPER_API = 'https://paper-api.alpaca.markets';
const SUPPORTED_TIMEFRAMES = new Map([
  ['1', { api: '1Min', minutes: 1, sourceMinutes: 1 }],
  ['5', { api: '5Min', minutes: 5, sourceMinutes: 5 }],
  ['15', { api: '15Min', minutes: 15, sourceMinutes: 15 }],
  ['30', { api: '30Min', minutes: 30, sourceMinutes: 30 }],
  ['60', { api: '1Hour', minutes: 60, sourceMinutes: 60 }],
  ['D', { api: '1Day', minutes: 1440, sourceMinutes: 1440 }],
  ['1D', { api: '1Day', minutes: 1440, sourceMinutes: 1440 }],
]);

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_KEY_LENGTH) {
    throw new Error(`Enter a valid Alpaca ${label}.`);
  }
  return value.trim();
}

function validateTicker(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid US stock ticker.');
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker)) throw new Error('Enter a valid US stock ticker.');
  return ticker;
}

function timeframe(value) {
  const key = String(value).trim().toUpperCase();
  const native = SUPPORTED_TIMEFRAMES.get(key);
  if (native) return native;
  const minutes = Number(key);
  if (/^\d+$/.test(key) && Number.isSafeInteger(minutes) && minutes > 0 && minutes < 1440) {
    const sourceMinutes = minutes > 60 && minutes % 60 === 0 ? 60 : 1;
    return {
      api: sourceMinutes === 60 ? '1Hour' : '1Min',
      minutes,
      sourceMinutes,
    };
  }
  if (key === 'W' || key === '1W' || key === 'W1') {
    return { api: '1Day', minutes: 10_080, sourceMinutes: 1440, period: 'week' };
  }
  if (key === 'M' || key === 'MN1' || key === '1MO') {
    return { api: '1Day', minutes: 0, sourceMinutes: 1440, period: 'month' };
  }
  throw new Error(`Alpaca does not support chart timeframe "${value}".`);
}

function aggregateBars(bars, frame) {
  if (!frame.period && frame.minutes === frame.sourceMinutes) return bars;
  const buckets = new Map();
  for (const bar of bars) {
    let time;
    if (frame.period === 'month') {
      const date = new Date(bar.time);
      time = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    } else if (frame.period === 'week') {
      const mondayOffset = 3 * 86_400_000;
      time = Math.floor((bar.time + mondayOffset) / 604_800_000) * 604_800_000 - mondayOffset;
    } else {
      const size = frame.minutes * 60_000;
      time = Math.floor(bar.time / size) * size;
    }
    const current = buckets.get(time);
    if (!current) {
      buckets.set(time, { ...bar, time });
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
    }
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

function decodeSocketData(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  throw new Error('Alpaca returned an unsupported WebSocket message.');
}

class AlpacaMarketData extends EventEmitter {
  constructor({
    safeStorage,
    storagePath,
    fetchImpl = globalThis.fetch,
    WebSocketCtor = globalThis.WebSocket,
    socketUrl = 'wss://stream.data.alpaca.markets/v2/iex',
  }) {
    super();
    this.safeStorage = safeStorage;
    this.storagePath = storagePath;
    this.fetchImpl = fetchImpl;
    this.WebSocketCtor = WebSocketCtor;
    this.socketUrl = socketUrl;
    this.credentials = null;
    this.socket = null;
    this.authenticated = false;
    this.connectPromise = null;
    this.subscriptions = new Map();
    this.minuteBuckets = new Map();
    this.streamSubscriptions = { bars: new Set(), updatedBars: new Set(), dailyBars: new Set() };
  }

  assertSecureStorageAvailable() {
    if (!this.safeStorage || typeof this.safeStorage.isEncryptionAvailable !== 'function'
      || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure API-key storage is unavailable. Alpaca credentials were not saved.');
    }
    if (typeof this.safeStorage.getSelectedStorageBackend === 'function'
      && this.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('The operating system does not provide encrypted API-key storage. Alpaca credentials were not saved.');
    }
  }

  async readSavedCredentials() {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(this.storagePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('The encrypted Alpaca credential store is invalid. Re-enter the API keys.');
      throw error;
    }
    if (!saved || saved.version !== 1 || typeof saved.keyId !== 'string' || typeof saved.secretKey !== 'string') {
      throw new Error('The encrypted Alpaca credential store has an unsupported format.');
    }
    this.assertSecureStorageAvailable();
    try {
      return {
        keyId: this.safeStorage.decryptString(Buffer.from(saved.keyId, 'base64')),
        secretKey: this.safeStorage.decryptString(Buffer.from(saved.secretKey, 'base64')),
      };
    } catch {
      throw new Error('Could not decrypt the saved Alpaca credentials. Re-enter the API keys.');
    }
  }

  async writeCredentials(credentials) {
    this.assertSecureStorageAvailable();
    const serialized = {
      version: 1,
      keyId: this.safeStorage.encryptString(credentials.keyId).toString('base64'),
      secretKey: this.safeStorage.encryptString(credentials.secretKey).toString('base64'),
    };
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    const temporaryPath = `${this.storagePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(serialized), { mode: 0o600 });
    await fs.rename(temporaryPath, this.storagePath);
  }

  async saveBrokerCredentials(candidate = {}) {
    const apiKey = requiredText(candidate.apiKey, 'API key ID');
    const apiSecret = requiredText(candidate.apiSecret, 'secret key');
    await this.writeCredentials({ keyId: apiKey, secretKey: apiSecret });
    return { configured: true };
  }

  async readBrokerCredentials() {
    const saved = await this.readSavedCredentials();
    return saved ? { apiKey: saved.keyId, apiSecret: saved.secretKey } : null;
  }

  async status() {
    let configured = false;
    try {
      configured = (await this.readSavedCredentials()) !== null;
    } catch (error) {
      return { connected: this.authenticated, configured: false, error: error.message };
    }
    return { connected: this.authenticated, configured };
  }

  async connect(candidate = {}) {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal(candidate);
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectInternal(candidate) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Enter the Alpaca API key ID and secret key.');
    }
    if ((candidate.keyId !== undefined && typeof candidate.keyId !== 'string')
      || (candidate.secretKey !== undefined && typeof candidate.secretKey !== 'string')) {
      throw new Error('Enter the Alpaca API key ID and secret key as text.');
    }
    const keyId = typeof candidate.keyId === 'string' ? candidate.keyId.trim() : '';
    const secretKey = typeof candidate.secretKey === 'string' ? candidate.secretKey.trim() : '';
    let credentials;
    if (!keyId && !secretKey) {
      credentials = await this.readSavedCredentials();
      if (!credentials) throw new Error('Enter your Alpaca API key ID and secret key first.');
    } else {
      if (!keyId || !secretKey) throw new Error('Enter both the Alpaca API key ID and secret key.');
      credentials = {
        keyId: requiredText(keyId, 'API key ID'),
        secretKey: requiredText(secretKey, 'secret key'),
      };
    }

    await this.closeSocket();
    this.assertSecureStorageAvailable();
    await this.verifyCredentials(credentials);
    try {
      await this.openStream(credentials);
      await this.writeCredentials(credentials);
      this.credentials = credentials;
    } catch (error) {
      await this.closeSocket();
      throw error;
    }
    this.emit('status', { connected: true, configured: true });
    return { connected: true, configured: true, feed: 'IEX' };
  }

  async verifyCredentials(credentials) {
    if (typeof this.fetchImpl !== 'function') throw new Error('Alpaca HTTP requests are unavailable.');
    const url = new URL('https://data.alpaca.markets/v2/stocks/AAPL/bars');
    url.search = new URLSearchParams({ timeframe: '1Min', limit: '1', feed: 'iex' }).toString();
    const response = await this.fetchImpl(url, {
      headers: {
        'APCA-API-KEY-ID': credentials.keyId,
        'APCA-API-SECRET-KEY': credentials.secretKey,
      },
      signal: AbortSignal.timeout(20_000),
    });
    await this.readResponse(response, 'Alpaca');
  }

  async readResponse(response, service) {
    if (!response.ok) {
      const body = await response.text();
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = typeof parsed.message === 'string' ? parsed.message : '';
      } catch {
        detail = '';
      }
      throw new Error(`${service} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : '.'}`);
    }
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${service} returned an invalid response.`);
    return result;
  }

  async bars(request) {
    if (!this.credentials || !this.authenticated) throw new Error('Connect Alpaca in the Alpaca Feed panel first.');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Alpaca bars request.');
    const ticker = validateTicker(request.ticker);
    const frame = timeframe(request.timeframe);
    const range = request.range && typeof request.range === 'object' ? request.range : {};
    const limit = range.limit === undefined ? 1000 : Number(range.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BARS) {
      throw new Error(`Alpaca history requests must be between 1 and ${MAX_BARS} bars.`);
    }
    const from = range.from === undefined ? undefined : Number(range.from);
    const to = range.to === undefined ? undefined : Number(range.to);
    if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
      throw new Error('Alpaca history range contains an invalid date.');
    }
    if (from !== undefined && to !== undefined && from > to) throw new Error('Alpaca history range is reversed.');

    const sourceBarsLimit = Math.min(MAX_BARS, limit * (frame.period === 'month'
      ? 31
      : frame.period === 'week'
        ? 7
        : Math.max(1, frame.minutes / frame.sourceMinutes)));
    const allBars = [];
    let pageToken;
    const seenPageTokens = new Set();
    do {
      const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars`);
      const params = new URLSearchParams({
        timeframe: frame.api,
        limit: String(Math.min(sourceBarsLimit, 10_000)),
        feed: 'iex',
        sort: 'desc',
      });
      if (from !== undefined) params.set('start', new Date(from).toISOString());
      if (to !== undefined) params.set('end', new Date(to).toISOString());
      if (pageToken) params.set('page_token', pageToken);
      url.search = params.toString();
      const response = await this.fetchImpl(url, {
        headers: {
          'APCA-API-KEY-ID': this.credentials.keyId,
          'APCA-API-SECRET-KEY': this.credentials.secretKey,
        },
        signal: AbortSignal.timeout(20_000),
      });
      const result = await this.readResponse(response, 'Alpaca market data');
      let bars = Array.isArray(result.bars) ? result.bars : null;
      if (!bars && result.bars && typeof result.bars === 'object' && !Array.isArray(result.bars)) {
        const entries = Object.entries(result.bars);
        const symbolEntry = entries.find(([symbol]) => symbol.toUpperCase() === ticker);
        if (symbolEntry) bars = symbolEntry[1];
        else if (entries.length === 0) bars = [];
        else if (entries.length === 1 && Array.isArray(entries[0][1])) bars = entries[0][1];
      }
      if (!Array.isArray(bars)) {
        const responseKeys = Object.keys(result).filter(key => /^[a-z_]+$/i.test(key)).slice(0, 8).join(', ');
        const barsType = result.bars === null ? 'null' : Array.isArray(result.bars) ? 'array' : typeof result.bars;
        throw new Error(`Alpaca market data returned an invalid bars list for ${ticker} (bars: ${barsType}; response fields: ${responseKeys || 'none'}).`);
      }
      for (const item of bars) {
        const time = Date.parse(item.t);
        const values = [item.o, item.h, item.l, item.c, item.v].map(Number);
        if (!Number.isFinite(time) || values.some(value => !Number.isFinite(value))) continue;
        allBars.push({ time, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] });
      }
      const nextPageToken = result.next_page_token;
      if (nextPageToken !== undefined && nextPageToken !== null && typeof nextPageToken !== 'string') {
        throw new Error('Alpaca market data returned an invalid page token.');
      }
      if (nextPageToken && seenPageTokens.has(nextPageToken)) {
        throw new Error('Alpaca market data repeated a history page token.');
      }
      if (nextPageToken) seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken || undefined;
    } while (pageToken && allBars.length < sourceBarsLimit);

    const sorted = allBars.sort((left, right) => left.time - right.time);
    const aggregated = aggregateBars(sorted, frame);
    return aggregated.length > limit ? aggregated.slice(-limit) : aggregated;
  }

  async assets() {
    if (!this.credentials || !this.authenticated) {
      throw new Error('Connect Alpaca in the Alpaca Feed panel first.');
    }
    const apiHost = this.credentials.keyId.trim().toUpperCase().startsWith('PK')
      ? ALPACA_PAPER_API
      : ALPACA_LIVE_API;
    const url = new URL('/v2/assets', apiHost);
    url.search = new URLSearchParams({ status: 'active', asset_class: 'us_equity' }).toString();
    const response = await this.fetchImpl(url, {
      headers: {
        'APCA-API-KEY-ID': this.credentials.keyId,
        'APCA-API-SECRET-KEY': this.credentials.secretKey,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Alpaca asset catalogue returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : '.'}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Alpaca asset catalogue returned an invalid response.');
    return payload
      .filter(asset => asset && typeof asset === 'object'
        && typeof asset.symbol === 'string' && asset.symbol.trim()
        && typeof asset.name === 'string'
        && asset.status === 'active' && asset.asset_class === 'us_equity'
        && asset.tradable !== false && asset.exchange !== 'OTC')
      .map(asset => ({
        ticker: asset.symbol.trim().toUpperCase(),
        description: asset.name.trim(),
        exchange: typeof asset.exchange === 'string' ? asset.exchange : 'US',
      }))
      .sort((left, right) => left.ticker.localeCompare(right.ticker));
  }

  async openStream(credentials) {
    if (typeof this.WebSocketCtor !== 'function') throw new Error('WebSocket support is unavailable in this Electron runtime.');
    const socket = new this.WebSocketCtor(this.socketUrl);
    this.socket = socket;
    this.authenticated = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Timed out connecting to Alpaca market data.')), 15_000);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ action: 'auth', key: credentials.keyId, secret: credentials.secretKey }));
      });
      socket.addEventListener('message', event => {
        let messages;
        try {
          messages = JSON.parse(decodeSocketData(event.data));
        } catch (error) {
          finish(new Error(`Could not parse Alpaca stream response: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        const list = Array.isArray(messages) ? messages : [messages];
        for (const message of list) {
          if (message.T === 'success' && message.msg === 'authenticated') {
            this.authenticated = true;
            this.syncStreamSubscriptions();
            finish();
          } else if (message.T === 'error') {
            finish(new Error(`Alpaca stream error ${message.code ?? 'unknown'}: ${message.msg ?? 'request rejected'}`));
          }
        }
        for (const message of list) this.handleStreamMessage(message);
      });
      socket.addEventListener('error', () => {
        const error = new Error('Could not connect to Alpaca market data stream.');
        if (!settled) {
          finish(error);
          return;
        }
        this.authenticated = false;
        this.credentials = null;
        this.emit('status', { connected: false, configured: true, error: error.message });
      });
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        if (!this.authenticated) finish(new Error('Alpaca closed the market data stream before authentication.'));
        this.authenticated = false;
        this.credentials = null;
        this.emit('status', { connected: false, configured: true });
        this.socket = null;
      });
    });
  }

  subscribe(tickerValue, timeframeValue) {
    if (!this.authenticated || !this.socket) throw new Error('Connect Alpaca in the Alpaca Feed panel first.');
    const ticker = validateTicker(tickerValue);
    const frame = timeframe(timeframeValue);
    const id = randomUUID();
    this.subscriptions.set(id, {
      ticker,
      ...frame,
      frameKey: String(timeframeValue).toUpperCase(),
    });
    this.minuteBuckets.delete(`${id}`);
    this.syncStreamSubscriptions();
    return id;
  }

  unsubscribe(id) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return false;
    this.subscriptions.delete(id);
    this.minuteBuckets.delete(id);
    this.syncStreamSubscriptions();
    return true;
  }

  syncStreamSubscriptions() {
    if (!this.authenticated || !this.socket) return;
    const next = {
      bars: new Set([...this.subscriptions.values()].filter(item => !item.period && item.minutes < 1440).map(item => item.ticker)),
      updatedBars: new Set([...this.subscriptions.values()].filter(item => !item.period && item.minutes < 1440).map(item => item.ticker)),
      dailyBars: new Set([...this.subscriptions.values()].filter(item => item.period || item.minutes === 1440).map(item => item.ticker)),
    };
    const additions = {};
    const removals = {};
    for (const channel of Object.keys(next)) {
      additions[channel] = [...next[channel]].filter(symbol => !this.streamSubscriptions[channel].has(symbol));
      removals[channel] = [...this.streamSubscriptions[channel]].filter(symbol => !next[channel].has(symbol));
    }
    const addedChannels = Object.fromEntries(Object.entries(additions).filter(([, symbols]) => symbols.length));
    const removedChannels = Object.fromEntries(Object.entries(removals).filter(([, symbols]) => symbols.length));
    if (Object.keys(addedChannels).length) {
      this.socket.send(JSON.stringify({ action: 'subscribe', ...addedChannels }));
    }
    if (Object.keys(removedChannels).length) {
      this.socket.send(JSON.stringify({ action: 'unsubscribe', ...removedChannels }));
    }
    this.streamSubscriptions = next;
  }

  handleStreamMessage(rawMessage) {
    let messages;
    try {
      messages = rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
        ? [rawMessage]
        : JSON.parse(decodeSocketData(rawMessage));
    } catch (error) {
      this.emit('status', {
        connected: this.authenticated,
        configured: Boolean(this.credentials),
        error: `Alpaca stream message error: ${error.message}`,
      });
      return;
    }
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      if (message.T === 'error') {
        this.emit('status', {
          connected: this.authenticated,
          configured: Boolean(this.credentials),
          error: `Alpaca stream error ${message.code ?? 'unknown'}: ${message.msg ?? ''}`,
        });
        continue;
      }
      if (message.T !== 'b' && message.T !== 'u' && message.T !== 'd') continue;
      const time = Date.parse(message.t);
      const values = [message.o, message.h, message.l, message.c, message.v].map(Number);
      if (!Number.isFinite(time) || values.some(value => !Number.isFinite(value))) continue;
      const minuteBar = { time, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] };
      for (const [id, subscription] of this.subscriptions) {
        if (subscription.ticker !== message.S) continue;
        if (subscription.minutes === 1440 && !subscription.period) {
          if (message.T !== 'd') continue;
          this.emit('bar', {
            subscriptionId: id,
            ticker: subscription.ticker,
            timeframe: subscription.frameKey,
            ...minuteBar,
          });
          continue;
        }
        if (subscription.period) {
          if (message.T !== 'd') continue;
        } else if (message.T === 'd') continue;
        const bucketOffset = subscription.minutes === 60 ? 30 * 60_000 : 0;
        const bucketTime = subscription.period === 'month'
          ? Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth(), 1)
          : subscription.period === 'week'
            ? Math.floor((time + 3 * 86_400_000) / 604_800_000) * 604_800_000 - 3 * 86_400_000
            : Math.floor((time - bucketOffset) / (subscription.minutes * 60_000)) * (subscription.minutes * 60_000) + bucketOffset;
        let current = this.minuteBuckets.get(id);
        if (!current || current.time !== bucketTime) {
          if (current && bucketTime < current.time) continue;
          current = { time: bucketTime, minutes: new Map() };
          this.minuteBuckets.set(id, current);
        }
        current.minutes.set(minuteBar.time, minuteBar);
        const aggregates = aggregateBars([...current.minutes.values()], subscription);
        const aggregate = aggregates[aggregates.length - 1];
        if (!aggregate) continue;
        this.emit('bar', {
          subscriptionId: id,
          ticker: subscription.ticker,
          timeframe: subscription.frameKey,
          ...aggregate,
        });
      }
    }
  }

  async closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.streamSubscriptions = { bars: new Set(), updatedBars: new Set(), dailyBars: new Set() };
    if (!socket) return;
    try {
      socket.close();
    } catch (error) {
      console.error('Could not close Alpaca WebSocket cleanly:', error);
    }
  }

  async disconnect() {
    await this.closeSocket();
    this.credentials = null;
    this.subscriptions.clear();
    this.minuteBuckets.clear();
    this.emit('status', { connected: false, configured: (await this.status()).configured });
    return true;
  }
}

module.exports = { AlpacaMarketData, timeframe, validateTicker };