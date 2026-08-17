/**
 * On-screen keyboard for text entry inside the embedded printer page
 * (Wi-Fi passwords, email addresses, PINs — the dead panel's virtual
 * keyboard, in-app). Character keys emit text, Backspace/Enter emit special
 * keys; the control view delivers them via webview.insertText /
 * sendInputEvent — deliberately NOT through the nav-layer NavEvent path
 * (this is text entry, not navigation).
 *
 * Buttons never take focus on pointer press (pointerdown + preventDefault),
 * so clicking a key does not blur the guest's text field.
 */

export type OskSpecialKey = 'backspace' | 'enter';

export interface OskDeps {
  onText(text: string): void;
  onSpecialKey(key: OskSpecialKey): void;
  onDismiss(): void;
}

export interface Osk {
  element: HTMLElement;
  readonly visible: boolean;
  readonly shifted: boolean;
  setVisible(visible: boolean): void;
}

/** Character rows of the layout (shift row excluded — it holds modifiers). */
export const OSK_ROWS: readonly string[] = ['1234567890-=', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** Shifted symbols for non-letter keys; letters uppercase. */
export const SHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
};

/** The text a key produces in the given shift state. */
export function shiftedKey(key: string, shifted: boolean): string {
  if (!shifted) return key;
  return SHIFTED_SYMBOLS[key] ?? key.toUpperCase();
}

export function createOsk(deps: OskDeps): Osk {
  const board = document.createElement('div');
  board.id = 'osk';
  board.className = 'osk';
  board.setAttribute('role', 'group');
  board.setAttribute('aria-label', 'On-screen keyboard');
  board.hidden = true;

  let visible = false;
  let shifted = false;
  const charButtons: HTMLButtonElement[] = [];
  let shiftButton: HTMLButtonElement | null = null;

  function makeButton(text: string, ariaLabel: string, id?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'osk__key';
    button.textContent = text;
    button.setAttribute('aria-label', ariaLabel);
    if (id) button.id = id;
    return button;
  }

  /** Pointer press activates without moving DOM focus off the text field. */
  function onPress(button: HTMLButtonElement, act: () => void): void {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      act();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        act();
      }
    });
  }

  function refreshShift(): void {
    for (const button of charButtons) {
      const base = button.dataset.text ?? '';
      const text = shiftedKey(base, shifted);
      button.textContent = text;
      button.setAttribute('aria-label', `Insert ${text}`);
    }
    shiftButton?.setAttribute('aria-pressed', String(shifted));
  }

  // Character rows.
  for (const rowKeys of OSK_ROWS) {
    const row = document.createElement('div');
    row.className = 'osk__row';
    if (rowKeys === 'zxcvbnm') {
      shiftButton = makeButton('⇧', 'Shift', 'osk-shift');
      shiftButton.classList.add('osk__key--wide');
      onPress(shiftButton, () => {
        shifted = !shifted;
        refreshShift();
      });
      row.append(shiftButton);
    }
    for (const key of rowKeys) {
      const button = makeButton(key, `Insert ${key}`);
      button.dataset.text = key;
      onPress(button, () => deps.onText(shiftedKey(key, shifted)));
      charButtons.push(button);
      row.append(button);
    }
    if (rowKeys === 'zxcvbnm') {
      const backspace = makeButton('⌫', 'Backspace', 'osk-backspace');
      backspace.classList.add('osk__key--wide');
      onPress(backspace, () => deps.onSpecialKey('backspace'));
      row.append(backspace);
    }
    board.append(row);
  }

  // Bottom row: space, enter, dismiss.
  const bottomRow = document.createElement('div');
  bottomRow.className = 'osk__row';
  const space = makeButton('space', 'Space', 'osk-space');
  space.classList.add('osk__key--space');
  onPress(space, () => deps.onText(' '));
  const enter = makeButton('↵', 'Enter', 'osk-enter');
  enter.classList.add('osk__key--wide');
  onPress(enter, () => deps.onSpecialKey('enter'));
  const dismiss = makeButton('✕', 'Dismiss keyboard', 'osk-dismiss');
  dismiss.classList.add('osk__key--wide');
  onPress(dismiss, () => deps.onDismiss());
  bottomRow.append(space, enter, dismiss);
  board.append(bottomRow);

  return {
    element: board,
    get visible() {
      return visible;
    },
    get shifted() {
      return shifted;
    },
    setVisible(next: boolean) {
      visible = next;
      board.hidden = !next;
    },
  };
}
