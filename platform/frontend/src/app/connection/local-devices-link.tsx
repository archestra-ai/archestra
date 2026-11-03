"use client";

import { ArrowRight, Laptop } from "lucide-react";
import Link from "next/link";
import { useOrganization } from "@/lib/organization.query";

/**
 * A one-line pointer from Connect to Personal Settings → Devices, where a
 * person adds their own computers. Hidden while the organization has local
 * devices turned off.
 */
export function LocalDevicesLink() {
  const organization = useOrganization();
  if (organization.data?.deviceMcpEnabled !== true) return null;
  return (
    <Link
      href="/account/devices"
      title="Connect also installs a background agent on this computer using Node.js 22 or newer. Manage your connected computers in Devices."
      className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
    >
      <Laptop aria-hidden className="size-3.5 shrink-0" />
      <span>Local devices</span>
      <ArrowRight aria-hidden className="size-3 shrink-0" />
    </Link>
  );
}
