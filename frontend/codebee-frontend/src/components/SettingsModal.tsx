import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { getBgmVolume, getSfxVolume, playClick, setBgmVolume, setSfxVolume } from '../lib/sound';
import './SettingsModal.css';

interface SettingsModalProps {
  onClose: () => void;
  onShowRules: () => void;
  onLogout: () => void;
}

// LobbyPage의 "게임 규칙" 모달과 같은 rules-overlay/rules-modal 틀을 그대로 재사용하고,
// 이 파일의 CSS로 슬라이더/버튼 레이아웃만 얹는다. 사운드 조절뿐 아니라 게임 규칙
// 보기/로그아웃도 여기 하나로 모아뒀다.
function SettingsModal({ onClose, onShowRules, onLogout }: SettingsModalProps) {
  const [bgmPercent, setBgmPercent] = useState(() => Math.round(getBgmVolume() * 100));
  const [sfxPercent, setSfxPercent] = useState(() => Math.round(getSfxVolume() * 100));

  function handleBgmChange(event: ChangeEvent<HTMLInputElement>) {
    const percent = Number(event.target.value);
    setBgmPercent(percent);
    setBgmVolume(percent / 100);
  }

  function handleSfxChange(event: ChangeEvent<HTMLInputElement>) {
    const percent = Number(event.target.value);
    setSfxPercent(percent);
    setSfxVolume(percent / 100);
  }

  function handleShowRules() {
    onClose();
    onShowRules();
  }

  return (
    <div className="rules-overlay" role="presentation" onClick={onClose}>
      <div
        className="rules-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="rules-close" onClick={onClose} aria-label="닫기">
          ×
        </button>
        <h2 id="settings-title">⚙️ 설정</h2>

        <label className="sound-settings-row">
          <span className="sound-settings-label">배경음악</span>
          <input
            type="range"
            min={0}
            max={100}
            value={bgmPercent}
            onChange={handleBgmChange}
            className="sound-settings-slider"
          />
          <span className="sound-settings-value">{bgmPercent}%</span>
        </label>

        <label className="sound-settings-row">
          <span className="sound-settings-label">효과음</span>
          <input
            type="range"
            min={0}
            max={100}
            value={sfxPercent}
            onChange={handleSfxChange}
            onMouseUp={() => playClick()}
            onTouchEnd={() => playClick()}
            className="sound-settings-slider"
          />
          <span className="sound-settings-value">{sfxPercent}%</span>
        </label>

        <div className="settings-actions">
          <button type="button" className="btn-link" onClick={handleShowRules}>
            게임 규칙
          </button>
          <button type="button" className="btn-link" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
