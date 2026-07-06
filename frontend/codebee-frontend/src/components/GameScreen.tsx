import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { FallingCode, ScoreBoard } from '../types';
import './GameScreen.css';

// 서버는 spawn_ts(스폰 절대시각)만 보낼 뿐 낙하 시간을 지정하지 않는다 — 화면 연출용
// 고정값이라 프론트에서만 정하면 된다(architecture.md §5 "고정 낙하 시간").
export const FALL_DURATION_MS = 9000;

function hashToPercent(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash) % 90;
}

interface GameScreenProps {
  falling: FallingCode[];
  scores: ScoreBoard;
  myUserId: number | null;
  myUsername: string | null;
  opponentUsername: string | null;
  startedAt: number;
  duration: number;
  clockOffset: number;
  feedback: 'correct' | 'incorrect' | 'miss' | null;
  onSubmit: (text: string) => void;
  onForfeit: () => void;
}

function GameScreen({
  falling,
  scores,
  myUserId,
  myUsername,
  opponentUsername,
  startedAt,
  duration,
  clockOffset,
  feedback,
  onSubmit,
  onForfeit,
}: GameScreenProps) {
  const [input, setInput] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let frame: number;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // §9 클럭 오프셋 보정: (now + offset - spawn_ts) / fall_duration
  const adjustedNow = now + clockOffset;
  const remainingMs = Math.max(0, duration - (adjustedNow - startedAt));
  const remainingSec = Math.ceil(remainingMs / 1000);

  const myScore = myUserId !== null ? scores[String(myUserId)] ?? 0 : 0;
  const opponentEntry = Object.entries(scores).find(([id]) => id !== String(myUserId));
  const opponentScore = opponentEntry ? opponentEntry[1] : 0;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    onSubmit(text);
    setInput('');
  }

  return (
    <div className="game-screen">
      <div className="game-hud">
        <div className="score-box">
          <span className="score-label">{myUsername ?? (myUserId !== null ? '나' : '나(확인 중)')}</span>
          <span className="score-value">{myScore}</span>
        </div>
        <div className="game-timer">{remainingSec}s</div>
        <div className="score-box score-box-right">
          <span className="score-label">{opponentUsername ?? '상대'}</span>
          <span className="score-value">{opponentScore}</span>
        </div>
      </div>

      <div className="fall-field">
        {falling.map((code) => {
          const progress = Math.min(1, Math.max(0, (adjustedNow - code.spawnTs) / FALL_DURATION_MS));
          return (
            <span
              key={code.codeId}
              className="falling-code"
              style={{ top: `${progress * 100}%`, left: `${hashToPercent(code.codeId)}%` }}
            >
              {code.text}
            </span>
          );
        })}
      </div>

      <form className={`submit-form ${feedback ? `feedback-${feedback}` : ''}`} onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="화면의 코드를 그대로 입력 후 Enter"
          autoFocus
        />
        <button type="submit" className="btn-primary">
          제출
        </button>
      </form>

      <button type="button" className="btn-link" onClick={onForfeit}>
        게임 포기하기
      </button>
    </div>
  );
}

export default GameScreen;
