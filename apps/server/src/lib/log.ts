type SafeFields = Record<string, string | number | boolean | undefined> & { ip?: never };

interface Logger {
	info(msg: string, fields?: SafeFields): void;
	warn(msg: string, fields?: SafeFields): void;
	error(msg: string, err?: unknown, fields?: SafeFields): void;
}

function stripPii(fields?: SafeFields): Record<string, unknown> | undefined {
	if (!fields) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) {
		if (k === 'ip' || k === 'CF-Connecting-IP') continue;
		out[k] = v;
	}
	return out;
}

export function createLogger(base?: Record<string, string | number>): Logger {
	return {
		info(msg, fields) {
			console.log(JSON.stringify({ level: 'info', msg, ...base, ...stripPii(fields) }));
		},
		warn(msg, fields) {
			console.log(JSON.stringify({ level: 'warn', msg, ...base, ...stripPii(fields) }));
		},
		error(msg, err?, fields?) {
			const errFields: Record<string, unknown> = {};
			if (err instanceof Error) {
				errFields.err = { message: err.message, name: err.name };
			} else if (err !== undefined) {
				errFields.err = String(err);
			}
			console.error(
				JSON.stringify({ level: 'error', msg, ...base, ...errFields, ...stripPii(fields) }),
			);
		},
	};
}
