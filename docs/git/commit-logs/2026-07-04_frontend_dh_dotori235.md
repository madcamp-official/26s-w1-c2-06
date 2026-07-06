# feat(ui): Add login, signup, and lobby screens

## 1. 기본 정보

| 항목 | 내용 |
|------|------|
| 작성자 | dotori235 |
| 브랜치 | frontend_dh |
| 날짜 | 2026-07-04 |
| 버전 | v0.1.0 |

---

## 2. 커밋 메시지

```
feat(ui): Add login, signup, and lobby screens

Version: v0.1.0

로그인/회원가입/로비 화면을 신규 구현함

- Django 세션+CSRF 인증 방식에 맞춘 API 클라이언트(api/client.ts,
  api/auth.ts, api/rooms.ts)와 zustand 인증 스토어(authStore.ts) 추가
- 로그인/회원가입 폼에 클라이언트 검증과 서버 에러 코드별 안내 메시지 적용
- 로비 화면에 방 생성/코드로 참가, player1·player2 슬롯 표시, 2초 간격
  방 상태 폴링 구현
- react-router 기반 라우팅과 인증 가드(ProtectedRoute/GuestRoute) 추가
- vite.config.ts에 /api, /ws를 localhost:8000 백엔드로 프록시하는 설정 추가
```

---

## 3. 변경 파일

| 상태 | 파일 | 설명 |
|------|------|------|
| A | frontend/codebee-frontend/.gitignore | node_modules/dist 등 제외 규칙 |
| A | frontend/codebee-frontend/package.json | react-router-dom, zustand 등 의존성 정의 |
| A | frontend/codebee-frontend/package-lock.json | 의존성 잠금 파일 |
| A | frontend/codebee-frontend/vite.config.ts | /api, /ws → localhost:8000 프록시 설정 |
| A | frontend/codebee-frontend/index.html | 앱 엔트리 HTML |
| A | frontend/codebee-frontend/tsconfig*.json | TypeScript 프로젝트 설정 |
| A | frontend/codebee-frontend/eslint.config.js | ESLint 설정 |
| A | frontend/codebee-frontend/src/main.tsx | React 엔트리포인트 |
| A | frontend/codebee-frontend/src/index.css | 전역 스타일/디자인 토큰 |
| A | frontend/codebee-frontend/src/vite-env.d.ts | Vite 클라이언트 타입 참조 |
| A | frontend/codebee-frontend/src/App.tsx | 라우팅 및 인증 초기화 |
| A | frontend/codebee-frontend/src/App.css | 로딩 화면 스타일 |
| A | frontend/codebee-frontend/src/types.ts | User/Room 공용 타입 |
| A | frontend/codebee-frontend/src/api/client.ts | CSRF 처리 fetch 래퍼, 에러 메시지 매핑 |
| A | frontend/codebee-frontend/src/api/auth.ts | signup/login/logout/me 호출 함수 |
| A | frontend/codebee-frontend/src/api/rooms.ts | createRoom/joinRoom/getRoom 호출 함수 |
| A | frontend/codebee-frontend/src/store/authStore.ts | zustand 인증 상태 스토어 |
| A | frontend/codebee-frontend/src/components/ProtectedRoute.tsx | 인증 필요 라우트 가드 |
| A | frontend/codebee-frontend/src/components/GuestRoute.tsx | 비로그인 전용 라우트 가드 |
| A | frontend/codebee-frontend/src/pages/LoginPage.tsx | 로그인 화면 |
| A | frontend/codebee-frontend/src/pages/SignupPage.tsx | 회원가입 화면 |
| A | frontend/codebee-frontend/src/pages/LobbyPage.tsx | 로비 화면(방 생성/참가/상태 폴링) |
| A | frontend/codebee-frontend/src/pages/AuthPage.css | 로그인/회원가입 공용 스타일 |
| A | frontend/codebee-frontend/src/pages/LobbyPage.css | 로비 화면 스타일 |

---

## 4. 변경 배경 및 결과

백엔드 팀원이 정리한 API 명세(`/api/csrf/`, `/api/signup/`, `/api/login/`, `/api/logout/`, `/api/me/`, `/api/rooms/` 등, 세션+CSRF 기반 인증)를 기준으로, 프론트엔드에 회원가입·로그인·로비 화면이 아직 없어 사용자가 계정을 만들고 게임 방에 들어가기까지의 진입 경로 자체가 없었다.

이를 해결하기 위해 Django의 세션 쿠키 + CSRF 토큰 인증 방식에 맞춘 API 클라이언트 계층을 먼저 구성하고, 그 위에 로그인/회원가입 폼과 로비 화면(방 생성·코드 참가·상대방 입장 대기)을 구현했다. 백엔드 팀원과의 작업 충돌을 피하기 위해 `frontend/` 디렉터리 바깥은 일절 수정하지 않았다.

결과적으로 사용자가 회원가입 → 로그인 → 방 생성/참가까지 이어지는 진입 흐름을 프론트엔드에서 끝까지 탈 수 있게 되었고, 백엔드에 실제 API가 배포되면 별도 프론트 수정 없이 바로 연동 가능한 상태가 되었다.

---

## 5. 중요 변경 사항

- Django 세션 인증 특성상 POST 요청 전 `/api/csrf/`로 쿠키를 먼저 확보하고 `X-CSRFToken` 헤더를 첨부하는 공용 fetch 래퍼(`api/client.ts`)를 도입 — 이후 모든 POST 요청이 이 래퍼를 거치도록 통일
- 서버 에러 코드(`duplicate_username`, `invalid_credentials`, `room_full` 등)를 한글 안내 메시지로 매핑하는 테이블을 두어, 개별 화면에서 에러 문자열을 하드코딩하지 않도록 함
- `zustand` 기반 인증 스토어가 앱 시작 시 `/api/me/`로 세션 상태를 한 번만 확인하고, `ProtectedRoute`/`GuestRoute`가 그 결과만 참조하도록 구조화 — 중복 네트워크 요청 방지
- 로비 화면은 방 상태가 `waiting`인 동안에만 2초 간격으로 `GET /api/rooms/{code}/`를 폴링하고, `playing`/`finished`로 바뀌면 자동으로 폴링을 멈춤
- 개발 편의를 위해 `vite.config.ts`에 `/api`, `/ws` 프록시를 추가해 프론트(5173)·백엔드(8000)를 분리 실행해도 쿠키/CORS 이슈 없이 연동되도록 함

---

## 6. 통계

| 항목 | 값 |
|------|-----|
| 변경 파일 수 | 26 |
| 추가 라인 | +3629 |
| 삭제 라인 | -0 |

---

## 7. 요약

사용자가 서비스에 처음 들어왔을 때 거치게 되는 회원가입, 로그인, 그리고 게임 방을 만들거나 코드로 들어가는 로비 화면을 새로 만들었다. 회원가입 시 아이디 중복이나 로그인 시 잘못된 비밀번호 같은 경우에는 한글로 이유를 안내한다. 방을 만들면 코드가 발급되고, 상대방이 그 코드로 들어오면 화면이 자동으로 갱신되어 별도로 새로고침하지 않아도 상대방이 들어왔는지 알 수 있다. 아직 백엔드의 실제 회원가입/로그인 처리 로직은 구현 전이라, 화면 자체는 완성되었지만 실제 계정 생성·로그인은 백엔드 작업이 끝나야 동작한다.
