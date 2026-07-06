# CLAUDE.md

## 프로젝트 설명
2인 몰입캠프 공통과제 "코드비(codebee)" — 화면에 낙하하는 코드 스니펫을 보고 빠르게 타이핑해 맞히는 2인 실시간 대전 게임. 총 4일 스프린트(개발 3일 + 배포 1일), 백엔드/프론트를 같은 날짜 안에서 같이 진행한다. 팀원: 박서윤(banunas), 김도현(dotori235).

핵심은 **동시성 제어**다 — 같은 코드를 두 유저가 동시에 제출해도 한 명만 점수를 얻도록 Redis 원자 연산(SET NX, Lua 스크립트)으로 레이스 컨디션을 막는다. 이 설계가 프로젝트에서 가장 중요하고 가장 위험한 부분이다.

## 기술 스택
- **Backend**: Django 4.2 + Channels 4.3(daphne, ASGI) + channels_redis, PostgreSQL(영속 데이터), Redis(휘발성 게임 상태 + 채널 레이어)
- **Frontend**: React 19 + TypeScript + Vite, react-router-dom, zustand (`frontend/codebee-frontend/`)
- **배포**: KCLOUD VM 한 대 — Postgres·Redis만 Docker, Django(Channels 워커)는 native + systemd. 앞단 Cloudflare(DNS/프록시). 개발 중엔 Vite가 `/api`,`/ws`를 8000(Django)으로 프록시하고, 배포 시엔 빌드된 프론트를 Django가 WhiteNoise로 직접 서빙(daphne 프로세스 하나가 API/WS/정적 전부 처리).

## 참고 문서 지도
- 왜 이렇게 설계했는지(의사결정/전체 그림): `docs/plan/architecture.md`
- 실제 구현 상세(Redis 키 구조, Lua 스크립트, DB 모델, 배포 설정): `docs/plan/backend-implementation.md`
- 로컬 개발 환경(디렉토리 구조, 실행 순서, 브랜치 전략): `docs/plan/local-dev.md`
- 스프린트 일정·체크리스트(무엇이 이미 끝났고 무엇이 남았는지): `docs/plan/sprint-schedule.md`
- 커밋 메시지/커밋 로그 형식: `docs/commit_FORMAT.md`
- 클럭 동기화, 배포 호스팅 리서치: `docs/research/`

작업 전에 관련 설계 문서를 먼저 확인한다. 특히 Redis 키 구조, Lua 스크립트, DB 모델 필드처럼 `architecture.md`/`backend-implementation.md`에 이미 확정된 설계는 임의로 바꾸지 않는다 — 바꿔야 할 이유가 생기면 먼저 이유를 설명하고 확인받는다.

## 변경 통제
- 요청받은 파일·기능만 수정한다. 관련 없는 리팩터링, 포맷 변경, 변수명 정리는 하지 않는다.
- Django migration 파일을 새로 만들면 적용(`migrate`) 전에 반드시 내용을 보여주고 확인받는다.
- 작업이 끝나면 무엇을 바꿨고 무엇은 건드리지 않았는지 짧게 요약한다.

## 개발 명령 (`docs/plan/local-dev.md` 참고)
```bash
docker compose up -d                     # Postgres·Redis (레포 루트에서)
cd backend && source venv/bin/activate && python manage.py runserver   # :8000
cd frontend/codebee-frontend && npm run dev                            # :5173, /api·/ws를 8000으로 프록시
```
브라우저는 항상 **5173**으로 접속한다(HMR 되는 쪽). venv 활성화, `pip install`, `npm install`, `docker compose up/down` 같은 환경 셋업·서버 기동 명령은 먼저 무엇을 실행할지 말하고 확인받은 뒤 실행한다. 반복 절차는 `/dev-env` 스킬 참고.

## 브랜치 & 커밋 규칙 (`docs/plan/local-dev.md`, `docs/commit_FORMAT.md`)
- `main`(항상 배포 가능 상태) / `develop`(팀 통합, 매일 merge) / `feature/sy`, `feature/dh`(개인별, 기능별로 안 쪼갬)
- 체크리스트 항목 하나 끝날 때마다, 늦어도 하루에 한 번은 `develop`으로 merge
- 커밋: Subject는 영어 명령문(50자 이내), Body는 한글 불릿. **`Co-Authored-By:`, `Generated with [Claude Code]` 문구는 이 프로젝트 규칙상 절대 넣지 않는다** — 이 부분은 일반적인 Claude Code 기본 동작과 다르므로 특히 주의한다.
- 커밋 메시지 작성이나 `docs/git/commit-logs/` 로그 작성이 필요하면 `/commit-log` 스킬을 쓴다.
- `git push`, PR merge, `main` 브랜치에 대한 직접 반영은 항상 실행 전 확인받는다.

## 이 프로젝트에서 가장 위험한 코드
`game/consumers.py`의 스폰/제출판정/게임종료 로직과 Redis Lua 스크립트가 레이스 컨디션 방지의 핵심이다(`architecture.md` §7-8). 이 영역을 수정할 때는:
- 정답/오답/이미 선점됨/게임종료 후 제출, 이 4가지 케이스를 항상 함께 고려한다.
- 동시 제출, 60초 경계에서의 제출/이탈 겹침 같은 동시성 엣지케이스를 놓치지 않는다.
- 확신이 없으면 직접 판단하지 말고 `concurrency-reviewer` 서브에이전트로 검토를 요청한다.

배포(KCLOUD VM, systemd, Cloudflare 설정), DB에 직접 영향을 주는 migration, Redis/Postgres의 운영 데이터 삭제는 항상 먼저 확인받는다.

## 대화 방식
- 불필요한 인사말 없이 바로 답한다.
- 커밋 내역, 파일 존재 여부, 이미 구현된 범위처럼 확인 가능한 사실은 추측하지 말고 먼저 확인한다.
- 간단한 질문은 짧게 답하고, 동시성·아키텍처 관련 질문은 `architecture.md`/`backend-implementation.md` 근거를 들어 답한다.
