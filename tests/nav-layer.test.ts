import { describe, expect, it } from 'vitest';
import {
  mapKeyToNavEvent,
  NavEventBus,
  SyntheticInputSource,
  type NavEvent,
} from '../src/preload/nav-layer';

function collect(source: SyntheticInputSource): NavEvent[] {
  const events: NavEvent[] = [];
  source.onEvent((e) => events.push(e));
  return events;
}

describe('mapKeyToNavEvent', () => {
  it('maps arrow keys to moves', () => {
    expect(mapKeyToNavEvent('ArrowUp')).toEqual({ type: 'move', direction: 'up' });
    expect(mapKeyToNavEvent('ArrowDown')).toEqual({ type: 'move', direction: 'down' });
    expect(mapKeyToNavEvent('ArrowLeft')).toEqual({ type: 'move', direction: 'left' });
    expect(mapKeyToNavEvent('ArrowRight')).toEqual({ type: 'move', direction: 'right' });
  });

  it('maps Enter to activate and Escape to back', () => {
    expect(mapKeyToNavEvent('Enter')).toEqual({ type: 'activate' });
    expect(mapKeyToNavEvent('Escape')).toEqual({ type: 'back' });
  });

  it('ignores unrelated keys', () => {
    expect(mapKeyToNavEvent('a')).toBeNull();
    expect(mapKeyToNavEvent('Tab')).toBeNull();
    expect(mapKeyToNavEvent(' ')).toBeNull();
  });
});

describe('SyntheticInputSource', () => {
  it('delivers emitted events to subscribers while started', () => {
    const source = new SyntheticInputSource();
    const events = collect(source);
    source.start();
    source.emit({ type: 'move', direction: 'down' });
    source.emit({ type: 'activate' });
    expect(events).toEqual([
      { type: 'move', direction: 'down' },
      { type: 'activate' },
    ]);
  });

  it('drops events while stopped', () => {
    const source = new SyntheticInputSource();
    const events = collect(source);
    source.emit({ type: 'back' }); // never started
    source.start();
    source.stop();
    source.emit({ type: 'back' }); // stopped again
    expect(events).toEqual([]);
  });

  it('supports multiple subscribers', () => {
    const source = new SyntheticInputSource();
    const first = collect(source);
    const second = collect(source);
    source.start();
    source.emit({ type: 'back' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

describe('NavEventBus', () => {
  it('fans events from all sources into one stream', () => {
    const keyboard = new SyntheticInputSource();
    const gamepad = new SyntheticInputSource();
    const bus = new NavEventBus([keyboard, gamepad]);
    const events: NavEvent[] = [];
    bus.onEvent((e) => events.push(e));

    bus.start();
    keyboard.emit({ type: 'move', direction: 'left' });
    gamepad.emit({ type: 'activate' });
    expect(events).toEqual([{ type: 'move', direction: 'left' }, { type: 'activate' }]);
  });

  it('stops all underlying sources', () => {
    const source = new SyntheticInputSource();
    const bus = new NavEventBus([source]);
    const events: NavEvent[] = [];
    bus.onEvent((e) => events.push(e));

    bus.start();
    bus.stop();
    source.emit({ type: 'activate' });
    expect(events).toEqual([]);
  });
});
