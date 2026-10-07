import type { ReactNode } from "react";
import { ValidationProvider } from "./validation-context";

export default function ValidationLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <ValidationProvider>{children}</ValidationProvider>;
}
