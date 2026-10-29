import type { ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** One numbered step of "How your policy decides". */
export function StepCard({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-3 px-5">
        <CardTitle className="flex items-center gap-2.5 text-[15px]">
          <span
            aria-hidden
            className="bg-muted flex size-6.5 shrink-0 items-center justify-center rounded-full font-mono text-[13px] font-medium"
          >
            {step}
          </span>
          <span>{title}</span>
        </CardTitle>
        <CardDescription className="leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-1 flex-col gap-4 px-5">
        {children}
      </CardContent>
    </Card>
  );
}
