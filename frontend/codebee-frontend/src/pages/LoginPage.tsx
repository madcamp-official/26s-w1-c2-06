import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { login } from '../api/auth';
import { getErrorMessage } from '../api/client';
import { useAuthStore } from '../store/authStore';
import './AuthPage.css';

function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useAuthStore((state) => state.setUser);

  const signupSuccess = Boolean((location.state as { signupSuccess?: boolean } | null)?.signupSuccess);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!username) {
      setError('아이디를 입력해주세요.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(username, String(password).padStart(4, '0'));
      setUser(user);
      navigate('/lobby', { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1 className="auth-title">로그인</h1>

        {signupSuccess && <p className="field-success">회원가입이 완료되었습니다. 로그인해주세요.</p>}

        <label className="field">
          <span>아이디</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label className="field">
          <span>비밀번호 (0~9999)</span>
          <div className="password-slider-row">
            <input
              type="range"
              min={0}
              max={9999}
              value={password}
              onChange={(e) => setPassword(Number(e.target.value))}
              className="password-slider"
            />
            <span className="password-slider-value">{String(password).padStart(4, '0')}</span>
          </div>
        </label>

        {error && <p className="field-error">{error}</p>}

        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '로그인 중...' : '로그인'}
        </button>

        <p className="auth-switch">
          계정이 없으신가요? <Link to="/signup">회원가입</Link>
        </p>
      </form>
    </div>
  );
}

export default LoginPage;
