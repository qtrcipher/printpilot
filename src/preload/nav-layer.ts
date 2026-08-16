/**
 * Navigation layer input abstraction (design doc §3 and §6).
 *
 * Keyboard and gamepad sources emit a common `NavEvent` stream; the control
 * core turns events into roving-focus moves, clicks, and back-navigation
 * inside the printer's Remote UI. Tests inject a `SyntheticInputSource`
 * instead of real hardware (house rule: no physical printer/gamepad in CI).
 *
 * Phase 2: interfaces + synthetic source (tests), keyboard/gamepad sources,
 * the roving-focus ring engine, and Remote UI login detection. The webview
 * preload (src/preload/webview.ts) composes these inside the embedded page.
 *
 * Remapping (design doc §7): the gamepad source resolves presses through
 * the saved GamepadMapping (buttons/axes per action, defaults fill unmapped
 * actions); the keyboard source applies saved key overrides before its
 * built-in scheme. Both are threaded from settings.json by the shell via
 * the `nav:config` message (src/preload/webview.ts).
 */

import { DEFAULT_GAMEPAD_MAPPING, type GamepadBinding, type GamepadMapping } from '../main/settings-schema';

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export type NavEvent =
  | { type: 'move'; direction: NavDirection } // arrows / D-pad / stick (spatial)
  | { type: 'step'; delta: 1 | -1 } // Tab / Shift+Tab (sequential, visual order)
  | { type: 'activate' } // Enter / gamepad A
  | { type: 'back' } // Esc / gamepad B
  | { type: 'leave' }; // Ctrl+` — move focus out of the page to the shell chrome

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

const NAV_DIRECTIONS: readonly NavDirection[] = ['up', 'down', 'left', 'right'];

/**
 * Validate an untrusted NavEvent arriving over IPC (shell → guest, e.g. the
 * on-screen D-pad). Returns null for anything malformed. The `leave` event
 * is shell-internal and deliberately not accepted here.
 */
export function sanitizeNavEvent(value: unknown): NavEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case 'move':
      return NAV_DIRECTIONS.includes(raw.direction as NavDirection)
        ? { type: 'move', direction: raw.direction as NavDirection }
        : null;
    case 'step':
      return raw.delta === 1 || raw.delta === -1 ? { type: 'step', delta: raw.delta } : null;
    case 'activate':
      return { type: 'activate' };
    case 'back':
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

/* ---------------------------------------------------------------------------
 * Phase 2: real input sources + roving-focus ring (design doc §3).
 * Everything below uses only DOM APIs (no Electron imports) so Vitest +
 * jsdom exercises it directly; src/preload/webview.ts wires it into the
 * embedded Remote UI page.
 * ------------------------------------------------------------------------- */

/** Keychord that moves focus out of the embedded page to the shell chrome. */
export const LEAVE_KEY = '`'; // with Ctrl

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable)
  );
}

/**
 * DOM keydown source. Arrows/Enter/Escape follow mapKeyToNavEvent;
 * Tab/Shift+Tab are sequential steps (tab order = visual order, design §7).
 * While the caret is in an editable field, arrows/Enter/Tab keep their
 * native form behavior — only Escape and the leave keychord are hijacked,
 * so login forms stay usable.
 */
export class KeyboardInputSource implements InputSource {
  readonly kind = 'keyboard' as const;
  private handlers: NavEventHandler[] = [];
  private running = false;
  private readonly listener = (event: KeyboardEvent): void => this.onKeydown(event);

  constructor(
    private readonly target: Window,
    /** Saved key overrides (settings.json gamepad remap, key bindings). */
    private readonly keyMap: Readonly<Record<string, NavEvent>> = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.target.addEventListener('keydown', this.listener, true);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.target.removeEventListener('keydown', this.listener, true);
  }

  onEvent(handler: NavEventHandler): void {
    this.handlers.push(handler);
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === LEAVE_KEY) {
      event.preventDefault();
      this.dispatch({ type: 'leave' });
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return; // browser chords pass through
    if (isEditableTarget(event.target)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.dispatch({ type: 'back' });
      }
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      this.dispatch({ type: 'step', delta: event.shiftKey ? -1 : 1 });
      return;
    }
    // Saved key overrides win over the built-in scheme (custom mapping
    // overrides defaults, design doc §7).
    const custom = this.keyMap[event.key];
    if (custom) {
      event.preventDefault();
      this.dispatch(custom);
      return;
    }
    const navEvent = mapKeyToNavEvent(event.key);
    if (navEvent) {
      event.preventDefault();
      this.dispatch(navEvent);
    }
  }

  private dispatch(event: NavEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

export interface GamepadDeps {
  /** Defaults to navigator.getGamepads. */
  getGamepads?: () => readonly (GamepadLike | null)[];
  /** Frame pump — defaults to requestAnimationFrame on the given window. */
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
  /** Resolved mapping from settings.json; defaults when absent/unmapped. */
  mapping?: GamepadMapping;
}

/** Minimal shape so tests can feed synthetic pads without the real Gamepad type. */
export interface GamepadLike {
  buttons: ReadonlyArray<{ pressed: boolean }>;
  axes: readonly number[];
}

export const GAMEPAD_DEADZONE = 0.4;
export const GAMEPAD_REPEAT_MS = 150;

// The standard-layout D-pad always works, whatever the mapping — it is how
// pads without remappable sticks move, and it never conflicts with defaults.
const DPAD: ReadonlyArray<[number, NavDirection]> = [
  [12, 'up'],
  [13, 'down'],
  [14, 'left'],
  [15, 'right'],
];

const DIRECTIONS: readonly NavDirection[] = ['up', 'down', 'left', 'right'];

/** True when a button/axis binding is currently actuated (key bindings are not gamepad input). */
function bindingActive(pad: GamepadLike, binding: GamepadBinding, deadzone: number): boolean {
  switch (binding.kind) {
    case 'button':
      return Boolean(pad.buttons[binding.index]?.pressed);
    case 'axis':
      return (pad.axes[binding.axis] ?? 0) * binding.sign >= deadzone;
    case 'key':
      return false;
  }
}

function directionFromPad(
  pad: GamepadLike,
  mapping: GamepadMapping,
  deadzone: number,
): NavDirection | null {
  for (const [index, direction] of DPAD) {
    if (pad.buttons[index]?.pressed) return direction;
  }
  // Button-bound directions first (unambiguous single-press semantics).
  for (const direction of DIRECTIONS) {
    const binding = mapping[direction];
    if (binding.kind === 'button' && bindingActive(pad, binding, deadzone)) return direction;
  }
  // Axis-bound directions: dominant deflection wins, mirroring stick feel.
  let best: { direction: NavDirection; magnitude: number } | null = null;
  for (const direction of DIRECTIONS) {
    const binding = mapping[direction];
    if (binding.kind !== 'axis') continue;
    const magnitude = (pad.axes[binding.axis] ?? 0) * binding.sign;
    if (magnitude >= deadzone && (!best || magnitude > best.magnitude)) {
      best = { direction, magnitude };
    }
  }
  return best?.direction ?? null;
}

/**
 * Gamepad API polling source (design doc §3): D-pad/left-stick → focus move
 * with ~150ms auto-repeat, button 0 (A) → activate, button 1 (B) → back by
 * default. Saved mappings (settings.json) rebind any action to another
 * button/axis; unmapped actions fall back to these defaults. Rising edge
 * emits immediately; holds repeat. Timing and frame pumping are injectable
 * so tests drive synthetic pads deterministically.
 */
export class GamepadInputSource implements InputSource {
  readonly kind = 'gamepad' as const;
  private handlers: NavEventHandler[] = [];
  private frameHandle: number | null = null;
  private heldDirection: NavDirection | null = null;
  private lastMoveAt = 0;
  private activateHeld = false;
  private backHeld = false;

  private readonly getGamepads: () => readonly (GamepadLike | null)[];
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;
  private readonly mapping: GamepadMapping;

  constructor(
    win: Window,
    deps: GamepadDeps = {},
    private readonly deadzone = GAMEPAD_DEADZONE,
    private readonly repeatMs = GAMEPAD_REPEAT_MS,
  ) {
    this.getGamepads = deps.getGamepads ?? (() => win.navigator.getGamepads?.() ?? []);
    this.requestFrame = deps.requestFrame ?? ((cb) => win.requestAnimationFrame(cb));
    this.cancelFrame = deps.cancelFrame ?? ((handle) => win.cancelAnimationFrame(handle));
    this.now = deps.now ?? (() => win.performance.now());
    this.mapping = deps.mapping ?? DEFAULT_GAMEPAD_MAPPING;
  }

  start(): void {
    if (this.frameHandle !== null) return;
    this.pump();
  }

  stop(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.heldDirection = null;
    this.activateHeld = false;
    this.backHeld = false;
  }

  onEvent(handler: NavEventHandler): void {
    this.handlers.push(handler);
  }

  private pump(): void {
    this.frameHandle = this.requestFrame(() => {
      this.poll();
      if (this.frameHandle !== null) this.pump();
    });
  }

  /** One poll iteration — exposed for tests that pump frames manually. */
  poll(): void {
    const now = this.now();
    let direction: NavDirection | null = null;
    let activate = false;
    let back = false;
    for (const pad of this.getGamepads()) {
      if (!pad) continue;
      direction = direction ?? directionFromPad(pad, this.mapping, this.deadzone);
      activate = activate || bindingActive(pad, this.mapping.activate, this.deadzone);
      back = back || bindingActive(pad, this.mapping.back, this.deadzone);
    }

    if (direction) {
      if (direction !== this.heldDirection) {
        this.dispatch({ type: 'move', direction });
        this.lastMoveAt = now;
      } else if (now - this.lastMoveAt >= this.repeatMs) {
        this.dispatch({ type: 'move', direction });
        this.lastMoveAt = now;
      }
    }
    this.heldDirection = direction;

    if (activate && !this.activateHeld) this.dispatch({ type: 'activate' });
    this.activateHeld = activate;
    if (back && !this.backHeld) this.dispatch({ type: 'back' });
    this.backHeld = back;
  }

  private dispatch(event: NavEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

/* ---------------------------------------------------------------------------
 * Roving-focus ring
 * ------------------------------------------------------------------------- */

export const FOCUS_RING_CLASS = 'printpilot-focus-ring';
export const FOCUS_RING_STYLE_ID = 'printpilot-focus-ring-style';
export const FOCUS_RING_COLOR = '#60A5FA';

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [onclick], [tabindex]';

/** Inject the 2px #60A5FA outline rule (design doc §8 focus ring). */
export function injectFocusRingStyle(doc: Document): void {
  if (doc.getElementById(FOCUS_RING_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = FOCUS_RING_STYLE_ID;
  style.textContent =
    `.${FOCUS_RING_CLASS} { outline: 2px solid ${FOCUS_RING_COLOR} !important;` +
    ' outline-offset: 2px !important; }';
  doc.head.append(style);
}

function isHidden(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && element.type === 'hidden') return true;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return true;
    const display = node.style.display;
    const visibility = node.style.visibility;
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse') return true;
  }
  return false;
}

function isDisabled(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return (
    'disabled' in element &&
    Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled)
  );
}

/**
 * Interactive elements in document (= visual) order, minus hidden/disabled
 * ones and anything matching the adapter's focus-skip selectors.
 */
export function collectFocusable(root: ParentNode, skipSelectors: readonly string[] = []): HTMLElement[] {
  const skip = skipSelectors.filter((s) => s.trim().length > 0);
  const matches = [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)];
  return matches.filter((element) => {
    if (isHidden(element) || isDisabled(element)) return false;
    if (skip.length > 0 && skip.some((selector) => element.matches(selector))) return false;
    return true;
  });
}

interface Axis {
  primary: 'x' | 'y';
  sign: 1 | -1;
}

const AXES: Record<NavDirection, Axis> = {
  right: { primary: 'x', sign: 1 },
  left: { primary: 'x', sign: -1 },
  down: { primary: 'y', sign: 1 },
  up: { primary: 'y', sign: -1 },
};

function edgeStart(rect: DOMRect, axis: Axis): number {
  return axis.primary === 'x' ? (axis.sign > 0 ? rect.left : rect.right) : axis.sign > 0 ? rect.top : rect.bottom;
}

function edgeEnd(rect: DOMRect, axis: Axis): number {
  return axis.primary === 'x' ? (axis.sign > 0 ? rect.right : rect.left) : axis.sign > 0 ? rect.bottom : rect.top;
}

function overlapRange(rect: DOMRect, axis: Axis): [number, number] {
  return axis.primary === 'x' ? [rect.top, rect.bottom] : [rect.left, rect.right];
}

function center(value: [number, number]): number {
  return (value[0] + value[1]) / 2;
}

/**
 * Score a candidate for a spatial move; null when it is not in the direction.
 * Cheapest = short primary distance + small perpendicular offset, with a
 * strong bonus for axis overlap so "straight ahead" wins over diagonals.
 */
export function spatialScore(from: DOMRect, to: DOMRect, direction: NavDirection): number | null {
  const axis = AXES[direction];
  const gap = (edgeStart(to, axis) - edgeEnd(from, axis)) * axis.sign;
  if (gap < -2) return null; // not (meaningfully) in that direction
  const [a1, a2] = overlapRange(from, axis);
  const [b1, b2] = overlapRange(to, axis);
  const overlap = Math.min(a2, b2) - Math.max(a1, b1);
  const perpendicular = Math.abs(center([b1, b2]) - center([a1, a2]));
  const overlapBonus = overlap > 0 ? 0 : 1000;
  return Math.max(gap, 0) + perpendicular * 2 + overlapBonus;
}

export interface FocusRingOptions {
  /** Adapter focus-skip selectors. */
  skipSelectors?: readonly string[];
  /** Root to scan — defaults to document. */
  root?: ParentNode;
  /** Called whenever the focused element changes (hint bar / tests). */
  onFocusChange?: (element: HTMLElement | null) => void;
}

/**
 * Roving-focus ring over the embedded page's interactive elements.
 * Arrow keys move spatially, Tab steps sequentially, Enter activates,
 * and a MutationObserver keeps the ring valid across DOM changes
 * (Remote UI pages re-render menus in place).
 */
export class FocusRing {
  private elements: HTMLElement[] = [];
  private current: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private rescanQueued = false;
  private readonly root: ParentNode;
  private readonly skipSelectors: readonly string[];

  constructor(
    private readonly doc: Document,
    private readonly options: FocusRingOptions = {},
  ) {
    this.root = options.root ?? doc;
    this.skipSelectors = options.skipSelectors ?? [];
  }

  get focused(): HTMLElement | null {
    return this.current;
  }

  get count(): number {
    return this.elements.length;
  }

  start(): void {
    injectFocusRingStyle(this.doc);
    this.rescan();
    this.observer = new MutationObserver(() => this.queueRescan());
    this.observer.observe(this.doc.body ?? this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'disabled', 'aria-hidden'],
    });
    if (!this.current && this.elements.length > 0) this.focusElement(this.elements[0] ?? null);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.focusElement(null);
  }

  handle(event: NavEvent): void {
    switch (event.type) {
      case 'move':
        this.move(event.direction);
        break;
      case 'step':
        this.step(event.delta);
        break;
      case 'activate':
        this.current?.click();
        break;
      case 'back':
        this.doc.defaultView?.history.back();
        break;
      case 'leave':
        break; // handled by the shell (focus leaves the page)
    }
  }

  /** Sequential move in document order; wraps around. */
  step(delta: 1 | -1): void {
    if (this.elements.length === 0) return;
    const index = this.current ? this.elements.indexOf(this.current) : -1;
    const next = (index + delta + this.elements.length) % this.elements.length;
    this.focusElement(this.elements[next] ?? null);
  }

  /** Spatial move; falls back to a sequential step when nothing lies that way. */
  move(direction: NavDirection): void {
    if (this.elements.length === 0) return;
    if (!this.current || !this.elements.includes(this.current)) {
      this.focusElement(this.elements[0] ?? null);
      return;
    }
    const from = this.current.getBoundingClientRect();
    let best: { element: HTMLElement; score: number } | null = null;
    for (const element of this.elements) {
      if (element === this.current) continue;
      const score = spatialScore(from, element.getBoundingClientRect(), direction);
      if (score === null) continue;
      if (!best || score < best.score) best = { element, score };
    }
    if (best) {
      this.focusElement(best.element);
    } else {
      this.step(direction === 'up' || direction === 'left' ? -1 : 1);
    }
  }

  /** Re-collect after DOM changes; keeps focus on the same element when it survives. */
  rescan(): void {
    this.rescanQueued = false;
    this.elements = collectFocusable(this.root, this.skipSelectors);
    if (this.current && !this.elements.includes(this.current)) {
      // Current element vanished or became inert — land on the nearest survivor.
      this.focusElement(this.elements[0] ?? null);
    }
  }

  private queueRescan(): void {
    if (this.rescanQueued) return;
    this.rescanQueued = true;
    queueMicrotask(() => this.rescan());
  }

  private focusElement(element: HTMLElement | null): void {
    if (this.current === element) return;
    this.current?.classList.remove(FOCUS_RING_CLASS);
    this.current = element;
    if (element) {
      element.classList.add(FOCUS_RING_CLASS);
      element.focus();
    }
    this.options.onFocusChange?.(element);
  }
}

/* ---------------------------------------------------------------------------
 * Remote UI login detection (credential offer, design doc §7 connect flow)
 * ------------------------------------------------------------------------- */

export interface LoginWatchConfig {
  formSelector: string;
  passwordSelector: string;
}

/**
 * Watches for the Remote UI login form and reports the PIN when the form is
 * submitted. Whether the login *succeeded* is decided by the shell (next
 * navigation leaves the login URL) — this class only captures the attempt.
 */
export class LoginWatcher {
  private readonly listener = (event: Event): void => this.onSubmit(event);

  constructor(
    private readonly doc: Document,
    private readonly config: LoginWatchConfig,
    private readonly onPinSubmitted: (pin: string) => void,
  ) {}

  start(): void {
    // Capture phase: fires even if page scripts stopPropagation.
    this.doc.addEventListener('submit', this.listener, true);
  }

  stop(): void {
    this.doc.removeEventListener('submit', this.listener, true);
  }

  private onSubmit(event: Event): void {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.matches(this.config.formSelector)) return;
    const field = form.querySelector<HTMLInputElement>(this.config.passwordSelector);
    const pin = field?.value ?? '';
    if (pin) this.onPinSubmitted(pin);
  }
}
