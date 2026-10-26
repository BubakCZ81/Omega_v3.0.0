const { EventEmitter } = require('node:events');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');

const PAYLOAD = {
  applicationAuthRequest: 2100,
  applicationAuthResponse: 2101,
  accountAuthRequest: 2102,
  accountAuthResponse: 2103,
  assetListRequest: 2112,
  assetListResponse: 2113,
  symbolsListRequest: 2114,
  symbolsListResponse: 2115,
  amendPositionSltpRequest: 2110,
  closePositionRequest: 2111,
  newOrderRequest: 2106,
  cancelOrderRequest: 2108,
  reconcileRequest: 2124,
  reconcileResponse: 2125,
  executionEvent: 2126,
  traderRequest: 2121,
  traderResponse: 2122,
  subscribeSpotsRequest: 2127,
  subscribeSpotsResponse: 2128,
  spotEvent: 2131,
  accountsByTokenRequest: 2149,
  accountsByTokenResponse: 2150,
  errorResponse: 50,
};

const REDIRECT_URI = 'http://127.0.0.1:17863/ctrader/callback';
const LIVE_URL = 'wss://live.ctraderapi.com:5036';
const DEMO_URL = 'wss://demo.ctraderapi.com:5036';
const REQUEST_TIMEOUT_MS = 15_000;

function requiredString(value, label, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return value.trim();
}

function stringifyPayload(value) {
  return value === undefined || value === null ? '' : String(value);
}

function decodeMessageData(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  throw new Error('Received an unsupported cTrader WebSocket message.');
}

function toQuote(payload, symbolName) {
  const quote = {
    symbolId: stringifyPayload(payload.symbolId),
    symbol: symbolName,
    timestamp: payload.timestamp === undefined ? new Date().toISOString() : new Date(Number(payload.timestamp)).toISOString(),
  };
  if (payload.bid !== undefined) quote.bid = Number(payload.bid) / 100_000;
  if (payload.ask !== undefined) quote.ask = Number(payload.ask) / 100_000;
  return quote;
}

function buildAuthorizationUrl(clientId, allowTrading, state) {
  const authorizationUrl = new URL('https://id.ctrader.com/my/settings/openapi/grantingaccess/');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: allowTrading ? 'trading' : 'accounts',
    product: 'web',
    state,
  }).toString();
  return authorizationUrl;
}

function assertSuccessfulExecution(execution, operation) {
  const successfulTypes = new Set(['ORDER_ACCEPTED', 'ORDER_REPLACED', 'ORDER_FILLED', 2, 3, 4]);
  if (execution.errorCode || !successfulTypes.has(execution.executionType)) {
    throw new Error(`cTrader did not confirm ${operation}${execution.errorCode ? `: ${execution.errorCode}` : ` (${execution.executionType || 'unknown status'})`}.`);
  }
}

class CTraderConnection extends EventEmitter {
  constructor(url, WebSocketCtor = globalThis.WebSocket) {
    super();
    if (typeof WebSocketCtor !== 'function') throw new Error('This Electron runtime does not provide WebSocket support.');
    this.socket = new WebSocketCtor(url);
    this.pending = new Map();
    this.opened = false;
    this.closed = false;
    this.openPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to cTrader Open API.')), REQUEST_TIMEOUT_MS);
      this.rejectOpen = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        this.opened = true;
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to cTrader Open API.'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => this.handleClose());
    this.socket.addEventListener('error', () => this.handleClose(new Error('The cTrader Open API connection failed.')));
  }

  async connect() {
    await this.openPromise;
  }

  async request(payloadType, payload, expectedType) {
    await this.connect();
    if (this.closed) throw new Error('The cTrader Open API connection is closed.');
    const clientMsgId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`cTrader did not respond to request ${payloadType} in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(clientMsgId, { expectedType, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ clientMsgId, payloadType, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(clientMsgId);
        reject(error);
      }
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(decodeMessageData(data));
    } catch (error) {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!message || typeof message !== 'object' || !Number.isInteger(Number(message.payloadType))) return;

    const payloadType = Number(message.payloadType);
    const payload = message.payload ?? {};
    if (payloadType === PAYLOAD.spotEvent) {
      this.emit('spot', payload);
      return;
    }

    const pending = this.pending.get(message.clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.clientMsgId);

    if (payloadType === PAYLOAD.errorResponse) {
      const description = typeof payload.description === 'string' ? `: ${payload.description}` : '';
      pending.reject(new Error(`cTrader error ${payload.errorCode || 'UNKNOWN'}${description}`));
    } else if (payloadType !== pending.expectedType) {
      pending.reject(new Error(`Unexpected cTrader response ${payloadType}; expected ${pending.expectedType}.`));
    } else {
      pending.resolve(payload);
    }
  }

  handleClose(error = new Error('The cTrader Open API connection was closed.')) {
    if (this.closed) return;
    this.closed = true;
    if (!this.opened) this.rejectOpen(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The cTrader Open API connection was disconnected.'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

class CTraderIntegration extends EventEmitter {
  constructor({ openExternal, fetchImpl = globalThis.fetch, WebSocketCtor = globalThis.WebSocket } = {}) {
    super();
    this.openExternal = openExternal;
    this.fetchImpl = fetchImpl;
    this.WebSocketCtor = WebSocketCtor;
    this.sessions = new Map();
    this.accounts = new Map();
    this.activeAccount = null;
    this.credentials = null;
    this.token = null;
    this.cancelAuthorization = null;
    this.tradingPermissionRequested = false;
    this.lastQuotes = new Map();
    this.authorizationRevision = 0;
    this.demoOrderInProgress = false;
  }

  async authorize({ clientId, clientSecret, allowTrading = false }) {
    const normalizedClientId = requiredString(clientId, 'cTrader Client ID');
    const normalizedClientSecret = requiredString(clientSecret, 'cTrader Client Secret');
    if (typeof allowTrading !== 'boolean') throw new Error('Invalid cTrader permission choice.');
    if (typeof this.openExternal !== 'function') throw new Error('Opening the system browser is unavailable.');
    if (typeof this.fetchImpl !== 'function') throw new Error('HTTP requests are unavailable in this Electron runtime.');

    const revision = ++this.authorizationRevision;
    await this.disconnectInternal();
    if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
    this.credentials = { clientId: normalizedClientId, clientSecret: normalizedClientSecret };
    this.tradingPermissionRequested = allowTrading;
    try {
      const code = await this.receiveAuthorizationCode(normalizedClientId, allowTrading);
      if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
      this.token = await this.exchangeToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      });
      if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
      return await this.loadAccounts(revision);
    } catch (error) {
      if (revision === this.authorizationRevision) await this.disconnectInternal();
      throw error;
    }
  }

  async receiveAuthorizationCode(clientId, allowTrading = false) {
    const state = randomBytes(32).toString('hex');
    const redirectUrl = new URL(REDIRECT_URI);
    const authorizationUrl = buildAuthorizationUrl(clientId, allowTrading, state);

    let settleCallback;
    const callback = new Promise((resolve, reject) => {
      settleCallback = { resolve, reject };
    });
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', REDIRECT_URI);
      if (requestUrl.pathname !== redirectUrl.pathname) {
        response.writeHead(404).end('Not found.');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      // cTrader's documented redirect guarantees a code, but does not require a returned state parameter.
      if (requestUrl.searchParams.has('state') && returnedState !== state) {
        response.writeHead(400).end('Invalid OAuth state.');
        return;
      }
      const oauthError = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      if (oauthError || !code) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          .end(oauthError ? 'cTrader authorization was denied. You can close this page.' : 'cTrader did not return an authorization code.');
        settleCallback.reject(new Error(oauthError ? `cTrader authorization failed: ${oauthError}` : 'cTrader did not return an authorization code.'));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><title>cTrader connected</title><p>Authorization received. You can return to Pine Editor.</p>');
      settleCallback.resolve(code);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(redirectUrl.port), '127.0.0.1', resolve);
    });
    const timeout = setTimeout(() => settleCallback.reject(new Error('cTrader authorization timed out after five minutes.')), 5 * 60_000);
    const cancel = () => {
      settleCallback.reject(new Error('cTrader authorization was cancelled.'));
      if (server.listening) server.close();
    };
    this.cancelAuthorization = cancel;
    try {
      await this.openExternal(authorizationUrl.toString());
      return await callback;
    } finally {
      clearTimeout(timeout);
      if (this.cancelAuthorization === cancel) this.cancelAuthorization = null;
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }

  async exchangeToken(parameters) {
    const query = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      ...parameters,
    });
    const response = await this.fetchImpl(`https://openapi.ctrader.com/apps/token?${query}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const body = await response.text();
    let result = {};
    try {
      result = JSON.parse(body);
    } catch {
      result = {};
    }
    if (!response.ok || !result.accessToken) {
      const description = result.description || result.errorCode
        || (body && !body.trimStart().startsWith('<') ? body.trim().slice(0, 200) : '')
        || `HTTP ${response.status}`;
      throw new Error(`cTrader token exchange failed: ${description}`);
    }
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || parameters.refresh_token,
      expiresAt: Date.now() + Number(result.expiresIn || 0) * 1000,
    };
  }

  async ensureAccessToken() {
    if (!this.token) throw new Error('Authorize with cTrader first.');
    if (this.token.expiresAt - Date.now() > 60_000) return this.token.accessToken;
    if (!this.token.refreshToken) throw new Error('The cTrader access token expired. Disconnect and authorize again.');
    this.token = await this.exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: this.token.refreshToken,
    });
    return this.token.accessToken;
  }

  async loadAccounts(revision = this.authorizationRevision) {
    const accessToken = await this.ensureAccessToken();
    const results = await Promise.allSettled([
      this.loadAccountsFromEnvironment('live', LIVE_URL, accessToken, revision),
      this.loadAccountsFromEnvironment('demo', DEMO_URL, accessToken, revision),
    ]);
    if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
    const warnings = [];
    const collected = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const environment = index === 0 ? 'live' : 'demo';
      if (result.status === 'fulfilled') {
        collected.push(...result.value);
      } else {
        warnings.push(`${environment}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    if (!collected.length) {
      await this.disconnectSessions();
      throw new Error(warnings.length
        ? `Could not retrieve cTrader accounts. ${warnings.join(' ')}`
        : 'No cTrader accounts are linked to this Open API application. Grant the requested account access and try again.');
    }

    const uniqueAccounts = new Map();
    for (const account of collected) uniqueAccounts.set(account.id, account);
    this.accounts = uniqueAccounts;
    return {
      accounts: [...uniqueAccounts.values()].map(({ id, environment, login, broker }) => ({ id, environment, login, broker })),
      warnings,
      tradingPermissionRequested: this.tradingPermissionRequested,
    };
  }

  async loadAccountsFromEnvironment(environment, url, accessToken, revision = this.authorizationRevision) {
    const connection = new CTraderConnection(url, this.WebSocketCtor);
    try {
      await connection.request(PAYLOAD.applicationAuthRequest, {
        clientId: this.credentials.clientId,
        clientSecret: this.credentials.clientSecret,
      }, PAYLOAD.applicationAuthResponse);
      if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
      const result = await connection.request(PAYLOAD.accountsByTokenRequest, { accessToken }, PAYLOAD.accountsByTokenResponse);
      if (revision !== this.authorizationRevision) throw new Error('cTrader authorization was superseded by a newer request.');
      this.sessions.set(environment, connection);
      connection.on('spot', (payload) => this.handleSpot(environment, payload));
      return (result.ctidTraderAccount || []).map((account) => {
        const accountEnvironment = typeof account.isLive === 'boolean'
          ? (account.isLive ? 'live' : 'demo')
          : environment;
        return {
          id: stringifyPayload(account.ctidTraderAccountId),
          environment: accountEnvironment,
          login: stringifyPayload(account.traderLogin),
          broker: account.brokerTitleShort || 'cTrader',
          session: accountEnvironment === environment ? connection : null,
        };
      }).filter((account) => account.id);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async selectAccount(accountId) {
    const revision = this.authorizationRevision;
    const account = this.accounts.get(String(accountId));
    if (!account) throw new Error('Select a cTrader account returned by authorization.');
    const session = account.session || this.sessions.get(account.environment);
    if (!session || session.closed) throw new Error(`The ${account.environment} cTrader connection is unavailable. Reauthorize and try again.`);
    const accessToken = await this.ensureAccessToken();
    if (revision !== this.authorizationRevision) throw new Error('cTrader account selection was cancelled by a provider change.');
    await session.request(PAYLOAD.accountAuthRequest, {
      ctidTraderAccountId: account.id,
      accessToken,
    }, PAYLOAD.accountAuthResponse);
    if (revision !== this.authorizationRevision) throw new Error('cTrader account selection was cancelled by a provider change.');

    const [traderResponse, symbolsResponse, assetsResponse] = await Promise.all([
      session.request(PAYLOAD.traderRequest, { ctidTraderAccountId: account.id }, PAYLOAD.traderResponse),
      session.request(PAYLOAD.symbolsListRequest, { ctidTraderAccountId: account.id }, PAYLOAD.symbolsListResponse),
      session.request(PAYLOAD.assetListRequest, { ctidTraderAccountId: account.id }, PAYLOAD.assetListResponse),
    ]);
    if (revision !== this.authorizationRevision) throw new Error('cTrader account selection was cancelled by a provider change.');
    const assets = (assetsResponse.asset || []).map((asset) => ({
      id: stringifyPayload(asset.assetId),
      name: asset.displayName || asset.name || stringifyPayload(asset.assetId),
      digits: Number(asset.digits || 0),
    }));
    const currencyAsset = (assetsResponse.asset || []).find((asset) => stringifyPayload(asset.assetId) === stringifyPayload(traderResponse.trader?.depositAssetId));
    const currency = currencyAsset?.name || 'USD';
    const moneyDigits = Number(traderResponse.trader?.moneyDigits ?? 2);
    const symbols = (symbolsResponse.symbol || [])
      .filter((symbol) => symbol.enabled !== false && symbol.symbolId !== undefined)
      .map((symbol) => ({
        id: stringifyPayload(symbol.symbolId),
        name: symbol.symbolName || stringifyPayload(symbol.symbolId),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const symbolNames = new Map(symbols.map((symbol) => [symbol.id, symbol.name]));
    const accessRights = traderResponse.trader?.accessRights;
    const fullTradingAccess = accessRights === 0 || accessRights === 'FULL_ACCESS';
    const tradingEnabled = this.tradingPermissionRequested && fullTradingAccess;
    this.activeAccount = { ...account, session, symbols: symbolNames, tradingEnabled };
    return {
      account: {
        id: account.id,
        environment: account.environment,
        login: account.login,
        broker: account.broker,
        balance: Number(traderResponse.trader?.balance || 0) / (10 ** moneyDigits),
        currency,
        tradingEnabled,
      },
      assets,
      symbols,
    };
  }

  async subscribeSymbol(symbolId) {
    const account = this.activeAccount;
    if (!account) throw new Error('Select a cTrader account first.');
    const id = String(symbolId);
    const symbolName = account.symbols.get(id);
    if (!symbolName) throw new Error('Choose an available cTrader symbol.');
    await account.session.request(PAYLOAD.subscribeSpotsRequest, {
      ctidTraderAccountId: account.id,
      symbolId: [id],
      subscribeToSpotTimestamp: true,
    }, PAYLOAD.subscribeSpotsResponse);
    return { symbolId: id, symbol: symbolName };
  }

  async placeDemoMarketOrder(order) {
    if (this.demoOrderInProgress) {
      throw new Error('A cTrader demo order is already being processed. Check the account before retrying.');
    }
    this.demoOrderInProgress = true;
    try {
      return await this.executeDemoMarketOrder(order);
    } finally {
      this.demoOrderInProgress = false;
    }
  }

  async executeDemoMarketOrder({ symbolId, side, volume, stopLoss, takeProfit, confirmed }) {
    const account = this.requireTradingAccount();
    if (account.environment !== 'demo') {
      throw new Error('Live order placement is locked until demo order protection is validated.');
    }
    if (confirmed !== true) throw new Error('Confirm the demo order before sending it.');
    const id = String(symbolId);
    if (!account.symbols.has(id)) throw new Error('Choose an available cTrader symbol.');
    if (side !== 'BUY' && side !== 'SELL') throw new Error('Choose BUY or SELL.');
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0 || volume > 1_000_000) {
      throw new Error('Order volume must be a positive number within the supported range.');
    }
    const scaledVolume = Math.round(volume * 100);
    if (scaledVolume <= 0 || Math.abs(scaledVolume / 100 - volume) > 1e-8) {
      throw new Error('Order volume can have at most two decimal places.');
    }
    if (typeof stopLoss !== 'number' || !Number.isFinite(stopLoss) || stopLoss <= 0) {
      throw new Error('A valid stop-loss price is required for every order.');
    }
    if (takeProfit !== undefined && takeProfit !== null
      && (typeof takeProfit !== 'number' || !Number.isFinite(takeProfit) || takeProfit <= 0)) {
      throw new Error('Take-profit price must be a positive number.');
    }
    const quote = this.lastQuotes.get(`${account.id}:${id}`);
    if (!quote || Date.now() - quote.receivedAt > 30_000) {
      throw new Error('A fresh quote is required before an order. Subscribe to this symbol and wait for an update.');
    }
    if (side === 'BUY' && (stopLoss >= quote.bid || (takeProfit !== undefined && takeProfit !== null && takeProfit <= quote.ask))) {
      throw new Error('For a BUY order, stop loss must be below bid and take profit must be above ask.');
    }
    if (side === 'SELL' && (stopLoss <= quote.ask || (takeProfit !== undefined && takeProfit !== null && takeProfit >= quote.bid))) {
      throw new Error('For a SELL order, stop loss must be above ask and take profit must be below bid.');
    }

    const execution = await account.session.request(PAYLOAD.newOrderRequest, {
      ctidTraderAccountId: account.id,
      symbolId: id,
      orderType: 'MARKET',
      tradeSide: side,
      volume: String(scaledVolume),
    }, PAYLOAD.executionEvent);
    if (execution.executionType === 'ORDER_REJECTED' || execution.executionType === 7) {
      throw new Error(`cTrader rejected the order${execution.errorCode ? `: ${execution.errorCode}` : '.'}`);
    }
    const partialFill = execution.executionType === 'ORDER_PARTIAL_FILL' || execution.executionType === 3;
    if (execution.executionType !== 'ORDER_FILLED' && execution.executionType !== 2 && !partialFill) {
      throw new Error(`cTrader has not confirmed a market fill (${execution.executionType || 'unknown status'}). Check the demo account before retrying.`);
    }
    const positionId = stringifyPayload(execution.position?.positionId);
    if (!positionId) {
      throw new Error('cTrader accepted the order but returned no position ID. Check the demo account in cTrader before retrying.');
    }

    let remainderStatus = 'not-applicable';
    let remainderCancellationError = '';
    if (partialFill) {
      remainderStatus = 'unknown';
      const orderId = stringifyPayload(execution.order?.orderId);
      if (!orderId) {
        remainderCancellationError = 'cTrader did not return an order ID for the unfilled remainder.';
      } else {
        try {
          const cancellation = await account.session.request(PAYLOAD.cancelOrderRequest, {
            ctidTraderAccountId: account.id,
            orderId,
          }, PAYLOAD.executionEvent);
          if (cancellation.executionType === 'ORDER_CANCELLED' || cancellation.executionType === 5) {
            remainderStatus = 'cancelled';
          } else if (cancellation.executionType === 'ORDER_FILLED' || cancellation.executionType === 2) {
            remainderStatus = 'filled';
          } else {
            remainderCancellationError = `cTrader did not confirm cancellation of the unfilled remainder (${cancellation.executionType || 'unknown status'}).`;
          }
        } catch (error) {
          remainderCancellationError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    let reconciledPosition;
    try {
      const protection = { ctidTraderAccountId: account.id, positionId, stopLoss };
      if (takeProfit !== undefined && takeProfit !== null) protection.takeProfit = takeProfit;
      const protectionResult = await account.session.request(PAYLOAD.amendPositionSltpRequest, protection, PAYLOAD.executionEvent);
      assertSuccessfulExecution(protectionResult, 'stop-loss protection');
      const reconciliation = await this.reconcileActiveAccount();
      const protectedPosition = reconciliation.positions.find(position => stringifyPayload(position.positionId) === positionId);
      if (!protectedPosition) {
        throw new Error('cTrader did not return the filled position during reconciliation.');
      }
      reconciledPosition = protectedPosition;
      const confirmedStopLoss = Number(protectedPosition?.stopLoss);
      const confirmedTakeProfit = Number(protectedPosition?.takeProfit);
      if (!Number.isFinite(confirmedStopLoss) || Math.abs(confirmedStopLoss - stopLoss) > 1e-8
        || (takeProfit !== undefined && takeProfit !== null
          && (!Number.isFinite(confirmedTakeProfit) || Math.abs(confirmedTakeProfit - takeProfit) > 1e-8))) {
        throw new Error('cTrader did not confirm the requested protective prices during reconciliation.');
      }
      if (partialFill) {
        const orderId = stringifyPayload(execution.order?.orderId);
        if (orderId && reconciliation.orders.some(order => stringifyPayload(order.orderId) === orderId)) {
          remainderStatus = 'open';
          remainderCancellationError = [
            remainderCancellationError,
            'The unfilled remainder is still listed as an open order.',
          ].filter(Boolean).join(' ');
        }
      }
    } catch (protectionError) {
      const protectionMessage = protectionError instanceof Error ? protectionError.message : String(protectionError);
      if (partialFill && remainderStatus !== 'cancelled' && remainderStatus !== 'filled') {
        throw new Error(`A partial order fill was detected, but stop-loss protection failed (${protectionMessage}) and cancellation of the unfilled remainder was not confirmed (${remainderCancellationError || remainderStatus}). Omega did not close the partial position because the remainder may still fill. Check the position and pending orders in cTrader immediately; do not retry the order.`);
      }
      try {
        const currentState = await account.session.request(PAYLOAD.reconcileRequest, {
          ctidTraderAccountId: account.id,
        }, PAYLOAD.reconcileResponse);
        const currentPosition = (currentState.position || []).find(position => stringifyPayload(position.positionId) === positionId);
        const positionVolume = Number(currentPosition?.tradeData?.volume ?? execution.position?.tradeData?.volume);
        if (!Number.isSafeInteger(positionVolume) || positionVolume <= 0) throw new Error('The filled position volume was unavailable.');
        const closeResult = await account.session.request(PAYLOAD.closePositionRequest, {
          ctidTraderAccountId: account.id,
          positionId,
          volume: String(positionVolume),
        }, PAYLOAD.executionEvent);
        if (closeResult.executionType !== 'ORDER_FILLED' && closeResult.executionType !== 2 && closeResult.executionType !== 3) {
          throw new Error(`The close request was not confirmed as filled (${closeResult.executionType || 'unknown status'}).`);
        }
        const reconciliation = await account.session.request(PAYLOAD.reconcileRequest, {
          ctidTraderAccountId: account.id,
        }, PAYLOAD.reconcileResponse);
        if ((reconciliation.position || []).some(position => stringifyPayload(position.positionId) === positionId)) {
          throw new Error('The position is still present after the close request.');
        }
      } catch (closeError) {
        throw new Error(`Order filled, but stop-loss protection failed (${protectionMessage}) and automatic close failed (${closeError instanceof Error ? closeError.message : String(closeError)}). Check the position and pending orders in cTrader immediately; do not retry the order.`);
      }
      throw new Error(`Order filled, but stop-loss protection failed. Omega closed the demo position. Protection error: ${protectionMessage}`);
    }

    return {
      positionId,
      executionType: execution.executionType,
      protected: true,
      partialFill,
      filledVolume: stringifyPayload(reconciledPosition?.tradeData?.volume ?? execution.position?.tradeData?.volume) || undefined,
      remainderStatus,
      remainderCancellationError: remainderCancellationError || undefined,
    };
  }

  async reconcileActiveAccount() {
    const account = this.requireTradingAccount();
    const result = await account.session.request(PAYLOAD.reconcileRequest, {
      ctidTraderAccountId: account.id,
    }, PAYLOAD.reconcileResponse);
    return {
      positions: Array.isArray(result.position) ? result.position : [],
      orders: Array.isArray(result.order) ? result.order : [],
    };
  }

  requireTradingAccount() {
    const account = this.activeAccount;
    if (!account) throw new Error('Select a cTrader account first.');
    if (!this.tradingPermissionRequested) throw new Error('Reconnect and explicitly grant cTrader trading permission before placing orders.');
    if (!account.tradingEnabled) throw new Error('This cTrader account does not grant full trading access.');
    if (!account.session || account.session.closed) throw new Error(`The ${account.environment} cTrader connection is unavailable. Reauthorize and try again.`);
    return account;
  }

  handleSpot(environment, payload) {
    if (!this.activeAccount || this.activeAccount.environment !== environment
      || stringifyPayload(payload.ctidTraderAccountId) !== this.activeAccount.id) return;
    const symbolId = stringifyPayload(payload.symbolId);
    const symbol = this.activeAccount.symbols.get(symbolId);
    if (symbol) {
      const quote = toQuote(payload, symbol);
      if (Number.isFinite(quote.bid) && Number.isFinite(quote.ask)) {
        this.lastQuotes.set(`${this.activeAccount.id}:${symbolId}`, {
          bid: quote.bid,
          ask: quote.ask,
          receivedAt: Date.now(),
        });
      }
      this.emit('quote', { ...quote, accountId: this.activeAccount.id });
    }
  }

  async disconnectSessions() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.accounts.clear();
    this.activeAccount = null;
    this.lastQuotes.clear();
  }

  async disconnect() {
    this.authorizationRevision += 1;
    await this.disconnectInternal();
  }

  async disconnectInternal() {
    this.cancelAuthorization?.();
    this.cancelAuthorization = null;
    await this.disconnectSessions();
    this.credentials = null;
    this.token = null;
    this.tradingPermissionRequested = false;
  }
}

module.exports = { CTraderConnection, CTraderIntegration, PAYLOAD, REDIRECT_URI, buildAuthorizationUrl, toQuote };
