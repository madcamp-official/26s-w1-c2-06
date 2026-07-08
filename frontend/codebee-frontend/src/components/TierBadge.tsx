import type { CSSProperties } from 'react';
import { TIER_COLOR, TIER_GRADIENT, TIER_LABEL } from '../lib/tier';
import type { Tier } from '../lib/tier';
import TierIcon from './TierIcon';
import './TierBadge.css';

interface TierBadgeProps {
  tier?: Tier | null;
  tierScore?: number | null;
  // 리더보드처럼 좁은 목록 안에 여러 개 나열될 때 쓰는 축소 표시.
  compact?: boolean;
}

// 백엔드가 아직 /api/me/에 tier를 안 내려주는 동안에는 그냥 아무것도 안 그린다 —
// 필드가 생기는 순간 자동으로 나타난다.
function TierBadge({ tier, tierScore, compact }: TierBadgeProps) {
  if (!tier) return null;

  const color = TIER_COLOR[tier];
  const gradient = TIER_GRADIENT[tier];
  const style = {
    '--tier-color': color,
    ...(gradient && { '--tier-color-a': gradient[0], '--tier-color-b': gradient[1] }),
  } as CSSProperties;

  return (
    <span
      className={`tier-badge ${compact ? 'compact' : ''} ${gradient ? 'has-gradient' : ''}`.replace(/\s+/g, ' ').trim()}
      style={style}
    >
      <TierIcon tier={tier} />
      <span className="tier-badge-label">{TIER_LABEL[tier]}</span>
      {typeof tierScore === 'number' && <span className="tier-badge-score">{tierScore}</span>}
    </span>
  );
}

export default TierBadge;
