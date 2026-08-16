/**
 * Navigation layer input abstraction (design doc §3 and §6).
 *
 * Keyboard and gamepad sources emit a common `NavEvent` stream; the control
 * core turns events into roving-focus moves, clicks, and back-navigation
 * inside the printer's Remote UI. Tests inject a `SyntheticInputSource`
 * instead of real hardware (house rule: no physical printer/gamepad in CI).
 *
 * Phase 1: interfaces + the synthetic source + key mapping only. The focus
 * ring engine, gamepad loop, and webview injection are Phase 2.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export type NavEvent =
  | { type: 'move'; direction: NavDirection }
  | { type: 'activate' } // Enter / gamepad A
  | { type: 'back' }; // Esc / gamepad B

export type NavEventHandler = (event: NavEvent) => void;

/**
 * A source of navigation events. Sources are startable/stoppable so the
 * control view can attach them only while it is visible.
 */
export interface InputSource {
  readonly kind: 'keyboard' | 'gamepad' | 'synthetic';
  start(): void;
  stop(): void;
  onEvent(handler: NavEventHandler): void;
}

/** Default keyboard mapping (design doc §3). Pure for testability. */
export function mapKeyToNavEvent(key: string): NavEvent | null {
  switch (key) {
    case 'ArrowUp':
      return { type: 'move', direction: 'up' };
    case 'ArrowDown':
      return { type: 'move', direction: 'down' };
    case 'ArrowLeft':
      return { type: 'move', direction: 'left' };
    case 'ArrowRight':
      return { type: 'move', direction: 'right' };
    case 'Enter':
      return { type: 'activate' };
    case 'Escape':
      return { type: 'back' };
    default:
      return null;
  }
}

/**
 * Test-double source: `emit` feeds events to all subscribers. Lives in src
 * (not tests) because the Phase 2 control core composes sources the same way
 * in production and tests.
 */
export class SyntheticInputSource implements InputSource {
  readonly kind = 'synthetic' as const;
  private handlers: NavEventHandler[] = [];
  private running = false;

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  onEvent(handler: NavEventHandler): void {
    this.handlers.push(handler);
  }

  /** Events are dropped while stopped, mirroring real source behavior. */
  emit(event: NavEvent): void {
    if (!this.running) return;
    for (const handler of this.handlers) handler(event);
  }
}

/**
 * Fan-in for multiple sources (keyboard + gamepad simultaneously). The
 * Phase 2 control core consumes exactly one event stream.
 */
export class NavEventBus implements InputSource {
  readonly kind = 'synthetic' as const;
  private handlers: NavEventHandler[] = [];

  constructor(private readonly sources: InputSource[]) {}

  start(): void {
    for (const source of this.sources) {
      source.onEvent((event) => this.dispatch(event));
      source.start();
    }
  }

  stop(): void {
    for (const source of this.sources) source.stop();
  }

  onEvent(handler: NavEventHandler): void {
    this.handlers.push(handler);
  }

  private dispatch(event: NavEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

// TODO(Phase 2): KeyboardInputSource (DOM keydown -> mapKeyToNavEvent) and
// GamepadInputSource (requestAnimationFrame Gamepad API poll, D-pad/stick ->
// move, A -> activate, B -> back) implementing InputSource.
