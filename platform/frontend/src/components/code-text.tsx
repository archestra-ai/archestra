import { cn } from "@/lib/utils";

export function CodeText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <code className={cn("text-sm bg-muted px-1 py-0.5 rounded", className)}>
      {children}
    </code>
  );
}
