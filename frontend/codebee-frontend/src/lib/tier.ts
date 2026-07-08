// backend/game/tier.py를 그대로 포팅 — 서버가 진짜 계산을 하고, 여기 로직은
// 매칭 대기 중 화면에 보여줄 레이팅 숫자를 티어/점수로 변환하는 표시용으로만 쓴다
// (내 티어 자체는 GET /api/me/tier/가 이미 계산해서 내려줌, tier.py가 계산 권위).
export const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'challenger'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABEL: Record<Tier, string> = {
  iron: '아이언',
  bronze: '브론즈',
  silver: '실버',
  gold: '골드',
  platinum: '플래티넘',
  diamond: '다이아',
  challenger: '챌린저',
};

export const TIER_COLOR: Record<Tier, string> = {
  iron: '#9ca3af',
  bronze: '#ff9a4d',
  silver: '#d9dbe5',
  gold: '#ffd700',
  platinum: '#00f0ff',
  diamond: '#60a5fa',
  challenger: '#ff2af5',
};

// rating(정수) -> {tier, tierScore}. 챌린저는 상한이 없어 rating이 600을 넘어갈 수
// 있으므로 인덱스를 챌린저에서 클램프한다(tier.py의 apply_tier_result와 동일 규칙).
export function ratingToTier(rating: number): { tier: Tier; tierScore: number } {
  const maxIdx = TIERS.length - 1;
  const idx = Math.min(maxIdx, Math.max(0, Math.floor(rating / 100)));
  const tierScore = idx === maxIdx ? rating - maxIdx * 100 : rating % 100;
  return { tier: TIERS[idx], tierScore };
}
