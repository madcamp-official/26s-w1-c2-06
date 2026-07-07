import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { GuestRoute } from './components/GuestRoute';
import { ProtectedRoute } from './components/ProtectedRoute';
import CursorBee from './components/CursorBee';
import LobbyPage from './pages/LobbyPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import { useAuthStore } from './store/authStore';
import './App.css';

function App() {
  const status = useAuthStore((state) => state.status);
  const checkAuth = useAuthStore((state) => state.checkAuth);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (status !== 'ready') {
    return (
      <>
        <CursorBee />
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
