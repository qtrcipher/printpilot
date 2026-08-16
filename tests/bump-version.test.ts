import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-node script without type declarations
import { bumpChangelog, extractSection, isValidVersion } from '../scripts/bump-version.mjs';

/**
 * Changelog-rewrite logic of the version bumper — fixture strings only, no
 * fs/network (house rule). The CLI itself does the file writes.
 */

const REPO = 'https://github.com/example/proj';

const FIXTURE = `# Changelog

## [Unreleased]

### Added

- New shiny thing
- Another thing

## [0.1.0] - 2026-08-17

### Added

- Initial release

[Unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`;

describe('isValidVersion', () => {
  it('accepts semver with optional prerelease', () => {
    expect(isValidVersion('0.2.0')).toBe(true);
    expect(isValidVersion('0.9.0-beta.1')).toBe(true);
  });

  it('rejects non-semver', () => {
    expect(isValidVersion('v0.2.0')).toBe(false);
    expect(isValidVersion('0.2')).toBe(false);
    expect(isValidVersion('latest')).toBe(false);
  });
});

describe('extractSection', () => {
  it('returns the section body, stopping at the next heading', () => {
    expect(extractSection(FIXTURE, '0.1.0')).toBe('### Added\n\n- Initial release');
  });

  it('stops at the link footer for the last section', () => {
    const single = `## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- Everything\n\n[Unreleased]: ${REPO}/compare/v1.0.0...HEAD\n[1.0.0]: ${REPO}/releases/tag/v1.0.0\n`;
    expect(extractSection(single, '1.0.0')).toBe('- Everything');
  });

  it('throws loudly when the section is missing', () => {
    expect(() => extractSection(FIXTURE, '9.9.9')).toThrow(/no section for \[9\.9\.9\]/);
    expect(() => extractSection(FIXTURE, '9.9.9')).toThrow(/0\.1\.0/); // lists what exists
  });

  it('does not confuse 0.1.0 with 0.1.0-beta.1', () => {
    const pre = `## [Unreleased]\n\n## [0.1.0-beta.1] - 2026-01-01\n\n- Beta bits\n`;
    expect(() => extractSection(pre, '0.1.0')).toThrow();
    expect(extractSection(pre, '0.1.0-beta.1')).toBe('- Beta bits');
  });
});

describe('bumpChangelog', () => {
  it('moves Unreleased content into a dated section and resets Unreleased', () => {
    const out = bumpChangelog(FIXTURE, '0.2.0', '0.1.0', '2026-09-01', REPO);
    expect(out).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-09-01\n');
    expect(extractSection(out, '0.2.0')).toBe('### Added\n\n- New shiny thing\n- Another thing');
    expect(extractSection(out, '0.1.0')).toBe('### Added\n\n- Initial release');
  });

  it('handles an empty Unreleased section', () => {
    const empty = FIXTURE.replace('### Added\n\n- New shiny thing\n- Another thing\n\n', '');
    const out = bumpChangelog(empty, '0.2.0', '0.1.0', '2026-09-01', REPO);
    expect(extractSection(out, '0.2.0')).toBe('');
  });

  it('updates the footer links', () => {
    const out = bumpChangelog(FIXTURE, '0.2.0', '0.1.0', '2026-09-01', REPO);
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v0.2.0...HEAD`);
    expect(out).toContain(`[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0`);
    expect(out).toContain(`[0.1.0]: ${REPO}/releases/tag/v0.1.0`); // untouched
  });

  it('throws when there is no Unreleased section', () => {
    expect(() => bumpChangelog('# Changelog\n', '0.2.0', '0.1.0', '2026-09-01', REPO)).toThrow(
      /no ## \[Unreleased\]/,
    );
  });
});
