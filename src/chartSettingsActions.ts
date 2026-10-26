import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { isOmegaTheme, type OmegaTheme } from './themeControls';

interface ChartSettingsActionsOptions {
  workspace: VelaWorkspace;
  openReplayControls(): void;
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
  updatesEnabled?: boolean;
}

const THEME_CHOICES: ReadonlyArray<readonly [OmegaTheme, string]> = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['high-contrast', 'High contrast · light'],
  ['high-contrast-dark', 'High contrast · dark'],
];

export function initializeChartSettingsActions(options: ChartSettingsActionsOptions): {
  openChartSettings(): void;
} {
  const { workspace, openReplayControls, getTheme, setTheme, updatesEnabled = true } = options;

  function installSettingsActionButtons(): void {
    const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
    const resetButton = settingsDialog?.querySelector<HTMLButtonElement>('button.vela-sd-btn');
    const footer = resetButton?.parentElement;
    if (!footer || footer.querySelector('[data-omega-settings-action]')) return;

    // Theme is an application-wide setting; it belongs next to the other
    // settings actions instead of an extra toolbar menu.
    const themeField = document.createElement('label');
    themeField.className = 'omega-settings-theme';
    themeField.dataset.omegaSettingsAction = 'theme';
    const caption = document.createElement('span');
    caption.textContent = 'Theme';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Colour theme');
    for (const [value, label] of THEME_CHOICES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = getTheme();
    select.addEventListener('change', () => {
      const value = select.value;
      if (isOmegaTheme(value)) setTheme(value);
    });
    themeField.append(caption, select);
    footer.insertBefore(themeField, resetButton);

    const makeButton = (label: string, action: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vela-sd-btn';
      button.textContent = label;
      button.dataset.omegaSettingsAction = label;
      button.addEventListener('click', action);
      footer.insertBefore(button, resetButton);
    };
    makeButton('Replay', openReplayControls);
    if (updatesEnabled) {
      makeButton('Check for updates', () => {
        // Loaded on demand so the update checker stays an optional module.
        void import('./updateChecker')
          .then(module => module.checkForUpdates())
          .catch(error => console.error('Could not check for updates:', error));
      });
    }
  }

  new MutationObserver(records => {
    const settingsWasInserted = records.some(record => [...record.addedNodes].some(node =>
      node instanceof Element && (node.matches('.vela-dialog--settings') || Boolean(node.querySelector('.vela-dialog--settings'))),
    ));
    if (settingsWasInserted) requestAnimationFrame(installSettingsActionButtons);
  }).observe(document.body, { childList: true, subtree: true });

  function openChartSettings(): void {
    const activeChart = workspace.active?.chart ?? workspace.chart;
    try {
      activeChart.renderer.setSettingsVisibility({ hidden: [] });
      activeChart.renderer.openSettings();
      requestAnimationFrame(installSettingsActionButtons);
    } catch (error) {
      console.error('Could not open chart settings:', error);
      workspace.toast('Could not open chart settings. Please try again.', 'error');
    }
  }

  return { openChartSettings };
}
