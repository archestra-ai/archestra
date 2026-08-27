"use client";

import { useSearchParams } from "next/navigation";
import { UserCredentialsCard } from "@/app/account/_components/user-credentials-card";

export default function AccountCredentialsPage() {
  // Deep-link from a "this runner needs credentials you have not set up"
  // refusal: ?add=KEY_A,KEY_B pre-fills the first key so the person lands
  // ready to paste a value rather than retyping the variable name.
  const searchParams = useSearchParams();
  const requestedKeys = (searchParams.get("add") ?? "")
    .split(",")
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);

  return <UserCredentialsCard requestedKeys={requestedKeys} />;
}
