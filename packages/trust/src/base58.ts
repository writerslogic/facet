// Base58 (Bitcoin alphabet) encode/decode, used for Multibase `base58btc` values (the `z` prefix in
// publicKeyMultibase and Data Integrity proofValues). Small, dependency-free, and runtime-agnostic.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = 58n;

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i] as string] = i;

/** Encode bytes to a base58 (Bitcoin-alphabet) string. Leading zero bytes become leading `1`s. */
export function base58encode(bytes: Uint8Array): string {
	let leading = 0;
	while (leading < bytes.length && bytes[leading] === 0) leading++;
	let num = 0n;
	for (const b of bytes) num = num * 256n + BigInt(b);
	let out = '';
	while (num > 0n) {
		const rem = Number(num % BASE);
		num = num / BASE;
		out = ALPHABET[rem] + out;
	}
	return '1'.repeat(leading) + out;
}

/** Decode a base58 (Bitcoin-alphabet) string to bytes. Throws on an invalid character. */
export function base58decode(str: string): Uint8Array {
	let leading = 0;
	while (leading < str.length && str[leading] === '1') leading++;
	let num = 0n;
	for (const ch of str) {
		const v = INDEX[ch];
		if (v === undefined) throw new Error(`invalid base58 character: ${ch}`);
		num = num * BASE + BigInt(v);
	}
	const bytes: number[] = [];
	while (num > 0n) {
		bytes.unshift(Number(num % 256n));
		num = num / 256n;
	}
	return new Uint8Array([...new Array(leading).fill(0), ...bytes]);
}
