# 로컬 개발 환경 — 디렉토리 구조 및 실행 순서

## 디렉토리 구조

```
26s-w1-c2-06/
├── docker-compose.yml      ← Postgres·Redis (backend-implementation.md §1-1)
├── backend/                ← Django 프로젝트
│   ├── manage.py
│   ├── config/              settings.py, asgi.py, urls.py
│   ├── requirements.txt
│   └── .venv/               (git 추적 안 함)
├── frontend/                ← React(Vite) 프로젝트
│   ├── package.json
│   ├── vite.config.js        /api, /ws 프록시 설정
│   └── src/
└── docs/
```

`backend/`, `frontend/`를 분리하는 이유는 [architecture.md](./architecture.md)/대화에서 정리한 대로 — "Django에 React를 끼워넣는다"는 **배포 시 정적 파일 서빙 방식**에 대한 결정이지, 소스 코드를 한 폴더에 합치라는 뜻이 아니다. 개발 중엔 두 서버를 항상 따로 띄운다.

## 사전 준비 (한 번만)

- Docker Desktop
- Python 3.x + venv
- Node.js + npm

## 실행 순서 (개발 시작할 때마다)

**1. Postgres·Redis 띄우기** (레포 루트에서)

```bash
docker compose up -d
```

Redis가 떠 있어야 Channels의 `CHANNEL_LAYERS` 연결과 클럭 동기화([backend-implementation.md](./backend-implementation.md) §9) 테스트가 실제로 가능하다 — 항상 제일 먼저 띄운다.

**2. 백엔드 서버 실행** (`backend/`에서, 터미널 1)

```bash
cd backend
source .venv/bin/activate
python manage.py runserver
```

→ `http://localhost:8000` (REST API + WebSocket)

**3. 프론트엔드 개발 서버 실행** (`frontend/`에서, 터미널 2 — 백엔드와 별도)

```bash
cd frontend
npm run dev
```

→ `http://localhost:5173` — Vite가 `/api`, `/ws` 요청을 8000번(백엔드)으로 프록시한다. 백엔드가 먼저 떠 있어야 프록시가 응답을 받는다.

**4. 브라우저에서 `http://localhost:5173` 접속**해서 개발/테스트한다 (8000번이 아니라 5173번으로 접속 — HMR이 되는 쪽).

## 종료

```bash
docker compose down   # Postgres·Redis 종료 (볼륨은 유지, 데이터 안 지워짐)
```

## 참고

- 배포 시 실행 순서/구성은 다르다 — [backend-implementation.md](./backend-implementation.md) §1-2 (KCLOUD VM + systemd + Cloudflare) 참고. 배포 후엔 Vite 서버가 따로 없고, 빌드된 프론트 정적 파일을 Django가 직접 서빙한다.
- 서버별 역할: Django = API + WebSocket (+ 배포 시엔 정적 프론트까지), Vite = 개발 중 프론트 HMR 전용 (배포엔 관여 안 함)
