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
  duration: number; // 이 코드의 낙하 시간(ms) — 서버가 텍스트 길이 기준으로 계산해 내려줌
  resolution?: { correct: boolean; userId: number } | null; // 판정 후 날아가는 연출용, 판정 전엔 없음
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

export interface ScorePop {
  id: string;
  userId: number;
  delta: number;
}
