export type TopPanelMode = 'classic' | 'large';

const STORAGE_KEY = 'omega_top_panel_mode';

export function getTopPanelMode(): TopPanelMode {
  return localStorage.getItem(STORAGE_KEY) === 'large' ? 'large' : 'classic';
}

export function applyTopPanelMode(mode: TopPanelMode): void {
  document.documentElement.dataset.topPanelMode = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  window.velaDiagnostics?.record({
    source: 'top-panel', type: 'appearance', name: 'mode', status: 'ok', message: mode,
  });
}
