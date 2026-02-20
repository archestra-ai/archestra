import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface StepCardProps {
  stepNumber: number;
  title: string;
  children: React.ReactNode;
  className?: string;
}

export function StepCard({
  stepNumber,
  title,
  children,
  className,
}: StepCardProps) {
  return (
    <div
      className={cn(
        "relative items-start rounded-lg border bg-muted/30 p-2",
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-2">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Step {stepNumber}
          </Badge>
          <h3 className="text-lg font-semibold">{title}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}
