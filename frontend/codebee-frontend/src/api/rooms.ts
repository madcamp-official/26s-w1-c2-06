import { apiFetch } from './client';
import type { Room } from '../types';

export function createRoom() {
  return apiFetch<Room>('/api/rooms/', { method: 'POST' });
}

export function joinRoom(code: string) {
  return apiFetch<Room>(`/api/rooms/${encodeURIComponent(code)}/join/`, { method: 'POST' });
}

export function getRoom(code: string) {
  return apiFetch<Room>(`/api/rooms/${encodeURIComponent(code)}/`);
}
