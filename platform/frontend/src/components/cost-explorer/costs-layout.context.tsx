"use client";

import { createContext, useContext } from "react";

type CostsLayoutContextType = {
  setActionButton: (button: React.ReactNode) => void;
};

export const CostsLayoutContext = createContext<CostsLayoutContextType>({
  setActionButton: () => {},
});

export function useSetCostsAction() {
  return useContext(CostsLayoutContext).setActionButton;
}
