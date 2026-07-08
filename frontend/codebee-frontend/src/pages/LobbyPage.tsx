import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../api/auth';
import { getErrorMessage } from '../api/client';
import { createRoom, getLeaderboard, getRoom, joinRoom } from '../api/rooms';
import { getMyTier } from '../api/tier';
import GameScreen, { RESOLVE_ANIM_MS } from '../components/GameScreen';
import Leaderboard from '../components/Leaderboard';
import Logo from '../components/Logo';
import MatchmakingModal from '../components/MatchmakingModal';
import PromotionBanner from '../components/PromotionBanner';
import TierBadge from '../components/TierBadge';
import PracticeMode from '../components/PracticeMode';
import { useAuthStore } from '../store/authStore';
import { DIFFICULTY_LABEL } from '../lib/gameConstants';
import type { Difficulty } from '../lib/gameConstants';
import { ratingToTier, TIERS } from '../lib/tier';
import type { Tier } from '../lib/tier';
import type {
  ActiveItemEffect,
  FallingCode,
  GameOverInfo,
  ItemType,
  LeaderboardEntry,
  Room,
  ScoreBoard,
  ScorePop,
  TierInfo,
  WorstEntry,
} from '../types';
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

// 방해 아이템(alert/ink) 지속시간 — 순수 연출값이라 프론트 상수로 관리한다
// (docs/plan/game-items.md §7). 중첩 시 지속시간을 연장하지 않고 겹쳐서 쌓인다.
const INK_EFFECT_MS = 3000;
const ALERT_EFFECT_MS = 3000;

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
  // 게임 시작 전 3초 카운트다운 — 서버 game.starting을 받으면 초 단위로 세팅되고
  // 1초마다 줄어든다. null이면 카운트다운 중이 아님(대기실 기본 상태).
  const [pregameCountdown, setPregameCountdown] = useState<number | null>(null);
  const [showMatchmaking, setShowMatchmaking] = useState(false);
  const [practiceActive, setPracticeActive] = useState(false);
  // 친선전 패널 안에서 방 만들기/방 참가하기를 전환하는 탭
  const [friendlyTab, setFriendlyTab] = useState<'create' | 'join'>('create');
  // 이 방이 매칭으로 성사된 방인지 — 백엔드가 room 응답에 is_ranked를 안 내려주므로
  // (docs/plan/architecture.md 갭) handleMatchFound를 거쳤는지로 프론트에서만 추적한다.
  // true면 대기실 화면(방 코드/복사/난이도 선택) 대신 "매칭 완료" 화면을 보여주고,
  // 방장 쪽에서 자동으로 게임을 시작시킨다 — 대기실이 노출되면 방 코드로 제3자가
  // 끼어들 수 있는 문제(방 참가하기 API가 is_ranked를 모름)를 화면단에서 우회한다.
  const [isRankedMatch, setIsRankedMatch] = useState(false);
  // 위 state와 같은 값을 미러링하는 ref — room WS useEffect(아래) 안에서 읽는데,
  // state를 의존성에 넣으면 값이 바뀔 때마다 소켓이 불필요하게 재연결돼버린다.
  const isRankedMatchRef = useRef(false);
  // 매칭으로 들어간 판이 끝났을 때 티어 변동을 보여주기 위한 "매칭 성사 시점" 스냅샷.
  // handleSocketMessage(useCallback)에서 읽지 않고 ref로만 다뤄서, 값이 바뀌어도
  // 소켓 재연결을 유발하지 않게 한다(아래 room WS useEffect가 handleSocketMessage에
  // 의존하기 때문).
  const preMatchRatingRef = useRef<number | null>(null);
  const [tierDelta, setTierDelta] = useState<number | null>(null);
  // 이번 판으로 티어 등급 자체가 올랐을 때만 채워짐 — 승급 연출(PromotionBanner)
  // 트리거용. 점수만 오르내린 경우(등급은 그대로)엔 null로 두고 tierDelta 텍스트만 보여준다.
  const [promotion, setPromotion] = useState<{ from: Tier; to: Tier } | null>(null);
  // 헤더에 상시 표시할 내 티어 — GET /api/me/tier/ 결과. 매칭 전/후, 랭크전 종료
  // 후에 갱신된다.
  const [myTier, setMyTier] = useState<TierInfo | null>(null);

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
  const [inkEffects, setInkEffects] = useState<ActiveItemEffect[]>([]);
  const [alerts, setAlerts] = useState<ActiveItemEffect[]>([]);

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

  // 헤더에 상시 보여줄 내 티어 배지 — 최초 진입 시 한 번 불러온다.
  useEffect(() => {
    getMyTier()
      .then(setMyTier)
      .catch(() => {
        // 조회 실패는 조용히 무시 — 배지가 안 보일 뿐 게임 진행엔 지장 없다
      });
  }, []);

  // 매칭 모달이 fresh하게 새로 조회하는 티어와 헤더 배지가 다르게 보이는 걸
  // 막기 위해, 매칭을 시작하는 시점에 헤더 값도 같이 최신화한다.
  useEffect(() => {
    if (!showMatchmaking) return;
    getMyTier()
      .then(setMyTier)
      .catch(() => {});
  }, [showMatchmaking]);

  useEffect(() => {
    if (!showRules) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowRules(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showRules]);

  useEffect(() => {
    if (pregameCountdown === null) return;
    if (pregameCountdown <= 0) {
      setPregameCountdown(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setPregameCountdown((s) => (s === null ? null : s - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [pregameCountdown]);

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

  // alert 모달의 "확인" 버튼으로 개별 인스턴스를 닫는다 — 자동 타임아웃과 동일하게
  // 그 id만 배열에서 제거(중첩된 나머지는 그대로 유지).
  const dismissAlert = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((e) => e.id !== id));
  }, []);

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
        const nextPlayer1 = data.player1 as string | null;
        const nextPlayer2 = data.player2 as string | null;
        setRoom((prev) =>
          prev
            ? {
                ...prev,
                status: nextStatus,
                player1: nextPlayer1,
                player2: nextPlayer2,
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
          // 카운트다운 도중 상대가 나가는 등으로 시작이 취소된 경우도 여기로 옴
          setPregameCountdown(null);
          setTierDelta(null);
          setPromotion(null);
          setInkEffects([]);
          setAlerts([]);

          // 랭킹전은 대기실이 노출되지 않으므로(§LobbyPage 위쪽 주석) 상대가
          // 게임 시작 전에 나가면 방에 혼자 남아 멈춰있게 된다 — 나도 방을 나가고
          // 곧바로 다시 매칭 큐에 들어가게 한다.
          if (isRankedMatchRef.current && (!nextPlayer1 || !nextPlayer2)) {
            handleLeaveRoom();
            setShowMatchmaking(true);
          }
        }
        break;
      }
      case 'game.starting': {
        // room.status는 아직 waiting — 대기실 화면 위에 3,2,1만 띄운다.
        setPregameCountdown(Math.round((data.countdown as number) / 1000));
        break;
      }
      case 'game.start': {
        setRoom((prev) => (prev ? { ...prev, status: 'playing' } : prev));
        setGameStartedAt(data.started_at as number);
        setGameDuration(data.duration as number);
        setFallingCodes([]);
        setScores({});
        setGameOver(null);
        setPregameCountdown(null);
        setInkEffects([]);
        setAlerts([]);
        break;
      }
      case 'code.spawn': {
        const codeId = data.code_id as string;
        const text = data.text as string;
        setFallingCodes((prev) => [
          ...prev,
          {
            codeId,
            text,
            spawnTs: data.spawn_ts as number,
            duration: data.duration as number,
            item: (data.item as ItemType | null) ?? null,
          },
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

        // 아이템은 상대방이 그 코드를 맞혔을 때만 내 화면에 발동한다 — 내가 맞힌
        // 경우(userId === myUserId)엔 아무 효과도 재생하지 않는다.
        const item = data.item as ItemType | null | undefined;
        if (item && correct && userId !== myUserId) {
          const effectId = `${codeId}-${Date.now()}`;
          if (item === 'ink') {
            setInkEffects((prev) => [...prev, { id: effectId, type: 'ink', spawnedAt: Date.now() }]);
            window.setTimeout(() => {
              setInkEffects((prev) => prev.filter((e) => e.id !== effectId));
            }, INK_EFFECT_MS);
          } else if (item === 'alert') {
            setAlerts((prev) => [...prev, { id: effectId, type: 'alert', spawnedAt: Date.now() }]);
            window.setTimeout(() => {
              setAlerts((prev) => prev.filter((e) => e.id !== effectId));
            }, ALERT_EFFECT_MS);
          }
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

        // 매칭으로 들어온 판이었으면(preMatchRatingRef가 세팅돼 있으면) 티어가
        // 얼마나 바뀌었는지 계산하고, 헤더 배지도 최신 값으로 갱신한다.
        if (preMatchRatingRef.current !== null) {
          const before = preMatchRatingRef.current;
          preMatchRatingRef.current = null;
          getMyTier()
            .then((info) => {
              setMyTier(info);
              setTierDelta(info.rating - before);

              const beforeTier = ratingToTier(before).tier;
              setPromotion(
                TIERS.indexOf(info.tier) > TIERS.indexOf(beforeTier)
                  ? { from: beforeTier, to: info.tier }
                  : null,
              );
            })
            .catch(() => {});
        }
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

      // 매칭으로 성사된 방은 대기실 화면을 안 보여주는 대신, 방장 쪽에서 곧바로
      // 게임 시작을 걸어준다(수동 "게임 시작" 버튼 없음). 난이도는 서버가 두 사람의
      // 티어를 평균 내주는 게 이상적이지만 백엔드 변경 없이는 알 수 없어 'normal'
      // 고정 — 나중에 백엔드가 지원하면 여기만 바꾸면 된다.
      if (room?.is_host && isRankedMatchRef.current) {
        socket.send(JSON.stringify({ type: 'game.start', difficulty: 'normal' }));
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

  async function handleMatchFound(code: string) {
    setShowMatchmaking(false);
    setError(null);
    setIsRankedMatch(true);
    isRankedMatchRef.current = true;

    // 결산 화면에서 티어 변동을 보여주기 위해 매칭 성사 시점의 레이팅을 스냅샷.
    try {
      const info = await getMyTier();
      preMatchRatingRef.current = info.rating;
    } catch {
      preMatchRatingRef.current = null;
    }

    try {
      const joined = await getRoom(code);
      setRoom(joined);
    } catch (err) {
      setError(getErrorMessage(err));
    }
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
    setPregameCountdown(null);
    setTierDelta(null);
    setPromotion(null);
    setIsRankedMatch(false);
    isRankedMatchRef.current = false;
    preMatchRatingRef.current = null;
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
        {room?.status !== 'playing' && !practiceActive && (
          <div className="lobby-header-user">
            <button type="button" className="btn-link" onClick={() => setShowRules(true)}>
              게임 규칙
            </button>
            <TierBadge tier={myTier?.tier} tierScore={myTier?.tier_score} />
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
              <li>정답 코드를 맞히면 코드 길이에 비례해 최대 1000점까지 얻고, 오답 코드를 잘못 입력하면 -500점이에요.</li>
              <li>같은 코드를 상대와 동시에 노려도 먼저 제출한 사람만 점수를 가져가요.</li>
              <li>화면 아래로 완전히 떨어진 코드는 더 이상 제출할 수 없어요.</li>
              <li>난이도(쉬움/보통/어려움)에 따라 코드가 생성되는 주기와 떨어지는 속도가 달라져요.</li>
              <li>상대가 게임 중간에 나가면 남아있는 쪽이 자동으로 승리해요.</li>
            </ul>
          </div>
        </div>
      )}

      {!room && !practiceActive && (
        <div className="lobby-content">
          <div className="lobby-modes">
            <div className="lobby-card mode-panel mode-ranked">
              <h2>랭킹전</h2>
              <p>비슷한 티어의 상대와 자동으로 매칭돼요. 승패에 따라 티어 점수가 바뀌어요.</p>
              <button type="button" className="btn-primary" onClick={() => setShowMatchmaking(true)}>
                매칭 시작
              </button>
            </div>

            <div className="lobby-card mode-panel mode-friendly">
              <h2>친선전</h2>
              <div className="friendly-tabs">
                <button
                  type="button"
                  className={`friendly-tab-btn ${friendlyTab === 'create' ? 'selected' : ''}`}
                  onClick={() => setFriendlyTab('create')}
                >
                  방 만들기
                </button>
                <button
                  type="button"
                  className={`friendly-tab-btn ${friendlyTab === 'join' ? 'selected' : ''}`}
                  onClick={() => setFriendlyTab('join')}
                >
                  방 참가하기
                </button>
              </div>

              {friendlyTab === 'create' ? (
                <>
                  <p>새로운 방을 만들고 상대방을 초대하세요.</p>
                  <button type="button" className="btn-primary" onClick={handleCreateRoom} disabled={busy}>
                    {busy ? '생성 중...' : '방 만들기'}
                  </button>
                </>
              ) : (
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
              )}
            </div>

            <div className="lobby-card mode-panel mode-practice">
              <h2>연습 모드</h2>
              <p>연습봇을 상대로 감을 익혀보세요. 결과는 저장되지 않아요.</p>
              <button type="button" className="btn-primary" onClick={() => setPracticeActive(true)}>
                연습 시작
              </button>
            </div>
          </div>

          <Leaderboard
            entries={leaderboard}
            me={myLeaderboardRank}
            myUsername={user?.username ?? null}
            worst={worst}
          />
        </div>
      )}

      {showMatchmaking && (
        <MatchmakingModal onMatchFound={handleMatchFound} onClose={() => setShowMatchmaking(false)} />
      )}

      {practiceActive && (
        <PracticeMode myUsername={user?.username ?? null} onExit={() => setPracticeActive(false)} />
      )}

      {error && <p className="field-error">{error}</p>}

      {room && !gameOver && room.status === 'waiting' && pregameCountdown !== null && pregameCountdown > 0 && (
        <div className="start-countdown-overlay" key={`start-${pregameCountdown}`} aria-hidden="true">
          {pregameCountdown}
        </div>
      )}

      {room && !gameOver && room.status === 'waiting' && isRankedMatch && (
        <div className="room-status">
          <h2>매칭 완료!</h2>
          <span className="room-status-label">게임 준비 중</span>

          <div className="player-slots">
            <div className="player-slot filled">
              <span className="player-role">나</span>
              <span className="player-name">{youAreHost ? room.player1 : room.player2}</span>
            </div>
            <div className="player-slot filled">
              <span className="player-role">상대</span>
              <span className="player-name">{opponentUsername}</span>
            </div>
          </div>

          <p className="room-hint">잠시 후 게임이 자동으로 시작돼요.</p>

          <button type="button" className="btn-link" onClick={handleLeaveRoom}>
            나가기
          </button>
        </div>
      )}

      {room && !gameOver && room.status === 'waiting' && !isRankedMatch && (
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
          inkEffects={inkEffects}
          alerts={alerts}
          onDismissAlert={dismissAlert}
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

          {promotion && <PromotionBanner from={promotion.from} to={promotion.to} />}

          <p className="room-hint">
            {resultOutcome === 'draw'
              ? '무승부입니다.'
              : resultOutcome === 'win'
                ? '승리했습니다!'
                : resultOutcome === 'lose'
                  ? '패배했습니다.'
                  : '게임이 종료되었습니다.'}
          </p>
          {tierDelta !== null && !promotion && (
            <p className={`tier-delta-line ${tierDelta > 0 ? 'positive' : 'negative'}`}>
              티어 점수 {tierDelta > 0 ? `+${tierDelta}` : tierDelta}
            </p>
          )}
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

          {/* 랭킹전은 매칭으로 성사된 일회성 대전이라 재대결 개념이 없다 —
              방을 나가면 §room.update 핸들러가 자동으로 다시 매칭을 걸어준다. */}
          {!isRankedMatch &&
            (youAreHost ? (
              <button type="button" className="btn-primary" onClick={handleRematch}>
                재대결
              </button>
            ) : (
              <p className="room-hint">방장이 재대결을 시작하면 자동으로 전환됩니다.</p>
            ))}
          <button type="button" className="btn-link" onClick={handleLeaveRoom}>
            로비로 돌아가기
          </button>
        </div>
      )}
    </div>
  );
}

export default LobbyPage;
