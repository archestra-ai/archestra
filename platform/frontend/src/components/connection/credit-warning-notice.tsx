import {
  PROVIDER_BILLING_BLOCK_BODY,
  PROVIDER_BILLING_BLOCK_TITLE,
} from "@archestra/shared";
import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Signal returned by the connection-setup endpoints when the bound Anthropic key
 * couldn't be confirmed to have a usable balance. Mirrors the backend
 * `creditWarning`. `insufficient_balance` is a definitive block (out of credit or
 * over a usage limit); `unverified` is a transient check failure. `keyName` names
 * the provider API key the verdict is about.
 */
export type ConnectionCreditWarning =
  | { kind: "insufficient_balance"; keyName: string }
  | { kind: "unverified"; keyName: string };

/**
 * Renders the connection-page warning when the Anthropic key a setup bound has no
 * (confirmable) usable balance. `insufficient_balance` is a definitive,
 * do-not-retry condition; `unverified` is a transient check failure the user can
 * retry. Renders nothing when there is no warning.
 */
export function CreditWarningNotice({
  warning,
}: {
  warning: ConnectionCreditWarning | null | undefined;
}) {
  if (!warning) return null;

  if (warning.kind === "insufficient_balance") {
    return (
      <Alert variant="warning" data-testid="connection-credit-warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{PROVIDER_BILLING_BLOCK_TITLE}</AlertTitle>
        <AlertDescription>
          {`Provider API key name: ${warning.keyName}. ${PROVIDER_BILLING_BLOCK_BODY}`}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="info" data-testid="connection-credit-warning">
      <Info className="h-4 w-4" />
      <AlertTitle>Couldn&apos;t verify the key&apos;s balance</AlertTitle>
      <AlertDescription>
        {`Provider API key name: ${warning.keyName}. We couldn't confirm its remaining balance right now (a temporary error). Setup still works; if requests fail, re-check the key or try again in a moment.`}
      </AlertDescription>
    </Alert>
  );
}
