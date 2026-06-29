"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface TypingTextProps {
  text: string;
  className?: string;
  typingSpeed?: number;
  initialDelay?: number;
  onComplete?: () => void;
  showCursor?: boolean;
  cursorClassName?: string;
}

/**
 * Typing text animation component
 * Inspired by https://www.shadcn.io/text/typing-text
 */
export function TypingText({
  text,
  className,
  typingSpeed = 40,
  initialDelay = 0,
  onComplete,
  showCursor = true,
  cursorClassName,
}: TypingTextProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isTypingComplete, setIsTypingComplete] = useState(false);

  useEffect(() => {
    // Reset when text changes
    setDisplayedText("");
    setIsTypingComplete(false);

    let currentIndex = 0;
    let timeout: NodeJS.Timeout;

    const startTyping = () => {
      if (currentIndex < text.length) {
        timeout = setTimeout(() => {
          setDisplayedText(text.slice(0, currentIndex + 1));
          currentIndex++;
          startTyping();
        }, typingSpeed);
      } else {
        setIsTypingComplete(true);
        onComplete?.();
      }
    };

    // Start with initial delay
    timeout = setTimeout(startTyping, initialDelay);

    return () => clearTimeout(timeout);
  }, [text, typingSpeed, initialDelay, onComplete]);

  return (
    <span className={cn("inline-flex items-center", className)}>
      <span>{displayedText}</span>
      {showCursor && !isTypingComplete && (
        <span
          className={cn(
            "ml-0.5 inline-block w-[2px] h-[1em] bg-current",
            cursorClassName,
          )}
        />
      )}
    </span>
  );
}
