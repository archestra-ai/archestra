"use client";

import { createContext, useContext } from "react";

type LlmProxyLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

/**
 * Lets a tab page hand its header action button up to the shared layout.
 * Lives outside layout.tsx because Next.js route files may only export route
 * entries.
 */
export const LlmProxyLayoutContext = createContext<LlmProxyLayoutContextType>({
  setActionButton: () => {},
});

export function useSetLlmProxyAction() {
  return useContext(LlmProxyLayoutContext).setActionButton;
}
