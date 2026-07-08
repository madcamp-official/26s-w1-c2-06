import './BeeIcon.css';

// 코드를 물고 나르는 벌 아이콘 — 픽셀 느낌의 각진 사각형으로만 구성.
// 더듬이/눈/침을 더해 실루엣만으로도 벌임을 알아볼 수 있게 한다.
function BeeIcon({ flapping }: { flapping?: boolean }) {
  return (
    <svg className={`bee-icon ${flapping ? 'flapping' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      {/* 더듬이 */}
      <rect className="bee-antenna" x="8.2" y="1.5" width="1.4" height="4" transform="rotate(-24 8.9 5.5)" />
      <rect className="bee-antenna" x="14.4" y="1.5" width="1.4" height="4" transform="rotate(24 15.1 5.5)" />

      {/* 날개 — 안쪽/바깥쪽 두 겹으로 겹쳐 곤충 날개다운 실루엣을 만든다 */}
      <rect className="bee-wing bee-wing-l" x="0.5" y="8" width="7" height="4.5" />
      <rect className="bee-wing bee-wing-l bee-wing-inner" x="1.5" y="6" width="5" height="3" />
      <rect className="bee-wing bee-wing-r" x="16.5" y="8" width="7" height="4.5" />
      <rect className="bee-wing bee-wing-r bee-wing-inner" x="17.5" y="6" width="5" height="3" />

      {/* 머리 + 눈 */}
      <rect className="bee-head" x="8" y="6" width="8" height="4" />
      <rect className="bee-eye" x="9.5" y="7.3" width="1.6" height="1.6" />
      <rect className="bee-eye" x="12.9" y="7.3" width="1.6" height="1.6" />

      {/* 몸통 + 줄무늬 */}
      <rect className="bee-body" x="7" y="9" width="10" height="9" />
      <rect className="bee-stripe" x="7" y="11" width="10" height="2" />
      <rect className="bee-stripe" x="7" y="15" width="10" height="2" />

      {/* 침 */}
      <polygon className="bee-stinger" points="17,16.4 21,18 17,19.6" />
    </svg>
  );
}

export default BeeIcon;
