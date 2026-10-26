interface PriceWindow {
  min: number;
  max: number;
  log?: boolean;
}

interface PricePane {
  kind: string;
  scale: PriceWindow;
  manualScale: PriceWindow | null;
}

interface PriceBarRatioRenderer {
  name: string;
  scene: { panes: Map<string, PricePane> };
  coords: { barCount: number; getViewport: () => { barSpacing: number } };
  scaleDragHolder: PricePane | null;
  scaleDragStart: PriceWindow | null;
  beginPriceScale: (x: number, y: number) => void;
  priceScaleBy: (dy: number) => void;
  onViewportChange: (callback: (range: { from: number; to: number }) => void) => () => void;
  getVisibleRange: () => { from: number; to: number } | null;
  setVisibleRange: (range: { from: number; to: number }) => void;
  readFeature: (feature: string) => unknown;
  applyFeature: (feature: string, value: unknown) => void;
}

interface RendererControl {
  renderer?: unknown;
}

export interface PriceBarRatioController {
  setEnabled(enabled: boolean): void;
}

const pricePaneId = 'price';
const controllers = new WeakMap<PriceBarRatioRenderer, PriceBarRatioController>();

function scaleSpan(scale: PriceWindow): number {
  if (scale.log && scale.min > 0 && scale.max > 0) return Math.log(scale.max) - Math.log(scale.min);
  return scale.max - scale.min;
}

function resizeScale(scale: PriceWindow, factor: number): PriceWindow | null {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (scale.log && scale.min > 0 && scale.max > 0) {
    const center = (Math.log(scale.min) + Math.log(scale.max)) / 2;
    const halfSpan = scaleSpan(scale) * factor / 2;
    return { ...scale, min: Math.exp(center - halfSpan), max: Math.exp(center + halfSpan) };
  }
  const center = (scale.min + scale.max) / 2;
  const halfSpan = scaleSpan(scale) * factor / 2;
  return { ...scale, min: center - halfSpan, max: center + halfSpan };
}

export function createPriceBarRatioController(rendererControl: unknown): PriceBarRatioController {
  const renderer = (rendererControl as RendererControl | null)?.renderer as PriceBarRatioRenderer | undefined;
  if (!renderer
    || renderer.name !== 'native'
    || !renderer.scene?.panes
    || !renderer.coords?.getViewport
    || !renderer.getVisibleRange
    || !renderer.setVisibleRange
    || !renderer.beginPriceScale
    || !renderer.priceScaleBy
    || !renderer.onViewportChange
    || !renderer.readFeature
    || !renderer.applyFeature) {
    throw new Error('Lock price to bar ratio requires the native Vela chart renderer.');
  }

  const existing = controllers.get(renderer);
  if (existing) return existing;

  const originalBeginPriceScale = renderer.beginPriceScale;
  const originalPriceScaleBy = renderer.priceScaleBy;
  let enabled = false;
  let syncing = false;
  let lastBarSpacing = renderer.coords.getViewport().barSpacing;
  let gestureStartRange: { from: number; to: number } | null = null;
  const pricePane = renderer.scene.panes.get(pricePaneId);

  if (!pricePane) throw new Error('The native Vela renderer has no price scale.');

  const freezeCurrentScale = (): boolean => {
    if (renderer.coords.barCount === 0 || pricePane.manualScale !== null) return false;
    const span = scaleSpan(pricePane.scale);
    if (!Number.isFinite(span) || span <= 0) return false;
    pricePane.manualScale = { ...pricePane.scale };
    renderer.applyFeature('logScale', renderer.readFeature('logScale'));
    return true;
  };

  renderer.beginPriceScale = function (x, y): void {
    originalBeginPriceScale.call(this, x, y);
    gestureStartRange = this.getVisibleRange();
  };

  renderer.priceScaleBy = function (dy): void {
    originalPriceScaleBy.call(this, dy);
    if (!enabled || syncing || this.scaleDragHolder !== pricePane || !this.scaleDragStart) return;

    const currentScale = pricePane.manualScale ?? pricePane.scale;
    const initialSpan = scaleSpan(this.scaleDragStart);
    const currentSpan = scaleSpan(currentScale);
    if (initialSpan <= 0 || currentSpan <= 0) return;

    const range = gestureStartRange;
    if (!range) return;
    const factor = currentSpan / initialSpan;
    const center = (range.from + range.to) / 2;
    const halfSpan = (range.to - range.from) * factor / 2;
    syncing = true;
    try {
      this.setVisibleRange({ from: center - halfSpan, to: center + halfSpan });
      lastBarSpacing = this.coords.getViewport().barSpacing;
    } finally {
      syncing = false;
    }
  };

  renderer.onViewportChange(() => {
    if (!enabled || syncing) return;
    const barSpacing = renderer.coords.getViewport().barSpacing;
    if (!Number.isFinite(barSpacing) || barSpacing <= 0) return;

    if (freezeCurrentScale()) {
      lastBarSpacing = barSpacing;
      return;
    }
    if (barSpacing === lastBarSpacing) return;

    const currentScale = pricePane.manualScale ?? pricePane.scale;
    const resized = resizeScale(currentScale, lastBarSpacing / barSpacing);
    lastBarSpacing = barSpacing;
    if (!resized || !Number.isFinite(resized.min) || !Number.isFinite(resized.max)) return;

    pricePane.manualScale = resized;
    renderer.applyFeature('logScale', renderer.readFeature('logScale'));
  });

  const controller: PriceBarRatioController = {
    setEnabled(value): void {
      if (enabled === value) return;
      enabled = value;
      lastBarSpacing = renderer.coords.getViewport().barSpacing;
      if (enabled && pricePane.manualScale === null) {
        freezeCurrentScale();
      }
    },
  };

  controllers.set(renderer, controller);
  return controller;
}
