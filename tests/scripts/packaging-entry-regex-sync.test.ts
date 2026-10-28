/**
 * @fileoverview Pins the bundle-entry patterns duplicated across
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts`
 * (the post-bundle content check). Both files carry a KEEP IN SYNC note
 * pointing at this test; a drift between them would let the linter pass a
 * bundle the strip step never cleaned, or fail one it did.
 * @module tests/scripts/packaging-entry-regex-sync.test
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY,
  BUILD_ONLY_ENTRY,
  NATIVE_BINDING_ENTRY,
  NODE_GYP_OUTPUT,
} from '../../scripts/clean-mcpb.js';

// Loaded by URL so tsc never follows lint-packaging.ts into its framework-repo-only fallback import.
const lint: Record<string, unknown> = await import(
  new URL('../../scripts/lint-packaging.ts', import.meta.url).href
);

const cleanPatterns = { AGENT_DOC_ENTRY, BUILD_ONLY_ENTRY, NATIVE_BINDING_ENTRY, NODE_GYP_OUTPUT };

describe('bundle-entry pattern sync', () => {
  it.each(Object.entries(cleanPatterns))(
    '%s is identical in clean-mcpb and lint-packaging',
    (name, cleanPattern) => {
      const lintPattern = lint[name];
      expect(lintPattern).toBeInstanceOf(RegExp);
      expect(cleanPattern.source).toBe((lintPattern as RegExp).source);
      expect(cleanPattern.flags).toBe((lintPattern as RegExp).flags);
    },
  );

  it('matches the entries each pattern exists to strip', () => {
    expect(AGENT_DOC_ENTRY.test('node_modules/@scope/pkg/skills/add-tool/SKILL.md')).toBe(true);
    expect(AGENT_DOC_ENTRY.test('dist/index.js')).toBe(false);
    expect(
      NATIVE_BINDING_ENTRY.test('node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node'),
    ).toBe(true);
    expect(NATIVE_BINDING_ENTRY.test('node_modules/@duckdb/node-bindings/duckdb.js')).toBe(false);
  });
});
