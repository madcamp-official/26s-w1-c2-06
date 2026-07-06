import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

export function GuestRoute({ children }: { children: ReactNode }) {
  const user = useAuthStore((state) => state.user);
  if (user) return <Navigate to="/lobby" replace />;
  return <>{children}</>;
}
