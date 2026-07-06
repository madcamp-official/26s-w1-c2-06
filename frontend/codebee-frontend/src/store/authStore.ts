import { create } from 'zustand';
import type { User } from '../types';
import { me as fetchMe } from '../api/auth';

interface AuthState {
  user: User | null;
  status: 'idle' | 'loading' | 'ready';
  checkAuth: () => Promise<void>;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'idle',
  checkAuth: async () => {
    set({ status: 'loading' });
    try {
      const user = await fetchMe();
      set({ user, status: 'ready' });
    } catch {
      set({ user: null, status: 'ready' });
    }
  },
  setUser: (user) => set({ user }),
}));
