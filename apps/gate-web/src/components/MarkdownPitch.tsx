import { Fragment, type ReactNode } from 'react';
import { validateMarkdown, type MarkdownToken } from '../gate-domain';

/**
 * Renders the frozen CommonMark allowlist — and nothing else.
 *
 * The allowlist itself lives in `@gavel/gate`, shared byte-for-byte with the
 * server that validates submissions. This component only walks the token stream
 * that validator produced. It never uses `dangerouslySetInnerHTML`, so there is
 * no path by which raw HTML, an image, an embed, a stylesheet, a script, or a
 * Mermaid diagram could reach the DOM even if the allowlist were bypassed.
 * Content the validator rejects renders as a notice, never as a best effort.
 */

interface Node {
  token: MarkdownToken;
  children: Node[];
}

function buildTree(tokens: MarkdownToken[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const token of tokens) {
    const target = stack[stack.length - 1];
    if (token.nesting === 1) {
      const node: Node = { token, children: [] };
      target.push(node);
      stack.push(node.children);
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else {
      target.push({ token, children: [] });
    }
  }
  return root;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function renderNodes(nodes: Node[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderNode(node)}</Fragment>);
}

function renderNode(node: Node): ReactNode {
  const { token, children } = node;
  switch (token.type) {
    case 'inline':
      return renderNodes(buildTree(token.children ?? []));
    case 'text':
      return token.content;
    case 'softbreak':
      return ' ';
    case 'hardbreak':
      return <br />;
    case 'code_inline':
      return <code>{token.content}</code>;
    case 'fence':
      return (
        <pre>
          <code>{token.content}</code>
        </pre>
      );
    case 'paragraph_open':
      // Tight list items mark their paragraph hidden; honour that so list text
      // is not wrapped in a stray block.
      return token.hidden ? <>{renderNodes(children)}</> : <p>{renderNodes(children)}</p>;
    case 'heading_open': {
      const Tag = (HEADING_TAGS.has(token.tag) ? token.tag : 'h3') as 'h1';
      return <Tag>{renderNodes(children)}</Tag>;
    }
    case 'blockquote_open':
      return <blockquote>{renderNodes(children)}</blockquote>;
    case 'bullet_list_open':
      return <ul>{renderNodes(children)}</ul>;
    case 'ordered_list_open':
      return <ol>{renderNodes(children)}</ol>;
    case 'list_item_open':
      return <li>{renderNodes(children)}</li>;
    case 'strong_open':
      return <strong>{renderNodes(children)}</strong>;
    case 'em_open':
      return <em>{renderNodes(children)}</em>;
    case 'link_open': {
      // The validator has already proven this destination is absolute HTTPS.
      const href = token.attrGet('href') ?? '';
      return (
        <a className="external-link" href={href} rel="noopener noreferrer" target="_blank">
          {renderNodes(children)}
          <span className="external-indicator" aria-label="external link">
            ↗
          </span>
        </a>
      );
    }
    default:
      // Unreachable for validated content; refusing is safer than guessing.
      return null;
  }
}

export interface MarkdownPitchProps {
  source: string;
  className?: string;
}

export function MarkdownPitch({ source, className }: MarkdownPitchProps) {
  let tokens: MarkdownToken[];
  try {
    tokens = validateMarkdown(source).tokens;
  } catch {
    // The reason is deliberately coarse: it never echoes the rejected content.
    return (
      <div role="alert" className="notice notice-error">
        This content cannot be displayed. It uses Markdown that Gavel Gate does not allow.
      </div>
    );
  }
  return <div className={className ? `markdown ${className}` : 'markdown'}>{renderNodes(buildTree(tokens))}</div>;
}
