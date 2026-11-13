"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFeature } from "@/lib/config/config.query";
import { DevicesCard } from "./_parts/devices-card";

export default function AccountDevicesPage() {
  const router = useRouter();
  // Desktop MCP is in alpha, behind the beta flag: without it there is no
  // Device tab, and a link to it lands on Account.
  const betaEnabled = useFeature("betaEnabled");
  useEffect(() => {
    if (betaEnabled === false) router.replace("/account");
  }, [betaEnabled, router]);
  if (betaEnabled !== true) return null;
  return <DevicesCard />;
}
