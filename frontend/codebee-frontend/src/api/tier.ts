import { apiFetch } from './client';
import type { TierInfo } from '../types';

export function getMyTier() {
  return apiFetch<TierInfo>('/api/me/tier/');
}
