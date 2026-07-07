import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../api/auth';
import { getErrorMessage } from '../api/client';
import { createRoom, getLeaderboard, getRoom, joinRoom } from '../api/rooms';
import GameScreen, { RESOLVE_ANIM_MS } from '../components/GameScreen';
import Leaderboard from '../components/Leaderboard';
import Logo from '../components/Logo';
import { useAuthStore } from '../store/authStore';
import type { FallingCode, GameOverInfo, LeaderboardEntry, Room, ScoreBoard, ScorePop, WorstEntry } from '../types';
import './LobbyPage.css';

const STATUS_LABEL: Record<Room['status'], string> = {
  waiting: '대기 중',
  playing: '게임 진행 중',
  finished: '종료됨',
};

const WS_ERROR_LABEL: Record<string, string> = {
  not_host: '방장만 할 수 있습니다.',
  room_not_full: '상대방이 아직 들어오지 않았습니다.',
  room_not_waiting: '지금은 게임을 시작할 수 없는 상태입니다.',
  room_not_finished: '게임이 끝난 뒤에만 재대결할 수 있습니다.',
};

type Difficulty = 'easy' | 'normal' | 'hard';

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '쉬움',
  normal: '보통',
  hard: '어려움',
};

function LobbyPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);

  const [room, setRoom] = useState<Room | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [showRules, setShowRules] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  // --- 인게임 상태 (WebSocket 이벤트로만 갱신됨, backend-implementation.md §4~§6) ---
  const [fallingCodes, setFallingCodes] = useState<FallingCode[]>([]);
  const [scores, setScores] = useState<ScoreBoard>({});
  const [gameStartedAt, setGameStartedAt] = useState<number | null>(null);
  const [gameDuration, setGameDuration] = useState<number | null>(null);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  const [feedback, setFeedback] = useState<'correct' | 'incorrect' | 'miss' | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [myLeaderboardRank, setMyLeaderboardRank] = useState<LeaderboardEntry | null>(null);
  const [worst, setWorst] = useState<WorstEntry[]>([]);
  const [scorePops, setScorePops] = useState<ScorePop[]>([]);

  const pollTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const clockBestRttRef = useRef<number>(Infinity);
  const feedbackTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!room || room.status !== 'waiting') return;

    pollTimer.current = window.setInterval(async () => {
      try {
        const updated = await getRoom(room.code);
        // 응답이 도착하기 전에 WS로 game.start/game.over가 먼저 반영돼 status가
        // waiting을 벗어났다면, 뒤늦게 도착한 이 폴링 응답으로 되돌리지 않는다.
        setRoom((prev) => (prev && prev.status === 'waiting' ? updated : prev));
      } catch {
        // 폴링 실패는 조용히 무시하고 다음 주기에 재시도한다
      }
    }, 2000);

    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [room]);

  // 화면 밖으로 떨어진 지 오래된 코드 정리 (서버는 낙하 위치를 모르므로 프론트 전용 정리)
  useEffect(() => {
    if (room?.status !== 'playing') return;

    const interval = window.setInterval(() => {
      const adjustedNow = Date.now() + clockOffset;
      setFallingCodes((prev) => prev.filter((c) => adjustedNow - c.spawnTs < c.duration + 1000));
    }, 1000);

    return () => window.clearInterval(interval);
  }, [room?.status, clockOffset]);

  // 로비/대기실에서도 전체 랭킹을 볼 수 있도록 최초 진입 시 한 번 불러온다
  // (게임이 끝나면 game.over 핸들러가 다시 최신값으로 갱신한다)
  useEffect(() => {
    getLeaderboard()
      .then(({ entries, me, worst }) => {
        setLeaderboard(entries);
        setMyLeaderboardRank(me);
        setWorst(worst);
      })
      .catch(() => {
        // 조회 실패는 조용히 무시 — 리더보드는 부가 정보라 화면 전체를 막을 이유가 없다
      });
  }, []);

  useEffect(() => {
    if (!showRules) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowRules(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showRules]);

  const myUserId = user?.id ?? null;

  const scheduleFeedbackClear = useCallback(() => {
    if (feedbackTimeoutRef.current) window.clearTimeout(feedbackTimeoutRef.current);
    feedbackTimeoutRef.current = window.setTimeout(() => setFeedback(null), 700);
  }, []);

  // feedback을 null로 한 번 거쳤다가 다시 세팅한다 — 연속으로 같은 값(예: 연타 miss)이
  // 와도 CSS 애니메이션(흔들림 등)이 리액트 리렌더로 인해 재생되지 않는 문제를 막는다.
  const pulseFeedback = useCallback((next: 'correct' | 'incorrect' | 'miss') => {
    setFeedback(null);
    requestAnimationFrame(() => {
      setFeedback(next);
      scheduleFeedbackClear();
    });
  }, [scheduleFeedbackClear]);

  const handleSocketMessage = useCallback((data: Record<string, unknown>, receivedAt: number) => {
    switch (data.type) {
      case 'clock.sync.reply': {
        const clientSentAt = data.client_sent_at as number;
        const serverTime = data.server_time as number;
        const rtt = receivedAt - clientSentAt;
        if (rtt < clockBestRttRef.current) {
          clockBestRttRef.current = rtt;
          setClockOffset(serverTime - (clientSentAt + receivedAt) / 2);
        }
        break;
      }
      case 'room.update': {
        const nextStatus = data.status as Room['status'];
        setRoom((prev) =>
          prev
            ? {
                ...prev,
                status: nextStatus,
                player1: data.player1 as string | null,
                player2: data.player2 as string | null,
              }
            : prev,
        );
        if (nextStatus === 'waiting') {
          // 재대결로 room이 waiting으로 되돌아온 경우 — 지난 판 잔여 상태 정리
          // (리더보드는 로비/대기실에서도 계속 보여줄 것이므로 지우지 않는다)
          setFallingCodes([]);
          setScores({});
          setGameStartedAt(null);
          setGameDuration(null);
          setGameOver(null);
          setFeedback(null);
        }
        break;
      }
      case 'game.start': {
        setRoom((prev) => (prev ? { ...prev, status: 'playing' } : prev));
        setGameStartedAt(data.started_at as number);
        setGameDuration(data.duration as number);
        setFallingCodes([]);
        setScores({});
        setGameOver(null);
        break;
      }
      case 'code.spawn': {
        const codeId = data.code_id as string;
        const text = data.text as string;
        setFallingCodes((prev) => [
          ...prev,
          { codeId, text, spawnTs: data.spawn_ts as number, duration: data.duration as number },
        ]);
        break;
      }
      case 'code.result': {
        const codeId = data.code_id as string;
        const userId = data.user_id as number;
        const delta = data.delta as number;
        const correct = data.correct as boolean;

        // 즉시 지우지 않고 판정 결과를 표시만 해서, 점수판으로 날아가는 연출이 끝난
        // 뒤에(RESOLVE_ANIM_MS) 실제로 목록에서 제거한다 (GameScreen 참고)
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

        if (userId === myUserId) {
          pulseFeedback(correct ? 'correct' : 'incorrect');
        }
        break;
      }
      case 'code.submit.ack': {
        // 사설 ack — 나에게만 오는 메시지라 별도 신원 확인 없이 바로 내 피드백으로 처리
        pulseFeedback('miss');
        break;
      }
      case 'game.over': {
        setGameOver({ scores: data.scores as ScoreBoard, winnerId: data.winner_id as number | null });
        setRoom((prev) => (prev ? { ...prev, status: 'finished' } : prev));
        getLeaderboard()
          .then(({ entries, me, worst }) => {
            setLeaderboard(entries);
            setMyLeaderboardRank(me);
            setWorst(worst);
          })
          .catch(() => {
            // 리더보드 조회 실패는 결산 화면 표시를 막지 않고 조용히 무시한다
          });
        break;
      }
      case 'error': {
        const code = data.error as string;
        setError(WS_ERROR_LABEL[code] ?? code);
        break;
      }
    }
  }, [pulseFeedback, myUserId]);

  // 방에 입장한 동안 연결을 유지하다가, 소켓이 끊기면(나가기 버튼 또는 탭 종료)
  // 서버 disconnect() 핸들러가 대기 중 이탈 처리를 해준다 (backend-implementation.md §7).
  useEffect(() => {
    if (!room?.code) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/room/${room.code}/`);
    wsRef.current = socket;

    socket.onopen = () => {
      // §9 클럭 오프셋 보정 — 여러 번 왕복해서 가장 RTT가 작은 샘플의 offset을 채택
      for (let i = 0; i < 5; i++) {
        socket.send(JSON.stringify({ type: 'clock.sync', client_sent_at: Date.now() }));
      }
    };

    socket.onmessage = (event) => {
      handleSocketMessage(JSON.parse(event.data), Date.now());
    };

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [room?.code, handleSocketMessage]);

  function sendMessage(payload: unknown) {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  async function handleCreateRoom() {
    setError(null);
    setBusy(true);
    try {
      const created = await createRoom();
      setRoom(created);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinRoom(event: SubmitEvent) {
    event.preventDefault();
    if (!joinCode.trim()) {
      setError('참가할 방 코드를 입력해주세요.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const joined = await joinRoom(joinCode.trim());
      setRoom(joined);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function handleStartGame() {
    sendMessage({ type: 'game.start', difficulty });
  }

  function handleCopyRoomCode() {
    if (!room) return;
    navigator.clipboard
      .writeText(room.code)
      .then(() => {
        setCodeCopied(true);
        window.setTimeout(() => setCodeCopied(false), 1500);
      })
      .catch(() => {
        // 클립보드 권한이 없는 등 실패 시 조용히 무시 — 코드 자체는 화면에 그대로 보임
      });
  }

  function handleGameSubmit(text: string) {
    sendMessage({ type: 'code.submit', text });
  }

  function handleRematch() {
    sendMessage({ type: 'rematch' });
  }

  function handleLeaveRoom() {
    wsRef.current?.close();
    setRoom(null);
    setError(null);
    setFallingCodes([]);
    setScores({});
    setScorePops([]);
    setGameStartedAt(null);
    setGameDuration(null);
    setGameOver(null);
    setFeedback(null);
    setClockOffset(0);
    clockBestRttRef.current = Infinity;
    if (feedbackTimeoutRef.current) window.clearTimeout(feedbackTimeoutRef.current);

    // 로비로 돌아왔을 때 리더보드를 최신 상태로 갱신 (지우지는 않는다 — 로비에서도 계속 보여줌)
    getLeaderboard()
      .then(({ entries, me, worst }) => {
        setLeaderboard(entries);
        setMyLeaderboardRank(me);
        setWorst(worst);
      })
      .catch(() => {});
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      setUser(null);
      navigate('/login', { replace: true });
    }
  }

  const youAreHost = room?.is_host ?? false;
  const opponentUsername = room ? (youAreHost ? room.player2 : room.player1) : null;

  const myFinalScore = gameOver && myUserId !== null ? gameOver.scores[String(myUserId)] ?? 0 : 0;
  const opponentFinalEntry = gameOver
    ? Object.entries(gameOver.scores).find(([id]) => id !== String(myUserId))
    : undefined;
  const opponentFinalScore = opponentFinalEntry ? opponentFinalEntry[1] : 0;

  const resultOutcome: 'win' | 'lose' | 'draw' | 'unknown' = !gameOver
    ? 'unknown'
    : gameOver.winnerId === null
      ? 'draw'
      : myUserId !== null
        ? gameOver.winnerId === myUserId
          ? 'win'
          : 'lose'
        : 'unknown';

  function resultSlotClass(forMe: boolean): string {
    if (!gameOver || gameOver.winnerId === null) return '';
    const opponentUserId = opponentFinalEntry ? Number(opponentFinalEntry[0]) : null;
    const isWinner = forMe ? gameOver.winnerId === myUserId : gameOver.winnerId === opponentUserId;
    return isWinner ? 'result-winner' : 'result-loser';
  }

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <Logo />
        {room?.status !== 'playing' && (
          <div className="lobby-header-user">
            <button type="button" className="btn-link" onClick={() => setShowRules(true)}>
              게임 규칙
            </button>
            <span>{user?.username}님 환영합니다</span>
            <button type="button" className="btn-link" onClick={handleLogout}>
              로그아웃
            </button>
          </div>
        )}
      </header>

      {showRules && (
        <div
          className="rules-overlay"
          role="presentation"
          onClick={() => setShowRules(false)}
        >
          <div
            className="rules-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rules-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="rules-close"
              onClick={() => setShowRules(false)}
              aria-label="닫기"
            >
              ×
            </button>
            <h2 id="rules-title">🐝 게임 규칙</h2>
            <ul className="rules-list">
              <li>60초 동안 상대보다 점수가 높으면 승리, 같으면 무승부예요.</li>
              <li>화면 위에서 코드 스니펫이 계속 떨어져요. 정답 코드만 골라서 입력창에 그대로 입력하고 Enter를 누르세요.</li>
              <li>정답 코드를 맞히면 +500점, 오답 코드를 잘못 입력하면 -500점이에요.</li>
              <li>같은 코드를 상대와 동시에 노려도 먼저 제출한 사람만 점수를 가져가요.</li>
              <li>화면 아래로 완전히 떨어진 코드는 더 이상 제출할 수 없어요.</li>
              <li>난이도(쉬움/보통/어려움)에 따라 코드가 생성되는 주기와 떨어지는 속도가 달라져요.</li>
              <li>상대가 게임 중간에 나가면 남아있는 쪽이 자동으로 승리해요.</li>
            </ul>
          </div>
        </div>
      )}

      {!room && (
        <div className="lobby-actions">
          <div className="lobby-card">
            <h2>방 만들기</h2>
            <p>새로운 방을 만들고 상대방을 초대하세요.</p>
            <button type="button" className="btn-primary" onClick={handleCreateRoom} disabled={busy}>
              {busy ? '생성 중...' : '방 만들기'}
            </button>
          </div>

          <div className="lobby-card">
            <h2>방 참가하기</h2>
            <form onSubmit={handleJoinRoom}>
              <label className="field">
                <span>방 코드</span>
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="예: AB12CD"
                  autoFocus
                />
              </label>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? '참가 중...' : '참가하기'}
              </button>
            </form>
          </div>
        </div>
      )}

      {!room && (
        <Leaderboard
          entries={leaderboard}
          me={myLeaderboardRank}
          myUsername={user?.username ?? null}
          worst={worst}
        />
      )}

      {error && <p className="field-error">{error}</p>}

      {room && !gameOver && room.status === 'waiting' && (
        <div className="room-status">
          <h2 className="room-code-heading">
            방 코드: {room.code}
            <button type="button" className="btn-link copy-code-btn" onClick={handleCopyRoomCode}>
              {codeCopied ? '복사됨!' : '복사'}
            </button>
          </h2>
          <span className="room-status-label">{STATUS_LABEL[room.status]}</span>

          <div className="player-slots">
            <div className={`player-slot ${room.player1 ? 'filled' : ''}`}>
              <span className="player-role">방장</span>
              <span className="player-name">
                {room.player1 ?? '대기 중'}
                {youAreHost && room.player1 ? ' (나)' : ''}
              </span>
            </div>
            <div className={`player-slot ${room.player2 ? 'filled' : ''}`}>
              <span className="player-role">참가자</span>
              <span className="player-name">
                {room.player2 ?? '상대방을 기다리는 중...'}
                {!youAreHost && room.player2 ? ' (나)' : ''}
              </span>
            </div>
          </div>

          {!room.player2 && <p className="room-hint">상대방이 입장하면 자동으로 갱신됩니다.</p>}
          {room.player2 && !youAreHost && <p className="room-hint">방장이 게임을 시작하면 자동으로 전환됩니다.</p>}

          {youAreHost && room.player2 && (
            <>
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
              <button type="button" className="btn-primary" onClick={handleStartGame}>
                게임 시작
              </button>
            </>
          )}

          <button type="button" className="btn-link" onClick={handleLeaveRoom}>
            방 나가기
          </button>
        </div>
      )}

      {room && !gameOver && room.status === 'playing' && gameStartedAt !== null && gameDuration !== null && (
        <GameScreen
          falling={fallingCodes}
          scores={scores}
          scorePops={scorePops}
          myUserId={myUserId}
          myUsername={user?.username ?? null}
          opponentUsername={opponentUsername}
          startedAt={gameStartedAt}
          duration={gameDuration}
          clockOffset={clockOffset}
          feedback={feedback}
          onSubmit={handleGameSubmit}
          onForfeit={handleLeaveRoom}
        />
      )}

      {room && gameOver && (
        <div className={`room-status result-${resultOutcome}`}>
          <div className={`result-banner ${resultOutcome}`}>
            {resultOutcome === 'lose' && (
              <span className="result-emoji" aria-hidden="true">
                😡
              </span>
            )}
            {resultOutcome === 'win'
              ? 'YOU WIN!'
              : resultOutcome === 'lose'
                ? 'YOU LOSE'
                : resultOutcome === 'draw'
                  ? 'DRAW'
                  : 'GAME OVER'}
          </div>
          <p className="room-hint">
            {resultOutcome === 'draw'
              ? '무승부입니다.'
              : resultOutcome === 'win'
                ? '승리했습니다!'
                : resultOutcome === 'lose'
                  ? '패배했습니다.'
                  : '게임이 종료되었습니다.'}
          </p>
          <div className="player-slots">
            <div className={`player-slot filled ${resultSlotClass(true)}`}>
              <span className="player-role">내 점수</span>
              <span className="player-name result-score">{myFinalScore}</span>
              {resultSlotClass(true) === 'result-winner' && <span className="winner-badge">WINNER</span>}
            </div>
            <div className={`player-slot filled ${resultSlotClass(false)}`}>
              <span className="player-role">상대 점수</span>
              <span className="player-name result-score">{opponentFinalScore}</span>
              {resultSlotClass(false) === 'result-winner' && <span className="winner-badge">WINNER</span>}
            </div>
          </div>

          <Leaderboard
            entries={leaderboard}
            me={myLeaderboardRank}
            myUsername={user?.username ?? null}
            worst={worst}
          />

          {youAreHost ? (
            <button type="button" className="btn-primary" onClick={handleRematch}>
              재대결
            </button>
          ) : (
            <p className="room-hint">방장이 재대결을 시작하면 자동으로 전환됩니다.</p>
          )}
          <button type="button" className="btn-link" onClick={handleLeaveRoom}>
            로비로 돌아가기
          </button>
        </div>
      )}
    </div>
  );
}

export default LobbyPage;
