"use client";

import { createContext } from "react";

interface AgentNodeContextValue {
  onEditAgent: (promptId: string) => void;
  onDeleteAgent: (promptId: string) => void;
  onConnectAgent: (promptId: string) => void;
}

export const AgentNodeContext = createContext<AgentNodeContextValue>({
  onEditAgent: () => {},
  onDeleteAgent: () => {},
  onConnectAgent: () => {},
});
