"use client";

import { useEffect, useState } from "react";
import { useHealth } from "@/lib/health.query";

interface VersionProps {
  inline?: boolean;
}

export function Version({ inline = false }: VersionProps) {
  const { data } = useHealth();
  const [shouldHide, setShouldHide] = useState(false);

  useEffect(() => {
    // Only check for hide-version class if not inline
    if (inline) return;

    // Check if the hide-version class is present on body
    const checkHideClass = () => {
      setShouldHide(document.body.classList.contains("hide-version"));
    };

    // Initial check
    checkHideClass();

    // Listen for class changes
    const observer = new MutationObserver(checkHideClass);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [inline]);

  if (!inline && shouldHide) {
    return null;
  }

  return (
    <>
      {data?.version && (
        <div
          className={
            inline
              ? "text-xs text-muted-foreground"
              : "text-xs text-muted-foreground text-center py-4"
          }
        >
          Version: {data.version}
        </div>
      )}
    </>
  );
}
