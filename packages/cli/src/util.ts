import pc from 'picocolors';

export function printError(msg: string): void {
	process.stderr.write(`${pc.red(msg)}\n`);
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		let code: string = String(res.status);
		try {
			// The canonical error envelope is `{ error, message?, issues? }`. Surfacing `message` matters
			// for the operator-facing commands: a bare `out_of_retention` says nothing about which date
			// in their export was out of range, and the code alone is what every command used to print.
			const body = (await res.json()) as { error?: string; message?: string };
			if (body.error) code = body.error;
			if (body.message) code = `${code}: ${body.message}`;
		} catch {
			// ignore parse errors
		}
		throw new Error(code);
	}
	return res.json() as Promise<T>;
}
