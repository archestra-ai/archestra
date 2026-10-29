import type { ReactNode } from "react";
import { ValidationProvider } from "./_parts/validation-context";
import { ValidationRunnerProvider } from "./_parts/validation-runner";

export default function ValidationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <ValidationProvider>
      <ValidationRunnerProvider>{children}</ValidationRunnerProvider>
    </ValidationProvider>
  );
}
