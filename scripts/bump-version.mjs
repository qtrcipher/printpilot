/**
 * Release version bumper.
 *
 *   node scripts/bump-version.mjs <version>           e.g. 0.2.0 or 0.9.0-beta.1
 *   node scripts/bump-version.mjs extract <version>   print that CHANGELOG section
 *
 * Bump mode: sets package.json version, moves the CHANGELOG [Unreleased]
 * content into a new dated section, adds a fresh empty [Unreleased], and
 * updates the link footer. It does NOT commit or tag — it prints the
 * suggested git commands instead (tags are for releases only, and the
 * human pushes them).
 *
 * Extract mode is used by the release workflow to build the release body;
 * it fails loudly when the section is missing.
 *
 * Plain node, no dependencies. The changelog-rewrite logic is exported so
 * the unit test can exercise it without touching the filesystem.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REPO_URL = 'https://github.com/qtrcipher/printpilot';

const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isValidVersion(version) {
  return VERSION_RE.test(version);
}

/** Body of one `## [version] - date` section; throws if it doesn't exist. */
export function extractSection(changelog, version) {
  const lines = changelog.split('\n');
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) {
    const available = lines
      .filter((l) => /^## \[[^\]]+\]/.test(l))
      .map((l) => l.replace(/^## \[([^\]]+)\].*$/, '$1'))
      .join(', ');
    throw new Error(
      `CHANGELOG.md has no section for [${version}] (found: ${available || 'none'}). ` +
        'Run the bump script before tagging.',
    );
  }
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break; // next section
    if (/^\[[^\]]+\]:\s*https?:/.test(line)) break; // link footer
    body.push(line);
  }
  return body.join('\n').trim();
}

/**
 * Move [Unreleased] content into `## [newVersion] - date`, leave a fresh
 * empty [Unreleased], and update the link footer. The new version's link
 * compares against the previous tag; existing links are left untouched.
 */
export function bumpChangelog(changelog, newVersion, prevVersion, date, repoUrl = REPO_URL) {
  const unreleasedHeading = '## [Unreleased]';
  const start = changelog.indexOf(unreleasedHeading);
  if (start === -1) throw new Error('CHANGELOG.md has no ## [Unreleased] section');
  const bodyStart = start + unreleasedHeading.length;
  const rest = changelog.slice(bodyStart);
  const nextSection = rest.search(/^## /m);
  if (nextSection === -1) throw new Error('CHANGELOG.md has no released section after [Unreleased]');
  const unreleasedBody = rest.slice(0, nextSection).trim();

  const before = changelog.slice(0, bodyStart);
  const after = rest.slice(nextSection);

  let updated =
    `${before}\n\n## [${newVersion}] - ${date}\n` +
    (unreleasedBody ? `\n${unreleasedBody}\n` : '') +
    `\n${after.replace(/^\n+/, '')}`;

  // Footer: Unreleased now compares against the new tag; the new version
  // compares against the previous tag.
  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/`;
  const linkIdx = updated.indexOf(unreleasedLink);
  if (linkIdx === -1) throw new Error('CHANGELOG.md footer has no [Unreleased] compare link');
  const lineEnd = updated.indexOf('\n', linkIdx);
  updated =
    `${updated.slice(0, linkIdx)}` +
    `${unreleasedLink}v${newVersion}...HEAD\n` +
    `[${newVersion}]: ${repoUrl}/compare/v${prevVersion}...v${newVersion}` +
    `${updated.slice(lineEnd)}`;

  return updated;
}

async function bump(version) {
  if (!isValidVersion(version)) {
    console.error(`"${version}" is not a valid semver (e.g. 0.2.0 or 0.9.0-beta.1)`);
    process.exit(1);
  }
  const pkgPath = 'package.json';
  const changelogPath = 'CHANGELOG.md';

  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const prevVersion = pkg.version;
  if (prevVersion === version) {
    console.error(`package.json is already at ${version}`);
    process.exit(1);
  }
  const date = new Date().toISOString().slice(0, 10);

  const changelog = await readFile(changelogPath, 'utf8');
  try {
    extractSection(changelog, version);
    console.error(`CHANGELOG.md already has a [${version}] section — is it released?`);
    process.exit(1);
  } catch {
    // expected: no section for the new version yet
  }
  await writeFile(changelogPath, bumpChangelog(changelog, version, prevVersion, date));

  pkg.version = version;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(`Bumped ${prevVersion} → ${version} (package.json + CHANGELOG.md, dated ${date}).`);
  console.log(`
Nothing was committed or tagged. Next steps:
  git add package.json CHANGELOG.md
  git commit -m "release v${version}"
  git push
  # after CI is green on main:
  git tag v${version}
  git push origin v${version}
`);
}

// Run only as a script, not when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === 'extract') {
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    try {
      process.stdout.write(`${extractSection(changelog, args[1])}\n`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  } else if (args.length === 1) {
    await bump(args[0]);
  } else {
    console.error('Usage: node scripts/bump-version.mjs <version> | extract <version>');
    process.exit(1);
  }
}
