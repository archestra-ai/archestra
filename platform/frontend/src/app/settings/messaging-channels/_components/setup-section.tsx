import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ExternalDocsLink } from "./external-docs-link";

export function SetupSection({
  allStepsCompleted,
  isLoading,
  providerLabel,
  docsUrl,
  children,
}: {
  allStepsCompleted: boolean;
  isLoading: boolean;
  providerLabel: string;
  docsUrl: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Setup</h2>
            {!isLoading && allStepsCompleted && (
              <Badge
                variant="secondary"
                className="border-green-500/70 bg-green-500/10 text-green-600"
              >
                <CheckCircle2 className="size-3" />
                Completed
              </Badge>
            )}
          </div>
          <ExternalDocsLink href={docsUrl} className="text-xs">
            Learn more
          </ExternalDocsLink>
        </div>
        {!isLoading && (
          <p className="mt-1 text-xs text-muted-foreground">
            Connect {providerLabel} so agents can receive and respond to
            messages.
          </p>
        )}
      </div>
      {!isLoading && children}
    </section>
  );
}
