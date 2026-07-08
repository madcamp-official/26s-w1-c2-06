import type { CSSProperties } from 'react';
import { TIER_COLOR, TIER_LABEL } from '../lib/tier';
import type { Tier } from '../lib/tier';
import TierIcon from './TierIcon';
import './PromotionBanner.css';

interface PromotionBannerProps {
  from: Tier;
  to: Tier;
}

// 결산화면 상단 배너에 붙는 승급 연출 — 이전 티어 아이콘이 왼쪽으로 빠지며
// 사라지고, 그 자리를 새 티어 아이콘이 오른쪽에서 채우며 들어온다. 두 아이콘이
// 스쳐 지나가는 순간 밝은 빛이 모였다가 터지는 이펙트가 함께 재생된다.
function PromotionBanner({ from, to }: PromotionBannerProps) {
  return (
    <div className="promotion-banner" style={{ '--tier-color': TIER_COLOR[to] } as CSSProperties}>
      <div className="promotion-icons">
        <span className="promotion-icon promotion-icon-out">
          <TierIcon tier={from} />
        </span>
        <span className="promotion-burst" aria-hidden="true" />
        <span className="promotion-icon promotion-icon-in">
          <TierIcon tier={to} />
        </span>
      </div>
      <p className="promotion-text">
        {TIER_LABEL[from]} → {TIER_LABEL[to]} 승급!
      </p>
    </div>
  );
}

export default PromotionBanner;
