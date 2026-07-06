export interface User {
  id: number;
  username: string;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface Room {
  code: string;
  status: RoomStatus;
  player1: string | null;
  player2: string | null;
  is_host: boolean;
}

export interface FallingCode {
  codeId: string;
  text: string;
  spawnTs: number; // 서버 기준 epoch ms
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
