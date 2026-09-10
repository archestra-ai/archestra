"use client";

import type { CSSProperties } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeBlockHighlighterProps {
  className?: string;
  code: string;
  contentStyle?: CSSProperties;
  isDark: boolean;
  language: string;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
}

export function CodeBlockHighlighter({
  className,
  code,
  contentStyle,
  isDark,
  language,
  showLineNumbers,
  wrapLongLines,
}: CodeBlockHighlighterProps) {
  return (
    <SyntaxHighlighter
      className={className}
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
  );
}
