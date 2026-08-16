import { GAMEPAD_REPEAT_MS, type NavDirection, type NavEvent } from '../preload/nav-layer';

/**
 * On-screen navigation pad (third input source, alongside keyboard and
 * gamepad): a compact overlay of real <button>s in the control view. Pointer
 * presses produce the same NavEvents as the corresponding keyboard arrows /
 * gamepad D-pad — the control view forwards them to the webview guest,
 * where they enter the same dispatch path as every other source.
 *
 * Press-and-hold repeats move events at the gamepad cadence (150 ms); OK and
 * Back are single-shot, matching gamepad A/B. Timers are the window's own,
 * so unit tests drive repeat timing with a fake clock.
 */

export interface DPadDeps {
  onEvent(event: NavEvent): void;
  repeatMs?: number;
}

export interface DPad {
  element: HTMLElement;
  setVisible(visible: boolean): void;
}

const DIRECTIONS: ReadonlyArray<{ direction: NavDirection; glyph: string; label: string }> = [
  { direction: 'up', glyph: '▲', label: 'Move up' },
  { direction: 'down', glyph: '▼', label: 'Move down' },
  { direction: 'left', glyph: '◀', label: 'Move left' },
  { direction: 'right', glyph: '▶', label: 'Move right' },
];

export function createDPad(deps: DPadDeps): DPad {
  const repeatMs = deps.repeatMs ?? GAMEPAD_REPEAT_MS;
  const pad = document.createElement('div');
  pad.id = 'nav-pad';
  pad.className = 'nav-pad';
  pad.setAttribute('role', 'group');
  pad.setAttribute('aria-label', 'On-screen navigation pad');

  let repeatTimer: number | undefined;

  const stopRepeat = (): void => {
    window.clearInterval(repeatTimer);
    repeatTimer = undefined;
  };

  function emit(event: NavEvent, repeatable: boolean): void {
    deps.onEvent(event);
    stopRepeat();
    if (repeatable) {
      repeatTimer = window.setInterval(() => deps.onEvent(event), repeatMs);
    }
  }

  function makeButton(id: string, glyph: string, label: string, event: NavEvent): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = id;
    button.className = 'nav-pad__button';
    button.textContent = glyph;
    button.setAttribute('aria-label', label);
    const repeatable = event.type === 'move';
    button.addEventListener('pointerdown', () => emit(event, repeatable));
    button.addEventListener('pointerup', stopRepeat);
    button.addEventListener('pointerleave', stopRepeat);
    button.addEventListener('pointercancel', stopRepeat);
    // Keyboard activation (Enter/Space on the focused button): single shot.
    button.addEventListener('keydown', (key) => {
      if (key.key === 'Enter' || key.key === ' ') {
        key.preventDefault();
        emit(event, false);
      }
    });
    return button;
  }

  pad.append(
    ...DIRECTIONS.map(({ direction, glyph, label }) =>
      makeButton(`nav-pad-${direction}`, glyph, label, { type: 'move', direction }),
    ),
    makeButton('nav-pad-ok', '●', 'Select', { type: 'activate' }),
    makeButton('nav-pad-back', '↩', 'Back', { type: 'back' }),
  );

  return {
    element: pad,
    setVisible(visible) {
      pad.hidden = !visible;
      if (!visible) stopRepeat();
    },
  };
}
