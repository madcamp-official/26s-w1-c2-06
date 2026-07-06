import { useEffect, useRef, useState } from 'react';
import type { SubmitEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../api/auth';
import { getErrorMessage } from '../api/client';
import { createRoom, getRoom, joinRoom } from '../api/rooms';
import { useAuthStore } from '../store/authStore';
import type { Room } from '../types';
import './LobbyPage.css';

const STATUS_LABEL: Record<Room['status'], string> = {
  waiting: '대기 중',
  playing: '게임 진행 중',
  finished: '종료됨',
};

function LobbyPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);

  const [room, setRoom] = useState<Room | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pollTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!room || room.status !== 'waiting') return;

    pollTimer.current = window.setInterval(async () => {
      try {
        const updated = await getRoom(room.code);
        setRoom(updated);
      } catch {
        // 폴링 실패는 조용히 무시하고 다음 주기에 재시도한다
      }
    }, 2000);

    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [room]);

  // 방에 입장한 동안 연결을 유지하다가, 소켓이 끊기면(나가기 버튼 또는 탭 종료)
  // 서버 disconnect() 핸들러가 대기 중 이탈 처리를 해준다 (backend-implementation.md §7).
  useEffect(() => {
    if (!room?.code) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/room/${room.code}/`);
    wsRef.current = socket;

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [room?.code]);

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

  function handleLeaveRoom() {
    wsRef.current?.close();
    setRoom(null);
    setError(null);
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

  return (
    <div className="lobby-page">
      <header className="lobby-header">
        <span>{user?.username}님 환영합니다</span>
        <button type="button" className="btn-link" onClick={handleLogout}>
          로그아웃
        </button>
      </header>

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

      {error && <p className="field-error">{error}</p>}

      {room && (
        <div className="room-status">
          <h2>방 코드: {room.code}</h2>
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

          {room.status === 'waiting' && !room.player2 && (
            <p className="room-hint">상대방이 입장하면 자동으로 갱신됩니다.</p>
          )}
          {room.status === 'waiting' && room.player2 && (
            <p className="room-hint">두 명 모두 입장했습니다. 곧 게임이 시작됩니다.</p>
          )}

          {room.status === 'waiting' && (
            <button type="button" className="btn-link" onClick={handleLeaveRoom}>
              방 나가기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default LobbyPage;
