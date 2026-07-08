import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { GuestRoute } from './components/GuestRoute';
import { ProtectedRoute } from './components/ProtectedRoute';
import CursorBee from './components/CursorBee';
import SoundToggle from './components/SoundToggle';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import { useAuthStore } from './store/authStore';
import { playClick, playHover, unlockAudio } from './lib/sound';
import './App.css';

function App() {
  const status = useAuthStore((state) => state.status);
  const checkAuth = useAuthStore((state) => state.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // 모든 버튼이 시맨틱 <button>이라 전역 위임 하나로 호버/클릭음을 다 처리한다 —
  // 개별 컴포넌트를 건드릴 필요가 없다. mouseover는 버블링되므로(mouseenter는 안 됨)
  // relatedTarget이 같은 버튼 안에서 온 게 아닐 때만 "진입"으로 간주한다.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      unlockAudio();
      const button = (e.target as HTMLElement | null)?.closest('button');
      if (button && !button.disabled) playClick();
    }

    function handleOver(e: MouseEvent) {
      const button = (e.target as HTMLElement | null)?.closest('button');
      if (!button || button.disabled) return;
      const related = e.relatedTarget as Node | null;
      if (related && button.contains(related)) return;
      playHover();
    }

    document.addEventListener('click', handleClick);
    document.addEventListener('mouseover', handleOver);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('mouseover', handleOver);
    };
  }, []);

  if (status !== 'ready') {
    return (
      <>
        <CursorBee />
        <SoundToggle />
        <div className="page-loading">
          <p>불러오는 중...</p>
        </div>
      </>
    );
  }

  return (
    <>
      <CursorBee />
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              <GuestRoute>
                <LoginPage />
              </GuestRoute>
            }
          />
          <Route
            path="/signup"
            element={
              <GuestRoute>
                <SignupPage />
              </GuestRoute>
            }
          />
          <Route
            path="/lobby"
            element={
              <ProtectedRoute>
                <LobbyPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/lobby" replace />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}

export default App;
