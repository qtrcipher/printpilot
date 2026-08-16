// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_GAMEPAD_MAPPING, resolveGamepadMapping } from '../src/main/settings';
import {
  GamepadInputSource,
  KeyboardInputSource,
  type GamepadLike,
  type NavEvent,
} from '../src/preload/nav-layer';

function pad(init: { buttons?: Record<number, boolean>; axes?: number[] }): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: init.buttons?.[i] ?? false }));
  return { buttons, axes: init.axes ?? [0, 0, 0, 0] };
}

function gamepadRig(mapping = DEFAULT_GAMEPAD_MAPPING) {
  let current: GamepadLike | null = null;
  let now = 0;
  const source = new GamepadInputSource(window, {
    getGamepads: () => [current],
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    now: () => now,
    mapping,
  });
  const events: NavEvent[] = [];
  source.onEvent((e) => events.push(e));
  source.start();
  return {
    events,
    setPad: (p: GamepadLike | null) => {
      current = p;
    },
    poll: (at: number) => {
      now = at;
      source.poll();
    },
  };
}

describe('GamepadInputSource with a custom mapping', () => {
  it('uses the remapped button for activate and ignores the default one', () => {
    const rig = gamepadRig(resolveGamepadMapping({ activate: { kind: 'button', index: 7 } }));
    rig.setPad(pad({ buttons: { 0: true } })); // old default — no longer activate
    rig.poll(0);
    expect(rig.events).toEqual([]);

    rig.setPad(pad({ buttons: { 7: true } }));
    rig.poll(10);
    expect(rig.events).toEqual([{ type: 'activate' }]);
  });

  it('supports button-bound directions while unmapped directions stay on the stick', () => {
    const rig = gamepadRig(resolveGamepadMapping({ up: { kind: 'button', index: 5 } }));
    rig.setPad(pad({ buttons: { 5: true } }));
    rig.poll(0);
    expect(rig.events).toEqual([{ type: 'move', direction: 'up' }]);

    // Unmapped action falls back: stick-down still works.
    rig.setPad(pad({ axes: [0, 0.9, 0, 0] }));
    rig.poll(10);
    expect(rig.events[1]).toEqual({ type: 'move', direction: 'down' });

    // ...but stick-up no longer maps up (custom overrides the default).
    rig.setPad(pad({ axes: [0, -0.9, 0, 0] }));
    rig.poll(20);
    expect(rig.events).toHaveLength(2);
  });

  it('supports axis-bound activate with deadzone semantics', () => {
    const rig = gamepadRig(resolveGamepadMapping({ activate: { kind: 'axis', axis: 2, sign: 1 } }));
    rig.setPad(pad({ axes: [0, 0, 0.2, 0] })); // below deadzone
    rig.poll(0);
    expect(rig.events).toEqual([]);
    rig.setPad(pad({ axes: [0, 0, 0.9, 0] }));
    rig.poll(10);
    expect(rig.events).toEqual([{ type: 'activate' }]);
  });

  it('keeps the standard D-pad working under any mapping', () => {
    const rig = gamepadRig(resolveGamepadMapping({ left: { kind: 'button', index: 4 } }));
    rig.setPad(pad({ buttons: { 14: true } })); // D-pad left
    rig.poll(0);
    expect(rig.events).toEqual([{ type: 'move', direction: 'left' }]);
  });
});

describe('KeyboardInputSource key overrides', () => {
  function keyRig(keyMap: Record<string, NavEvent>) {
    const source = new KeyboardInputSource(window, keyMap);
    const events: NavEvent[] = [];
    source.onEvent((e) => events.push(e));
    source.start();
    return { events, press: (key: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key })) };
  }

  it('maps a saved key binding to its nav event', () => {
    const rig = keyRig({ x: { type: 'activate' } });
    rig.press('x');
    expect(rig.events).toEqual([{ type: 'activate' }]);
  });

  it('key overrides win over the built-in scheme', () => {
    const rig = keyRig({ Enter: { type: 'back' } });
    rig.press('Enter');
    expect(rig.events).toEqual([{ type: 'back' }]);
  });

  it('leaves unmapped keys to the built-in scheme', () => {
    const rig = keyRig({ x: { type: 'activate' } });
    rig.press('ArrowUp');
    expect(rig.events).toEqual([{ type: 'move', direction: 'up' }]);
  });
});
