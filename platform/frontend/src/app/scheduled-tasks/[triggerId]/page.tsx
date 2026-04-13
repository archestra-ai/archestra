"use client";

import { useParams } from "next/navigation";
import { ScheduleTriggerDetailPage } from "../schedule-triggers-client";

export default function Page() {
  const params = useParams<{ triggerId: string }>();
  const triggerId =
    typeof params?.triggerId === "string" ? params.triggerId : "";

  return <ScheduleTriggerDetailPage triggerId={triggerId} />;
}
