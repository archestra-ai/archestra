"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

const SettingsActionContext = createContext<{
  actionButton: ReactNode;
  setActionButton: (button: ReactNode) => void;
}>({ actionButton: null, setActionButton: () => {} });

export function SettingsActionProvider({ children }: { children: ReactNode }) {
  const [actionButton, setActionButton] = useState<ReactNode>(null);
  return (
    <SettingsActionContext.Provider value={{ actionButton, setActionButton }}>
      {children}
    </SettingsActionContext.Provider>
  );
}

export function useSettingsAction() {
  return useContext(SettingsActionContext);
}
