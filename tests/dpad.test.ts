// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GAMEPAD_REPEAT_MS, type NavEvent } from '../src/preload/nav-layer';
import { createDPad } from '../src/renderer/dpad';

function fire(element: Element, type: string): void {
  element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

describe('on-screen D-pad', () => {
  let events: NavEvent[];
  let pad: ReturnType<typeof createDPad>;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    pad = createDPad({ onEvent: (e) => events.push(e) });
    document.body.replaceChildren(pad.element);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function button(id: string): HTMLElement {
    const node = pad.element.querySelector(`#${id}`);
    expect(node).not.toBeNull();
    return node as HTMLElement;
  }

  it('maps each arrow button to the same NavEvent as the keyboard arrows', () => {
    fire(button('nav-pad-up'), 'pointerdown');
    fire(button('nav-pad-up'), 'pointerup');
    fire(button('nav-pad-down'), 'pointerdown');
    fire(button('nav-pad-down'), 'pointerup');
    fire(button('nav-pad-left'), 'pointerdown');
    fire(button('nav-pad-left'), 'pointerup');
    fire(button('nav-pad-right'), 'pointerdown');
    fire(button('nav-pad-right'), 'pointerup');
    expect(events).toEqual([
      { type: 'move', direction: 'up' },
      { type: 'move', direction: 'down' },
      { type: 'move', direction: 'left' },
      { type: 'move', direction: 'right' },
    ]);
  });

  it('maps OK to activate and Back to back, single-shot (no repeat)', () => {
    fire(button('nav-pad-ok'), 'pointerdown');
    fire(button('nav-pad-back'), 'pointerdown');
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS * 5);
    expect(events).toEqual([{ type: 'activate' }, { type: 'back' }]);
  });

  it('repeats a held direction at the gamepad cadence (~150ms)', () => {
    fire(button('nav-pad-down'), 'pointerdown');
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS - 1);
    expect(events).toHaveLength(1); // immediate press only
    vi.advanceTimersByTime(1);
    expect(events).toHaveLength(2);
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS * 2);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.type === 'move' && e.direction === 'down')).toBe(true);
  });

  it.each(['pointerup', 'pointerleave', 'pointercancel'])('stops repeating on %s', (type) => {
    fire(button('nav-pad-right'), 'pointerdown');
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS);
    fire(button('nav-pad-right'), type);
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS * 5);
    expect(events).toHaveLength(2); // press + one repeat, then stopped
  });

  it('emits a single shot on keyboard activation (Enter / Space)', () => {
    const ok = button('nav-pad-ok');
    ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    ok.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
    ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS * 3);
    expect(events).toEqual([{ type: 'activate' }, { type: 'activate' }]);
  });

  it('hides and stops repeating when set invisible', () => {
    pad.setVisible(true);
    expect(pad.element.hidden).toBe(false);
    fire(button('nav-pad-left'), 'pointerdown');
    pad.setVisible(false);
    expect(pad.element.hidden).toBe(true);
    vi.advanceTimersByTime(GAMEPAD_REPEAT_MS * 3);
    expect(events).toHaveLength(1); // repeat was cancelled with visibility
  });

  it('exposes real buttons with aria-labels (tab order + focus ring intact)', () => {
    const buttons = [...pad.element.querySelectorAll('button')];
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.tabIndex).toBe(0); // default: in tab order
    }
  });
});
