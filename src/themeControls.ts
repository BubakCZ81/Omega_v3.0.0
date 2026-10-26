import type { VelaTheme } from '@luxalgo/vela';

export type OmegaTheme = 'dark' | 'light' | 'high-contrast' | 'high-contrast-dark';

const highContrastTheme: VelaTheme = {
  background: '#f7fbff',
  textColor: '#061a33',
  gridColor: '#9bb1c8',
  borderColor: '#183b60',
  upColor: '#0063a8',
  downColor: '#b00020',
  fontFamily: 'Arial, sans-serif',
};

const highContrastDarkTheme: VelaTheme = {
  background: '#101d30',
  textColor: '#f5f9ff',
  gridColor: '#506d91',
  borderColor: '#9bbde5',
  upColor: '#00c98d',
  downColor: '#ff6473',
  fontFamily: 'Arial, sans-serif',
};

export function isOmegaTheme(theme: unknown): theme is OmegaTheme {
  return theme === 'dark' || theme === 'light' || theme === 'high-contrast' || theme === 'high-contrast-dark';
}

export function velaTheme(theme: OmegaTheme): VelaTheme | 'dark' | 'light' {
  if (theme === 'high-contrast') return highContrastTheme;
  if (theme === 'high-contrast-dark') return highContrastDarkTheme;
  return theme;
}

export function applyThemeUi(theme: OmegaTheme): void {
  const baseTheme = theme === 'high-contrast' ? 'light' : theme === 'high-contrast-dark' ? 'dark' : theme;
  document.documentElement.dataset.theme = baseTheme;
  document.body.dataset.theme = baseTheme;
  document.documentElement.dataset.themeVariant = theme.startsWith('high-contrast') ? theme : '';
  document.body.dataset.themeVariant = theme.startsWith('high-contrast') ? theme : '';
  document.documentElement.style.colorScheme = baseTheme;
  document.body.style.backgroundColor = 'var(--omega-bg)';
}

/**
 * Applies the stored theme at startup. The picker itself lives in the chart
 * settings dialog; this keeps the document-level theme state in one place.
 */
export function initializeTheme(getTheme: () => OmegaTheme): void {
  applyThemeUi(getTheme());
}
