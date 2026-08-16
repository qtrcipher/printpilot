// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectFocusable,
  FOCUS_RING_CLASS,
  FocusRing,
  spatialScore,
} from '../src/preload/nav-layer';

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function place(element: Element, r: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => r });
}

describe('collectFocusable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('collects interactive elements in document (visual) order', () => {
    document.body.innerHTML = `
      <div>
        <a href="/b">second-in-dom-label</a>
        <button>third</button>
        <input type="text" />
        <select><option>x</option></select>
        <span onclick="x()">fifth</span>
        <div tabindex="0">sixth</div>
      </div>`;
    const found = collectFocusable(document);
    expect(found.map((e) => e.tagName.toLowerCase())).toEqual([
      'a',
      'button',
      'input',
      'select',
      'span',
      'div',
    ]);
  });

  it('skips hidden and disabled elements', () => {
    document.body.innerHTML = `
      <button id="a">visible</button>
      <button hidden>attr-hidden</button>
      <button style="display:none">css-hidden</button>
      <div style="visibility:hidden"><button>nested-hidden</button></div>
      <button disabled>disabled</button>
      <button aria-disabled="true">aria-disabled</button>
      <input type="hidden" />
      <div aria-hidden="true"><a href="/x">aria-hidden-nested</a></div>`;
    const found = collectFocusable(document);
    expect(found.map((e) => e.id || e.textContent)).toEqual(['a']);
  });

  it('skips adapter focus-skip selectors', () => {
    document.body.innerHTML = `
      <a href="/a">keep</a>
      <a href="/b" class="ad-banner">skip me</a>
      <button id="debug-panel">skip me too</button>`;
    const found = collectFocusable(document, ['.ad-banner', '#debug-panel']);
    expect(found.map((e) => e.textContent)).toEqual(['keep']);
  });
});

describe('spatialScore', () => {
  const from = rect(0, 0, 100, 40);

  it('prefers the straight-ahead candidate over a diagonal one', () => {
    const straight = rect(0, 60, 100, 40); // directly below
    const diagonal = rect(300, 60, 100, 40); // below but far right
    const straightScore = spatialScore(from, straight, 'down');
    const diagonalScore = spatialScore(from, diagonal, 'down');
    expect(straightScore).not.toBeNull();
    expect(diagonalScore).not.toBeNull();
    expect(straightScore ?? 0).toBeLessThan(diagonalScore ?? 0);
  });

  it('rejects candidates behind the direction', () => {
    expect(spatialScore(from, rect(0, -100, 100, 40), 'down')).toBeNull();
    expect(spatialScore(from, rect(200, 0, 100, 40), 'left')).toBeNull();
  });
});

describe('FocusRing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function makeRing(onFocusChange?: (el: HTMLElement | null) => void): FocusRing {
    const ring = new FocusRing(document, { onFocusChange });
    ring.start();
    return ring;
  }

  it('focuses the first element on start and applies the ring class', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a>`;
    const ring = makeRing();
    const first = document.querySelector('a');
    expect(ring.focused).toBe(first);
    expect(first?.classList.contains(FOCUS_RING_CLASS)).toBe(true);
    expect(document.activeElement).toBe(first);
    ring.stop();
  });

  it('steps sequentially and wraps around', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`;
    const ring = makeRing();
    const links = [...document.querySelectorAll('a')];
    ring.handle({ type: 'step', delta: 1 });
    expect(ring.focused).toBe(links[1]);
    ring.handle({ type: 'step', delta: 1 });
    ring.handle({ type: 'step', delta: 1 }); // wraps to first
    expect(ring.focused).toBe(links[0]);
    ring.handle({ type: 'step', delta: -1 }); // wraps to last
    expect(ring.focused).toBe(links[2]);
    ring.stop();
  });

  it('moves spatially with arrow events', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`;
    const [a, b, c] = [...document.querySelectorAll('a')];
    place(a!, rect(0, 0, 100, 40));
    place(b!, rect(0, 60, 100, 40)); // below A
    place(c!, rect(200, 0, 100, 40)); // right of A
    const ring = makeRing();
    expect(ring.focused).toBe(a);
    ring.handle({ type: 'move', direction: 'down' });
    expect(ring.focused).toBe(b);
    ring.handle({ type: 'move', direction: 'up' });
    expect(ring.focused).toBe(a);
    ring.handle({ type: 'move', direction: 'right' });
    expect(ring.focused).toBe(c);
    ring.stop();
  });

  it('falls back to a sequential step when nothing lies that way', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a>`;
    const [a, b] = [...document.querySelectorAll('a')];
    place(a!, rect(0, 0, 100, 40));
    place(b!, rect(0, 60, 100, 40));
    const ring = makeRing();
    ring.handle({ type: 'move', direction: 'left' }); // nothing left of A
    expect(ring.focused).toBe(b);
    ring.stop();
  });

  it('activates the focused element', () => {
    document.body.innerHTML = `<button>Go</button>`;
    const button = document.querySelector('button')!;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    const ring = makeRing();
    ring.handle({ type: 'activate' });
    expect(onClick).toHaveBeenCalledOnce();
    ring.stop();
  });

  it('goes back in history on back events', () => {
    document.body.innerHTML = `<a href="/a">A</a>`;
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const ring = makeRing();
    ring.handle({ type: 'back' });
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
    ring.stop();
  });

  /** MutationObserver delivery + queued rescan needs a macrotask in jsdom. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('keeps focus valid across DOM changes (MutationObserver re-scan)', async () => {
    document.body.innerHTML = `<div id="list"><a href="/a">A</a><a href="/b">B</a></div>`;
    const ring = makeRing();
    ring.handle({ type: 'step', delta: 1 });
    const second = document.querySelectorAll('a')[1]!;
    expect(ring.focused).toBe(second);

    // The focused element is removed — the ring must land on a survivor.
    second.remove();
    await flush();
    expect(ring.focused).toBe(document.querySelector('a'));
    expect(ring.count).toBe(1);

    // New elements joining the DOM become focusable.
    document.querySelector('#list')!.insertAdjacentHTML('beforeend', '<a href="/c">C</a>');
    await flush();
    expect(ring.count).toBe(2);
    ring.handle({ type: 'step', delta: 1 });
    expect(ring.focused?.textContent).toBe('C');
    ring.stop();
  });

  it('ignores elements hidden after the fact', async () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a>`;
    const ring = makeRing();
    const second = document.querySelectorAll('a')[1]!;
    second.hidden = true;
    await flush();
    expect(ring.count).toBe(1);
    ring.handle({ type: 'step', delta: 1 });
    expect(ring.focused?.textContent).toBe('A');
    ring.stop();
  });

  it('reports focus changes', () => {
    document.body.innerHTML = `<a href="/a">A</a><a href="/b">B</a>`;
    const seen: Array<string | null> = [];
    const ring = makeRing((el) => seen.push(el?.textContent ?? null));
    ring.handle({ type: 'step', delta: 1 });
    expect(seen).toEqual(['A', 'B']);
    ring.stop();
  });
});
