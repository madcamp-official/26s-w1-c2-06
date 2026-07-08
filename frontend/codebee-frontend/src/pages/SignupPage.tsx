import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { signup } from '../api/auth';
import { getErrorMessage } from '../api/client';
import './AuthPage.css';

function SignupPage() {
  const navigate = useNavigate();

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
      await signup(username, String(password).padStart(4, '0'));
      navigate('/login', { replace: true, state: { signupSuccess: true } });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1 className="auth-title">회원가입</h1>

        <label className="field">
          <span>아이디 (영문/숫자, 15자 이내)</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 15))}
            maxLength={15}
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
          {submitting ? '가입 중...' : '회원가입'}
        </button>

        <p className="auth-switch">
          이미 계정이 있으신가요? <Link to="/login">로그인</Link>
        </p>
      </form>
    </div>
  );
}

export default SignupPage;
