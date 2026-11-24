import chalk from 'chalk';
import { fromMarkdown } from 'mdast-util-from-markdown';
import wrapAnsi from 'wrap-ansi';
import { stripControl } from './format.js';

type Block = ReturnType<typeof fromMarkdown>['children'][number];
type Inline = Extract<Block, { type: 'paragraph' }>['children'][number];

function inlineText(nodes: Inline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': return stripControl(node.value).replace(/\n/g, ' ');
      case 'strong': return chalk.bold(inlineText(node.children));
      case 'emphasis': return chalk.italic(inlineText(node.children));
      case 'inlineCode': return chalk.cyan(stripControl(node.value));
      case 'link': {
        const label = inlineText(node.children);
        const url = stripControl(node.url).replace(/\s/g, '');
        return /^https?:\/\//i.test(url) && stripControl(label) !== url ? `${label} (${url})` : chalk.underline(label);
      }
      case 'linkReference': return chalk.underline(inlineText(node.children));
      case 'image':
      case 'imageReference': return stripControl(node.alt ?? '');
      case 'break': return '\n';
      case 'html': return stripControl(node.value);
      default: return '';
    }
  }).join('');
}

function blockRows(node: Block, width: number): string[] {
  const wrap = (text: string) => wrapAnsi(text, Math.max(1, width), { hard: true }).split('\n');
  switch (node.type) {
    case 'heading': return wrap(chalk.bold(inlineText(node.children)));
    case 'paragraph': return wrap(inlineText(node.children));
    case 'blockquote': return node.children.flatMap((child) => blockRows(child, width - 2).map((row) => `│ ${row}`));
    case 'list': return node.children.flatMap((item, index) => {
      const bullet = node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
      return item.children.flatMap((child) => blockRows(child, width - bullet.length))
        .map((row, line) => `${line === 0 ? bullet : ' '.repeat(bullet.length)}${row}`);
    });
    case 'code': return wrapAnsi(stripControl(node.value), Math.max(1, width - 2), { hard: true, trim: false, wordWrap: false })
      .split('\n').map((row) => `│ ${chalk.cyan(row)}`);
    case 'html': return wrap(stripControl(node.value));
    case 'thematicBreak': return ['─'.repeat(Math.max(1, Math.min(12, width)))];
    default: return [];
  }
}

export function markdownRows(text: string, width: number): string[] {
  const blocks = fromMarkdown(text).children.map((block) => blockRows(block, width)).filter((rows) => rows.length > 0);
  return blocks.flatMap((rows, index) => index === 0 ? rows : ['', ...rows]);
}
