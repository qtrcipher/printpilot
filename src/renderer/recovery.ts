/**
 * Offline recovery guide (deadlock case: the printer fell off the network
 * and its dead panel can't be used to rejoin). Three honest, ordered
 * recovery paths — Ethernet first (the MF750 has it), then Canon's Direct
 * Connection mode (only if it was previously enabled), then Canon's own USB
 * setup tool as the last resort. Content is data so tests can assert the
 * wording stays honest.
 */

export const CANON_SUPPORT_URL = 'https://www.usa.canon.com/support';

export interface RecoveryPath {
  id: string;
  title: string;
  lines: string[];
  link?: { label: string; url: string };
}

export const RECOVERY_PATHS: readonly RecoveryPath[] = [
  {
    id: 'ethernet',
    title: 'Connect an Ethernet cable',
    lines: [
      'Plug the printer into your router with a network cable.',
      'Rescan here — once the printer appears, open its Remote UI and set the Wi-Fi up again.',
    ],
  },
  {
    id: 'direct-connection',
    title: 'Try Direct Connection mode',
    lines: [
      'Only if Direct Connection was previously enabled on the printer: it may broadcast a DIRECT-xxxx Wi-Fi network.',
      'Connect this computer to that network, then add the printer by IP (usually 192.168.22.1).',
    ],
  },
  {
    id: 'usb-tool',
    title: "Use Canon's USB setup tool",
    lines: [
      "Canon's own setup utility (Windows) can configure Wi-Fi over a USB cable.",
      'Download it from the official Canon support site.',
    ],
    link: { label: 'Open Canon support site', url: CANON_SUPPORT_URL },
  },
];

export interface RecoveryGuideDeps {
  /** Routes external links to the system browser (bridge.openExternal). */
  openExternal(url: string): void;
}

/** The guide as a DOM component: heading + ordered checklist. */
export function createRecoveryGuide(deps: RecoveryGuideDeps): HTMLElement {
  const guide = document.createElement('div');
  guide.className = 'recovery-guide';

  const heading = document.createElement('p');
  heading.className = 'recovery-guide__heading';
  heading.textContent = "Can't reach your printer? Get it back on the network:";
  guide.append(heading);

  const list = document.createElement('ol');
  list.className = 'recovery-guide__list';
  for (const path of RECOVERY_PATHS) {
    const item = document.createElement('li');
    item.className = 'recovery-guide__item';
    item.dataset.path = path.id;

    const title = document.createElement('p');
    title.className = 'recovery-guide__title';
    title.textContent = path.title;
    item.append(title);

    for (const line of path.lines) {
      const text = document.createElement('p');
      text.className = 'recovery-guide__line';
      text.textContent = line;
      item.append(text);
    }

    if (path.link) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link recovery-guide__link';
      link.textContent = path.link.label;
      link.setAttribute('aria-label', `${path.link.label} (opens in your browser)`);
      link.addEventListener('click', () => deps.openExternal(path.link!.url));
      item.append(link);
    }
    list.append(item);
  }
  guide.append(list);
  return guide;
}

const toggleButtons = new WeakMap<HTMLElement, Set<HTMLButtonElement>>();

/**
 * Toggle behavior for an expandable guide: buttons with aria-expanded /
 * aria-controls that show and hide the guide element. Multiple affordances
 * (empty state, offline profiles) can share one guide — all wired buttons
 * stay in sync.
 */
export function wireRecoveryToggle(button: HTMLButtonElement, guide: HTMLElement): void {
  guide.id = guide.id || 'recovery-guide';
  let buttons = toggleButtons.get(guide);
  if (!buttons) {
    buttons = new Set();
    toggleButtons.set(guide, buttons);
  }
  buttons.add(button);
  button.setAttribute('aria-controls', guide.id);
  button.setAttribute('aria-expanded', String(!guide.hidden));
  button.addEventListener('click', () => {
    guide.hidden = !guide.hidden;
    for (const b of buttons ?? []) b.setAttribute('aria-expanded', String(!guide.hidden));
  });
}

/**
 * True when at least one saved profile's host is not currently discovered —
 * the grey-dot case where the "can't reach it?" affordance is offered.
 */
export function hasOfflineProfiles(
  profiles: ReadonlyArray<{ host: string }>,
  onlineHosts: ReadonlySet<string>,
): boolean {
  return profiles.some((profile) => !onlineHosts.has(profile.host));
}
