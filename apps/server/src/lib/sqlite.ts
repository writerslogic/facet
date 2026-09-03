/** Return a unique-constraint message through bounded nested `cause` wrappers. */
export function uniqueConstraintText(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		if (!(current instanceof Error)) return null;
		if (/UNIQUE constraint failed/i.test(current.message)) return current.message;
		current = current.cause;
	}
	return null;
}
