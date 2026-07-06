import './Logo.css';

// 컨셉아트 "B · Hex Bracket + Sting"안을 그대로 구현한 로고 마크.
// 헥사곤(벌집 셀) 안에 타이핑 중인 코드 라인 + 정답을 향해 쏘는 호박색 침(stinger).
function Logo() {
  return (
    <div className="logo">
      <svg className="logo-mark" viewBox="0 0 100 100" aria-hidden="true">
        <polygon className="logo-hex" points="50,4 93,27 93,73 50,96 7,73 7,27" />
        <path
          className="logo-lines"
          d="M30 40 L45 40 M30 50 L55 50 M30 60 L40 60"
        />
        <polygon className="logo-sting" points="62,44 78,50 62,56" />
      </svg>
      <span className="logo-word">
        code<span className="logo-bee">bee</span>
      </span>
    </div>
  );
}

export default Logo;
