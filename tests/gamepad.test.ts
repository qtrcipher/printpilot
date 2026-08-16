// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  GAMEPAD_DEADZONE,
  GAMEPAD_REPEAT_MS,
  GamepadInputSource,
  type GamepadLike,
  type NavEvent,
} from '../src/preload/nav-layer';

function pad(init: { buttons?: Record<number, boolean>; axes?: number[] }): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: init.buttons?.[i] ?? false }));
  return { buttons, axes: init.axes ?? [0, 0, 0, 0] };
}

interface Rig {
  source: GamepadInputSource;
  events: NavEvent[];
  setPad(p: GamepadLike | null): void;
  poll(at: number): void;
}

function makeRig(): Rig {
  let current: GamepadLike | null = null;
  let now = 0;
  const source = new GamepadInputSource(window, {
    getGamepads: () => [current],
    requestFrame: () => 1, // frames never fire — tests poll manually
    cancelFrame: () => undefined,
    now: () => now,
  });
  const events: NavEvent[] = [];
  source.onEvent((e) => events.push(e));
  source.start();
  return {
    source,
    events,
    setPad: (p) => {
      current = p;
    },
    poll: (at) => {
      now = at;
      source.poll();
    },
  };
}

describe('GamepadInputSource', () => {
  it('maps D-pad presses to move events on the rising edge', () => {
    const rig = makeRig();
    rig.setPad(pad({ buttons: { 13: true } })); // D-pad down
    rig.poll(0);
    rig.poll(10); // held — no repeat before 150ms
    expect(rig.events).toEqual([{ type: 'move', direction: 'down' }]);
  });

  it('repeats a held direction every ~150ms', () => {
    const rig = makeRig();
    rig.setPad(pad({ buttons: { 15: true } })); // D-pad right
    rig.poll(0);
    rig.poll(GAMEPAD_REPEAT_MS - 1);
    rig.poll(GAMEPAD_REPEAT_MS);
    rig.poll(GAMEPAD_REPEAT_MS * 2);
    expect(rig.events).toEqual([
      { type: 'move', direction: 'right' },
      { type: 'move', direction: 'right' },
      { type: 'move', direction: 'right' },
    ]);
  });

  it('maps the left stick beyond the deadzone, dominant axis wins', () => {
    const rig = makeRig();
    rig.setPad(pad({ axes: [0.2, 0.2, 0, 0] })); // below deadzone → nothing
    rig.poll(0);
    expect(rig.events).toEqual([]);

    rig.setPad(pad({ axes: [0.9, 0.5, 0, 0] }));
    rig.poll(10);
    expect(rig.events).toEqual([{ type: 'move', direction: 'right' }]);

    rig.setPad(pad({ axes: [-0.5, -0.9, 0, 0] })); // direction change → immediate
    rig.poll(20);
    expect(rig.events[1]).toEqual({ type: 'move', direction: 'up' });
  });

  it('respects the configured deadzone boundary', () => {
    const rig = makeRig();
    rig.setPad(pad({ axes: [GAMEPAD_DEADZONE - 0.01, 0, 0, 0] }));
    rig.poll(0);
    expect(rig.events).toEqual([]);
    rig.setPad(pad({ axes: [GAMEPAD_DEADZONE + 0.01, 0, 0, 0] }));
    rig.poll(10);
    expect(rig.events).toEqual([{ type: 'move', direction: 'right' }]);
  });

  it('maps button 0 (A) to activate and button 1 (B) to back, once per press', () => {
    const rig = makeRig();
    rig.setPad(pad({ buttons: { 0: true } }));
    rig.poll(0);
    rig.poll(200); // held — no repeat for buttons
    expect(rig.events).toEqual([{ type: 'activate' }]);

    rig.setPad(pad({ buttons: { 1: true } }));
    rig.poll(300);
    rig.poll(400);
    expect(rig.events).toEqual([{ type: 'activate' }, { type: 'back' }]);
  });

  it('emits nothing without a connected pad', () => {
    const rig = makeRig();
    rig.setPad(null);
    rig.poll(0);
    rig.poll(500);
    expect(rig.events).toEqual([]);
  });

  it('resets held state on stop', () => {
    const rig = makeRig();
    rig.setPad(pad({ buttons: { 0: true } }));
    rig.poll(0);
    rig.source.stop();
    rig.source.start();
    rig.poll(200); // still held — treated as a fresh press after restart
    expect(rig.events).toEqual([{ type: 'activate' }, { type: 'activate' }]);
  });
});
