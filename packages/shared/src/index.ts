import { createHash } from 'node:crypto';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function encode(value: unknown, path: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'string': return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers have no canonical form');
      return JSON.stringify(value);
    case 'object': break;
    default: throw new TypeError(`Values of type ${typeof value} have no canonical form`);
  }
  const container = value as object;
  if (path.has(container)) throw new TypeError('Circular values have no canonical form');
  path.add(container);
  try {
    if (Array.isArray(container)) {
      const items: string[] = [];
      for (let index = 0; index < container.length; index++) items.push(encode(container[index] ?? null, path));
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(container);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain objects have a canonical form');
    return `{${Object.entries(container).filter(([, item]) => item !== undefined).sort(([a], [b]) => byCodeUnit(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, path)}`).join(',')}}`;
  } finally { path.delete(container); }
}

/**
 * Deterministic JSON encoding: keys sorted by UTF-16 code unit rather than locale
 * collation, undefined members dropped, and every value that JSON cannot represent
 * faithfully rejected instead of silently collapsing. Equal values always encode to
 * equal strings regardless of insertion order, so digests survive PostgreSQL JSONB
 * round trips, schema parsing and transport.
 */
export function canonicalJson(value: unknown): string { return encode(value, new Set()); }

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !value.startsWith('/') && !/^[a-z]:/i.test(value)
    && !value.includes('\\') && !value.includes('\0') && value.split('/').every(p => p !== '..' && p !== '.' && p !== '');
}

export function lineAt(source: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) throw new RangeError('Invalid source offset');
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === '\n') line++;
  return line;
}

export function normalizeText(value: string): string { return value.normalize('NFC').replace(/\s+/gu, ' ').trim(); }

export function abortIfNeeded(signal?: AbortSignal): void { signal?.throwIfAborted(); }

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
