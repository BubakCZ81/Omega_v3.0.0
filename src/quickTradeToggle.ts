import { registerIcon, registerWidgetAction } from '@luxalgo/vela';

const STORAGE_KEY = 'omega.quicktrade.enabled';
const ACTION_ID = 'omega-quicktrade-toggle';
const quickTradeControls = document.getElementById('chart-paper-trade-controls');

let enabled = localStorage.getItem(STORAGE_KEY) === 'true';

function registerToggleAction(): void {
  const iconId = enabled ? 'omega-quicktrade-enabled' : 'omega-quicktrade-disabled';
  registerWidgetAction({
    id: ACTION_ID,
    target: 'context:body',
    label: 'Enable QuickTrade',
    icon: iconId,
    order: 20,
    run: () => setQuickTradeEnabled(!enabled),
  });
}

registerIcon(
  'omega-quicktrade-enabled',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="m4.2 8.2 2.3 2.3 5-5"/></svg>',
);
registerIcon(
  'omega-quicktrade-disabled',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/></svg>',
);

export function setQuickTradeEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled;
  if (quickTradeControls) {
    quickTradeControls.hidden = !enabled;
    quickTradeControls.setAttribute('aria-hidden', String(!enabled));
  }
  localStorage.setItem(STORAGE_KEY, String(enabled));
  registerToggleAction();
}

export function initializeQuickTradeToggle(): void {
  setQuickTradeEnabled(enabled);
}
