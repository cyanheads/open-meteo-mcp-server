/**
 * @fileoverview Reads `content[]` Markdown back through a real CommonMark
 * parser (`markdown-it`), so a test asserts what a client renders rather than
 * which escape or code-span bytes the framework wrote.
 * @module tests/helpers/commonmark
 */
import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('commonmark');

function inlineText(children: Token[]): string {
  return children
    .map((token) => {
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
      if (token.type === 'text' || token.type === 'text_special' || token.type === 'code_inline') {
        return token.content;
      }
      return '';
    })
    .join('');
}

/**
 * The plain text a CommonMark parse of `markdown` reads as: each inline run's
 * text with emphasis, code-span, and escape markup resolved, and each code
 * block's content, joined by line breaks.
 */
export function renderedText(markdown: string): string {
  return parser
    .parse(markdown, {})
    .flatMap((token) => {
      if (token.type === 'inline') return [inlineText(token.children ?? [])];
      if (token.type === 'fence' || token.type === 'code_block') return [token.content];
      return [];
    })
    .join('\n');
}
