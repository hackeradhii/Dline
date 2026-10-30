import * as v from 'valibot';

/** Parse untrusted JSON text against a schema. One implementation for client and server (DRY). */
export function parseMessage<S extends v.GenericSchema>(schema: S, raw: unknown): v.InferOutput<S> | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = v.safeParse(schema, data);
  return result.success ? result.output : null;
}

/** Shared field schemas. */
export const nonNegativeInt = v.pipe(v.number(), v.integer(), v.minValue(0));
export const shortText = (max: number) => v.pipe(v.string(), v.maxLength(max));
