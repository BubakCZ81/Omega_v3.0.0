import type { OHLCV } from '@luxalgo/vela';

export {};

interface BrokerCredentialField {
  key: string;
  label: string;
  secret: boolean;
}

interface BrokerInfo {
  id: string;
  displayName: string;
  credentials: BrokerCredentialField[];
  readOnlySetup: string;
}

interface CTraderAccountOption {
  id: string;
  environment: 'live' | 'demo';
  login: string;
  broker: string;
}

interface CTraderAuthorization {
  accounts: CTraderAccountOption[];
  warnings: string[];
}

interface CTraderSymbol {
  id: string;
  name: string;
  digits?: number;
}

interface CTraderSubscription {
  symbolId: string;
  symbol: string;
}

interface CTraderAccountDetails {
  account: CTraderAccountOption & { balance: number; currency: string; tradingEnabled: boolean };
  assets: Array<{ id: string; name: string; digits: number }>;
  symbols: CTraderSymbol[];
}

interface CTraderPosition {
  positionId?: string | number;
  symbolId?: string | number;
  tradeData?: { volume?: string | number; tradeSide?: string };
  stopLoss?: number;
  takeProfit?: number;
  price?: number;
}

interface CTraderOrder {
  orderId?: string | number;
  symbolId?: string | number;
  orderType?: string;
  tradeData?: { volume?: string | number; tradeSide?: string };
  limitPrice?: number;
  stopPrice?: number;
}

interface CTraderReconciliation {
  positions: CTraderPosition[];
  orders: CTraderOrder[];
}

interface CTraderQuote {
  subscriptionId?: string;
  accountId: string;
  symbolId: string;
  symbol: string;
  bid?: number;
  ask?: number;
  timestamp: string | number;
}

interface BrokerPosition {
  symbol: string;
  quantity: number;
  marketValue?: number;
  assetClass?: string;
}

interface BrokerAccount {
  name: string;
  currency: string;
  equity: number;
  cash?: number;
  environment?: 'live' | 'paper';
  positions: BrokerPosition[];
}

interface BrokerSnapshot {
  broker: string;
  fetchedAt: string;
  accounts: BrokerAccount[];
}

interface BrokerBridge {
  listBrokers(): Promise<BrokerInfo[]>;
  connectReadOnly(brokerId: string, credentials: Record<string, string>): Promise<BrokerSnapshot>;
  saveAlpacaCredentials?(credentials: { apiKey: string; apiSecret: string }): Promise<{ configured: boolean }>;
  hasSavedAlpacaCredentials?(): Promise<boolean>;
  fetchSnapshot(): Promise<BrokerSnapshot>;
  fetchHistoricalBars(request: {
    symbol: string;
    timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
    from: number;
    to: number;
    limit: number;
  }): Promise<OHLCV[] | null>;
  authorizeCTrader(credentials: { clientId: string; clientSecret: string; allowTrading: boolean }): Promise<CTraderAuthorization>;
  selectCTraderAccount(accountId: string): Promise<CTraderAccountDetails>;
  subscribeCTraderSymbol(symbolId: string): Promise<CTraderSubscription>;
  placeDemoCTraderMarketOrder(order: {
    symbolId: string;
    side: 'BUY' | 'SELL';
    volume: number;
    stopLoss: number;
    takeProfit?: number;
    confirmed: boolean;
  }): Promise<{
    positionId: string;
    executionType?: string | number;
    protected: true;
    partialFill: boolean;
    filledVolume?: string;
    remainderStatus: 'not-applicable' | 'cancelled' | 'filled' | 'open' | 'unknown';
    remainderCancellationError?: string;
  }>;
  reconcileCTraderAccount(): Promise<CTraderReconciliation>;
  onCTraderQuote(callback: (quote: CTraderQuote) => void): () => void;
  disconnect(): Promise<boolean>;
}

declare global {
  interface Window {
	velaBroker?: BrokerBridge;
  }
}

const modal = document.getElementById('broker-modal');
const openButton = document.getElementById('broker-toggle');
const closeButton = document.getElementById('broker-close');
const brokerSelect = document.getElementById('broker-select') as HTMLSelectElement | null;
const fieldsHost = document.getElementById('broker-fields');
const setupNote = document.getElementById('broker-setup-note');
const connectButton = document.getElementById('broker-connect') as HTMLButtonElement | null;
const saveCredentialsButton = document.getElementById('broker-save-credentials') as HTMLButtonElement | null;
const refreshButton = document.getElementById('broker-refresh') as HTMLButtonElement | null;
const disconnectButton = document.getElementById('broker-disconnect') as HTMLButtonElement | null;
const status = document.getElementById('broker-status');
const accountsHost = document.getElementById('broker-accounts');
const ctraderAccountControls = document.getElementById('ctrader-account-controls');
const ctraderAccountSelect = document.getElementById('ctrader-account-select') as HTMLSelectElement | null;
const ctraderSelectAccountButton = document.getElementById('ctrader-select-account') as HTMLButtonElement | null;
const ctraderMarketControls = document.getElementById('ctrader-market-controls');
const ctraderSymbolSelect = document.getElementById('ctrader-symbol-select') as HTMLSelectElement | null;
const ctraderSubscribeButton = document.getElementById('ctrader-subscribe') as HTMLButtonElement | null;
const ctraderChartButton = document.getElementById('ctrader-use-chart') as HTMLButtonElement | null;
const ctraderQuotesHost = document.getElementById('ctrader-quotes');
const ctraderPermissions = document.getElementById('ctrader-permissions');
const ctraderTradingPermission = document.getElementById('ctrader-trading-permission') as HTMLInputElement | null;
const ctraderTradeControls = document.getElementById('ctrader-trade-controls');
const ctraderOrderSide = document.getElementById('ctrader-order-side') as HTMLSelectElement | null;
const ctraderOrderVolume = document.getElementById('ctrader-order-volume') as HTMLInputElement | null;
const ctraderOrderStop = document.getElementById('ctrader-order-stop') as HTMLInputElement | null;
const ctraderOrderTake = document.getElementById('ctrader-order-take') as HTMLInputElement | null;
const ctraderPlaceDemoOrder = document.getElementById('ctrader-place-demo-order') as HTMLButtonElement | null;
const ctraderTradeStatus = document.getElementById('ctrader-trade-status');
const ctraderRefreshPositions = document.getElementById('ctrader-refresh-positions') as HTMLButtonElement | null;
const ctraderPositionsList = document.getElementById('ctrader-positions-list');

let brokers: BrokerInfo[] = [];
let activeBrokerId: string | null = null;
let providerTransitionRevision = 0;
let cTraderAccountId: string | null = null;
let cTraderAccountEnvironment: 'live' | 'demo' | null = null;
const cTraderQuotes = new Map<string, CTraderQuote>();
const cTraderSymbols = new Map<string, string>();

function setStatus(message: string, isError = false) {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? 'error' : 'info';
}

function selectedBroker(): BrokerInfo | null {
  return brokers.find((broker) => broker.id === brokerSelect?.value) ?? null;
}

function renderCredentialFields() {
  if (!fieldsHost || !setupNote) return;
  fieldsHost.replaceChildren();
  const broker = selectedBroker();
  const isCTrader = broker?.id === 'ctrader';
  const isAlpaca = broker?.id === 'alpaca';
  setupNote.textContent = broker?.readOnlySetup ?? '';
  if (connectButton) connectButton.textContent = isCTrader ? 'Authorize with cTrader' : 'Connect Read Only';
  if (saveCredentialsButton) saveCredentialsButton.hidden = !isAlpaca;
  if (ctraderAccountControls) ctraderAccountControls.hidden = !isCTrader;
  if (ctraderPermissions) ctraderPermissions.hidden = !isCTrader;
  if (ctraderMarketControls) ctraderMarketControls.hidden = true;
  if (ctraderTradeControls) ctraderTradeControls.hidden = true;
  if (ctraderTradingPermission) ctraderTradingPermission.checked = false;
  if (!isCTrader) {
	ctraderAccountSelect?.replaceChildren();
	ctraderQuotesHost?.replaceChildren();
  }

  for (const field of broker?.credentials ?? []) {
	const label = document.createElement('label');
	label.className = 'broker-field';
	label.textContent = field.label;
	const input = document.createElement('input');
	input.type = field.secret ? 'password' : 'text';
	input.autocomplete = field.secret ? 'new-password' : 'off';
	input.spellcheck = false;
	input.dataset.credentialKey = field.key;
	input.required = true;
	label.append(input);
	fieldsHost.append(label);
  }
}

async function loadBrokers() {
  const bridge = window.velaBroker;
  if (!bridge) {
	setStatus('Broker access is available in the Electron desktop app, not a standalone browser tab.', true);
	return;
  }
  try {
	brokers = await bridge.listBrokers();
	if (!brokerSelect) return;
	brokerSelect.replaceChildren();
	for (const broker of brokers) {
	  const option = document.createElement('option');
	  option.value = broker.id;
	  option.textContent = broker.displayName;
	  brokerSelect.append(option);
	}
	renderCredentialFields();
	setStatus('cTrader credentials are held in memory for this session only. Read-only chart data is requested; enter the Open API app credentials, then sign in on cTrader’s page (Google sign-in is available there).');
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function renderSnapshot(snapshot: BrokerSnapshot) {
  if (!accountsHost) return;
  accountsHost.replaceChildren();
  if (!snapshot.accounts.length) {
	const empty = document.createElement('p');
	empty.textContent = 'The broker returned no accounts.';
	accountsHost.append(empty);
	return;
  }

	for (const account of snapshot.accounts) {
		document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
		  detail: {
			id: `${snapshot.broker}:${account.name}`,
			label: `${snapshot.broker} · ${account.name}`,
			mode: (account.environment ?? 'connected').toUpperCase(),
			detail: `${snapshot.broker} data · read-only`,
		  },
		}));
		const card = document.createElement('section');
	card.className = 'broker-account';
	const heading = document.createElement('div');
	heading.className = 'broker-account-heading';
	const name = document.createElement('strong');
	name.textContent = account.name || 'Broker account';
	const environment = document.createElement('span');
	environment.textContent = account.environment ?? 'account';
	heading.append(name, environment);

	const equity = document.createElement('p');
	equity.className = 'broker-equity';
	equity.textContent = `Equity: ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(account.equity)}`;
	card.append(heading, equity);

	if (account.cash !== undefined) {
	  const cash = document.createElement('p');
	  cash.className = 'broker-account-detail';
	  cash.textContent = `Cash: ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(account.cash)}`;
	  card.append(cash);
	}

	const positionsTitle = document.createElement('strong');
	positionsTitle.className = 'broker-positions-title';
	positionsTitle.textContent = `Open positions (${account.positions.length})`;
	card.append(positionsTitle);
	if (!account.positions.length) {
	  const noPositions = document.createElement('p');
	  noPositions.className = 'broker-account-detail';
	  noPositions.textContent = 'No open positions reported.';
	  card.append(noPositions);
	} else {
	  const positions = document.createElement('ul');
	  positions.className = 'broker-position-list';
	  for (const position of account.positions.slice(0, 50)) {
		const item = document.createElement('li');
		const marketValue = position.marketValue === undefined
		  ? ''
		  : ` · ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(position.marketValue)}`;
		item.textContent = `${position.symbol}: ${position.quantity}${marketValue}`;
		positions.append(item);
	  }
	  card.append(positions);
	}
	accountsHost.append(card);
  }

  const fetched = document.createElement('p');
  fetched.className = 'broker-account-detail';
  fetched.textContent = `Updated ${new Date(snapshot.fetchedAt).toLocaleString()}. Trade placement is not available from this panel.`;
  accountsHost.append(fetched);
}

function renderCTraderQuotes() {
  if (!ctraderQuotesHost || selectedBroker()?.id !== 'ctrader') return;
  ctraderQuotesHost.replaceChildren();
  for (const quote of cTraderQuotes.values()) {
	const item = document.createElement('p');
	item.className = 'broker-account-detail';
	const bid = quote.bid === undefined ? '—' : quote.bid.toFixed(5);
	const ask = quote.ask === undefined ? '—' : quote.ask.toFixed(5);
	item.textContent = `${quote.symbol}  Bid ${bid}  ·  Ask ${ask}`;
	ctraderQuotesHost.append(item);
  }
}

async function authorizeCTrader(credentials: Record<string, string>, expectedRevision: number) {
  if (!window.velaBroker || !connectButton) return;
  accountsHost?.replaceChildren();
  ctraderAccountSelect?.replaceChildren();
  if (ctraderMarketControls) ctraderMarketControls.hidden = true;
  cTraderAccountId = null;
  cTraderQuotes.clear();
  const allowTrading = ctraderTradingPermission?.checked === true;
  setStatus(allowTrading
	? 'Opening cTrader authorization. Trading permission is being requested; live order placement remains locked.'
	: 'Opening cTrader authorization in your system browser. Requesting accounts-only access…');
  try {
	const authorizationRequest = window.velaBroker.authorizeCTrader({
	  clientId: credentials.clientId || '',
	  clientSecret: credentials.clientSecret || '',
	  allowTrading,
	});
	for (const input of fieldsHost?.querySelectorAll<HTMLInputElement>('input[data-credential-key]') ?? []) input.value = '';
	credentials.clientId = '';
	credentials.clientSecret = '';
	const authorization = await authorizationRequest;
	if (expectedRevision !== providerTransitionRevision) return;
	for (const account of authorization.accounts) {
	  const option = document.createElement('option');
	  option.value = account.id;
	  option.textContent = `${account.broker} · ${account.login || account.id} · ${account.environment}`;
	  ctraderAccountSelect?.append(option);
	}
	activeBrokerId = 'ctrader';
	document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'ctrader' }));
	if (disconnectButton) disconnectButton.hidden = false;
	setStatus(authorization.warnings.length
	  ? `Authorized. Some environments could not be queried: ${authorization.warnings.join(' ')}`
	  : `Authorized. Found ${authorization.accounts.length} cTrader account(s). Choose one to load its assets and symbols.${allowTrading ? ' Trading permission was requested; live orders are still locked.' : ''}`);
  } catch (error) {
	if (expectedRevision === providerTransitionRevision) {
	  setStatus(error instanceof Error ? error.message : String(error), true);
	}
  } finally {
	for (const input of fieldsHost?.querySelectorAll<HTMLInputElement>('input[data-credential-key]') ?? []) input.value = '';
	connectButton.disabled = false;
  }
}

async function selectCTraderAccount() {
  if (!window.velaBroker || !ctraderAccountSelect || !ctraderSelectAccountButton) return;
  const expectedRevision = providerTransitionRevision;
  ctraderSelectAccountButton.disabled = true;
  publishCTraderChartPositions([]);
  setStatus('Connecting to the selected cTrader account and loading its instruments…');
  try {
	const details = await window.velaBroker.selectCTraderAccount(ctraderAccountSelect.value);
	if (expectedRevision !== providerTransitionRevision) return;
	cTraderAccountId = details.account.id;
	cTraderAccountEnvironment = details.account.environment;
	cTraderQuotes.clear();
	cTraderSymbols.clear();
	for (const symbol of details.symbols) cTraderSymbols.set(symbol.id, symbol.name);
	document.dispatchEvent(new CustomEvent('omega:ctrader-account-selected', { detail: details.symbols }));
	document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
	  detail: {
		id: `ctrader:${details.account.id}`,
		label: `cTrader · ${details.account.login || details.account.id}`,
		mode: details.account.environment.toUpperCase(),
		detail: details.account.tradingEnabled ? 'cTrader account selected' : 'cTrader data · read-only',
	  },
	}));
	ctraderPositionsList?.replaceChildren();
	if (ctraderSymbolSelect) {
	  ctraderSymbolSelect.replaceChildren();
	  for (const symbol of details.symbols) {
		const option = document.createElement('option');
		option.value = symbol.id;
		option.textContent = symbol.name;
		ctraderSymbolSelect.append(option);
	  }
	}
	if (ctraderMarketControls) ctraderMarketControls.hidden = false;
	if (ctraderTradeControls) ctraderTradeControls.hidden = !details.account.tradingEnabled;
	if (ctraderPlaceDemoOrder) {
	  ctraderPlaceDemoOrder.disabled = !details.account.tradingEnabled || details.account.environment !== 'demo';
	  ctraderPlaceDemoOrder.textContent = details.account.environment === 'live' ? 'Live order placement locked' : 'Place demo order';
	}
	if (ctraderTradeStatus) {
	  ctraderTradeStatus.textContent = !details.account.tradingEnabled
	    ? 'This account has no trading permission. Reconnect and explicitly request it to use demo order entry.'
	    : details.account.environment === 'live'
	      ? 'Live order placement is disabled until mandatory stop-loss protection is validated in demo.'
	      : 'Demo mode only. Every order requires a stop-loss, fresh quote, and explicit confirmation.';
	}
	if (accountsHost) {
	  accountsHost.replaceChildren();
	  const card = document.createElement('section');
	  card.className = 'broker-account';
	  const heading = document.createElement('div');
	  heading.className = 'broker-account-heading';
	  const name = document.createElement('strong');
	  name.textContent = `${details.account.broker} · ${details.account.login || details.account.id}`;
	  const environment = document.createElement('span');
	  environment.textContent = details.account.environment;
	  heading.append(name, environment);
	  const balance = document.createElement('p');
	  balance.className = 'broker-equity';
	  balance.textContent = `Balance: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(details.account.balance)} ${details.account.currency}`;
	  const inventory = document.createElement('p');
	  inventory.className = 'broker-account-detail';
	  inventory.textContent = `${details.assets.length} assets · ${details.symbols.length} available symbols`;
	  const assets = document.createElement('p');
	  assets.className = 'broker-account-detail';
	  assets.textContent = `Assets: ${details.assets.slice(0, 40).map((asset) => asset.name).join(', ')}${details.assets.length > 40 ? ', …' : ''}`;
	  card.append(heading, balance, inventory, assets);
	  accountsHost.append(card);
	}
	setStatus(details.account.tradingEnabled
	  ? `Connected to ${details.account.environment} cTrader account. Select a symbol and subscribe to quotes.${details.account.environment === 'live' ? ' Live order execution is locked.' : ' Demo order entry is available.'}`
	  : 'cTrader account connected for read-only data. Choose a symbol to load chart history and live quotes.');
	if (details.account.tradingEnabled) await refreshCTraderPositions();
  } catch (error) {
	if (expectedRevision === providerTransitionRevision) {
	  setStatus(error instanceof Error ? error.message : String(error), true);
	}
  } finally {
	ctraderSelectAccountButton.disabled = false;
  }
}

function cTraderSymbolName(symbolId: string | number | undefined): string {
  const key = symbolId === undefined ? '' : String(symbolId);
  return cTraderSymbols.get(key) ?? (key || 'Unknown symbol');
}

function publishCTraderChartPositions(positions: CTraderPosition[]): void {
  const detail = positions.map(position => ({
	positionId: String(position.positionId ?? ''),
	symbol: cTraderSymbolName(position.symbolId),
	side: String(position.tradeData?.tradeSide ?? ''),
	volume: String(position.tradeData?.volume ?? ''),
	entryPrice: Number(position.price),
	stopLoss: position.stopLoss,
	takeProfit: position.takeProfit,
  }));
  document.dispatchEvent(new CustomEvent('omega:ctrader-positions-updated', { detail }));
}

function renderCTraderPositions(snapshot: CTraderReconciliation) {
  publishCTraderChartPositions(snapshot.positions);
  if (!ctraderPositionsList) return;
  ctraderPositionsList.replaceChildren();
  ctraderPositionsList.dataset.state = '';
  if (!snapshot.positions.length && !snapshot.orders.length) {
	ctraderPositionsList.textContent = 'No open positions or orders.';
	return;
  }

  const addItems = (title: string, items: Array<CTraderPosition | CTraderOrder>, kind: 'position' | 'order') => {
	const heading = document.createElement('strong');
	heading.className = 'ctrader-position-kind';
	heading.textContent = title;
	ctraderPositionsList.append(heading);
	const list = document.createElement('ul');
	list.className = 'broker-position-list';
	for (const item of items) {
	  const line = document.createElement('li');
	  const tradeData = item.tradeData;
	  const id = kind === 'position'
	    ? (item as CTraderPosition).positionId
	    : (item as CTraderOrder).orderId;
	  const prices = kind === 'position'
	    ? `Entry ${formatBrokerPrice((item as CTraderPosition).price)} · SL ${formatBrokerPrice((item as CTraderPosition).stopLoss)} · TP ${formatBrokerPrice((item as CTraderPosition).takeProfit)}`
	    : `${(item as CTraderOrder).orderType ?? 'Order'} · Limit ${formatBrokerPrice((item as CTraderOrder).limitPrice)} · Stop ${formatBrokerPrice((item as CTraderOrder).stopPrice)}`;
	  line.textContent = `${cTraderSymbolName(item.symbolId)} · ${tradeData?.tradeSide ?? 'Unknown side'} · ${tradeData?.volume ?? '—'} units · ${prices} · ID ${id ?? 'unknown'}`;
	  list.append(line);
	}
	ctraderPositionsList.append(list);
  };

  if (snapshot.positions.length) addItems('Open positions', snapshot.positions, 'position');
  if (snapshot.orders.length) addItems('Pending orders', snapshot.orders, 'order');
}

function formatBrokerPrice(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

async function refreshCTraderPositions() {
  if (!window.velaBroker || !ctraderPositionsList || !cTraderAccountId) return;
  if (ctraderRefreshPositions) ctraderRefreshPositions.disabled = true;
  ctraderPositionsList.dataset.state = '';
  ctraderPositionsList.textContent = 'Reconciling with cTrader…';
  try {
	renderCTraderPositions(await window.velaBroker.reconcileCTraderAccount());
  } catch (error) {
	ctraderPositionsList.dataset.state = 'error';
	ctraderPositionsList.textContent = `Could not reconcile cTrader positions: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
	if (ctraderRefreshPositions) ctraderRefreshPositions.disabled = false;
  }
}

async function subscribeCTraderSymbol() {
  if (!window.velaBroker || !ctraderSymbolSelect || !ctraderSubscribeButton || !cTraderAccountId) return;
  ctraderSubscribeButton.disabled = true;
  try {
	const symbol = await window.velaBroker.subscribeCTraderSymbol(ctraderSymbolSelect.value);
	setStatus(`Subscribed to live ${symbol.symbol} quotes.`);
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
	ctraderSubscribeButton.disabled = false;
  }
}

async function placeDemoCTraderOrder() {
  if (!window.velaBroker || !ctraderSymbolSelect || !ctraderPlaceDemoOrder || !ctraderOrderSide
    || !ctraderOrderVolume || !ctraderOrderStop || ctraderPlaceDemoOrder.disabled) return;
  const symbolId = ctraderSymbolSelect.value;
  const symbol = ctraderSymbolSelect.selectedOptions[0]?.textContent || symbolId;
  const volume = Number(ctraderOrderVolume.value);
  const stopLoss = Number(ctraderOrderStop.value);
  const takeProfit = ctraderOrderTake?.value ? Number(ctraderOrderTake.value) : undefined;
  if (!symbolId || !Number.isFinite(volume) || volume <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0
    || (takeProfit !== undefined && (!Number.isFinite(takeProfit) || takeProfit <= 0))) {
    if (ctraderTradeStatus) {
	  ctraderTradeStatus.dataset.state = 'error';
	  ctraderTradeStatus.textContent = 'Enter a valid volume, mandatory stop-loss, and optional take-profit.';
	}
	return;
  }
  const side = ctraderOrderSide.value === 'SELL' ? 'SELL' : 'BUY';
  ctraderPlaceDemoOrder.disabled = true;
  try {
	const confirmed = window.confirm(
	  `Send DEMO ${side} market order for ${volume} units of ${symbol}?\nStop loss: ${stopLoss}${takeProfit === undefined ? '' : `\nTake profit: ${takeProfit}`}\n\nThe app will attach protection after the fill, and cancel any unfilled remainder if the order is only partially filled. If protection fails, it will attempt to close the demo position.`,
	);
	if (!confirmed) return;
	if (ctraderTradeStatus) {
	  ctraderTradeStatus.dataset.state = '';
	  ctraderTradeStatus.textContent = 'Sending demo order and applying stop-loss protection…';
	}
	const result = await window.velaBroker.placeDemoCTraderMarketOrder({
	  symbolId,
	  side,
	  volume,
	  stopLoss,
	  ...(takeProfit === undefined ? {} : { takeProfit }),
	  confirmed: true,
	});
	if (ctraderTradeStatus) {
	  if (!result.partialFill) {
		ctraderTradeStatus.textContent = `Demo position ${result.positionId} filled and protected.`;
	  } else {
		const remainder = result.remainderStatus === 'cancelled'
		  ? 'unfilled remainder cancelled'
		  : result.remainderStatus === 'filled'
			? 'remainder filled before cancellation'
			: result.remainderStatus === 'open'
			  ? 'unfilled remainder is still OPEN'
			  : 'remainder status is UNKNOWN';
		const needsAttention = result.remainderStatus === 'open' || result.remainderStatus === 'unknown';
		ctraderTradeStatus.dataset.state = needsAttention ? 'error' : '';
		ctraderTradeStatus.textContent = `PARTIAL demo fill: position ${result.positionId}, ${result.filledVolume ?? 'unknown'} volume, protected; ${remainder}.${result.remainderCancellationError ? ` ${result.remainderCancellationError}` : ''}`;
	  }
	}
	ctraderOrderVolume.value = '';
	await refreshCTraderPositions();
  } catch (error) {
	if (ctraderTradeStatus) {
	  ctraderTradeStatus.dataset.state = 'error';
	  ctraderTradeStatus.textContent = error instanceof Error ? error.message : String(error);
	}
	void refreshCTraderPositions();
  } finally {
	ctraderPlaceDemoOrder.disabled = selectedBroker()?.id !== 'ctrader'
	  || cTraderAccountEnvironment !== 'demo';
  }
}

async function connectReadOnly() {
  if (!window.velaBroker || !brokerSelect || !connectButton) return;
  const broker = selectedBroker();
  if (!broker) return;

  const credentials: Record<string, string> = {};
  for (const input of fieldsHost?.querySelectorAll<HTMLInputElement>('input[data-credential-key]') ?? []) {
	credentials[input.dataset.credentialKey ?? ''] = input.value;
  }

  if (broker.id === 'ctrader') {
	const hasClientId = Boolean(credentials.clientId?.trim());
	const hasClientSecret = Boolean(credentials.clientSecret?.trim());
	if (hasClientId !== hasClientSecret) {
	  setStatus('Enter both cTrader Open API app credentials.', true);
	  return;
	}
	if (!hasClientId) {
	  setStatus('Enter the Client ID and Client Secret from your cTrader Open API app first. Google sign-in happens afterward on cTrader’s official page.', true);
	  fieldsHost?.querySelector<HTMLInputElement>('input[data-credential-key="clientId"]')?.focus();
	  return;
	}
  }

  if (broker.id === 'alpaca' && !credentials.apiKey?.trim() && !credentials.apiSecret?.trim()) {
    try {
      if (!await window.velaBroker.hasSavedAlpacaCredentials?.()) {
        setStatus('Enter both Alpaca API credentials and click Save credentials first.', true);
        fieldsHost?.querySelector<HTMLInputElement>('input[data-credential-key="apiKey"]')?.focus();
        return;
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
  }

  connectButton.disabled = true;
  document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: broker.id }));
  const requestRevision = providerTransitionRevision;
  if (broker.id === 'ctrader') {
	await authorizeCTrader(credentials, requestRevision);
	return;
  }
	activeBrokerId = null;
  accountsHost?.replaceChildren();
  if (refreshButton) refreshButton.hidden = true;
  if (disconnectButton) disconnectButton.hidden = true;
  setStatus(`Connecting to ${broker.displayName} for read-only account data…`);
  try {
	const startedAt = performance.now();
	const snapshot = await window.velaBroker.connectReadOnly(broker.id, credentials);
	if (requestRevision !== providerTransitionRevision) return;
	document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
	activeBrokerId = broker.id;
	renderSnapshot(snapshot);
	document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: broker.id }));
	setStatus(broker.id === 'alpaca'
	  ? `Connected to ${broker.displayName}. Saved encrypted credentials will be reused on this device.`
	  : `Connected to ${broker.displayName}. Credentials are session-only.`);
	if (refreshButton) refreshButton.hidden = false;
	if (disconnectButton) disconnectButton.hidden = false;
  } catch (error) {
	if (requestRevision === providerTransitionRevision) {
	  setStatus(error instanceof Error ? error.message : String(error), true);
	}
  } finally {
	for (const input of fieldsHost?.querySelectorAll<HTMLInputElement>('input[data-credential-key]') ?? []) input.value = '';
	connectButton.disabled = false;
  }
}

/** Starts the same read-only Alpaca flow as the Broker panel, using only
 * credentials already encrypted by Electron on this device. */
export async function autoConnectSavedAlpaca(): Promise<boolean> {
  const bridge = window.velaBroker;
  if (!bridge?.hasSavedAlpacaCredentials) return false;
  try {
    if (!await bridge.hasSavedAlpacaCredentials()) return false;
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));
    setStatus('Connecting to saved Alpaca account (read-only)…');
    const startedAt = performance.now();
    const snapshot = await bridge.connectReadOnly('alpaca', {});
    activeBrokerId = 'alpaca';
    renderSnapshot(snapshot);
    document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'alpaca' }));
    if (refreshButton) refreshButton.hidden = false;
    if (disconnectButton) disconnectButton.hidden = false;
    setStatus('Connected to saved Alpaca account (read-only).');
    const firstAccount = snapshot.accounts[0]?.name;
    const accountId = firstAccount ? `alpaca:${firstAccount}` : '';
    const accountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
    if (accountSelect && accountId) {
      accountSelect.value = accountId;
      accountSelect.dispatchEvent(new Event('change'));
    }
    return true;
  } catch (error) {
    activeBrokerId = null;
    setStatus(`Saved Alpaca auto-connect failed: ${error instanceof Error ? error.message : String(error)}`, true);
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'alpaca', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function saveAlpacaCredentials() {
  if (!window.velaBroker || selectedBroker()?.id !== 'alpaca' || !saveCredentialsButton) return;
  const apiKey = fieldsHost?.querySelector<HTMLInputElement>('input[data-credential-key="apiKey"]')?.value.trim() ?? '';
  const apiSecret = fieldsHost?.querySelector<HTMLInputElement>('input[data-credential-key="apiSecret"]')?.value.trim() ?? '';
  if (!apiKey || !apiSecret) {
    setStatus('Enter both Alpaca API credentials before saving.', true);
    return;
  }
  if (!window.velaBroker.saveAlpacaCredentials) {
    setStatus('Encrypted Alpaca credential storage is unavailable in this app version.', true);
    return;
  }
  saveCredentialsButton.disabled = true;
  setStatus('Encrypting and saving Alpaca credentials…');
  try {
    await window.velaBroker.saveAlpacaCredentials({ apiKey, apiSecret });
    for (const input of fieldsHost?.querySelectorAll<HTMLInputElement>('input[data-credential-key]') ?? []) input.value = '';
    setStatus('Alpaca credentials are encrypted and saved on this Windows device. Leave both fields blank next time and click Connect Read Only.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    saveCredentialsButton.disabled = false;
  }
}

async function refreshSnapshot() {
  if (!window.velaBroker || !activeBrokerId || !refreshButton) return;
  refreshButton.disabled = true;
  setStatus('Refreshing read-only account data…');
  try {
	const startedAt = performance.now();
	renderSnapshot(await window.velaBroker.fetchSnapshot());
	document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
	setStatus('Account data refreshed.');
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
	refreshButton.disabled = false;
  }
}

async function disconnect() {
  if (!window.velaBroker) return;
  try {
	const disconnectedBrokerId = activeBrokerId;
	await window.velaBroker.disconnect();
	activeBrokerId = null;
	cTraderAccountId = null;
	cTraderAccountEnvironment = null;
	cTraderQuotes.clear();
	cTraderSymbols.clear();
	publishCTraderChartPositions([]);
	ctraderPositionsList?.replaceChildren();
	accountsHost?.replaceChildren();
	ctraderAccountSelect?.replaceChildren();
	ctraderSymbolSelect?.replaceChildren();
	ctraderQuotesHost?.replaceChildren();
	if (ctraderMarketControls) ctraderMarketControls.hidden = true;
	if (ctraderTradeControls) ctraderTradeControls.hidden = true;
	if (refreshButton) refreshButton.hidden = true;
	if (disconnectButton) disconnectButton.hidden = true;
	document.dispatchEvent(new CustomEvent('omega:ctrader-disconnected'));
	if (disconnectedBrokerId) document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: disconnectedBrokerId }));
	setStatus('Disconnected. No credentials were saved.');
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function openModal() {
  modal?.classList.add('open');
  modal?.setAttribute('aria-hidden', 'false');
  if (!brokers.length) void loadBrokers();
}

function closeModal() {
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
  openButton?.focus();
}

document.addEventListener('omega:bottom-panel:broker-toggle', openModal);
closeButton?.addEventListener('click', closeModal);
brokerSelect?.addEventListener('change', () => {
  if (activeBrokerId) void disconnect();
  renderCredentialFields();
});
connectButton?.addEventListener('click', () => void connectReadOnly());
saveCredentialsButton?.addEventListener('click', () => void saveAlpacaCredentials());
ctraderSelectAccountButton?.addEventListener('click', () => void selectCTraderAccount());
ctraderSubscribeButton?.addEventListener('click', () => void subscribeCTraderSymbol());
ctraderChartButton?.addEventListener('click', () => {
	const symbol = ctraderSymbolSelect?.selectedOptions[0]?.textContent;
	if (!symbol) {
	  setStatus('Choose a cTrader symbol first.', true);
	  return;
	}
	document.dispatchEvent(new CustomEvent('omega:ctrader-chart-symbol', { detail: { symbol } }));
	setStatus(`Loading ${symbol} on the active chart…`);
});
ctraderPlaceDemoOrder?.addEventListener('click', () => void placeDemoCTraderOrder());
ctraderRefreshPositions?.addEventListener('click', () => void refreshCTraderPositions());
refreshButton?.addEventListener('click', () => void refreshSnapshot());
disconnectButton?.addEventListener('click', () => void disconnect());
window.velaBroker?.onCTraderQuote((quote) => {
  if (!cTraderAccountId || quote.accountId !== cTraderAccountId) return;
  cTraderQuotes.set(quote.symbolId, quote);
  renderCTraderQuotes();
});

document.addEventListener('omega:ctrader-feed-status', event => {
  const detail = (event as CustomEvent<{ message: string; error?: boolean }>).detail;
  if (detail?.message) setStatus(detail.message, detail.error === true);
});

document.addEventListener('omega:trading-broker-connecting', event => {
  providerTransitionRevision += 1;
  const nextBrokerId = (event as CustomEvent<string>).detail;
  if (!nextBrokerId) return;
  activeBrokerId = null;
  cTraderAccountId = null;
  cTraderAccountEnvironment = null;
  cTraderQuotes.clear();
  cTraderSymbols.clear();
  publishCTraderChartPositions([]);
  accountsHost?.replaceChildren();
  ctraderPositionsList?.replaceChildren();
  ctraderAccountSelect?.replaceChildren();
  ctraderSymbolSelect?.replaceChildren();
  ctraderQuotesHost?.replaceChildren();
  if (ctraderMarketControls) ctraderMarketControls.hidden = true;
  if (ctraderTradeControls) ctraderTradeControls.hidden = true;
  if (refreshButton) refreshButton.hidden = true;
  if (disconnectButton) disconnectButton.hidden = true;
});
