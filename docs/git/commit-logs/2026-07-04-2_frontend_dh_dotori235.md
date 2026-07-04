# fix(config): Remove changeOrigin from /api dev proxy

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
fix(config): Remove changeOrigin from /api dev proxy

Version: v0.1.0

실제 백엔드 API로 회원가입/로그인 E2E 테스트 중 CSRF 403 오류를 발견해 수정함

- vite dev 프록시가 changeOrigin: true로 Host 헤더를 localhost:8000으로
  바꾸면서, 브라우저가 보낸 Origin(localhost:5173)과 불일치해 Django
  CSRF Origin 검증이 항상 403으로 실패하던 문제 확인
- changeOrigin 옵션을 제거해 Host 헤더를 원래 값(localhost:5173)으로
  유지, DEBUG 모드의 기본 ALLOWED_HOSTS(localhost) 범위 안에서 Origin과
  Host가 일치하도록 수정
- 회원가입/로그인/me/방 생성/참가/로비 폴링/로그아웃 전체 플로우를 실제
  백엔드(develop 브랜치 병합분)와 프록시를 통해 curl로 재현·검증함
```

---

## 3. 변경 파일

| 상태 | 파일 | 설명 |
|------|------|------|
| M | frontend/codebee-frontend/vite.config.ts | `/api` 프록시에서 `changeOrigin: true` 옵션 제거 |

---

## 4. 변경 배경 및 결과

백엔드 팀원이 `develop` 브랜치에 실제 회원가입/로그인/방 API를 구현해 푸시했고, 이를 `frontend_dh`로 머지한 뒤 Django(8000)·Vite(5173) 두 서버를 실제로 띄워 프론트가 만든 API 클라이언트로 회원가입을 시도했다. 그 결과 매 요청이 `CSRF verification failed. Origin checking failed - http://localhost:5173 does not match any trusted origins.` 라는 403으로 실패했다.

원인은 `vite.config.ts`의 `/api` 프록시 옵션 `changeOrigin: true`였다. 이 옵션이 프록시가 백엔드로 요청을 전달할 때 `Host` 헤더를 대상 서버 주소(`localhost:8000`)로 바꿔치기하는데, 브라우저가 실제로 보내는 `Origin` 헤더는 그대로 `http://localhost:5173`이라 두 값이 어긋나 Django의 CSRF Origin 검증(Django 4.0+ 기본 동작)이 항상 실패했다.

`changeOrigin`을 제거해 프록시가 원래 `Host` 헤더(`localhost:5173`)를 그대로 백엔드에 전달하도록 바꿨다. Django는 `DEBUG=True`이고 `ALLOWED_HOSTS`가 비어 있을 때 `localhost`/`127.0.0.1`/`[::1]`을 기본 허용하므로, `Host`와 `Origin`이 둘 다 `localhost:5173`으로 일치하게 되어 CSRF 검증을 통과한다. 백엔드 설정(`CSRF_TRUSTED_ORIGINS` 등)은 건드리지 않고 프론트엔드 프록시 설정만으로 해결했다.

수정 후 회원가입 → 로그인 → 세션 확인(`/api/me/`) → 방 생성 → 다른 계정으로 참가 → 로비 상태 조회(상대방 입장 반영) → 로그아웃까지 전체 플로우를 curl로 재현해 실제 백엔드와 정상 연동됨을 확인했다.

---

## 5. 중요 변경 사항

- 로컬 개발 환경에서 프론트(5173)·백엔드(8000)를 분리 실행하는 구조(`docs/plan/local-dev.md`)를 유지하면서, Django의 세션+CSRF 인증과 실제로 호환되도록 프록시 설정을 조정
- 이 수정으로 이전 커밋에서 명세만 보고 구현했던 API 클라이언트가 실제 백엔드 구현과 처음으로 end-to-end 검증됨

---

## 6. 통계

| 항목 | 값 |
|------|-----|
| 변경 파일 수 | 1 |
| 추가 라인 | +0 |
| 삭제 라인 | -1 |

---

## 7. 요약

개발 중 프론트엔드 화면에서 백엔드로 보내는 요청이 보안 검증에 막혀 전부 실패하던 문제를 찾아 고쳤다. 사용자가 겪는 증상으로 치면 "회원가입/로그인 버튼을 눌러도 아무것도 안 되던" 상태였는데, 이번 수정으로 실제 회원가입 → 로그인 → 방 만들기/참가까지 정상적으로 동작하는 것을 확인했다.
