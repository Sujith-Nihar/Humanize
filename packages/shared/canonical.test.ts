import { expect, it } from 'vitest';
import { canonicalJson, fingerprint } from './src/index.js';

it('encodes equal values identically regardless of key insertion order', () => {
  const inserted = { owner: 'acme', base: 1, nested: { b: [1, 2], a: null } };
  const reordered = { nested: { a: null, b: [1, 2] }, base: 1, owner: 'acme' };
  expect(canonicalJson(inserted)).toBe(canonicalJson(reordered));
  expect(fingerprint(inserted)).toBe(fingerprint(reordered));
  expect(canonicalJson(inserted)).toBe('{"base":1,"nested":{"a":null,"b":[1,2]},"owner":"acme"}');
});

it('orders keys by code unit rather than locale collation', () => {
  // localeCompare('_','a') and localeCompare('B','a') differ from code-unit order,
  // and vary with the ICU build, so the digest would not be portable.
  expect(canonicalJson({ a: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"a":1}');
  expect(canonicalJson({ 'é': 1, 'z': 2 })).toBe('{"z":2,"é":1}');
});

it('preserves array order and distinguishes structurally different values', () => {
  expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  expect(fingerprint({ a: '1' })).not.toBe(fingerprint({ a: 1 }));
  expect(fingerprint({ a: [1] })).not.toBe(fingerprint({ a: { 0: 1 } }));
  expect(fingerprint([{ a: 1 }, { b: 2 }])).not.toBe(fingerprint([{ b: 2 }, { a: 1 }]));
});

it('drops undefined members and normalizes array holes', () => {
  expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  const sparse: unknown[] = new Array<unknown>(2); sparse[1] = 1;
  expect(canonicalJson(sparse)).toBe('[null,1]');
});

it('rejects values that JSON would silently collapse or that cannot terminate', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  }
  expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError);
  expect(() => canonicalJson({ items: new Map([['a', 1]]) })).toThrow(TypeError);
  expect(() => canonicalJson({ id: 1n })).toThrow(TypeError);
  expect(() => canonicalJson({ run: () => 1 })).toThrow(TypeError);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => canonicalJson(cycle)).toThrow(TypeError);
});

it('encodes repeated references that are not cycles', () => {
  const shared = { a: 1 };
  expect(canonicalJson({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}');
});
