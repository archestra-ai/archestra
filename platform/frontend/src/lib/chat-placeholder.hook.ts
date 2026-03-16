"use client";

import { useEffect, useMemo, useState } from "react";
import { useTypingAnimation } from "./typing-animation.hook";

interface UseChatPlaceholderParams {
  animate: boolean;
  placeholders: string[] | null | undefined;
}

export function useChatPlaceholder({
  animate,
  placeholders,
}: UseChatPlaceholderParams): {
  placeholder: string | null;
  isAnimating: boolean;
} {
  const validPlaceholders = useMemo(
    () => placeholders?.filter((placeholder) => placeholder.length > 0) ?? [],
    [placeholders],
  );
  const shouldAnimate = animate && validPlaceholders.length > 1;
  const validPlaceholdersKey = useMemo(
    () => validPlaceholders.join("\u0000"),
    [validPlaceholders],
  );
  const [staticSelection, setStaticSelection] = useState(() => ({
    key: `${shouldAnimate}:${validPlaceholdersKey}`,
    placeholder: shouldAnimate
      ? null
      : pickStaticPlaceholder(validPlaceholders),
  }));

  useEffect(() => {
    const nextKey = `${shouldAnimate}:${validPlaceholdersKey}`;

    setStaticSelection((currentSelection) => {
      if (currentSelection.key === nextKey) {
        return currentSelection;
      }

      return {
        key: nextKey,
        placeholder: shouldAnimate
          ? null
          : pickStaticPlaceholder(validPlaceholders),
      };
    });
  }, [shouldAnimate, validPlaceholders, validPlaceholdersKey]);
  const { text: animatedPlaceholder, isAnimating } = useTypingAnimation(
    shouldAnimate ? validPlaceholders : null,
  );

  if (shouldAnimate) {
    return {
      placeholder: isAnimating ? animatedPlaceholder : null,
      isAnimating,
    };
  }

  return {
    placeholder: staticSelection.placeholder,
    isAnimating: false,
  };
}

function pickStaticPlaceholder(placeholders: string[]): string | null {
  if (placeholders.length === 0) {
    return null;
  }

  if (placeholders.length === 1) {
    return placeholders[0];
  }

  const index = Math.floor(Math.random() * placeholders.length);
  return placeholders[index] ?? placeholders[0];
}
