/**
 * First-run welcome (design doc §7): one skippable screen — what the app
 * does plus the "LAN-only, no telemetry, no account" note — shown only when
 * settings.json has onboardingSeen=false. Skippable via the Skip button and
 * Esc; traps focus while open (aria-modal dialog) and restores it after.
 */

export interface OnboardingDeps {
  /** Called exactly once per show, on dismiss (Get started, Skip, or Esc). */
  onDismiss(): void;
}

export interface Onboarding {
  show(): void;
  readonly open: boolean;
}

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

export function createOnboarding(deps: OnboardingDeps): Onboarding {
  const overlay = el('#onboarding');
  const startButton = el<HTMLButtonElement>('#onboarding-start');
  const skipButton = el<HTMLButtonElement>('#onboarding-skip');

  let restoreFocusTo: HTMLElement | null = null;
  let dismissed = false;

  function focusables(): HTMLElement[] {
    return [startButton, skipButton];
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus trap: cycle within the dialog while it is open.
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!items.includes(active as HTMLElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  function dismiss(): void {
    if (dismissed) return;
    dismissed = true;
    overlay.hidden = true;
    document.removeEventListener('keydown', onKeydown, true);
    restoreFocusTo?.focus();
    restoreFocusTo = null;
    deps.onDismiss();
  }

  startButton.addEventListener('click', dismiss);
  skipButton.addEventListener('click', dismiss);

  return {
    show() {
      dismissed = false;
      restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      overlay.hidden = false;
      document.addEventListener('keydown', onKeydown, true);
      startButton.focus();
    },
    get open() {
      return !overlay.hidden;
    },
  };
}
