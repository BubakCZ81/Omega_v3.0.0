const STORAGE_KEY = 'omega_platform_zoom_factor';
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.3;
const STEP = 0.1;

export function initializePlatformZoom(): void {
  const zoomOut = document.getElementById('platform-zoom-out') as HTMLButtonElement | null;
  const zoomIn = document.getElementById('platform-zoom-in') as HTMLButtonElement | null;
  const valueInput = document.getElementById('platform-zoom-value') as HTMLInputElement | null;
  const savedZoom = localStorage.getItem(STORAGE_KEY);
  const parsedZoom = savedZoom === null ? 1 : Number(savedZoom);
  let zoom = Number.isFinite(parsedZoom) && parsedZoom > 0
    ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsedZoom))
    : 1;

  function updateControls(): void {
    const percent = Math.round(zoom * 100);
    if (valueInput && document.activeElement !== valueInput) valueInput.value = `${percent}%`;
    if (zoomOut) zoomOut.disabled = zoom <= MIN_ZOOM;
    if (zoomIn) zoomIn.disabled = zoom >= MAX_ZOOM;
  }

  function apply(nextZoom: number): void {
    zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom)) * 100) / 100;
    localStorage.setItem(STORAGE_KEY, String(zoom));
    updateControls();
    document.documentElement.style.setProperty('--omega-platform-scale', String(zoom));
    window.velaDiagnostics?.record({ source: 'platform-zoom', type: 'ui', name: 'ui-scale', status: 'ok', message: `${Math.round(zoom * 100)}%` });
  }

  function readInput(): number | null {
    const value = valueInput?.value.trim().replace(',', '.').replace('%', '');
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed > 5 ? parsed / 100 : parsed;
  }

  function commitInput(): void {
    const nextZoom = readInput();
    if (nextZoom === null) {
      updateControls();
      return;
    }
    apply(nextZoom);
  }

  zoomOut?.addEventListener('click', () => apply(zoom - STEP));
  zoomIn?.addEventListener('click', () => apply(zoom + STEP));
  valueInput?.addEventListener('change', commitInput);
  valueInput?.addEventListener('blur', commitInput);
  valueInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInput();
      valueInput.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      updateControls();
      valueInput.blur();
    }
  });

  updateControls();
  apply(zoom);
}
