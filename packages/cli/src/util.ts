import pc from 'picocolors';

export function printError(msg: string): void {
	process.stderr.write(`${pc.red(msg)}\n`);
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		let code: string = String(res.status);
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) code = body.error;
		} catch {
			// ignore parse errors
		}
		throw new Error(code);
	}
	return res.json() as Promise<T>;
}
