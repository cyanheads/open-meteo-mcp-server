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
  AGENT_DOC_ENTRY as CLEAN_AGENT_DOC_ENTRY,
  NATIVE_BINDING_ENTRY as CLEAN_NATIVE_BINDING_ENTRY,
} from '../../scripts/clean-mcpb.js';
import {
  AGENT_DOC_ENTRY as LINT_AGENT_DOC_ENTRY,
  NATIVE_BINDING_ENTRY as LINT_NATIVE_BINDING_ENTRY,
} from '../../scripts/lint-packaging.js';

describe('bundle-entry pattern sync', () => {
  it('AGENT_DOC_ENTRY is identical in clean-mcpb and lint-packaging', () => {
    expect(CLEAN_AGENT_DOC_ENTRY.source).toBe(LINT_AGENT_DOC_ENTRY.source);
    expect(CLEAN_AGENT_DOC_ENTRY.flags).toBe(LINT_AGENT_DOC_ENTRY.flags);
  });

  it('NATIVE_BINDING_ENTRY is identical in clean-mcpb and lint-packaging', () => {
    expect(CLEAN_NATIVE_BINDING_ENTRY.source).toBe(LINT_NATIVE_BINDING_ENTRY.source);
    expect(CLEAN_NATIVE_BINDING_ENTRY.flags).toBe(LINT_NATIVE_BINDING_ENTRY.flags);
  });

  it('matches the entries each pattern exists to strip', () => {
    expect(CLEAN_AGENT_DOC_ENTRY.test('node_modules/@scope/pkg/skills/add-tool/SKILL.md')).toBe(
      true,
    );
    expect(CLEAN_AGENT_DOC_ENTRY.test('dist/index.js')).toBe(false);
    expect(
      CLEAN_NATIVE_BINDING_ENTRY.test(
        'node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node',
      ),
    ).toBe(true);
    expect(CLEAN_NATIVE_BINDING_ENTRY.test('node_modules/@duckdb/node-bindings/duckdb.js')).toBe(
      false,
    );
  });
});
