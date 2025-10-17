"use client";

import { QueryErrorResetBoundary } from "@tanstack/react-query";
import type { ComponentProps, ComponentType } from "react";
import { ErrorBoundary as ReactErrorBoundary } from "react-error-boundary";
import { ClientErrorFallback } from "@/components/error-fallback";

type FallbackProps = {
  error: Error;
  resetErrorBoundary: () => void;
};

function DefaultFallbackComponent({
  error,
  resetErrorBoundary,
}: FallbackProps) {
  return (
    <ClientErrorFallback
      error={{ message: error.message, stack: error.stack }}
      resetErrorBoundary={resetErrorBoundary}
    />
  );
}

export function ErrorBoundary({
  children,
  FallbackComponent = DefaultFallbackComponent,
  onReset,
}: {
  children: React.ReactNode;
  FallbackComponent?: ComponentType<FallbackProps>;
  onReset?: ComponentProps<typeof ReactErrorBoundary>["onReset"];
}) {
  const onError = (_error: Error) => {
    // we can do sth else with the error here
  };

  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ReactErrorBoundary
          FallbackComponent={FallbackComponent}
          onError={onError}
          onReset={(details) => {
            reset();
            onReset?.(details);
          }}
        >
          {children}
        </ReactErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
