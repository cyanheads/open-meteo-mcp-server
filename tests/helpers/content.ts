/**
 * @fileoverview Test helpers for narrowing MCP SDK content-block unions.
 * @module tests/helpers/content
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';

/** Returns the first text block's content, or an empty string when none exists. */
export function firstText(blocks: readonly ContentBlock[]): string {
  const block = blocks.find((candidate) => candidate.type === 'text');
  return block?.type === 'text' ? block.text : '';
}
