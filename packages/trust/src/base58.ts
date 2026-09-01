// Base58 (Bitcoin alphabet) encode/decode, used for Multibase `base58btc` values (the `z` prefix in
// publicKeyMultibase and Data Integrity proofValues). Small, dependency-free, and runtime-agnostic.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = 58n;

// IMPORTANT: decoding is quadratic in input length (each `num * 58n + v` costs O(limbs)), and
// proofValue/publicKeyMultibase are attacker-controlled in `verifyCredential`. The bound caps that
// at ~1ms; real values here are 47 chars (multikey) and 88 (Ed25519 signature).
const MAX_DECODE_LENGTH = 1024;

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i] as string] = i;

/** Encode bytes to a base58 (Bitcoin-alphabet) string. Leading zero bytes become leading `1`s. */
export function base58encode(bytes: Uint8Array): string {
	let leading = 0;
	while (leading < bytes.length && bytes[leading] === 0) leading++;
	let num = 0n;
	for (const b of bytes) num = num * 256n + BigInt(b);
	const digits: string[] = [];
	while (num > 0n) {
		const rem = Number(num % BASE);
		num = num / BASE;
		digits.push(ALPHABET[rem] as string);
	}
	return '1'.repeat(leading) + digits.reverse().join('');
}

/** Decode a base58 (Bitcoin-alphabet) string to bytes. Throws on an invalid or over-long input. */
export function base58decode(str: string): Uint8Array {
	if (str.length > MAX_DECODE_LENGTH) throw new Error('base58 input exceeds maximum length');
	let leading = 0;
	while (leading < str.length && str[leading] === '1') leading++;
	let num = 0n;
	for (const ch of str) {
		const v = INDEX[ch];
		if (v === undefined) throw new Error(`invalid base58 character: ${ch}`);
		num = num * BASE + BigInt(v);
	}
	const rest: number[] = [];
	while (num > 0n) {
		rest.push(Number(num % 256n));
		num = num / 256n;
	}
	const out = new Uint8Array(leading + rest.length);
	for (let i = 0; i < rest.length; i++) out[leading + i] = rest[rest.length - 1 - i] as number;
	return out;
}
