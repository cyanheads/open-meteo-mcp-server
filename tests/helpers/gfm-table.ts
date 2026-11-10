/**
 * @fileoverview Reads a Markdown table in `content[]` back through a GFM parser
 * (`markdown-it`'s default preset: tables and strikethrough), so a test asserts the
 * text each header and cell reads as, and any markup it opened, rather than the escape
 * bytes the tool wrote. `tests/helpers/commonmark.ts` parses no tables.
 * @module tests/helpers/gfm-table
 */
import MarkdownIt, { type Token } from 'markdown-it';

/** One parsed header or cell: the text a reader sees, and every markup token it opened. */
export interface GfmCell {
  /** Token types other than plain text: `em_open`, `link_open`, `code_inline`, `html_inline`, … */
  markup: string[];
  text: string;
}

const parsers = { off: new MarkdownIt(), on: new MarkdownIt({ html: true }) };

function readCell(children: readonly Token[]): GfmCell {
  let text = '';
  const markup: string[] = [];
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') {
      text += token.content;
    } else if (token.type === 'code_inline') {
      text += token.content;
      markup.push(token.type);
    } else if (!token.type.endsWith('_close')) {
      markup.push(token.type);
    }
  }
  return { markup, text };
}

/**
 * The first table in `markdown` as rows of cells, header row first; throws when the
 * text holds no table. `html: true` parses raw HTML as CommonMark does by default; the
 * GFM default preset leaves it off.
 */
export function gfmTable(markdown: string, options: { html?: boolean } = {}): GfmCell[][] {
  const tokens = parsers[options.html ? 'on' : 'off'].parse(markdown, {});
  const start = tokens.findIndex((token) => token.type === 'table_open');
  if (start === -1) throw new Error(`No table parsed from:\n${markdown}`);
  const rows: GfmCell[][] = [];
  for (let i = start; i < tokens.length && tokens[i]?.type !== 'table_close'; i++) {
    const token = tokens[i] as Token;
    if (token.type === 'tr_open') rows.push([]);
    if (token.type === 'th_open' || token.type === 'td_open') {
      const inline = tokens[i + 1];
      rows
        .at(-1)
        ?.push(
          inline?.type === 'inline' ? readCell(inline.children ?? []) : { markup: [], text: '' },
        );
    }
  }
  return rows;
}
