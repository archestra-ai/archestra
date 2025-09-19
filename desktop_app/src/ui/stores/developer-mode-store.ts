import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_SYSTEM_PROMPT } from '@constants';

interface DeveloperModeState {
  isDeveloperMode: boolean;
  customSystemPrompt: string | null;
}

interface DeveloperModeActions {
  toggleDeveloperMode: () => void;
  setCustomSystemPrompt: (prompt: string) => void;
  getSystemPrompt: () => string;
}

type DeveloperModeStore = DeveloperModeState & DeveloperModeActions;

export const useDeveloperModeStore = create<DeveloperModeStore>()(
  persist(
    (set, get) => ({
      isDeveloperMode: false,
      customSystemPrompt: null,

      toggleDeveloperMode: () => set((state) => ({ isDeveloperMode: !state.isDeveloperMode })),

      setCustomSystemPrompt: (customSystemPrompt: string) => set({ customSystemPrompt }),

      getSystemPrompt: () => get().customSystemPrompt || DEFAULT_SYSTEM_PROMPT,
    }),
    {
      name: 'archestra-developer-mode',
    }
  )
);
