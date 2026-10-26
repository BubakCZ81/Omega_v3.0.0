import {
  closeColorPopover,
  isPopoverOpen,
  openPopoverTrigger,
} from '@luxalgo/vela/ui';

export function shouldDismissColorPicker(
  isOpen: boolean,
  isColorPicker: boolean,
  clickedInside: boolean,
): boolean {
  return isOpen && isColorPicker && !clickedInside;
}

export function initializeColorPickerDismissal(): () => void {
  const onOutsidePointerDown = (event: PointerEvent): void => {
    const trigger = openPopoverTrigger();
    if (!isPopoverOpen() || !trigger?.classList.contains('vela-color-field')) return;

    const target = event.target;
    const popover = document.querySelector('.vela-color-field-pop');
    const clickedInside = target instanceof Node
      && (trigger.contains(target) || Boolean(popover?.contains(target)));
    if (shouldDismissColorPicker(true, true, clickedInside)) closeColorPopover();
  };

  document.addEventListener('pointerdown', onOutsidePointerDown, true);
  return () => document.removeEventListener('pointerdown', onOutsidePointerDown, true);
}
