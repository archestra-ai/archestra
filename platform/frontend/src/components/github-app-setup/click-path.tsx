import { Fragment, type ReactNode } from "react";

/**
 * What to click on the Git host, in order, joined by arrows. A label the
 * host shows is given as a string and stands out; anything else (a link
 * there, "your policy repository") is given with its own key and reads as
 * plain text. Guidance for the host is written as one of these, not as a
 * sentence.
 */
export function ClickPath({
  steps,
  className,
}: {
  steps: readonly (string | { key: string; label: ReactNode })[];
  className?: string;
}) {
  return (
    <span className={className}>
      {steps.map((step, index) => (
        <Fragment key={typeof step === "string" ? step : step.key}>
          {index > 0 ? <span> → </span> : null}
          {typeof step === "string" ? (
            <span className="font-medium text-foreground">{step}</span>
          ) : (
            <span>{step.label}</span>
          )}
        </Fragment>
      ))}
    </span>
  );
}
