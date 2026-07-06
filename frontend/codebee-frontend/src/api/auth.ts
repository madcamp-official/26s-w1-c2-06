import { apiFetch } from './client';
import type { User } from '../types';

export function fetchCsrf() {
  return apiFetch<void>('/api/csrf/');
}

export function signup(username: string, password: string) {
  return apiFetch<User>('/api/signup/', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function login(username: string, password: string) {
  return apiFetch<User>('/api/login/', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return apiFetch<{ detail: string }>('/api/logout/', { method: 'POST' });
}

export function me() {
  return apiFetch<User>('/api/me/');
}
