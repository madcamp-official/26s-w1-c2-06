import { useEffect, useRef, useState } from 'react';
import { ratingToTier, TIER_LABEL } from '../lib/tier';
import type { Tier } from '../lib/tier';
import './MatchmakingModal.css';

interface MatchmakingModalProps {
  onMatchFound: (code: string, opponentTier: Tier | null, opponentTierScore: number | null) => void;
  onClose: () => void;
}

// ws/matchmaking/ 연결을 이 컴포넌트가 직접 소유한다 — 마운트 시 큐 등록,
// 언마운트/취소 시 큐 이탈. 매칭 방(room) 소켓과는 완전히 별개 연결.
function MatchmakingModal({ onMatchFound, onClose }: MatchmakingModalProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [failed, setFailed] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const matchedRef = useRef(false);

  useEffect(() => {
    // React StrictMode(개발 모드)는 mount→cleanup→재mount를 동기적으로 한 번 더
    // 돌린다. 소켓을 곧바로 열면 첫 번째(phantom) 소켓도 실제로 서버까지 접속해
    // 큐에 등록되고, phantom의 cleanup이 보내는 queue.leave가 "진짜" 두 번째
    // 소켓의 재등록보다 늦게 서버에 도착하면 방금 재등록한 큐 항목까지 지워버려서
    // — 실제 연결은 살아있는데 서버 큐에는 없는 상태가 되어 매칭이 영영 안 되는
    // 버그가 생긴다. setTimeout(0)으로 한 틱 미뤄서, phantom은 콜백이 실행되기도
    // 전에 cancelled=true로 취소돼 애초에 소켓을 열지 않게 만든다.
    let cancelled = false;
    let closing = false;
    let socket: WebSocket | null = null;

    const timer = window.setTimeout(() => {
      if (cancelled) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/matchmaking/`);
      wsRef.current = socket;

      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'queue.joined') {
          setRating(data.rating as number);
        } else if (data.type === 'match.found') {
          matchedRef.current = true;
          closing = true;
          onMatchFound(
            data.code as string,
            (data.opponent_tier as Tier | null) ?? null,
            (data.opponent_tier_score as number | null) ?? null,
          );
        } else if (data.type === 'queue.left') {
          closing = true;
          onClose();
        }
      };

      socket.onclose = () => {
        if (!closing) setFailed(true);
      };
      socket.onerror = () => {
        closing = true;
        setFailed(true);
      };
    }, 0);

    return () => {
      cancelled = true;
      closing = true;
      window.clearTimeout(timer);
      // 매칭이 이미 성사됐으면 서버가 알아서 소켓을 닫아줌 — 그 외엔(취소/언마운트)
      // 큐에서 빠지겠다고 알려주고 닫는다.
      if (socket && !matchedRef.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'queue.leave' }));
      }
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (failed) return;
    const timer = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [failed]);

  function handleCancel() {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'queue.leave' }));
    } else {
      onClose();
    }
  }

  if (failed) {
    return (
      <div className="rules-overlay" role="presentation">
        <div className="matchmaking-modal" role="dialog" aria-modal="true">
          <h2>매칭 연결이 끊겼어요</h2>
          <p className="room-hint">네트워크 문제일 수 있어요. 다시 시도해주세요.</p>
          <button type="button" className="btn-link" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    );
  }

  const ratingInfo = rating !== null ? ratingToTier(rating) : null;
  const mm = String(Math.floor(elapsedSec / 60)).padStart(1, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');

  return (
    <div className="rules-overlay" role="presentation">
      <div className="matchmaking-modal" role="dialog" aria-modal="true">
        <h2>매칭 중...</h2>
        <p className="matchmaking-timer">
          {mm}:{ss}
        </p>
        {ratingInfo && (
          <p className="matchmaking-rating">
            내 티어: {TIER_LABEL[ratingInfo.tier]} {ratingInfo.tierScore}
          </p>
        )}
        <p className="room-hint">비슷한 티어의 상대를 찾고 있어요. 오래 걸리면 범위가 점점 넓어져요.</p>
        <button type="button" className="btn-link" onClick={handleCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

export default MatchmakingModal;
