import { registerIcon, registerWidgetAction } from '@luxalgo/vela';

let getEnabled = (): boolean => false;
let setEnabled = (_enabled: boolean): void => undefined;

export function initializePriceBarRatioMenu(
  readEnabled: () => boolean,
  writeEnabled: (enabled: boolean) => void,
): void {
  getEnabled = readEnabled;
  setEnabled = writeEnabled;
}

registerIcon(
  'omega-price-ratio-inactive',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-linecap="round"><path d="M2 4h12M2 8h8M2 12h4"/></svg>',
);

registerIcon(
  'omega-price-ratio-active',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="#22c55e" stroke-width="1.8" stroke-linecap="round"><path d="M2 4h12M2 8h8M2 12h4"/></svg>',
);

registerWidgetAction({
  id: 'lock-price-bar-ratio',
  target: 'context:price-axis',
  label: 'Lock price to bar ratio',
  icon: 'omega-price-ratio-inactive',
  order: 20,
  when: () => !getEnabled(),
  run: context => {
    setEnabled(true);
    context.toast('Price-to-bar ratio locked.', 'success');
  },
});

registerWidgetAction({
  id: 'unlock-price-bar-ratio',
  target: 'context:price-axis',
  label: 'Unlock price to bar ratio',
  icon: 'omega-price-ratio-active',
  order: 20,
  when: () => getEnabled(),
  run: context => {
    setEnabled(false);
    context.toast('Price-to-bar ratio unlocked.', 'success');
  },
});
