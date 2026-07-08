import { useEffect, useRef, useState } from 'react';
import { getPracticeSnippets } from '../api/practice';
import type { Difficulty } from '../lib/gameConstants';
import {
  BOT_INTERVAL_MS,
  DIFFICULTY_LABEL,
  DIFFICULTY_PRESETS,
  GAME_DURATION_MS,
  SCORE_DELTA_INCORRECT,
  computeCorrectScore,
  computeFallDurationMs,
} from '../lib/gameConstants';
import { playCorrect, playTypo, playWrong, startGameBgm, startLobbyBgm } from '../lib/sound';
import type { ActiveItemEffect, FallingCode, PracticeSnippet, ScoreBoard, ScorePop } from '../types';
import GameScreen, { RESOLVE_ANIM_MS } from './GameScreen';

const MY_USER_ID = 1;
const BOT_USER_ID = 2;
// 연습모드엔 상대가 없어 방해 아이템이 발동되지 않는다 — GameScreen에 항상 빈 배열로 전달.
const EMPTY_ITEM_EFFECTS: ActiveItemEffect[] = [];

type Phase = 'setup' | 'countdown' | 'playing' | 'over';

interface PracticeModeProps {
  myUsername: string | null;
  onExit: () => void;
}

// 연습모드 — Room/Redis/WS를 전혀 안 쓰고 전부 로컬로 스폰/판정/봇을 시뮬레이션한다.
// GameScreen은 순수 props 기반이라 실전과 동일한 컴포넌트를 그대로 재사용한다.
// 결과는 어디에도 저장하지 않는다(리더보드/전적 영향 없음).
function PracticeMode({ myUsername, onExit }: PracticeModeProps) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [pool, setPool] = useState<PracticeSnippet[] | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [pregameCountdown, setPregameCountdown] = useState(3);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const [fallingCodes, setFallingCodes] = useState<FallingCode[]>([]);
  const [scores, setScores] = useState<ScoreBoard>({});
  const [scorePops, setScorePops] = useState<ScorePop[]>([]);
  const [feedback, setFeedback] = useState<'correct' | 'incorrect' | 'miss' | null>(null);

  const poolRef = useRef<PracticeSnippet[]>([]);
  const usedIdsRef = useRef<Set<number>>(new Set());
  const metaRef = useRef<Map<string, boolean>>(new Map()); // codeId -> is_correct
  const fallingRef = useRef<FallingCode[]>([]);
  const feedbackTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    getPracticeSnippets()
      .then(({ snippets }) => {
        poolRef.current = snippets;
        setPool(snippets);
      })
      .catch(() => setFetchFailed(true));
  }, []);

  useEffect(() => {
    fallingRef.current = fallingCodes;
  }, [fallingCodes]);

  // 3, 2, 1 카운트다운 — 로컬 시뮬레이션이라 서버 동기화가 필요 없다.
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (pregameCountdown <= 0) {
      setStartedAt(Date.now());
      setPhase('playing');
      return;
    }
    const timer = window.setTimeout(() => setPregameCountdown((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [phase, pregameCountdown]);

  // 스폰 — backend _try_spawn과 동일하게 안 쓴 스니펫을 랜덤으로 골라 떨어뜨린다.
  useEffect(() => {
    if (phase !== 'playing') return;
    const { spawnTickMs, fallSpeedMult } = DIFFICULTY_PRESETS[difficulty];
    const interval = window.setInterval(() => {
      const pool = poolRef.current;
      if (pool.length === 0) return;
      let snippet: PracticeSnippet | null = null;
      for (let i = 0; i < 10; i++) {
        const candidate = pool[Math.floor(Math.random() * pool.length)];
        if (!usedIdsRef.current.has(candidate.id)) {
          usedIdsRef.current.add(candidate.id);
          snippet = candidate;
          break;
        }
      }
      if (!snippet) return;

      const codeId = `p${snippet.id}`;
      const spawnTs = Date.now();
      const duration = computeFallDurationMs(snippet.text, fallSpeedMult);
      metaRef.current.set(codeId, snippet.is_correct);
      setFallingCodes((prev) => [...prev, { codeId, text: snippet.text, spawnTs, duration }]);
    }, spawnTickMs);
    return () => window.clearInterval(interval);
  }, [phase, difficulty]);

  // 화면 밖으로 떨어진 지 오래된 코드 정리 (LobbyPage의 동일한 정리 로직과 같음)
  useEffect(() => {
    if (phase !== 'playing') return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setFallingCodes((prev) => prev.filter((c) => now - c.spawnTs < c.duration + 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [phase]);

  // 라운드 종료 타이머
  useEffect(() => {
    if (phase !== 'playing') return;
    const timer = window.setTimeout(() => setPhase('over'), GAME_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // BGM 전환 — 연습모드가 떠 있는 동안엔 LobbyPage의 BGM effect가 관여하지
  // 않으므로(§LobbyPage practiceActive 가드) 여기서 전부 직접 관리한다.
  useEffect(() => {
    if (phase === 'playing') startGameBgm();
    else startLobbyBgm();
  }, [phase]);

  // 연습봇 — 난이도별 간격마다 현재 낙하 중인 미판정 정답 코드 중 하나를 랜덤으로 맞힌다.
  useEffect(() => {
    if (phase !== 'playing') return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      const candidates = fallingRef.current.filter(
        (c) => !c.resolution && metaRef.current.get(c.codeId) === true && now - c.spawnTs < c.duration,
      );
      if (candidates.length === 0) return;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      resolveCode(pick.codeId, BOT_USER_ID, true, pick.text);
    }, BOT_INTERVAL_MS[difficulty]);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, difficulty]);

  function pulseFeedback(next: 'correct' | 'incorrect' | 'miss') {
    if (next === 'correct') playCorrect();
    else if (next === 'incorrect') playWrong();
    else playTypo();

    setFeedback(null);
    requestAnimationFrame(() => {
      setFeedback(next);
      if (feedbackTimeoutRef.current) window.clearTimeout(feedbackTimeoutRef.current);
      feedbackTimeoutRef.current = window.setTimeout(() => setFeedback(null), 700);
    });
  }

  function resolveCode(codeId: string, userId: number, correct: boolean, text: string) {
    const delta = correct ? computeCorrectScore(text) : SCORE_DELTA_INCORRECT;
    setFallingCodes((prev) =>
      prev.map((c) => (c.codeId === codeId ? { ...c, resolution: { correct, userId } } : c)),
    );
    setScores((prev) => ({ ...prev, [String(userId)]: (prev[String(userId)] ?? 0) + delta }));

    const popId = `${codeId}-${Date.now()}`;
    setScorePops((prev) => [...prev, { id: popId, userId, delta }]);
    window.setTimeout(() => {
      setScorePops((prev) => prev.filter((p) => p.id !== popId));
    }, 900);
    window.setTimeout(() => {
      setFallingCodes((prev) => prev.filter((c) => c.codeId !== codeId));
    }, RESOLVE_ANIM_MS);

    metaRef.current.delete(codeId);
    if (userId === MY_USER_ID) pulseFeedback(correct ? 'correct' : 'incorrect');
  }

  function handleSubmit(text: string) {
    const now = Date.now();
    const match = fallingRef.current.find(
      (c) => !c.resolution && c.text === text && now - c.spawnTs < c.duration,
    );
    if (!match) {
      pulseFeedback('miss');
      return;
    }
    resolveCode(match.codeId, MY_USER_ID, metaRef.current.get(match.codeId) === true, match.text);
  }

  function handleStart() {
    usedIdsRef.current = new Set();
    metaRef.current = new Map();
    setFallingCodes([]);
    setScores({});
    setScorePops([]);
    setFeedback(null);
    setPregameCountdown(3);
    setPhase('countdown');
  }

  if (fetchFailed) {
    return (
      <div className="room-status">
        <h2>연습모드를 불러오지 못했어요</h2>
        <p className="room-hint">잠시 후 다시 시도해주세요.</p>
        <button type="button" className="btn-link" onClick={onExit}>
          로비로 돌아가기
        </button>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="lobby-actions">
        <div className="lobby-card">
          <h2>연습 모드</h2>
          <p>연습봇을 상대로 감을 익혀보세요. 결과는 저장되지 않아요.</p>
          <div className="difficulty-picker">
            <span className="difficulty-label">난이도</span>
            <div className="difficulty-options">
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`difficulty-btn ${difficulty === d ? 'selected' : ''}`}
                  onClick={() => setDifficulty(d)}
                >
                  {DIFFICULTY_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={handleStart} disabled={!pool || pool.length === 0}>
            {pool ? '시작' : '불러오는 중...'}
          </button>
          <button type="button" className="btn-link" onClick={onExit}>
            로비로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'countdown') {
    return (
      <div className="start-countdown-overlay" key={`practice-${pregameCountdown}`} aria-hidden="true">
        {pregameCountdown}
      </div>
    );
  }

  if (phase === 'over') {
    const my = scores[String(MY_USER_ID)] ?? 0;
    const bot = scores[String(BOT_USER_ID)] ?? 0;
    const outcome = my > bot ? 'win' : my < bot ? 'lose' : 'draw';
    return (
      <div className={`room-status result-${outcome}`}>
        <div className={`result-banner ${outcome}`}>
          {outcome === 'win' ? 'YOU WIN!' : outcome === 'lose' ? 'YOU LOSE' : 'DRAW'}
        </div>
        <p className="room-hint">연습 결과는 저장되지 않아요.</p>
        <div className="player-slots">
          <div className={`player-slot filled ${outcome === 'win' ? 'result-winner' : outcome === 'lose' ? 'result-loser' : ''}`}>
            <span className="player-role">내 점수</span>
            <span className="player-name result-score">{my}</span>
          </div>
          <div className={`player-slot filled ${outcome === 'lose' ? 'result-winner' : outcome === 'win' ? 'result-loser' : ''}`}>
            <span className="player-role">연습봇</span>
            <span className="player-name result-score">{bot}</span>
          </div>
        </div>
        <button type="button" className="btn-primary" onClick={handleStart}>
          다시하기
        </button>
        <button type="button" className="btn-link" onClick={onExit}>
          로비로 돌아가기
        </button>
      </div>
    );
  }

  return (
    <GameScreen
      falling={fallingCodes}
      scores={scores}
      scorePops={scorePops}
      myUserId={MY_USER_ID}
      myUsername={myUsername}
      opponentUsername="연습봇"
      startedAt={startedAt ?? Date.now()}
      duration={GAME_DURATION_MS}
      clockOffset={0}
      feedback={feedback}
      // 연습모드는 상대가 없어 방해 아이템이 발동될 일이 없다 — 항상 빈 상태로 고정.
      honeyEffects={EMPTY_ITEM_EFFECTS}
      alerts={EMPTY_ITEM_EFFECTS}
      onDismissAlert={() => {}}
      onSubmit={handleSubmit}
      onForfeit={() => setPhase('over')}
    />
  );
}

export default PracticeMode;
