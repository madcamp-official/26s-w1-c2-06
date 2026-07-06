import { apiFetch } from './client';
import type { LeaderboardEntry, Room } from '../types';

export function createRoom() {
  return apiFetch<Room>('/api/rooms/', { method: 'POST' });
}

export function joinRoom(code: string) {
  return apiFetch<Room>(`/api/rooms/${encodeURIComponent(code)}/join/`, { method: 'POST' });
}

export function getRoom(code: string) {
  return apiFetch<Room>(`/api/rooms/${encodeURIComponent(code)}/`);
}

export function getLeaderboard() {
  return apiFetch<{ entries: LeaderboardEntry[]; me: LeaderboardEntry | null }>('/api/leaderboard/');
}
