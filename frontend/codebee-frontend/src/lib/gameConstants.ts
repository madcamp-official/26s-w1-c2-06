// backend/game/consumers.py의 상수/공식을 그대로 포팅 — 연습모드가 실전과 같은
// 점수/낙하 체감을 갖도록 한다. 실전 판정은 항상 서버가 하므로 여기 값이 바뀌어도
// 점수 조작으로 이어지지 않는다(연습모드는 DB에 아무것도 저장하지 않음).
export const GAME_DURATION_MS = 60000;

const SCORE_CORRECT_BASE = 200;
const SCORE_CORRECT_PER_CHAR = 20;
const SCORE_CORRECT_MAX = 1000;
export const SCORE_DELTA_INCORRECT = -500;

export function computeCorrectScore(text: string): number {
  return Math.min(SCORE_CORRECT_MAX, SCORE_CORRECT_BASE + text.length * SCORE_CORRECT_PER_CHAR);
}

const FALL_BASE_MS = 5000;
const FALL_PER_CHAR_MS = 150;
const FALL_MAX_MS = 14000;

export function computeFallDurationMs(text: string, fallSpeedMult: number): number {
  const base = Math.min(FALL_MAX_MS, FALL_BASE_MS + text.length * FALL_PER_CHAR_MS);
  return Math.round(base * fallSpeedMult);
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
};

export const DIFFICULTY_PRESETS: Record<Difficulty, { spawnTickMs: number; fallSpeedMult: number }> = {
  easy: { spawnTickMs: 800, fallSpeedMult: 1.4 },
  normal: { spawnTickMs: 500, fallSpeedMult: 1.0 },
  hard: { spawnTickMs: 320, fallSpeedMult: 0.7 },
};

// 연습봇 반응 간격 — 백엔드엔 없는 프론트 전용 값(연습모드 전용 개념). 같은
// 난이도 선택 하나로 스폰/낙하 속도와 봇 반응 속도를 함께 조절한다.
export const BOT_INTERVAL_MS: Record<Difficulty, number> = {
  easy: 5000,
  normal: 4000,
  hard: 3000,
};
