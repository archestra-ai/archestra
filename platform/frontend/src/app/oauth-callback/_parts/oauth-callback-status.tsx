import {
  AlertTriangle,
  ArrowRight,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { LoadingState } from "@/components/loading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type OAuthCallbackStatusProps =
  | {
      status: "processing";
      phase: "initializing" | "completing";
    }
  | {
      status: "error";
      errorTitle: string;
      errorDescription: string;
      actionLabel: string;
      onAction: () => void;
    };

export function OAuthCallbackStatus(props: OAuthCallbackStatusProps) {
  if (props.status === "error") {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Connection Not Completed</CardTitle>
          <CardDescription>
            Your existing MCP server setup was not changed.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>{props.errorTitle}</AlertTitle>
            <AlertDescription>{props.errorDescription}</AlertDescription>
          </Alert>
        </CardContent>

        <CardFooter>
          <Button className="w-full" onClick={props.onAction}>
            <span>{props.actionLabel}</span>
            <ArrowRight aria-hidden="true" />
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const copy = getProcessingCopy(props.phase);

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="size-6" aria-hidden="true" />
        </div>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-4">
          <LoadingState label={copy.loadingLabel} variant="inline" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {copy.statusTitle}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              This usually takes only a few seconds.
            </p>
          </div>
        </div>

        <div className="flex items-start justify-center gap-2 text-xs text-muted-foreground">
          <LockKeyhole
            className="mt-0.5 size-3.5 shrink-0"
            aria-hidden="true"
          />
          <p>
            Keep this page open. You'll return automatically when it's ready.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function getProcessingCopy(phase: "initializing" | "completing") {
  if (phase === "initializing") {
    return {
      title: "Preparing OAuth Connection",
      description: "Getting the secure authorization handoff ready.",
      loadingLabel: "Preparing OAuth authentication",
      statusTitle: "Reading authorization response",
    };
  }

  return {
    title: "Finishing OAuth Connection",
    description: "Your authorization is confirmed.",
    loadingLabel: "Completing OAuth authentication",
    statusTitle: "Securing credentials and connecting the MCP server",
  };
}
