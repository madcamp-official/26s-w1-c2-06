import './SettingsIcon.css';

// BeeIcon/TierIcon과 같은 패턴 — 이미지 파일 대신 각진 도형만으로 그리는 톱니바퀴.
// currentColor를 써서 버튼의 텍스트 색을 그대로 물려받는다.
function SettingsIcon() {
  return (
    <svg className="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect className="gear-tooth" x="10.4" y="1" width="3.2" height="4" />
      <rect className="gear-tooth" x="10.4" y="19" width="3.2" height="4" />
      <rect className="gear-tooth" x="1" y="10.4" width="4" height="3.2" />
      <rect className="gear-tooth" x="19" y="10.4" width="4" height="3.2" />
      <rect className="gear-tooth" x="4.3" y="4.3" width="3.2" height="3.2" transform="rotate(45 5.9 5.9)" />
      <rect className="gear-tooth" x="16.5" y="4.3" width="3.2" height="3.2" transform="rotate(45 18.1 5.9)" />
      <rect className="gear-tooth" x="4.3" y="16.5" width="3.2" height="3.2" transform="rotate(45 5.9 18.1)" />
      <rect className="gear-tooth" x="16.5" y="16.5" width="3.2" height="3.2" transform="rotate(45 18.1 18.1)" />
      <circle className="gear-body" cx="12" cy="12" r="6.3" />
      <circle className="gear-hole" cx="12" cy="12" r="2.3" />
    </svg>
  );
}

export default SettingsIcon;
