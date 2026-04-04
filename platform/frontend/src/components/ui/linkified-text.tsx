import type { ReactNode } from "react";

const URL_REGEX = /(https?:\/\/[^\s,)}\]>]+)/g;

/**
 * Renders text with URLs automatically converted to clickable links
 * that open in a new tab. Pass as children to any text container.
 */
export function LinkifiedText({ children }: { children: string }) {
  const parts = children.split(URL_REGEX);
  const result: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (URL_REGEX.test(part)) {
      result.push(
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:no-underline"
        >
          {part}
        </a>,
      );
    } else {
      result.push(part);
    }
  }

  return <>{result}</>;
}
