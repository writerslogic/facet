#!/usr/bin/env node
// E.19: fail the build if any release-facing document still contains a placeholder repository
// owner/slug or a malformed Deploy-to-Cloudflare button. The npm scope `@writerslogic/…` and the
// D1 `PLACEHOLDER_D1_DATABASE_ID` config slot are NOT release links and are intentionally allowed.

import { readFileSync } from 'node:fs';

const FILES = ['README.md', 'CHANGELOG.md', 'docs/self-hosting.md', 'docs/api.md', 'docs/usage.md'];

// Placeholder owner/slug patterns that must never ship in release-facing docs.
const PLACEHOLDERS = [
	/github\.com\/OWNER\b/i,
	/\bOWNER\/(?:countless|facet)\b/i,
	/\bYOUR_ORG\b/i,
	/\bYOUR_REPO\b/i,
	/github\.com\/<[^>]+>/i,
	/github\.com\/example-(?:org|user)\b/i,
];

const DEPLOY_RE =
	/deploy\.workers\.cloudflare\.com\/\?url=https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/;

let failures = 0;
const fail = (msg) => {
	console.error(`✗ ${msg}`);
	failures += 1;
};

for (const file of FILES) {
	let text;
	try {
		text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	} catch {
		continue; // optional file
	}
	for (const re of PLACEHOLDERS) {
		const m = text.match(re);
		if (m) {
			fail(`${file}: placeholder repository reference "${m[0]}"`);
		}
	}
}

// The deploy button must exist in the README with a concrete, non-placeholder owner/repo.
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const deploy = readme.match(DEPLOY_RE);
if (!deploy) {
	fail('README.md: Deploy-to-Cloudflare button URL is missing or malformed.');
} else {
	const [, owner, repo] = deploy;
	if (/^(owner|your_org|example.*)$/i.test(owner)) {
		fail(`README.md: Deploy button owner "${owner}" is a placeholder — set the real GitHub org/user.`);
	} else {
		console.log(`✓ Deploy button targets github.com/${owner}/${repo}`);
	}
}

if (failures > 0) {
	console.error(
		`\n${failures} release-link problem(s). Replace placeholders with the real repository slug before releasing.`,
	);
	process.exit(1);
}
console.log('✓ No placeholder release links found.');
