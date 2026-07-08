import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, FormEvent } from 'react';
import type { ActiveItemEffect, FallingCode, ScoreBoard, ScorePop } from '../types';
import BeeIcon from './BeeIcon';
import './GameScreen.css';

const ITEM_BADGE: Record<'alert' | 'ink', string> = { alert: '⚠️', ink: '💧' };

// 판정 결과가 온 뒤 코드가 점수판으로 날아가며 사라지는 연출 시간(ms).
// LobbyPage가 이 시간만큼 기다렸다가 falling 목록에서 실제로 제거한다.
export const RESOLVE_ANIM_MS = 650;
// 점수판에 도착한 벌이 원래 자리로 돌아가는 연출 시간(ms).
const BEE_RETURN_MS = 500;
// 입력창에 한 글자를 칠 때마다 터지는 파티클이 자유낙하하는 시간(ms).
const TYPING_FALL_MS = 750;

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

// 타이핑 파티클 하나를 원형으로 무작위 방향/세기로 튀도록 생성한다.
function randomTypingParticle() {
  const angle = Math.random() * Math.PI * 2;
  const intensity = 6 + Math.random() * 14; // 무작위 세기 6~20px
  return { bx: Math.cos(angle) * intensity, by: Math.sin(angle) * intensity };
}

function randomTypingParticles() {
  const count = 4 + Math.floor(Math.random() * 3); // 4~6개
  return Array.from({ length: count }, randomTypingParticle);
}

function hashToPercent(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash) % 90;
}

// .falling-code는 폰트 22px 모노스페이스 + 좌우 padding 10px씩. 실측 대신 대략적인
// 글자 폭으로 너비를 추정해서, 코드가 길수록 fall-field 가장자리에서 더 안쪽에
// 떨어지도록 좌우 위치 범위를 좁힌다 — 그래야 overflow:hidden에 잘리지 않는다.
const CHAR_WIDTH_PX = 13;
const CODE_PADDING_PX = 24;

function clampedLeftPercent(seed: string, text: string, containerWidth: number): number {
  const rawPercent = hashToPercent(seed);
  if (containerWidth <= 0) return rawPercent;

  const halfWidthPercent = ((text.length * CHAR_WIDTH_PX + CODE_PADDING_PX) / 2 / containerWidth) * 100;
  const min = halfWidthPercent;
  const max = 100 - halfWidthPercent;
  if (min > max) return 50; // 코드가 컨테이너보다 넓을 정도면 그냥 가운데
  return Math.min(max, Math.max(min, rawPercent));
}

// 지금까지 입력한 내용이 이 코드의 접두사와 일치하면, 일치한 부분만 색을 바꿔 하이라이트한다.
function renderCodeText(text: string, typedInput: string) {
  if (typedInput.length === 0 || !text.startsWith(typedInput)) {
    return text;
  }
  return (
    <>
      <span className="code-typed">{text.slice(0, typedInput.length)}</span>
      {text.slice(typedInput.length)}
    </>
  );
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
  inkEffects: ActiveItemEffect[];
  alerts: ActiveItemEffect[];
  onDismissAlert: (id: string) => void;
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
  inkEffects,
  alerts,
  onDismissAlert,
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

  // 코드가 좌우 가장자리에서 잘리지 않도록, fall-field 실제 너비를 재서 위치 계산에 쓴다.
  const fallFieldRef = useRef<HTMLDivElement>(null);
  const [fallFieldWidth, setFallFieldWidth] = useState(0);

  useEffect(() => {
    const el = fallFieldRef.current;
    if (!el) return;
    const update = () => setFallFieldWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 점수판에 도착한 벌이 원래 자리로 돌아가는 연출 — codeId별 왕복 경로(dx, dy의 역방향).
  const [returningBees, setReturningBees] = useState<
    Record<string, { startLeft: number; startTop: number; dx: number; dy: number }>
  >({});
  const scheduledReturnRef = useRef(new Set<string>());

  // 입력창에 글자를 칠 때마다 그 위치에서 터져 아래로 자유낙하하는 파티클.
  // 뷰포트 기준 고정 좌표(position: fixed)로 그려야 낙하하는 동안 문서 스크롤 영역을
  // 늘리지 않는다(overflow:hidden 조상이 없어도 fixed는 스크롤 크기에 영향을 안 준다).
  const [typingBursts, setTypingBursts] = useState<
    { id: string; x: number; y: number; particles: { bx: number; by: number }[] }[]
  >([]);
  const measureRef = useRef<HTMLSpanElement>(null);
  const inputElRef = useRef<HTMLInputElement>(null);

  // 글자를 칠 때마다 입력창이 가볍게 떨리는 이펙트.
  const [inputVibrating, setInputVibrating] = useState(false);
  const vibrateTimeoutRef = useRef<number | null>(null);

  // alert 아이템이 걸려있는 동안 입력창을 비활성화하는데, 마지막 하나가 닫히는
  // 순간(배열이 비게 되는 순간) 다시 타이핑을 이어갈 수 있도록 포커스를 돌려준다.
  const prevAlertCountRef = useRef(0);
  useEffect(() => {
    if (prevAlertCountRef.current > 0 && alerts.length === 0) {
      inputElRef.current?.focus();
    }
    prevAlertCountRef.current = alerts.length;
  }, [alerts.length]);

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

  // 코드가 점수판에 도착한(flyTargets가 채워진) 뒤 벌이 원래 자리로 돌아가는 왕복 연출을
  // codeId당 한 번만 예약한다.
  useEffect(() => {
    for (const [id, target] of Object.entries(flyTargets)) {
      if (scheduledReturnRef.current.has(id)) continue;
      scheduledReturnRef.current.add(id);

      const arrivalLeft = target.startLeft + target.dx;
      const arrivalTop = target.startTop + target.dy;

      window.setTimeout(() => {
        setReturningBees((prev) => ({
          ...prev,
          [id]: { startLeft: arrivalLeft, startTop: arrivalTop, dx: -target.dx, dy: -target.dy },
        }));
        window.setTimeout(() => {
          setReturningBees((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          scheduledReturnRef.current.delete(id);
        }, BEE_RETURN_MS);
      }, RESOLVE_ANIM_MS);
    }
  }, [flyTargets]);

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

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    // 글자를 지울 땐 터뜨리지 않고, 실제로 새 글자가 들어갔을 때만 파티클을 튄다.
    if (next.length > input.length && measureRef.current && inputElRef.current) {
      // 방금 입력한 글자의 "시작" 지점(=커서 왼쪽)을 재기 위해 마지막 글자를 뺀 텍스트로 측정한다.
      // .input-measure의 padding-left가 입력창의 테두리+패딩과 동일해서, offsetWidth 자체가
      // 입력창 왼쪽 끝(border-box) 기준 텍스트 시작 위치를 그대로 나타낸다.
      measureRef.current.textContent = next.slice(0, -1);
      const inputRect = inputElRef.current.getBoundingClientRect();
      // 텍스트가 입력창 너비를 넘기면 브라우저가 안을 왼쪽으로 스크롤해서 커서를
      // 오른쪽 끝에 고정해버린다 — measureRef는 이 스크롤을 모르고 계속 넓어지기만
      // 하므로, 입력창 오른쪽 끝(테두리+패딩 뺀 안쪽 경계)을 넘지 않게 잡아준다.
      const maxX = inputRect.right - 17;
      const x = Math.min(inputRect.left + measureRef.current.offsetWidth, maxX);
      const y = inputRect.top + inputRect.height / 2;
      const id = `${Date.now()}-${Math.random()}`;
      setTypingBursts((prev) => [...prev, { id, x, y, particles: randomTypingParticles() }]);
      window.setTimeout(() => {
        setTypingBursts((prev) => prev.filter((b) => b.id !== id));
      }, TYPING_FALL_MS);

      // 입력창 가벼운 진동 — 연타해도 매번 재생되도록 껐다가 다음 프레임에 다시 켠다.
      setInputVibrating(false);
      requestAnimationFrame(() => {
        setInputVibrating(true);
        if (vibrateTimeoutRef.current) window.clearTimeout(vibrateTimeoutRef.current);
        vibrateTimeoutRef.current = window.setTimeout(() => setInputVibrating(false), 150);
      });
    }
    setInput(next);
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
        <div
          className={`game-timer ${remainingSec > 0 && remainingSec <= 10 ? 'game-timer-critical' : ''}`}
          key={remainingSec <= 10 ? remainingSec : undefined}
        >
          {remainingSec}s
        </div>
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

      <div className="fall-field" ref={fallFieldRef}>
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
                left: `${clampedLeftPercent(code.codeId, code.text, fallFieldWidth)}%`,
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
              {resolution ? code.text : renderCodeText(code.text, input)}
              {code.item && !resolution && (
                <span className={`item-badge item-badge-${code.item}`} aria-hidden="true">
                  {ITEM_BADGE[code.item]}
                </span>
              )}
              {resolution && (
                <>
                  <span className="particle-burst" aria-hidden="true">
                    {PARTICLE_OFFSETS.map((offset, i) => (
                      <span
                        key={i}
                        className="particle"
                        style={{ '--dx': `${offset.dx}px`, '--dy': `${offset.dy}px` } as CSSProperties}
                      />
                    ))}
                  </span>
                  <span className="carry-bee">
                    <BeeIcon flapping />
                  </span>
                </>
              )}
            </span>
          );
        })}

        {/* 상대가 맞힌 먹물 아이템 — fall-field 위에만 덮어서 낙하 중인 코드를 가린다.
            중첩 시 지속시간을 연장하지 않고 겹쳐서 쌓인다(§7 결정) — 각자 자기
            타임아웃(LobbyPage의 INK_EFFECT_MS)에 맞춰 개별적으로 사라진다. */}
        {inkEffects.map((effect) => (
          <div
            key={effect.id}
            className="ink-blot"
            style={{
              '--blot-x': `${hashToPercent(effect.id)}%`,
              '--blot-y': `${hashToPercent(`${effect.id}y`)}%`,
              '--blot-rotate': `${hashToPercent(`${effect.id}r`) - 45}deg`,
            } as CSSProperties}
            aria-hidden="true"
          />
        ))}
      </div>

      {/* 상대가 맞힌 alert 아이템 — 여러 개 겹쳐 쌓이고, 전부 닫아야(또는 각자
          타임아웃 지나야) 입력창이 다시 활성화된다(§7 결정). */}
      {alerts.map((alert, index) => (
        <div
          key={alert.id}
          className="item-alert-overlay"
          style={{ '--stack-index': index } as CSSProperties}
        >
          <div className="item-alert-modal">
            <span className="item-alert-icon" aria-hidden="true">
              ⚠️
            </span>
            <p>상대가 방해 아이템을 사용했습니다!</p>
            <button type="button" className="btn-primary" onClick={() => onDismissAlert(alert.id)}>
              확인
            </button>
          </div>
        </div>
      ))}

      {Object.entries(returningBees).map(([id, bee]) => (
        <span
          key={`return-${id}`}
          className="return-bee"
          style={{
            left: `${bee.startLeft}px`,
            top: `${bee.startTop}px`,
            '--fly-x': `${bee.dx}px`,
            '--fly-y': `${bee.dy}px`,
          } as CSSProperties}
        >
          <BeeIcon flapping />
        </span>
      ))}

      <form className={`submit-form ${feedback ? `feedback-${feedback}` : ''}`} onSubmit={handleSubmit}>
        <div className="input-wrap">
          <input
            ref={inputElRef}
            className={inputVibrating ? 'vibrating' : ''}
            value={input}
            onChange={handleInputChange}
            placeholder="화면의 코드를 그대로 입력 후 Enter"
            disabled={alerts.length > 0}
            autoFocus
          />
          <span ref={measureRef} className="input-measure" aria-hidden="true" />
        </div>
        {typingBursts.map((burst) => (
          <span
            key={burst.id}
            className="typing-burst"
            style={{ left: `${burst.x}px`, top: `${burst.y}px` } as CSSProperties}
          >
            {burst.particles.map((p, i) => (
              <span
                key={i}
                className="typing-particle"
                style={{ '--bx': `${p.bx}px`, '--by': `${p.by}px` } as CSSProperties}
              />
            ))}
          </span>
        ))}
        <button type="submit" className="btn-primary">
          제출
        </button>
      </form>

      <button type="button" className="btn-link forfeit-btn" onClick={onForfeit}>
        게임 포기하기
      </button>
    </div>
  );
}

export default GameScreen;
