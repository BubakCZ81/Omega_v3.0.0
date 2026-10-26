import { registerWidgetAction, type WidgetContext } from '@luxalgo/vela/widget';
import { appAssetUrl } from './appPaths';
import { buildIndicatorCategoryList } from './indicatorCategories';
import { rankIndicatorMatches } from './indicatorSearch';

interface CatalogIndicator {
  name: string;
  url: string;
  language?: string;
  enabled?: boolean;
  category?: string;
  collections?: string[];
}

type BrowserItem =
  | { kind: 'script'; name: string; category: string; url: string; language: string; collections?: string[] }
	| { kind: 'native'; name: string; category: string; group: string; type: string; supported: boolean; present: boolean; multiInstance?: boolean; inputs: Array<{ key: string; title: string; type: string; options?: string[]; min?: number; max?: number; step?: number; defval?: string | number | boolean }> }
  | { kind: 'user'; name: string; category: string; script: string };

let activeContext: WidgetContext | null = null;
let catalog: CatalogIndicator[] = [];
let items: BrowserItem[] = [];
let selectedItem: BrowserItem | null = null;
let detailRequestId = 0;
let nativeIndicatorError: string | null = null;
let activeCategory = 'Discover';
let searchQuery = '';
let catalogLoaded = false;
const favoritesKey = 'vela_indicator_favorites';
const catalogEntries = new Map<string, { name: string; source: string }>();

const categoryDescriptions: Record<string, string> = {
  'Bands & Channels': 'Plots price envelopes or channels to show how price relates to a calculated range.',
  Highlighters: 'Marks calendar events or price conditions directly on the chart for visual context.',
  'Moving Averages': 'Smooths a price series to make trend direction and changes easier to inspect.',
  Oscillators: 'Transforms price or volume data into an oscillator for studying momentum and market conditions.',
  Research: 'Provides chart examples or diagnostic visualizations; inspect the source and outputs before use.',
  Statistics: 'Summarizes historical or symbol-specific data to show context across time.',
  'Trailing Stops': 'Tracks a price-dependent stop level that follows trends and can mark potential reversals.',
  Trend: 'Helps assess the direction or strength of a prevailing price trend.',
  Utilities: 'Provides chart-development or diagnostic tooling rather than a conventional market signal.',
  Volatility: 'Measures recent price variability or range using a configurable calculation.',
  Volume: 'Uses trading volume, sometimes combined with price changes, to visualize market participation.',
  'Built-in': 'Built-in Vela chart indicator. Select it to review and configure its available inputs.',
  'My Scripts': 'A Pine script saved locally in your indicator library.',
};

const indicatorDescriptions: Record<string, string> = {
  'Exponential Moving Average': 'Smooths price using exponentially decreasing weights, giving recent values more influence.',
  'Simple Moving Average': 'Shows the arithmetic average of a selected price source over a configurable lookback.',
  'Weighted Moving Average': 'Smooths price with linearly weighted values, giving more recent observations greater weight.',
  'Corrected Moving Average': 'Compares a simple average with a lag-corrected average and highlights their crossover direction.',
  'Linear Regression (All Data)': 'Fits a linear trend to all available bars and reports its slope, intercept, and correlation.',
  'NRTR Nick Rypock Trailing Reverse': 'Plots a percentage-based trailing reversal level and marks direction changes.',
  'Hull Moving Average': 'A weighted-average construction designed to reduce lag while keeping the line smooth.',
  'Variable Index Dynamic Average': 'Adapts its smoothing speed to changes in momentum while following the selected price source.',
  'Awesome Oscillator': 'Compares short- and longer-period median-price averages to show changes in momentum.',
  'Chande Momentum Oscillator': 'Compares the sum of recent gains and losses to express directional momentum.',
  'Percentage Price Oscillator': 'Shows the percentage difference between short- and long-period moving averages.',
  'Supertrend': 'Uses an ATR-based band to follow price and indicate the current trend direction.',
  'Chandelier Exit': 'Places a volatility-adjusted trailing exit level relative to recent highs or lows.',
  'Parabolic SAR': 'Plots a trend-following stop-and-reversal level that accelerates as a trend continues.',
  'Halftrend': 'Plots a trend-following line and reversal markers from recent price highs and lows.',
  'Normalized Average True Range': 'Expresses average true range relative to price to compare volatility across price levels.',
  'Net Volume': 'Displays volume signed by price direction to show the balance of buying and selling activity.',
  'On Balance Volume': 'Cumulatively adds or subtracts volume according to price direction, with an optional signal line.',
  'Volume Accumulation': 'Accumulates volume according to price direction to visualize participation over time.',
  'Visible Range Volume Profile': 'Groups traded volume by price across the visible chart range to highlight high-activity areas.',
  'Bollinger Bands': 'Plots a moving average with upper and lower bands based on standard deviation.',
  'Bollinger Bands %B': 'Shows where price sits relative to the upper and lower Bollinger Bands.',
  'Bollinger Bands Width': 'Measures the distance between Bollinger Bands as a volatility gauge.',
  'Keltner Channels': 'Plots an average-price channel whose width is based on average true range.',
  'Donchian Channels': 'Shows the highest high and lowest low over a configurable lookback.',
  'Chande Kroll Stop': 'Calculates volatility-adjusted stop levels for long and short positions.',
  'Relative Strength Index': 'Measures the magnitude of recent gains versus losses on a bounded momentum scale.',
  'Stochastic': 'Compares the closing price with its recent high-low range to track momentum.',
  'Stochastic RSI': 'Applies the stochastic calculation to RSI values to emphasize short-term momentum changes.',
  'MACD': 'Compares fast and slow moving averages and plots their difference with a signal line.',
  'Commodity Channel Index': 'Measures price deviation from its statistical average over a selected period.',
  'Williams %R': 'Measures the close relative to the recent high-low range on an inverted bounded scale.',
  'Connors RSI': 'Combines RSI, streak length, and relative price change into a short-term momentum measure.',
  'Fisher Transform': 'Transforms price data to make potential turning points more distinct.',
  'TRIX': 'Measures the rate of change of a triple-smoothed moving average.',
  'True Strength Index': 'Uses smoothed price changes to show the strength and direction of momentum.',
  'Schaff Trend Cycle': 'Combines MACD-style trend information with a cycle-based oscillator.',
  'Know Sure Thing': 'Combines smoothed rates of change across several periods into a momentum oscillator.',
  'Coppock Curve': 'Smooths long-term rates of change to show broad momentum shifts.',
  'Average Directional Index': 'Measures trend strength independently of whether price is rising or falling.',
  'Aroon': 'Tracks how recently price has made period highs and lows to assess trend development.',
  'Vortex Indicator': 'Compares upward and downward price movement to help identify trend direction.',
  'Average True Range': 'Measures average price range, including gaps, as an indicator of volatility.',
  'Historical Volatility': 'Estimates past price variability from changes in price over a selected period.',
  'Chaikin Volatility': 'Measures changes in the range of high and low prices over time.',
  'Standard Deviation': 'Measures how widely price values vary around their average.',
  'Ulcer Index': 'Measures downside volatility by tracking the depth and duration of price drawdowns.',
  'Choppiness Index': 'Estimates whether price action is ranging or trending over a selected period.',
  'Accumulation / Distribution': 'Combines volume with each bar’s close location in its range to estimate flow.',
  'Chaikin Money Flow': 'Compares volume-weighted buying and selling pressure over a selected period.',
  'Chaikin Oscillator': 'Measures changes in the accumulation/distribution line using two moving averages.',
  'Ease of Movement': 'Relates price movement to volume to estimate how readily price is moving.',
  'Force Index': 'Combines price change and volume to estimate the strength of buying or selling pressure.',
  'Klinger Oscillator': 'Compares volume force over short and long periods to study money-flow direction.',
  'Money Flow Index': 'Uses price and volume to estimate buying and selling pressure on a bounded scale.',
  'Negative Volume Index': 'Tracks price changes on bars with lower volume than the prior bar.',
  'Elder Ray': 'Compares highs and lows with an average price to display bull and bear pressure.',
  'Williams Alligator': 'Uses three smoothed moving averages with different offsets to illustrate trend alignment.',
  'Gator Oscillator': 'Visualizes the separation and contraction of the Williams Alligator moving averages.',
  'TTM Squeeze': 'Highlights periods when Bollinger Bands contract inside Keltner Channels.',
};

function nativeIndicatorGroup(name: string): string {
  const normalized = name.toLowerCase();
  if (/volume|money flow|force index|ease of movement|klinger|accumulation/.test(normalized)) return 'Volume';
  if (/average true range|true range|relative volatility|volatility|standard deviation|ulcer|choppiness|squeeze/.test(normalized)) return 'Volatility';
  if (/stop|parabolic sar|super.?trend|chandelier/.test(normalized)) return 'Trailing Stops';
  if (/commodity channel index/.test(normalized)) return 'Oscillators';
  if (/band|channel|envelope/.test(normalized)) return 'Bands & Channels';
  if (/moving average|zero-lag|vidya|variable index dynamic average|linear regression curve/.test(normalized)) return 'Moving Averages';
  if (/alligator|gator|aroon|directional index|vortex|elder ray/.test(normalized)) return 'Trend';
  return 'Oscillators';
}

function itemCategory(item: BrowserItem): string {
  if (item.kind === 'native') return item.group;
  if (item.kind === 'script' && item.collections?.includes(activeCategory)) return activeCategory;
  return item.category;
}

function describeItem(item: BrowserItem): string {
  if (item.kind === 'user') return categoryDescriptions['My Scripts'];
  return indicatorDescriptions[item.name] ?? categoryDescriptions[itemCategory(item)] ?? categoryDescriptions['Built-in'];
}

function getFavorites(): Set<string> {
  try {
	return new Set(JSON.parse(localStorage.getItem(favoritesKey) ?? '[]') as string[]);
  } catch {
	return new Set();
  }
}

function setFavorites(favorites: Set<string>): void {
  localStorage.setItem(favoritesKey, JSON.stringify([...favorites]));
}

function getUserScripts(): Record<string, string> {
  try {
	return JSON.parse(localStorage.getItem('vela_user_scripts') ?? '{}') as Record<string, string>;
  } catch {
	return {};
  }
}

function getVisibleItems(): BrowserItem[] {
  const scripts: BrowserItem[] = catalog.map(entry => ({
	kind: 'script',
	name: entry.name,
	url: entry.url,
	language: entry.language ?? 'pine',
	category: entry.category ?? 'Other',
	collections: entry.collections,
  }));
  const users: BrowserItem[] = Object.entries(getUserScripts()).map(([name, script]) => ({
	kind: 'user', name, script, category: 'My Scripts',
  }));
  const favorites = getFavorites();
  const allItems = [...scripts, ...users, ...items.filter(item => item.kind === 'native')];
  let visible = allItems;

	if (searchQuery) {
	  // Searching is global: a query should find a built-in or a script even
	  // when the sidebar is currently filtered to another category.
	  visible = allItems;
	} else if (activeCategory === 'Favorites') visible = visible.filter(item => favorites.has(item.name));
  else if (activeCategory === 'My Scripts') visible = users;
  else if (activeCategory === 'Discover') visible = visible.filter(item => item.kind !== 'native');
  else if (activeCategory === 'All scripts') visible = scripts;
  else if (activeCategory === 'Built-in') visible = items.filter(item => item.kind === 'native');
  else {
	visible = visible.filter(item => itemCategory(item) === activeCategory);
  }

  if (searchQuery) {
	// Rank name matches first and keep description-only hits out of the way;
	// see indicatorSearch.ts for the scoring tiers.
	visible = rankIndicatorMatches(
	  visible,
	  searchQuery,
	  item => ({
		name: item.name,
		category: itemCategory(item),
		collections: item.kind === 'script' ? item.collections : undefined,
		description: describeItem(item),
	  }),
	);
  }
  return visible;
}

function itemId(item: BrowserItem): string {
  return item.kind === 'native' ? `native:${item.type}` : `${item.kind}:${item.name}`;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function getSettingValue(item: Extract<BrowserItem, { kind: 'native' }>, key: string): string | number | boolean {
  const saved = localStorage.getItem(`vela_native_indicator:${item.type}`);
  try {
	const values = saved ? JSON.parse(saved) as Record<string, string | number | boolean> : {};
	return values[key] ?? item.inputs.find(input => input.key === key)?.defval ?? '';
  } catch {
	return item.inputs.find(input => input.key === key)?.defval ?? '';
  }
}

function renderNativeSettings(item: Extract<BrowserItem, { kind: 'native' }>, host: HTMLElement): void {
  if (!item.inputs.length) return;
  const settings = makeElement('div', 'indicator-detail-settings');
  settings.appendChild(makeElement('strong', '', 'Settings'));
  for (const schema of item.inputs) {
	const row = makeElement('label', 'indicator-setting-row');
	row.appendChild(makeElement('span', '', schema.title));
	let control: HTMLInputElement | HTMLSelectElement;
	if (schema.options?.length) {
	  const select = document.createElement('select');
	  for (const option of schema.options) {
		const optionElement = document.createElement('option');
		optionElement.value = String(option);
		optionElement.textContent = String(option);
		select.appendChild(optionElement);
	  }
	  control = select;
	} else {
	  const input = document.createElement('input');
	  input.type = schema.type === 'bool' ? 'checkbox' : schema.type === 'int' || schema.type === 'float' ? 'number' : 'text';
	  if (schema.min !== undefined) input.min = String(schema.min);
	  if (schema.max !== undefined) input.max = String(schema.max);
	  if (schema.step !== undefined) input.step = String(schema.step);
	  control = input;
	}
	const current = getSettingValue(item, schema.key);
	if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(current);
	else control.value = String(current);
	row.appendChild(control);
	settings.appendChild(row);
  }
  host.appendChild(settings);
}

function renderSidebar(): void {
  const sidebar = document.getElementById('indicator-browser-categories');
  if (!sidebar) return;
  sidebar.replaceChildren();
	const categories = buildIndicatorCategoryList([
	  ...catalog.flatMap(item => [item.category ?? 'Other', ...(item.collections ?? [])]),
	  ...items.filter((item): item is Extract<BrowserItem, { kind: 'native' }> => item.kind === 'native').map(item => item.group),
	]);
  for (const category of categories) {
	const button = makeElement('button', `indicator-category${activeCategory === category ? ' active' : ''}`, category);
	button.type = 'button';
	button.addEventListener('click', () => {
	  activeCategory = category;
	  renderSidebar();
	  renderCards();
	});
	sidebar.appendChild(button);
  }
}

function renderCards(): void {
  const grid = document.getElementById('indicator-browser-grid');
  if (!grid) return;
  grid.replaceChildren();
  const visible = getVisibleItems();
  const favorites = getFavorites();
  for (const item of visible) {
	const card = makeElement('article', `indicator-card${selectedItem && itemId(selectedItem) === itemId(item) ? ' selected' : ''}`);
	const title = makeElement('strong', 'indicator-card-title', item.name);
	const subtitle = makeElement('span', 'indicator-card-category', itemCategory(item));
	const description = makeElement('span', 'indicator-card-description', describeItem(item));
	const favorite = makeElement('button', `indicator-favorite${favorites.has(item.name) ? ' active' : ''}`, favorites.has(item.name) ? '★' : '☆');
	favorite.type = 'button';
	favorite.title = favorites.has(item.name) ? 'Remove from favorites' : 'Add to favorites';
	favorite.addEventListener('click', event => {
	  event.stopPropagation();
	  const next = getFavorites();
	  if (next.has(item.name)) next.delete(item.name);
	  else next.add(item.name);
	  setFavorites(next);
	  renderCards();
	});
	card.append(favorite, title, subtitle, description);
	card.tabIndex = 0;
	card.setAttribute('role', 'button');
	card.addEventListener('click', () => {
	  selectedItem = item;
	  renderCards();
	  void renderDetails(item);
	});
	card.addEventListener('keydown', event => {
	  if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		selectedItem = item;
		renderCards();
		void renderDetails(item);
	  }
	});
	grid.appendChild(card);
  }
  if (!visible.length) grid.appendChild(makeElement('div', 'indicator-empty', 'No matching indicators.'));
  if (nativeIndicatorError) {
	grid.appendChild(makeElement('div', 'indicator-browser-status', `Built-in indicators unavailable: ${nativeIndicatorError}`));
  }
  const count = document.getElementById('indicator-browser-count');
  if (count) count.textContent = `${visible.length} indicator${visible.length === 1 ? '' : 's'}`;
}

async function renderDetails(item: BrowserItem): Promise<void> {
  const requestId = ++detailRequestId;
  const detail = document.getElementById('indicator-browser-detail');
  if (!detail) return;
  detail.replaceChildren();
  detail.append(makeElement('span', 'indicator-detail-category', itemCategory(item)));
  detail.append(makeElement('h2', 'indicator-detail-title', item.name));
  const description = makeElement('p', 'indicator-detail-description', describeItem(item));
  detail.appendChild(description);

  if (item.kind === 'native') renderNativeSettings(item, detail);

	if (item.kind !== 'native') {
	  const sourcePreview = makeElement('pre', 'indicator-source-preview', 'Loading Pine source...');
	  detail.appendChild(sourcePreview);
	try {
		const source = item.kind === 'user'
		? item.script
		: catalogEntries.get(item.name)?.source ?? await fetch(appAssetUrl(item.url)).then(response => {
		  if (!response.ok) throw new Error(`Source request failed (${response.status}).`);
		  return response.text();
		});
		if (requestId !== detailRequestId) return;
		if (source) {
		sourcePreview.textContent = source;
		if (item.kind === 'script') catalogEntries.set(item.name, { name: item.name, source });
	  }
	} catch (error) {
	  if (requestId !== detailRequestId) return;
	  sourcePreview.textContent = error instanceof Error ? error.message : String(error);
	}
  }

  const addButton = makeElement('button', 'indicator-add-button', item.kind === 'native' ? 'Add to chart' : 'Add to chart');
  addButton.type = 'button';
  addButton.disabled = item.kind === 'native' && (!item.supported || (item.present && !item.multiInstance));
  addButton.addEventListener('click', async () => {
	if (!activeContext) return;
	addButton.disabled = true;
	try {
	  if (item.kind === 'native') {
		const settings = detail.querySelector('.indicator-detail-settings');
		const inputs: Record<string, string | number | boolean> = {};
		for (const control of Array.from(settings?.querySelectorAll('input, select') ?? [])) {
		  const schema = item.inputs.find(input => input.title === control.closest('label')?.querySelector('span')?.textContent);
		  if (!schema) continue;
		  const inputControl = control as HTMLInputElement | HTMLSelectElement;
		  inputs[schema.key] = inputControl instanceof HTMLInputElement && inputControl.type === 'checkbox'
			? inputControl.checked
			: schema.type === 'int' ? Number.parseInt(inputControl.value, 10)
			  : schema.type === 'float' ? Number.parseFloat(inputControl.value)
				: inputControl.value;
		}
		localStorage.setItem(`vela_native_indicator:${item.type}`, JSON.stringify(inputs));
		activeContext.chart.addNativeIndicator(item.type, { inputs });
	  } else {
		const script = item.kind === 'user' ? item.script : catalogEntries.get(item.name)?.source;
		if (!script) throw new Error('The indicator source could not be loaded. Select the entry again and retry.');
		activeContext.addIndicator({
		  name: item.name,
		  script,
		  language: item.kind === 'user' ? 'pine' : item.language,
		  id: `browser:${encodeURIComponent(item.name)}`,
		});
	  }
	  activeContext.toast(`Added ${item.name} to chart.`, 'success');
	} catch (error) {
	  activeContext.toast(error instanceof Error ? error.message : String(error), 'error');
	  addButton.disabled = false;
	}
  });
  detail.appendChild(addButton);
}

async function openIndicatorBrowser(context: WidgetContext): Promise<void> {
  activeContext = context;
  const modal = document.getElementById('indicator-browser-modal');
  const search = document.getElementById('indicator-browser-search') as HTMLInputElement | null;
  if (!modal) return;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  if (search) {
	search.value = '';
	searchQuery = '';
	search.focus();
  }
  if (!catalogLoaded) {
	try {
	  const response = await fetch(appAssetUrl('/indicators/catalog.json'));
	  if (!response.ok) throw new Error(`Catalog request failed (${response.status}).`);
	  catalog = await response.json() as CatalogIndicator[];
	  catalogLoaded = true;
	} catch (error) {
	  const grid = document.getElementById('indicator-browser-grid');
	  if (grid) grid.textContent = error instanceof Error ? error.message : String(error);
	  return;
	}
  }
  nativeIndicatorError = null;
  try {
	const [nativeCatalog, nativeDetails] = await Promise.all([
	  context.chart.availableNativeIndicators(),
	  import('@luxalgo/vela').then(module => module.nativeIndicatorDescriptors()),
	]);
	items = nativeCatalog.filter(entry =>
	  entry.type !== 'bid-ask-lines' && entry.type !== 'omega-quick-trade-levels',
	).map(entry => ({
	  kind: 'native',
	  name: entry.title,
	  category: 'Built-in',
	  group: nativeIndicatorGroup(entry.title),
	type: entry.type,
	supported: entry.supported,
	present: entry.present,
	multiInstance: entry.multiInstance,
	inputs: nativeDetails.find(descriptor => descriptor.type === entry.type)?.inputsSchema().map(input => ({
	  key: input.key,
	  title: input.title,
	  type: input.type,
	  options: input.options ? [...input.options] : undefined,
	  min: input.min,
	  max: input.max,
	  step: input.step,
	  defval: input.defval,
	})) ?? [],
	}));
  } catch (error) {
	items = [];
	nativeIndicatorError = error instanceof Error ? error.message : String(error);
  }
  activeCategory = activeCategory === 'Discover' ? 'Discover' : activeCategory;
  renderSidebar();
  renderCards();
  const first = getVisibleItems()[0];
  if (first) {
	selectedItem = first;
	renderCards();
	await renderDetails(first);
  }
}

export function closeIndicatorBrowser(): void {
  detailRequestId += 1;
  const modal = document.getElementById('indicator-browser-modal');
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
  activeContext = null;
}

document.addEventListener('pine-indicator-picker-open', event => {
  const context = (event as CustomEvent<WidgetContext>).detail;
  if (context) void openIndicatorBrowser(context);
});

document.getElementById('indicator-browser-search')?.addEventListener('input', event => {
  searchQuery = (event.currentTarget as HTMLInputElement).value.trim();
  renderCards();
});
document.getElementById('indicator-browser-close')?.addEventListener('click', closeIndicatorBrowser);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeIndicatorBrowser();
});

let indicatorBrowserRegistered = false;

export function ensureIndicatorBrowserRegistration(): void {
  registerWidgetAction({
    id: 'indicators',
    target: 'topbar',
    label: 'Indicators',
    icon: 'indicators',
    align: 'left',
    order: 10,
    run: context => { void openIndicatorBrowser(context); },
  });
  indicatorBrowserRegistered = true;
}

export function isIndicatorBrowserRegistered(): boolean {
  return indicatorBrowserRegistered;
}

ensureIndicatorBrowserRegistration();
