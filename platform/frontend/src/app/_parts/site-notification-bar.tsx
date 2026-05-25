"use client";

import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      const code = String(children).replace(/\n$/, "");
      return (
        <code className={className} {...props}>
          {code}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

interface SiteNotificationBarProps {
  content: string;
  onDismiss?: () => void;
}

export function SiteNotificationBar({
  content,
  onDismiss,
}: SiteNotificationBarProps) {
  const [dismissed, setDismissed] = useState(false);
  const [barHeight, setBarHeight] = useState(0);
  const [barBounds, setBarBounds] = useState({ left: 0, width: 0 });
  const placeholderRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (dismissed) {
      return;
    }

    const updateLayout = () => {
      const placeholderRect = placeholderRef.current?.getBoundingClientRect();
      const fixedBarRect = barRef.current?.getBoundingClientRect();

      if (placeholderRect) {
        setBarBounds({
          left: placeholderRect.left,
          width: placeholderRect.width,
        });
      }
      if (fixedBarRect) {
        setBarHeight(fixedBarRect.height);
      }
    };

    updateLayout();

    const resizeObserver = new ResizeObserver(updateLayout);
    if (placeholderRef.current) resizeObserver.observe(placeholderRef.current);
    if (barRef.current) resizeObserver.observe(barRef.current);
    window.addEventListener("resize", updateLayout);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateLayout);
    };
  }, [dismissed]);

  if (dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <>
      <div ref={placeholderRef} style={{ height: barHeight }} />
      <div
        ref={barRef}
        className="fixed top-0 z-40 bg-muted border-b border-border px-4 py-2"
        style={{
          left: barBounds.left,
          width: barBounds.width || undefined,
        }}
      >
        <div className="max-w-7xl mx-auto flex items-start gap-3">
          <div className="flex-1 text-sm [&_p]:my-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {content}
            </ReactMarkdown>
          </div>
          {onDismiss && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              onClick={handleDismiss}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
