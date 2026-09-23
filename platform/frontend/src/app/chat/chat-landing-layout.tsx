import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ChatLandingLayoutProps {
  title: string;
  description: ReactNode;
  suggestions?: ReactNode;
  children: ReactNode;
  headingLevel?: 1 | 2;
  className?: string;
}

export function ChatLandingLayout({
  title,
  description,
  suggestions,
  children,
  headingLevel = 2,
  className,
}: ChatLandingLayoutProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col justify-center gap-4",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-4xl">
        <Heading className="text-xl font-semibold tracking-tight">
          {title}
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {suggestions && (
        <div className="mx-auto w-full max-w-4xl">{suggestions}</div>
      )}
      <div className="mx-auto w-full max-w-4xl">{children}</div>
    </div>
  );
}
