// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyboardInputSource, LEAVE_KEY, type NavEvent } from '../src/preload/nav-layer';

function key(
  keyName: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('KeyboardInputSource', () => {
  let source: KeyboardInputSource;
  let events: NavEvent[];

  beforeEach(() => {
    document.body.innerHTML = '';
    source = new KeyboardInputSource(window);
    events = [];
    source.onEvent((e) => events.push(e));
    source.start();
  });

  afterEach(() => {
    source.stop(); // jsdom windows persist across tests in a file
  });

  it('maps arrows, Enter, and Escape to nav events', () => {
    key('ArrowDown');
    key('ArrowUp');
    key('Enter');
    key('Escape');
    expect(events).toEqual([
      { type: 'move', direction: 'down' },
      { type: 'move', direction: 'up' },
      { type: 'activate' },
      { type: 'back' },
    ]);
  });

  it('prevents default for handled keys', () => {
    expect(key('ArrowLeft').defaultPrevented).toBe(true);
    expect(key('a').defaultPrevented).toBe(false);
  });

  it('maps Tab / Shift+Tab to sequential steps', () => {
    key('Tab');
    key('Tab', { shiftKey: true });
    expect(events).toEqual([
      { type: 'step', delta: 1 },
      { type: 'step', delta: -1 },
    ]);
  });

  it('emits leave on Ctrl+` and nothing else with modifiers', () => {
    key(LEAVE_KEY, { ctrlKey: true });
    expect(events).toEqual([{ type: 'leave' }]);
    events.length = 0;
    key('ArrowDown', { ctrlKey: true }); // browser chords pass through
    expect(events).toEqual([]);
  });

  it('leaves form fields alone except Escape', () => {
    document.body.innerHTML = `<input id="pin" type="password" />`;
    const input = document.querySelector<HTMLInputElement>('#pin')!;
    key('ArrowDown', {}, input);
    key('Enter', {}, input); // native submit must survive for the login form
    key('Tab', {}, input);
    expect(events).toEqual([]);
    key('Escape', {}, input);
    expect(events).toEqual([{ type: 'back' }]);
  });

  it('stops listening when stopped', () => {
    source.stop();
    key('ArrowDown');
    expect(events).toEqual([]);
  });
});
