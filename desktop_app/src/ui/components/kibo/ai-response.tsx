'use client';

import type { HTMLAttributes } from 'react';
import { memo } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@ui/lib/utils/tailwind';

import {
  type BundledLanguage,
  CodeBlock,
  CodeBlockBody,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockFiles,
  CodeBlockHeader,
  CodeBlockItem,
  type CodeBlockProps,
  CodeBlockSelect,
  CodeBlockSelectContent,
  CodeBlockSelectItem,
  CodeBlockSelectTrigger,
  CodeBlockSelectValue,
} from './code-block';

export type AIResponseProps = HTMLAttributes<HTMLDivElement> & {
  options?: Options;
  children: Options['children'];
};

const components: Options['components'] = {
  ol: ({ node, children, className, ...props }) => (
    <ol className={cn('list-inside pl-0.5 list-decimal', className)} {...props}>
      {children}
    </ol>
  ),
  li: ({ node, children, className, ...props }) => (
    <li className={cn('py-1', className)} {...props}>
      {children}
    </li>
  ),
  ul: ({ node, children, className, ...props }) => (
    <ul className={cn('list-inside pl-0.5 list-disc', className)} {...props}>
      {children}
    </ul>
  ),
  strong: ({ node, children, className, ...props }) => (
    <span className={cn('font-semibold', className)} {...props}>
      {children}
    </span>
  ),
  a: ({ node, children, className, href, ...props }) => {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (href) {
        e.preventDefault();
        if (window.electronAPI?.openExternal) {
          window.electronAPI.openExternal(href);
        } else {
          window.open(href, '_blank');
        }
      }
    };

    return (
      <a
        className={cn('font-medium text-primary underline', className)}
        rel="noreferrer"
        href={href}
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    );
  },
  h1: ({ node, children, className, ...props }) => (
    <h1 className={cn('mt-6 mb-2 font-semibold text-3xl', className)} {...props}>
      {children}
    </h1>
  ),
  h2: ({ node, children, className, ...props }) => (
    <h2 className={cn('mt-6 mb-2 font-semibold text-2xl', className)} {...props}>
      {children}
    </h2>
  ),
  h3: ({ node, children, className, ...props }) => (
    <h3 className={cn('mt-6 mb-2 font-semibold text-xl', className)} {...props}>
      {children}
    </h3>
  ),
  h4: ({ node, children, className, ...props }) => (
    <h4 className={cn('mt-6 mb-2 font-semibold text-lg', className)} {...props}>
      {children}
    </h4>
  ),
  h5: ({ node, children, className, ...props }) => (
    <h5 className={cn('mt-6 mb-2 font-semibold text-base', className)} {...props}>
      {children}
    </h5>
  ),
  h6: ({ node, children, className, ...props }) => (
    <h6 className={cn('mt-6 mb-2 font-semibold text-sm', className)} {...props}>
      {children}
    </h6>
  ),
  pre: ({ node, className, children }) => {
    let language = 'javascript';
    if (typeof node?.properties?.className === 'string') {
      language = node.properties.className.replace('language-', '');
    }
    const childrenIsCode =
      typeof children === 'object' && children !== null && 'type' in children && children.type === 'code';
    if (!childrenIsCode) {
      return <pre>{children}</pre>;
    }
    const data: CodeBlockProps['data'] = [
      {
        language,
        filename: 'index.js',
        code: (children.props as { children: string }).children,
      },
    ];
    return (
      <CodeBlock className={cn('my-4 h-auto', className)} data={data} defaultValue={data[0].language}>
        <CodeBlockHeader>
          <CodeBlockFiles>
            {(item) => (
              <CodeBlockFilename key={item.language} value={item.language}>
                {item.filename}
              </CodeBlockFilename>
            )}
          </CodeBlockFiles>
          <CodeBlockSelect>
            <CodeBlockSelectTrigger>
              <CodeBlockSelectValue />
            </CodeBlockSelectTrigger>
            <CodeBlockSelectContent>
              {(item) => (
                <CodeBlockSelectItem key={item.language} value={item.language}>
                  {item.language}
                </CodeBlockSelectItem>
              )}
            </CodeBlockSelectContent>
          </CodeBlockSelect>
          <CodeBlockCopyButton />
        </CodeBlockHeader>
        <CodeBlockBody>
          {(item) => (
            <CodeBlockItem key={item.language} value={item.language}>
              <CodeBlockContent language={item.language as BundledLanguage}>{item.code}</CodeBlockContent>
            </CodeBlockItem>
          )}
        </CodeBlockBody>
      </CodeBlock>
    );
  },
};

export const AIResponse = memo(
  ({ className, options, children, ...props }: AIResponseProps) => (
    <div className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)} {...props}>
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]} {...options}>
        {children}
      </ReactMarkdown>
    </div>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);
