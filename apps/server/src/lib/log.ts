type SafeFields = Record<string, string | number | boolean | undefined> & { ip?: never };

interface Logger {
	info(msg: string, fields?: SafeFields): void;
	warn(msg: string, fields?: SafeFields): void;
	error(msg: string, err?: unknown, fields?: SafeFields): void;
}

// IMPORTANT: raw IP must never reach a log line. Matching is on the key with separators and case
// removed, so `CF-Connecting-IP`, `client_ip` and `clientIp` all collapse onto one entry here.
const PII_KEYS = new Set([
	'ip',
	'ipaddress',
	'cfconnectingip',
	'xforwardedfor',
	'forwarded',
	'xrealip',
	'xclientip',
	'trueclientip',
	'clientip',
	'remoteaddr',
	'remoteaddress',
	'sourceip',
	'peerip',
]);

const MAX_VALUE_CHARS = 1024;

function isPiiKey(key: string): boolean {
	return PII_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function clamp(value: unknown): unknown {
	if (typeof value !== 'string' || value.length <= MAX_VALUE_CHARS) return value;
	return `${value.slice(0, MAX_VALUE_CHARS)}…`;
}

function stripPii(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!fields) return undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) {
		if (isPiiKey(k)) continue;
		out[k] = clamp(v);
	}
	return out;
}

function describeError(err: unknown): Record<string, unknown> {
	if (err === undefined) return {};
	try {
		if (err instanceof Error) {
			return { err: { message: clamp(err.message), name: clamp(err.name) } };
		}
		return { err: clamp(String(err)) };
	} catch {
		return { err: 'unserializable' };
	}
}

// IMPORTANT: every call site is a catch block or a cron job isolator, so a throw from the logger
// would take out the recovery path it was reporting on. A bad field degrades to a marker line.
function emit(sink: (line: string) => void, line: Record<string, unknown>): void {
	try {
		sink(JSON.stringify(line));
	} catch {
		sink(JSON.stringify({ level: line.level, msg: 'log_serialize_failed' }));
	}
}

export function createLogger(base?: Record<string, string | number>): Logger {
	const safeBase = stripPii(base);
	function build(
		level: string,
		msg: string,
		extra: Record<string, unknown>,
	): Record<string, unknown> {
		const line: Record<string, unknown> = { ...safeBase, ...extra };
		line.level = level;
		line.msg = clamp(msg);
		return line;
	}
	return {
		info(msg, fields) {
			emit((l) => console.log(l), build('info', msg, { ...stripPii(fields) }));
		},
		warn(msg, fields) {
			emit((l) => console.log(l), build('warn', msg, { ...stripPii(fields) }));
		},
		error(msg, err?, fields?) {
			emit(
				(l) => console.error(l),
				build('error', msg, { ...describeError(err), ...stripPii(fields) }),
			);
		},
	};
}
