import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

export function MarkdownView(props: { content: string; className?: string }): JSX.Element {
  const cls = props.className ? `markdown-view ${props.className}` : 'markdown-view';
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {props.content}
      </ReactMarkdown>
    </div>
  );
}
