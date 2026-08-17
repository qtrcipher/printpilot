// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOsk, OSK_ROWS, shiftedKey, type Osk } from '../src/renderer/osk';

function press(element: Element, type = 'pointerdown'): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

function charKey(osk: Osk, text: string): HTMLElement {
  const node = osk.element.querySelector(`[data-text="${text}"]`);
  expect(node, `missing key ${text}`).not.toBeNull();
  return node as HTMLElement;
}

describe('on-screen keyboard layout model', () => {
  it('lays out QWERTY rows + numbers', () => {
    expect(OSK_ROWS).toEqual(['1234567890-=', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']);
  });

  it('shift uppercases letters and maps symbols', () => {
    expect(shiftedKey('a', false)).toBe('a');
    expect(shiftedKey('a', true)).toBe('A');
    expect(shiftedKey('1', true)).toBe('!');
    expect(shiftedKey('-', true)).toBe('_');
    expect(shiftedKey('=', true)).toBe('+');
    expect(shiftedKey('q', true)).toBe('Q');
  });
});

describe('on-screen keyboard behavior', () => {
  let osk: Osk;
  let deps: {
    onText: ReturnType<typeof vi.fn<(text: string) => void>>;
    onSpecialKey: ReturnType<typeof vi.fn<(key: 'backspace' | 'enter') => void>>;
    onDismiss: ReturnType<typeof vi.fn<() => void>>;
  };

  beforeEach(() => {
    deps = { onText: vi.fn(), onSpecialKey: vi.fn(), onDismiss: vi.fn() };
    osk = createOsk(deps);
    document.body.replaceChildren(osk.element);
  });

  it('emits characters on pointer press without taking focus', () => {
    const event = press(charKey(osk, 'q'));
    expect(deps.onText).toHaveBeenCalledWith('q');
    expect(event.defaultPrevented).toBe(true); // guest text field keeps DOM focus
  });

  it('shift toggles letter case and shifted symbols', () => {
    expect(osk.shifted).toBe(false);
    press(osk.element.querySelector('#osk-shift')!);
    expect(osk.shifted).toBe(true);
    expect(charKey(osk, 'a').textContent).toBe('A');
    expect(charKey(osk, '1').textContent).toBe('!');
    press(charKey(osk, 'a'));
    expect(deps.onText).toHaveBeenCalledWith('A');
    press(charKey(osk, '1'));
    expect(deps.onText).toHaveBeenCalledWith('!');

    press(osk.element.querySelector('#osk-shift')!); // toggle back off
    expect(osk.shifted).toBe(false);
    press(charKey(osk, 'a'));
    expect(deps.onText).toHaveBeenCalledWith('a');
  });

  it('space emits a space character', () => {
    press(osk.element.querySelector('#osk-space')!);
    expect(deps.onText).toHaveBeenCalledWith(' ');
  });

  it('backspace and enter are special keys, dismiss reports up', () => {
    press(osk.element.querySelector('#osk-backspace')!);
    expect(deps.onSpecialKey).toHaveBeenCalledWith('backspace');
    press(osk.element.querySelector('#osk-enter')!);
    expect(deps.onSpecialKey).toHaveBeenCalledWith('enter');
    press(osk.element.querySelector('#osk-dismiss')!);
    expect(deps.onDismiss).toHaveBeenCalledOnce();
    expect(deps.onText).not.toHaveBeenCalled();
  });

  it('keyboard activation (Enter/Space on a focused key) also emits', () => {
    charKey(osk, 'z').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    charKey(osk, 'z').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }));
    expect(deps.onText).toHaveBeenCalledTimes(1);
    expect(deps.onText).toHaveBeenCalledWith('z');
  });

  it('starts hidden; setVisible toggles the hidden attribute', () => {
    expect(osk.visible).toBe(false);
    expect(osk.element.hidden).toBe(true);
    osk.setVisible(true);
    expect(osk.element.hidden).toBe(false);
  });

  it('every key is a real button with an accessible name', () => {
    const buttons = [...osk.element.querySelectorAll('button')];
    // 38 char keys + shift + backspace + space + enter + dismiss
    expect(buttons).toHaveLength(38 + 5);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
    expect(osk.element.getAttribute('role')).toBe('group');
    expect(osk.element.getAttribute('aria-label')).toBe('On-screen keyboard');
  });
});
