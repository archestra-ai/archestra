"use client";

import { LocalDeviceCards } from "@/app/account/_parts/local-device-cards";
import { useLocalDevicesController } from "@/app/account/_parts/use-local-devices-controller";

export default function AccountDevicesPage() {
  const controller = useLocalDevicesController();
  return <LocalDeviceCards controller={controller} />;
}
