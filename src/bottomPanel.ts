export type PaperTradingPanelAction =
  | 'open-trades'
  | 'trade-history'
  | 'activity-console'
  | 'toggle-right-panel'
  | 'buy'
  | 'sell';

export function initializeBottomPanel(options: {
  mt5Enabled: boolean;
  onPaperTradingAction(action: PaperTradingPanelAction): Promise<void>;
}): void {
  const route = (buttonId: string, eventName: string): void => {
    document.getElementById(buttonId)?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent(eventName));
    });
  };

  route('editor-toggle-btn', 'omega:bottom-panel:editor-toggle');
  route('broker-toggle', 'omega:bottom-panel:broker-toggle');
  for (const action of ['open-trades', 'trade-history', 'activity-console'] as const) {
    document.getElementById(`${action === 'open-trades' ? 'open-trades' : action}-toggle`)
      ?.addEventListener('click', () => {
        void options.onPaperTradingAction(action).catch(error => {
          console.error(`Could not open ${action.replace('-', ' ')}:`, error);
        });
      });
  }
  for (const [buttonId, action] of [
    ['trading-pane-toggle', 'toggle-right-panel'],
    ['paper-trade-buy', 'buy'],
    ['paper-trade-sell', 'sell'],
  ] as const) {
    document.getElementById(buttonId)?.addEventListener('click', () => {
      void options.onPaperTradingAction(action).catch(error => {
        console.error(`Could not run paper trading action "${action}":`, error);
      });
    });
  }

  const localFeedsModal = document.getElementById('local-feeds-modal');
  const closeLocalFeeds = (): void => {
    localFeedsModal?.setAttribute('aria-hidden', 'true');
    if (localFeedsModal) localFeedsModal.hidden = true;
  };

  document.getElementById('local-feeds-toggle')?.addEventListener('click', () => {
    if (!localFeedsModal) return;
    localFeedsModal.hidden = false;
    localFeedsModal.setAttribute('aria-hidden', 'false');
  });
  document.getElementById('local-feeds-close')?.addEventListener('click', closeLocalFeeds);
  localFeedsModal?.addEventListener('click', event => {
    if (event.target === localFeedsModal) closeLocalFeeds();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-local-feed]').forEach(button => {
    const trigger = document.getElementById('mt5-feed-toggle') as HTMLButtonElement | null;
    if (!trigger || !options.mt5Enabled) button.hidden = true;
    button.addEventListener('click', () => {
      trigger?.click();
      closeLocalFeeds();
    });
  });

  document.getElementById('diagnostics-console-toggle')?.addEventListener('click', () => {
    void window.velaDiagnostics?.openConsole().catch(error => {
      console.error('Could not open the diagnostic console:', error);
    });
  });
}
