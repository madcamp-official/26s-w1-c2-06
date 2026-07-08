import { useId } from 'react';
import './TierIcon.css';
import { TIER_GRADIENT } from '../lib/tier';
import type { Tier } from '../lib/tier';

interface TierIconProps {
  tier: Tier;
}

// BeeIcon과 같은 패턴 — 이미지 파일 대신 각진 rect/polygon만으로 그리는 픽셀아트
// SVG. 색은 여기서 지정하지 않고 부모(TierBadge)가 세팅하는 CSS 변수
// --tier-color를 그대로 상속해서 쓴다(TierIcon.css의 fill: var(--tier-color)).
// 다이아/챌린저처럼 TIER_GRADIENT가 정의된 티어는 본체 실루엣만 그라데이션으로
// 채운다 — id는 useId()로 인스턴스마다 유니크하게 만들어 여러 개(리더보드 목록)
// 동시에 떠 있어도 서로 다른 <linearGradient> id 충돌이 안 나게 한다.
function TierIcon({ tier }: TierIconProps) {
  const reactId = useId();
  const gradient = TIER_GRADIENT[tier];
  const gradientId = `tier-grad-${reactId}`;
  const mainShapeProps = gradient ? { fill: `url(#${gradientId})`, stroke: `url(#${gradientId})` } : undefined;

  return (
    <svg className={`tier-icon tier-icon-${tier}`} viewBox="0 0 24 24" aria-hidden="true">
      {gradient && (
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="100%" stopColor={gradient[1]} />
          </linearGradient>
        </defs>
      )}
      {tier === 'iron' && (
        // 아이언 — 장식 없는 각진 방패 하나
        <polygon className="tier-shape-main" points="4,3 20,3 20,12 12,21 4,12" />
      )}

      {tier === 'bronze' && (
        <>
          <polygon className="tier-shape-main" points="4,3 20,3 20,12 12,21 4,12" />
          <polygon className="tier-shape-accent" points="12,9 13.2,11.6 16,12 13.8,13.8 14.4,16.6 12,15.1 9.6,16.6 10.2,13.8 8,12 10.8,11.6" />
        </>
      )}

      {tier === 'silver' && (
        <>
          <polygon className="tier-shape-main" points="4,3 20,3 20,12 12,21 4,12" />
          <polygon className="tier-shape-accent" points="8.5,8 9.4,10 11.4,10 9.8,11.2 10.4,13.2 8.5,12 6.6,13.2 7.2,11.2 5.6,10 7.6,10" />
          <polygon className="tier-shape-accent" points="15.5,8 16.4,10 18.4,10 16.8,11.2 17.4,13.2 15.5,12 13.6,13.2 14.2,11.2 12.6,10 14.6,10" />
        </>
      )}

      {tier === 'gold' && (
        <>
          <polygon className="tier-shape-main" points="4,3 20,3 20,12 12,21 4,12" />
          <polygon
            className="tier-shape-accent tier-shape-glow"
            points="12,6.5 13.6,10 17.3,10.4 14.5,12.9 15.3,16.6 12,14.6 8.7,16.6 9.5,12.9 6.7,10.4 10.4,10"
          />
        </>
      )}

      {tier === 'platinum' && (
        // 플래티넘 — 각진 다이아 컷(마름모) + 가운데 가로 페싯 라인
        <>
          <polygon className="tier-shape-main" points="12,2 21,12 12,22 3,12" />
          <rect className="tier-shape-facet" x="4.5" y="11" width="15" height="2" />
          <polygon className="tier-shape-facet-tri" points="12,2 15.5,11 8.5,11" />
        </>
      )}

      {tier === 'diamond' && (
        // 다이아 — 젬 실루엣(위 크라운 + 아래 파빌리온, 그라데이션 채움) + 페싯 스트라이프
        <>
          <polygon className="tier-shape-main" points="6,4 18,4 22,10 12,22 2,10" {...mainShapeProps} />
          <polygon className="tier-shape-facet-tri" points="6,4 12,10 2,10" />
          <polygon className="tier-shape-facet-tri" points="18,4 22,10 12,10" />
          <rect className="tier-shape-facet" x="9.2" y="4" width="1.8" height="6" />
          <rect className="tier-shape-facet" x="13" y="4" width="1.8" height="6" />
        </>
      )}

      {tier === 'challenger' && (
        // 챌린저 — 왕관(그라데이션 채움): 지그재그 봉우리 3개 + 각 봉우리에 보석, 받침대
        <>
          <polygon
            className="tier-shape-main"
            points="2,10 6.5,14 12,5 17.5,14 22,10 20.5,18 3.5,18"
            {...mainShapeProps}
          />
          <rect className="tier-shape-base" x="3" y="18" width="18" height="2.5" />
          <rect className="tier-shape-jewel" x="10.8" y="6.5" width="2.4" height="2.4" />
          <rect className="tier-shape-jewel" x="4.5" y="11.5" width="2" height="2" />
          <rect className="tier-shape-jewel" x="17.5" y="11.5" width="2" height="2" />
        </>
      )}
    </svg>
  );
}

export default TierIcon;
