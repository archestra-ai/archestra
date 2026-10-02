import { notFound } from "next/navigation";
import { isConnectPrototypePlaygroundEnabled } from "./_parts/prototype-gate";

// Read the opt-in flag per request so one image can enable it per deployment.
export const dynamic = "force-dynamic";

export default function ConnectPrototypeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isConnectPrototypePlaygroundEnabled(process.env)) notFound();
  return children;
}
