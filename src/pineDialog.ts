/**
 * In-app replacements for `window.prompt()` / `window.confirm()`.
 *
 * Electron renderers do not implement `prompt()` — calling it throws
 * "prompt() is not supported." — so any click handler that relies on it fails
 * silently. These helpers render a small modal dialog in the page instead and
 * resolve a promise with the user's answer.
 */

export interface PinePromptOptions {
  title: string;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return an error message to keep the dialog open, or null when valid. */
  validate?: (value: string) => string | null;
}

export interface PineConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

let dialogSequence = 0;
let activeDialog: HTMLElement | null = null;

function nextId(): string {
  dialogSequence += 1;
  return `pine-dialog-${dialogSequence}`;
}

function createButton(label: string, type: 'button' | 'submit', primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = type;
  button.className = primary ? 'pine-dialog-button primary' : 'pine-dialog-button';
  button.textContent = label;
  return button;
}

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.hasAttribute('disabled') && element.offsetParent !== null);
}

function openModal(dialog: HTMLElement, onDismiss: () => void): { dispose: () => void } {
  const backdrop = document.createElement('div');
  backdrop.className = 'pine-dialog-backdrop';
  backdrop.append(dialog);
  activeDialog = backdrop;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = tabbableElements(dialog);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (!dialog.contains(current)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  backdrop.addEventListener('pointerdown', event => {
    if (event.target === backdrop) onDismiss();
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.body.append(backdrop);

  return {
    dispose: () => {
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
      if (activeDialog === backdrop) activeDialog = null;
      previousFocus?.focus();
    },
  };
}

/**
 * Asks the user for a single line of text. Resolves to the trimmed value, or
 * null when the dialog was cancelled.
 */
export function promptForText(options: PinePromptOptions): Promise<string | null> {
  if (activeDialog) return Promise.resolve(null);

  return new Promise<string | null>(resolve => {
    const titleId = nextId();
    const inputId = nextId();

    const dialog = document.createElement('form');
    dialog.className = 'pine-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.noValidate = true;

    const title = document.createElement('h2');
    title.className = 'pine-dialog-title';
    title.id = titleId;
    title.textContent = options.title;
    dialog.append(title);

    if (options.message) {
      const message = document.createElement('p');
      message.className = 'pine-dialog-message';
      message.textContent = options.message;
      dialog.append(message);
    }

    const field = document.createElement('label');
    field.className = 'pine-dialog-field';
    field.htmlFor = inputId;
    field.textContent = options.label ?? 'Name';

    const input = document.createElement('input');
    input.className = 'pine-dialog-input';
    input.id = inputId;
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = options.value ?? '';
    input.placeholder = options.placeholder ?? '';
    field.append(input);
    dialog.append(field);

    const error = document.createElement('p');
    error.className = 'pine-dialog-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    dialog.append(error);

    const actions = document.createElement('div');
    actions.className = 'pine-dialog-actions';
    const cancel = createButton(options.cancelLabel ?? 'Cancel', 'button', false);
    const confirm = createButton(options.confirmLabel ?? 'OK', 'submit', true);
    actions.append(cancel, confirm);
    dialog.append(actions);

    let settled = false;
    let dispose = (): void => {};
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      dispose();
      resolve(value);
    };

    const modal = openModal(dialog, () => finish(null));
    dispose = modal.dispose;

    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      const problem = options.validate?.(value) ?? null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.focus();
        input.select();
        return;
      }
      finish(value);
    });

    input.focus();
    input.select();
  });
}

/** Asks the user to confirm an action. Resolves to true when confirmed. */
export function confirmAction(options: PineConfirmOptions): Promise<boolean> {
  if (activeDialog) return Promise.resolve(false);

  return new Promise<boolean>(resolve => {
    const titleId = nextId();

    const dialog = document.createElement('div');
    dialog.className = 'pine-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);

    const title = document.createElement('h2');
    title.className = 'pine-dialog-title';
    title.id = titleId;
    title.textContent = options.title;
    dialog.append(title);

    const message = document.createElement('p');
    message.className = 'pine-dialog-message';
    message.textContent = options.message;
    dialog.append(message);

    const actions = document.createElement('div');
    actions.className = 'pine-dialog-actions';
    const cancel = createButton(options.cancelLabel ?? 'Cancel', 'button', false);
    const confirm = createButton(options.confirmLabel ?? 'Confirm', 'button', true);
    if (options.destructive) confirm.classList.add('destructive');
    actions.append(cancel, confirm);
    dialog.append(actions);

    let settled = false;
    let dispose = (): void => {};
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      dispose();
      resolve(value);
    };

    const modal = openModal(dialog, () => finish(false));
    dispose = modal.dispose;

    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));

    (options.destructive ? cancel : confirm).focus();
  });
}
