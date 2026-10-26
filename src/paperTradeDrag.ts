const STORAGE_KEY = 'omega-paper-trade-pos';

export function initializePaperTradeDrag(): void {
  const widget = document.getElementById('chart-paper-trade-controls');
  const coordinateRoot = document.getElementById('app-container');
  if (!widget) return;

  const getCoordinateSpace = () => {
    const rect = coordinateRoot?.getBoundingClientRect();
    if (!rect) return { left: 0, top: 0, scaleX: 1, scaleY: 1 };
    return {
      left: rect.left,
      top: rect.top,
      scaleX: coordinateRoot?.offsetWidth && coordinateRoot.offsetWidth > 0 ? rect.width / coordinateRoot.offsetWidth : 1,
      scaleY: coordinateRoot?.offsetHeight && coordinateRoot.offsetHeight > 0 ? rect.height / coordinateRoot.offsetHeight : 1,
    };
  };

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const pos = JSON.parse(saved);
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        const { scaleX, scaleY } = getCoordinateSpace();
        const legacyPosition = pos.coordinateSpace !== 'app';
        widget.style.position = 'fixed';
        widget.style.left = `${legacyPosition ? pos.x / scaleX : pos.x}px`;
        widget.style.top = `${legacyPosition ? pos.y / scaleY : pos.y}px`;
        widget.style.transform = 'none';
      }
    } catch (error) {
      console.warn('Could not restore the paper-trade panel position:', error);
    }
  }

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let scaleX = 1;
  let scaleY = 1;
  let initialLeft = 0;
  let initialTop = 0;
  let pointerId: number | null = null;

  const startDrag = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('button, input, select, textarea, a, label')) return;
    if (event.button !== 0 || isDragging) return;
    isDragging = true;
    pointerId = event.pointerId;
    const rect = widget.getBoundingClientRect();
    const coordinateSpace = getCoordinateSpace();
    scaleX = coordinateSpace.scaleX || 1;
    scaleY = coordinateSpace.scaleY || 1;
    widget.style.position = 'fixed';
    widget.style.transform = 'none';
    initialLeft = (rect.left - coordinateSpace.left) / scaleX;
    initialTop = (rect.top - coordinateSpace.top) / scaleY;
    widget.style.left = `${initialLeft}px`;
    widget.style.top = `${initialTop}px`;
    startX = event.clientX;
    startY = event.clientY;
    try {
      widget.setPointerCapture(event.pointerId);
    } catch {
      // Global listeners below remain reliable if pointer capture is unavailable.
    }
    event.preventDefault();
    event.stopPropagation();
  };
  widget.addEventListener('pointerdown', startDrag);

  const moveDrag = (event: PointerEvent) => {
    if (!isDragging || event.pointerId !== pointerId) return;
    const coordinateSpace = getCoordinateSpace();
    const dx = (event.clientX - startX) / scaleX;
    const dy = (event.clientY - startY) / scaleY;
    const minLeft = (10 - coordinateSpace.left) / scaleX;
    const minTop = (40 - coordinateSpace.top) / scaleY;
    const maxLeft = (window.innerWidth - coordinateSpace.left) / scaleX - widget.offsetWidth - 10;
    const maxTop = (window.innerHeight - coordinateSpace.top) / scaleY - widget.offsetHeight - 10;
    widget.style.left = `${Math.max(minLeft, Math.min(maxLeft, initialLeft + dx))}px`;
    widget.style.top = `${Math.max(minTop, Math.min(maxTop, initialTop + dy))}px`;
    event.preventDefault();
  };

  const stopDrag = (event?: PointerEvent) => {
    if (!isDragging || (event && event.pointerId !== pointerId)) return;
    isDragging = false;
    if (pointerId !== null) {
      try {
        widget.releasePointerCapture(pointerId);
      } catch {
        // The pointer may already have been released.
      }
    }
    pointerId = null;
    const rect = widget.getBoundingClientRect();
    const coordinateSpace = getCoordinateSpace();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      x: (rect.left - coordinateSpace.left) / coordinateSpace.scaleX,
      y: (rect.top - coordinateSpace.top) / coordinateSpace.scaleY,
      coordinateSpace: 'app',
    }));
  };

  window.addEventListener('pointermove', moveDrag, { passive: false });
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
  window.addEventListener('blur', () => stopDrag());
}
