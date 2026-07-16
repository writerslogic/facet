// Class-name helper: merges conditional clsx output through tailwind-merge so conflicting
// Tailwind utilities resolve to the last one.

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
