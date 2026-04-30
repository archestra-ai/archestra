"use client";

import { useTheme } from "next-themes";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "@/lib/utils";
import { CodeBlockContext } from "./code-block-context";

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
  contentStyle?: CSSProperties;
  contentClassName?: string;
  children?: ReactNode;
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  wrapLongLines = false,
  contentStyle,
  contentClassName,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-md border bg-background text-foreground",
          className,
        )}
        {...props}
      >
        <div className="relative">
          <SyntaxHighlighter
            className={cn("overflow-hidden", contentClassName)}
            codeTagProps={{
              className: "font-mono text-sm",
            }}
            customStyle={{
              margin: 0,
              padding: "1rem",
              fontSize: "0.875rem",
              background: "hsl(var(--background))",
              color: "hsl(var(--foreground))",
              ...contentStyle,
            }}
            language={language}
            lineNumberStyle={{
              color: "hsl(var(--muted-foreground))",
              paddingRight: "1rem",
              minWidth: "2.5rem",
            }}
            showLineNumbers={showLineNumbers}
            style={isDark ? oneDark : oneLight}
            wrapLongLines={wrapLongLines}
          >
            {code}
          </SyntaxHighlighter>
          {children && (
            <div className="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] items-center gap-2 overflow-hidden">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};
