import { useState } from 'react';
import { isMuted, toggleMuted, unlockAudio } from '../lib/sound';
import './SoundToggle.css';

// 모든 페이지에서 보이는 전역 음소거 토글 — RANK_MEDALS/ITEM_BADGE처럼 이
// 프로젝트가 이미 이모지를 아이콘으로 쓰는 패턴과 맞춘다.
function SoundToggle() {
  const [muted, setMutedState] = useState(isMuted);

  function handleClick() {
    unlockAudio();
    setMutedState(toggleMuted());
  }

  return (
    <button
      type="button"
      className="sound-toggle"
      onClick={handleClick}
      aria-label={muted ? '소리 켜기' : '소리 끄기'}
      title={muted ? '소리 켜기' : '소리 끄기'}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}

export default SoundToggle;
