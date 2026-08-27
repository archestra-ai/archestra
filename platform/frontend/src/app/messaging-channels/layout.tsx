"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

/** Keep old bookmarks working after provider setup moved under Settings. */
export default function LegacyMessagingChannelsLayout({
  children: _children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname === "/messaging-channels/a2a") {
      router.replace("/agents");
      return;
    }
    router.replace(
      pathname.replace("/messaging-channels", "/settings/messaging-channels"),
    );
  }, [pathname, router]);

  return null;
}
