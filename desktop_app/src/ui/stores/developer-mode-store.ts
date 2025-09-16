import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_SYSTEM_PROMPT } from '../../constants';

interface DeveloperModeState {
  isDeveloperMode: boolean;
  systemPrompt: string;
}

interface DeveloperModeActions {
  toggleDeveloperMode: () => void;
  setSystemPrompt: (prompt: string) => void;
}

type DeveloperModeStore = DeveloperModeState & DeveloperModeActions;

const STORAGE_KEY = 'archestra-developer-mode';

export const useDeveloperModeStore = create<DeveloperModeStore>()(
  persist(
    (set) => ({
      isDeveloperMode: false,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,

      toggleDeveloperMode: () => set((state) => ({ isDeveloperMode: !state.isDeveloperMode })),

      setSystemPrompt: (prompt: string) => set({ systemPrompt: prompt }),
    }),
    {
      name: STORAGE_KEY,
    }
  )
);
