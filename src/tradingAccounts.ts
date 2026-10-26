interface TradingAccountChoice {
  id: string;
  label: string;
  mode: string;
  detail: string;
}

const LOCAL_DEMO_ACCOUNT: TradingAccountChoice = {
  id: 'local-demo',
  label: 'DEMO · Local account',
  mode: 'DEMO',
  detail: 'Local account',
};
const TRADING_ACCOUNT_STORAGE_KEY = 'omega.selected-trading-account';

export function initializeTradingAccounts(): void {
  const connectionLatency = document.getElementById('connection-latency');
  const tradingAccountStatus = document.getElementById('trading-account-status');
  const chartTabsToggle = document.getElementById('chart-tabs-toggle');
  const tradingAccountMode = document.getElementById('trading-account-mode');
  const tradingAccountDetail = document.getElementById('trading-account-detail');
  const tradingAccountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
  const availableTradingAccounts = new Map<string, TradingAccountChoice>([[LOCAL_DEMO_ACCOUNT.id, LOCAL_DEMO_ACCOUNT]]);
  let topbarObserver: MutationObserver | null = null;

  const placeAccountControl = (): boolean => {
    const favoriteTools = document.querySelector<HTMLButtonElement>(
      '.vela-widget-topbar #vela-action-omega-favorite-drawing-tools',
    );
    const actionGroup = favoriteTools?.parentElement;
    if (!tradingAccountStatus || !actionGroup) return false;
    // Keep the "Tab View" switch directly before the account control so both
    // chart-level controls sit together in the chart topbar.
    if (chartTabsToggle) {
      if (actionGroup.nextElementSibling !== chartTabsToggle) actionGroup.after(chartTabsToggle);
      if (chartTabsToggle.nextElementSibling !== tradingAccountStatus) chartTabsToggle.after(tradingAccountStatus);
    } else if (actionGroup.nextElementSibling !== tradingAccountStatus) {
      actionGroup.after(tradingAccountStatus);
    }
    return true;
  };

  const observeTopbar = (): void => {
    if (topbarObserver) return;
    const topbar = document.querySelector<HTMLElement>('.vela-workspace .vela-widget-topbar');
    if (!topbar) return;
    // Vela can rebuild the topbar (layout/tab changes); re-place the controls.
    topbarObserver = new MutationObserver(() => { placeAccountControl(); });
    topbarObserver.observe(topbar, { childList: true });
  };

  if (placeAccountControl()) observeTopbar();
  else {
    const observer = new MutationObserver(() => {
      if (!placeAccountControl()) return;
      observer.disconnect();
      observeTopbar();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const selectTradingAccount = (id: string, persist = true): void => {
    const account = availableTradingAccounts.get(id) ?? LOCAL_DEMO_ACCOUNT;
    if (tradingAccountSelect) tradingAccountSelect.value = account.id;
    if (tradingAccountMode) tradingAccountMode.textContent = account.mode;
    if (tradingAccountDetail) tradingAccountDetail.textContent = account.detail;
    if (persist) localStorage.setItem(TRADING_ACCOUNT_STORAGE_KEY, account.id);
    document.dispatchEvent(new CustomEvent('omega:trading-account-selected', {
      detail: {
        id: account.id,
        provider: account.id.includes(':') ? account.id.slice(0, account.id.indexOf(':')).toLowerCase() : '',
      },
    }));
  };

  const renderTradingAccounts = (): void => {
    if (!tradingAccountSelect) return;
    const selected = localStorage.getItem(TRADING_ACCOUNT_STORAGE_KEY) || LOCAL_DEMO_ACCOUNT.id;
    tradingAccountSelect.replaceChildren(...[...availableTradingAccounts.values()].map(account => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      return option;
    }));
    selectTradingAccount(availableTradingAccounts.has(selected) ? selected : LOCAL_DEMO_ACCOUNT.id, false);
  };

  tradingAccountSelect?.addEventListener('change', () => selectTradingAccount(tradingAccountSelect.value));
  const accountLabel = tradingAccountStatus?.querySelector<HTMLElement>('.trading-account-label');
  if (accountLabel) accountLabel.textContent = 'Account';
  document.addEventListener('omega:trading-account-available', event => {
    const account = (event as CustomEvent<TradingAccountChoice>).detail;
    if (!account?.id || !account.label || !account.mode || !account.detail) return;
    availableTradingAccounts.set(account.id, account);
    renderTradingAccounts();
  });
  document.addEventListener('omega:trading-account-unavailable', event => {
    const id = (event as CustomEvent<string>).detail;
    if (!id || id === LOCAL_DEMO_ACCOUNT.id) return;
    availableTradingAccounts.delete(id);
    renderTradingAccounts();
  });
  document.addEventListener('omega:trading-broker-disconnected', event => {
    const brokerId = (event as CustomEvent<string>).detail;
    if (!brokerId) return;
    for (const id of availableTradingAccounts.keys()) {
      if (id.startsWith(`${brokerId}:`)) availableTradingAccounts.delete(id);
    }
    renderTradingAccounts();
  });
  renderTradingAccounts();

  document.addEventListener('omega:connection-latency', event => {
    const milliseconds = (event as CustomEvent<number>).detail;
    if (!connectionLatency || !Number.isFinite(milliseconds)) return;
    connectionLatency.textContent = `Server: ${Math.round(milliseconds)} ms`;
    connectionLatency.dataset.quality = milliseconds < 100 ? 'good' : milliseconds < 300 ? 'warning' : 'poor';
  });
}
