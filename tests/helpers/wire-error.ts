/**
 * @fileoverview Runs a tool through the production-shaped contract pipeline and
 * returns the error envelope a client receives — the surface where the framework
 * fills a declared reason's `data.recovery.hint`.
 * @module tests/helpers/wire-error
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';

type ToolDefinition = Parameters<typeof runToolContract>[0];

/** The `structuredContent.error` envelope of a failed tool call. */
export interface WireError {
  code: number;
  data?: { reason?: string; recovery?: { hint: string }; [key: string]: unknown };
  message: string;
}

/** Calls `definition` with `input` and returns its error envelope; fails when the call succeeds. */
export async function wireError<TDefinition extends ToolDefinition>(
  definition: TDefinition,
  input: Parameters<typeof runToolContract<TDefinition>>[1],
  options?: Parameters<typeof runToolContract>[2],
): Promise<WireError> {
  const result = await runToolContract(definition, input, options);
  if (!result.isError) {
    throw new Error(`Expected ${definition.name} to fail, but it succeeded.`);
  }
  return (result.structuredContent as { error: WireError }).error;
}
