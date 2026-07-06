import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { FallingCode, ScoreBoard, ScorePop } from '../types';
import './GameScreen.css';

// 판정 결과가 온 뒤 코드가 점수판으로 날아가며 사라지는 연출 시간(ms).
// LobbyPage가 이 시간만큼 기다렸다가 falling 목록에서 실제로 제거한다.
export const RESOLVE_ANIM_MS = 650;

// 판정 연출용 가루 파티클의 튀는 방향/거리 — 매번 랜덤이면 리렌더마다 흔들릴 수 있어
// 고정된 세트를 재사용한다.
const PARTICLE_OFFSETS = [
  { dx: -18, dy: -14 },
  { dx: 16, dy: -18 },
  { dx: -22, dy: 6 },
  { dx: 20, dy: 10 },
  { dx: -8, dy: -24 },
  { dx: 10, dy: 22 },
  { dx: -16, dy: 18 },
  { dx: 24, dy: -4 },
];

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
  scorePops: ScorePop[];
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
  scorePops,
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

  // 판정된 코드가 실제 점수판 DOM 위치까지 날아가도록, 코드/점수판 요소의 화면 좌표를
  // 측정해서 픽셀 단위 이동량(dx, dy)을 계산해둔다. codeId별로 한 번만 계산하고,
  // 이후엔 이 값으로 고정된 애니메이션을 재생한다(계속 재측정하면 낙하 진행에 따라
  // 목표가 흔들리므로).
  const [flyTargets, setFlyTargets] = useState<
    Record<string, { startLeft: number; startTop: number; dx: number; dy: number; frozenProgress: number }>
  >({});
  const codeElRefs = useRef(new Map<string, HTMLSpanElement>());
  const myScoreRef = useRef<HTMLDivElement>(null);
  const opponentScoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame: number;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // §9 클럭 오프셋 보정: (now - spawn_ts) / fall_duration
  const adjustedNow = now + clockOffset;

  useLayoutEffect(() => {
    const currentIds = new Set(falling.map((c) => c.codeId));
    for (const id of codeElRefs.current.keys()) {
      if (!currentIds.has(id)) codeElRefs.current.delete(id);
    }

    setFlyTargets((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const id of Object.keys(next)) {
        if (!currentIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }

      for (const code of falling) {
        if (!code.resolution || next[code.codeId]) continue;

        const el = codeElRefs.current.get(code.codeId);
        const targetEl = code.resolution.userId === myUserId ? myScoreRef.current : opponentScoreRef.current;
        if (!el || !targetEl) continue;

        const codeRect = el.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        next[code.codeId] = {
          // fall-field는 overflow:hidden이라 그 안에서 %로 이동시키면 점수판(HUD)까지
          // 못 가고 잘려버린다 — 뷰포트 기준 좌표를 캡처해 position:fixed로 전환하면
          // fall-field 밖으로도 자유롭게 날아갈 수 있다.
          startLeft: codeRect.left,
          startTop: codeRect.top,
          dx: targetRect.left + targetRect.width / 2 - (codeRect.left + codeRect.width / 2),
          dy: targetRect.top + targetRect.height / 2 - (codeRect.top + codeRect.height / 2),
          frozenProgress: Math.min(1, Math.max(0, (adjustedNow - code.spawnTs) / code.duration)),
        };
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [falling, myUserId, adjustedNow]);

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
        <div className="score-box" ref={myScoreRef}>
          <span className="score-label">{myUsername ?? (myUserId !== null ? '나' : '나(확인 중)')}</span>
          <span className="score-value">{myScore}</span>
          <div className="score-pops">
            {scorePops
              .filter((pop) => pop.userId === myUserId)
              .map((pop) => (
                <span key={pop.id} className={`score-pop ${pop.delta > 0 ? 'pop-positive' : 'pop-negative'}`}>
                  {pop.delta > 0 ? `+${pop.delta}` : pop.delta}
                </span>
              ))}
          </div>
        </div>
        <div className="game-timer">{remainingSec}s</div>
        <div className="score-box score-box-right" ref={opponentScoreRef}>
          <span className="score-label">{opponentUsername ?? '상대'}</span>
          <span className="score-value">{opponentScore}</span>
          <div className="score-pops">
            {scorePops
              .filter((pop) => pop.userId !== myUserId)
              .map((pop) => (
                <span key={pop.id} className={`score-pop ${pop.delta > 0 ? 'pop-positive' : 'pop-negative'}`}>
                  {pop.delta > 0 ? `+${pop.delta}` : pop.delta}
                </span>
              ))}
          </div>
        </div>
      </div>

      <div className="fall-field">
        {falling.map((code) => {
          const resolution = code.resolution;
          const flyTarget = flyTargets[code.codeId];
          // 판정된 코드는 낙하 진행을 멈추고(퍼센트 위치 고정), 실측한 점수판 좌표로
          // transform 애니메이션만 재생한다 — 계속 progress를 갱신하면 낙하와 날아가는
          // 연출이 동시에 섞여 버린다.
          const progress = flyTarget
            ? flyTarget.frozenProgress
            : Math.min(1, Math.max(0, (adjustedNow - code.spawnTs) / code.duration));
          const resolvedClass = resolution
            ? `resolved ${resolution.correct ? 'correct' : 'incorrect'} ${flyTarget ? 'flying' : ''}`
            : '';
          // fall-field는 overflow:hidden이라, 점수판(HUD)까지 날아가려면 그 밖으로
          // 벗어날 수 있는 position:fixed로 전환해야 한다(§ 위 useLayoutEffect 주석 참고).
          const style: CSSProperties = flyTarget
            ? {
                position: 'fixed',
                left: `${flyTarget.startLeft}px`,
                top: `${flyTarget.startTop}px`,
                transform: 'none',
                '--resolve-ms': `${RESOLVE_ANIM_MS}ms`,
                '--fly-x': `${flyTarget.dx}px`,
                '--fly-y': `${flyTarget.dy}px`,
              } as CSSProperties
            : {
                top: `${progress * 100}%`,
                left: `${hashToPercent(code.codeId)}%`,
                '--resolve-ms': `${RESOLVE_ANIM_MS}ms`,
              } as CSSProperties;
          return (
            <span
              key={code.codeId}
              ref={(el) => {
                if (el) codeElRefs.current.set(code.codeId, el);
                else codeElRefs.current.delete(code.codeId);
              }}
              className={`falling-code ${resolvedClass}`}
              style={style}
            >
              {code.text}
              {resolution && (
                <span className="particle-burst" aria-hidden="true">
                  {PARTICLE_OFFSETS.map((offset, i) => (
                    <span
                      key={i}
                      className="particle"
                      style={{ '--dx': `${offset.dx}px`, '--dy': `${offset.dy}px` } as CSSProperties}
                    />
                  ))}
                </span>
              )}
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
