/** Small numeric helpers, one implementation for the whole app (DRY). */

/** `value`, kept within [min, max]. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
