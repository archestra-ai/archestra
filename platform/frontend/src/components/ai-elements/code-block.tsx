"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useTheme } from "next-themes";
import type {
  ComponentProps,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
} from "react";
import { createContext, lazy, Suspense, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const CodeBlockHighlighter = lazy(async () => {
  const module = await import("./code-block-highlighter");
  return { default: module.CodeBlockHighlighter };
});

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
        {/* biome-ignore-start lint/a11y/noNoninteractiveTabindex: scrollable code regions must be keyboard focusable (WCAG 2.1.1) */}
        <section
          className="relative"
          tabIndex={0}
          aria-label={`Code sample, ${language}`}
        >
          <Suspense
            fallback={
              <CodeBlockFallback
                code={code}
                language={language}
                showLineNumbers={showLineNumbers}
                wrapLongLines={wrapLongLines}
                contentStyle={contentStyle}
                className={cn("overflow-hidden", contentClassName)}
              />
            }
          >
            <CodeBlockHighlighter
              className={cn("overflow-hidden", contentClassName)}
              code={code}
              contentStyle={contentStyle}
              isDark={isDark}
              language={language}
              showLineNumbers={showLineNumbers}
              wrapLongLines={wrapLongLines}
            />
          </Suspense>
          {children && (
            <div className="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] items-center gap-2 overflow-hidden">
              {children}
            </div>
          )}
        </section>
        {/* biome-ignore-end lint/a11y/noNoninteractiveTabindex: scrollable code regions must be keyboard focusable (WCAG 2.1.1) */}
      </div>
    </CodeBlockContext.Provider>
  );
};

function CodeBlockFallback({
  code,
  showLineNumbers = false,
  wrapLongLines = false,
  contentStyle,
  className,
}: CodeBlockProps) {
  const lines = code.split("\n");

  return (
    <pre
      className={className}
      style={{
        margin: 0,
        padding: "1rem",
        fontSize: "0.875rem",
        background: "hsl(var(--background))",
        color: "hsl(var(--foreground))",
        whiteSpace: wrapLongLines ? "pre-wrap" : "pre",
        overflowWrap: wrapLongLines ? "anywhere" : undefined,
        ...contentStyle,
      }}
    >
      <code className="font-mono text-sm">
        {showLineNumbers
          ? lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line positions are the line-number identity in this static code snapshot
              <span className="block" key={`${index}-${line}`}>
                <span
                  className="inline-block min-w-10 pr-4 text-muted-foreground"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span>{index < lines.length - 1 ? `${line}\n` : line}</span>
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      aria-label={isCopied ? "Copied!" : "Copy to clipboard"}
      className={cn("shrink-0", className)}
      onClick={handleCopy}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
