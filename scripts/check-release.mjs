#!/usr/bin/env node
// Release preflight: both public packages and the repository version must match the v* tag, and the
// changelog must contain that exact release. This runs harmlessly without a tag in local/PR builds.

import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifests = [
	'package.json',
	'packages/client/package.json',
	'packages/cli/package.json',
];
const versions = await Promise.all(
	manifests.map(async (file) => {
		const manifest = JSON.parse(await readFile(new URL(file, root), 'utf8'));
		return { file, name: String(manifest.name), version: String(manifest.version) };
	}),
);
const expected = versions[0]?.version;
const mismatches = versions.filter(({ version }) => version !== expected);
if (!expected || mismatches.length > 0) {
	throw new Error(
		`Release versions differ: ${versions.map(({ name, version }) => `${name}@${version}`).join(', ')}`,
	);
}

const ref = process.env.GITHUB_REF_NAME ?? '';
if (ref.startsWith('v') && ref.slice(1) !== expected) {
	throw new Error(`Release tag ${ref} does not match package version ${expected}.`);
}

const changelog = await readFile(new URL('CHANGELOG.md', root), 'utf8');
if (!changelog.includes(`## [${expected}]`)) {
	throw new Error(`CHANGELOG.md has no [${expected}] release section.`);
}

console.log(`Release metadata is aligned at ${expected}${ref ? ` (${ref})` : ''}.`);
