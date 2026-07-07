import type { CSSProperties } from 'react';
import { TIER_COLOR, TIER_LABEL } from '../lib/tier';
import type { Tier } from '../lib/tier';
import './TierBadge.css';

interface TierBadgeProps {
  tier?: Tier | null;
  tierScore?: number | null;
}

// 백엔드가 아직 /api/me/에 tier를 안 내려주는 동안에는 그냥 아무것도 안 그린다 —
// 필드가 생기는 순간 자동으로 나타난다.
function TierBadge({ tier, tierScore }: TierBadgeProps) {
  if (!tier) return null;

  const color = TIER_COLOR[tier];
  return (
    <span
      className="tier-badge"
      style={{ '--tier-color': color } as CSSProperties}
    >
      {TIER_LABEL[tier]}
      {typeof tierScore === 'number' && <span className="tier-badge-score">{tierScore}</span>}
    </span>
  );
}

export default TierBadge;
