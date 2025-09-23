import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SecurityTestState {
  dangerMode: boolean;
}

interface SecurityTestActions {
  setDangerMode: (enabled: boolean) => void;
}

type SecurityTestStore = SecurityTestState & SecurityTestActions;

export const useSecurityTestStore = create<SecurityTestStore>()(
  persist(
    (set) => ({
      dangerMode: false,
      setDangerMode: (enabled) => set({ dangerMode: enabled }),
    }),
    {
      name: 'archestra-security-test',
    }
  )
);
