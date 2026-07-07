import { apiFetch } from './client';
import type { PracticeSnippet } from '../types';

export function getPracticeSnippets() {
  return apiFetch<{ snippets: PracticeSnippet[] }>('/api/practice/snippets/');
}
