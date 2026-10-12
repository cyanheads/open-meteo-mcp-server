/**
 * @fileoverview Test helper for the canvas-less truncated response: asserts the full
 * no-canvas disclosure reaches `content[]` exactly once (through the notice trailer)
 * while `format()` carries only the short pointer line.
 * @module tests/helpers/no-canvas
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';
import { firstText } from './content.js';

type CallToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A sentence only the full `noCanvasNotice()` carries. */
const FULL_DISCLOSURE =
  'There is no canvas_id because DataCanvas is disabled on this server (CANVAS_PROVIDER_TYPE=none).';

/** The opening only the short `noCanvasLine()` carries. */
const SHORT_LINE = '⚠️ Large result — bounded preview only; no canvas_id (DataCanvas disabled).';

/**
 * Asserts a canvas-less truncated `runToolContract` result carries the full disclosure
 * — the duckdb remedy and `levers` included — in `structuredContent.notice` and once
 * across all of `content[]`, and the short line naming `levers` in `content[0]`.
 */
export function expectNoCanvasDisclosureOnce(result: CallToolResult, levers: string): void {
  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as { notice?: string; truncated?: boolean };
  expect(structured.truncated).toBe(true);
  expect(structured.notice).toContain(FULL_DISCLOSURE);
  expect(structured.notice).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  expect(structured.notice).toContain(levers);

  const allText = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  expect(allText.split(FULL_DISCLOSURE)).toHaveLength(2);

  const formatted = firstText(result.content);
  expect(formatted).toContain(SHORT_LINE);
  expect(formatted).toContain(levers);
}
