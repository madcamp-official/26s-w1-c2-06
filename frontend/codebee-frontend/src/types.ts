import type { Tier } from './lib/tier';

export interface User {
  id: number;
  username: string;
}

// GET /api/me/tier/ 응답 — rating은 백엔드가 미리 계산해서 내려줌(TIER_INDEX*100+tier_score).
export interface TierInfo {
  tier: Tier;
  tier_score: number;
  rating: number;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface Room {
  code: string;
  status: RoomStatus;
  player1: string | null;
  player2: string | null;
  is_host: boolean;
}

// 상대방을 방해하는 아이템 — 서버가 스폰 시점에 결정해서 정답 코드에만 붙인다
// (docs/plan/game-items.md)
export type ItemType = 'alert' | 'ink';

export interface FallingCode {
  codeId: string;
  text: string;
  spawnTs: number; // 서버 기준 epoch ms
  duration: number; // 이 코드의 낙하 시간(ms) — 서버가 텍스트 길이 기준으로 계산해 내려줌
  item?: ItemType | null; // 배지 표시용 — 스폰 시점에 이미 결정돼 있음
  resolution?: { correct: boolean; userId: number } | null; // 판정 후 날아가는 연출용, 판정 전엔 없음
}

// 발동된 아이템 효과 — ink/alert 둘 다 중첩(겹쳐 쌓임) 방식이라 배열로 관리
export interface ActiveItemEffect {
  id: string;
  type: ItemType;
  spawnedAt: number; // 로컬 Date.now() 기준, 지속시간 경과 판단용
}

// user_id(string) → 이번 판 누적 점수
export type ScoreBoard = Record<string, number>;

export interface GameOverInfo {
  scores: ScoreBoard;
  winnerId: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  total_score: number;
}

export interface WorstEntry {
  username: string;
  total_score: number;
}

export interface ScorePop {
  id: string;
  userId: number;
  delta: number;
}

export interface PracticeSnippet {
  id: number;
  text: string;
  is_correct: boolean;
}
