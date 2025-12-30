import { cn } from "@/lib/utils";

export function CodeText({
  children,
  className,
  language,
}: {
  children: React.ReactNode;
  className?: string;
  language?: string;
}) {
  return (
    <code className={cn("text-sm bg-muted px-1 py-0.5 rounded", className)} data-language={language}>
      {children}
    </code>
  );
}
