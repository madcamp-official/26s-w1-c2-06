# 개발 스프린트 일정

총 4일 — 개발 3일 + 배포 1일(마지막 날). [architecture.md](./architecture.md)/[backend-implementation.md](./backend-implementation.md)에 이미 확정된 설계를 구현 순서대로 나눈 것이라, 이 문서에서 새로 설계하는 내용은 없다. 백엔드·프론트엔드를 같은 날짜 안에서 같이 진행한다(백엔드 먼저 끝내고 프론트 시작하는 구조 아님) — 그날그날 만든 기능을 눈으로 바로 확인하려면 두 쪽이 같이 붙어야 하기 때문.

## 프론트엔드 스택 및 통합 방식

**React(Vite) + Django에 끼워넣기.** 데이터는 완전 분리 방식과 동일하게 REST API + WebSocket으로 주고받는다 — 차이는 "빌드 산출물을 어디서 서빙하느냐"뿐이다.

- **개발 중**: Vite 개발 서버(HMR)를 그대로 쓰되, `/api`, `/ws` 요청을 Django(daphne)로 프록시 — 브라우저 입장에서 같은 origin이라 CORS 설정 불필요
- **배포 시**: `npm run build` 산출물을 Django `STATICFILES_DIRS`에 연결하고 WhiteNoise로 서빙 — daphne 프로세스 하나가 API/WS/정적 프론트 전부 처리 (VM에 서버 프로세스 하나만 있으면 됨)

## 전체 그림

```
Day 1                          Day 2              Day 3           Day 4
셋업+인증+방입장+WS 골격   →   핵심 게임 로직   →  통합/QA/버그  →  KCLOUD 배포
(모델, Room, Consumer,         (스폰/판정/종료,     수정+배포준비     +Cloudflare
 로그인/로비 화면)              게임/결산 화면)                       (+프론트 빌드 배포)
```

각 날짜는 전날 산출물에 의존한다 — Day 1의 모델·Consumer 골격이 있어야 Day 2의 스폰/판정 로직을 붙일 수 있고, 프론트도 그 날 나온 API/WS 이벤트를 그대로 붙여써야 하므로 순서를 바꾸기 어렵다.

## Day 1 — 셋업 + 데이터 모델 + 인증 + 방 입장 + WebSocket 골격

**백엔드**
- [👍] Django 프로젝트 초기화, Channels(ASGI) 설정
- [😁] `docker-compose.yml`로 로컬 Postgres·Redis 실행 ([backend-implementation.md](./backend-implementation.md) §1-1)
- [💪] DB 모델 구현 + migration: `Profile`, `Room`, `CodeSnippet`, `GameResult` (§2)
- [👍] 회원가입/로그인 (Django 기본 auth 활용, 중복 아이디 검사, 비밀번호 정책 없음 — README 필수 기능)
- [x] `CodeSnippet` 시드 데이터 준비 (정답/오답 코드 텍스트 풀, `text` unique 제약 감안해서 중복 없이 준비)
- [💪] 방 생성/참가 API (초대 코드 발급, `Room.player1`/`player2` 슬롯 채움, 정원 2명 검증)
- [x] 방 안 유저 목록 표시용 데이터, "game start" 트리거 (호스트만 시작 가능)
- [x] Channels Consumer 골격: `connect()` → `room_group_name`에 `group_add`, 대기 중 이탈 처리 (§7 전반부 — 비방장 이탈/방장 위임/빈 방 소프트 종료)
- [x] 게임 시작 이벤트 처리: `game_started_at` 기록 + `game.start` 브로드캐스트 (§6 "게임 시작" 파트)
- [x] 클럭 동기화 핸들러: `clock.sync` 메시지 받으면 서버 시각 실어 즉시 응답 (§9, stateless)

**프론트엔드**
- [ ] Vite + React 프로젝트 셋업, `/api`·`/ws` 프록시 설정
- [ ] POST 하는 API 호출할 때 마다 쿠키에서 토큰을 읽어오는 공용 함수를 만들기. 
- [ ] 회원가입/로그인 화면 (폼, 에러 메시지 표시 — 중복 아이디 등)
- [ ] 로비 화면: 방 생성/참가(코드 입력), 방 안 유저 목록, "game start" 버튼(호스트에게만 노출)
- [ ] WebSocket 연결: 방 접속 시 WS 오픈, 유저 목록/게임 시작 이벤트 수신 처리
- [ ] 접속 직후 클럭 오프셋 측정 (§9): `clock.sync` 3~5회 왕복 → 최소 RTT 샘플로 `offset` 계산, 이후 낙하 위치 계산에 사용

**병렬 가능**: 모델/마이그레이션은 한 명이 먼저 끝내야 나머지가 그 위에서 작업 가능 — 이것만 순차로 먼저 처리. 이후 (a) 인증 API + 로그인/회원가입 화면, (b) 방 생성/참가 API + Consumer 골격 + 로비 화면을 백/프론트로 나눠서, 혹은 두 명이 한 기능씩 풀스택으로 맡아서 동시 진행. 하루치고 항목이 많으니 두 명 다 이 날은 풀로 투입하는 걸 권장.

## Day 2 — 핵심 게임 로직 (스폰 / 판정 / 종료)

**백엔드**
- [x] 스폰 틱 로직 (§4): `spawn_lock` 선점, 로컬 스니펫 풀에서 후보 선택, `codes`/`text_index` Redis 기록, `code.spawn` 브로드캐스트
- [x] 제출 판정 Lua 스크립트 연동 (§5): 유저 제출 수신 → 스크립트 실행 → 결과 브로드캐스트
- [x] 게임 종료 로직 (§6): 60초 경과 체크, `game_end_lock`, 점수 비교로 `winner` 계산, `GameResult`/`Profile.total_score` 기록, Redis 키 정리, `game.over` 브로드캐스트
- [x] 게임 중 이탈 강제 종료 (§7 후반부): `disconnect()` 시 즉시 `game_end_lock` 트리거, 남은 유저를 `winner`로 강제 지정
- [ ] **자동화 테스트**: 이 프로젝트에서 가장 위험한 코드가 오늘 나오는 만큼, 구현과 같이 짠다 (나중에 몰아서 안 함)
  - Lua 스크립트 단위 테스트 (실제 로컬 Redis에 대고 `EVAL` 직접 호출 — 정답/오답/이미 선점됨/게임종료 후 4가지 케이스)
  - Consumer 통합 테스트 (Channels `WebsocketCommunicator`로 connect→spawn→submit→score 흐름 검증)
  - 게임 종료 동시 트리거 테스트 (같은 방에 대해 `game_end_lock` 획득 요청 2번 보냈을 때 정확히 하나만 통과하는지)
  - [ ] 포트 터널링 공부하기. VM 에서 열리는 포트가 20,443 같은 거밖에없는데 장고는 8000이라 문제생기나봄(내 추측)

**프론트엔드**
- [ ] 게임 화면: `code.spawn` 이벤트 수신 → 낙하 애니메이션 렌더링 (`spawn_ts` 기준으로 위치 계산, [architecture.md](./architecture.md) §5)
- [ ] 텍스트 입력창 + Enter 제출 → WS 전송
- [ ] 판정 결과 수신 → 매칭된 텍스트 제거, 점수 갱신 표시
- [ ] 60초 타이머 표시 (`game_started_at` 기준 카운트다운)
- [ ] `game.over` 이벤트 수신 → 결산 화면으로 전환

**병렬 가능**: 백엔드는 스폰 로직과 판정 Lua 스크립트가 서로 다른 Redis 키를 다루므로 두 명이 동시 작업 가능 — 게임 종료 로직은 스폰+판정이 어느 정도 동작해야 테스트 가능하니 가장 나중에. 프론트는 낙하 애니메이션(스폰 이벤트 의존)과 입력창/제출 로직(판정 이벤트 의존)을 나눠서 각자 붙는 백엔드 항목이 준비되는 대로 붙여나간다. 이 날이 전체 스프린트에서 가장 무거우니 Day 1보다 시간을 넉넉히 잡는다.

## Day 3 — 통합 / QA / 버그 수정 / 배포 준비

**공통**
- [ ] 전체 플로우 수동 QA — 실제로 브라우저 두 개(또는 두 사람)로 방 생성부터 결산까지 한 판 플레이 (Day 2에서 짠 자동화 테스트가 못 잡는, 눈으로 봐야 아는 문제 위주 — 애니메이션 어색함, 타이밍 체감 등)
- [ ] 동시성 엣지케이스 확인: 두 유저가 거의 동시에 같은 코드 제출, 60초 경계에서 제출/이탈이 겹치는 경우 (Day 2 자동화 테스트로 이미 커버됐다면 여기선 회귀 확인만)
- [ ] 방장 위임/빈 방 종료, 게임 중 이탈 처리 마무리 점검 (백엔드 로직 + 프론트 화면 반응 둘 다)

**백엔드**
- [ ] 배포 준비: `.env.example` 정리, `requirements.txt` 고정, `DEBUG=False` 등 운영 설정 분리

**프론트엔드**
- [ ] 결산 화면 마무리 (최종 점수/승패 표시)
- [ ] 빌드 파이프라인 준비: `npm run build` → Django `STATICFILES_DIRS` 연결, WhiteNoise 설정, SPA 서빙용 Django 뷰 작성
- [ ] UI 버그/엣지케이스 수정 (재접속 시 화면, 상대방 이탈 알림 등)

**남은 버그 수정 여유 시간** (하루 중 절반 정도는 버퍼로 비워두기를 권장)

## Day 4 — KCLOUD VM 배포 (배포 공부 + 실습)

[backend-implementation.md](./backend-implementation.md) §1-2 절차를 그대로 따라간다.

- [ ] KCLOUD VM 발급, SSH 접속
- [ ] Docker 설치 → `docker-compose.yml`로 Postgres·Redis 실행 (로컬과 동일 파일)
- [ ] 레포 배포: `git pull` → venv/`pip install` → `.env`에 운영용 설정
- [ ] 프론트 빌드: `npm run build` → `collectstatic` 실행 (Django가 API/WS/정적 프론트를 전부 서빙)
- [ ] systemd 유닛(`codebee.service`) 등록 → Django Channels 상시 구동
- [ ] 방화벽에서 앱 포트 개방
- [ ] Cloudflare에서 캠프 도메인의 서브도메인 신청 → A 레코드를 VM 공인 IP로 연결
- [ ] 실제 배포 환경에서 최종 확인 — 서로 다른 기기 두 대로 접속해 한 판 플레이

## 참고

- 각 날짜의 체크박스는 [README.md 기능 명세서](../../README.md)의 필수 기능과 1:1로 대응한다. 선택 기능(재대결/페이즈 시스템/닉네임/실시간 하이라이트)은 이 4일 일정엔 포함하지 않았다 — 여유가 생기면 Day 3 버퍼 시간에 우선순위대로 끼워 넣는 걸 권장.
- Day 1이 항목 수로는 가장 많다 — 다만 대부분 "설계 그대로 옮기는" 성격(모델 필드, API 스펙, 화면 뼈대)이라 난이도보다는 양이 많은 쪽에 가깝다. Day 2가 실제로 가장 어려운 날이다(원자 연산, 동시성 로직, 그리고 그걸 눈으로 보여주는 애니메이션).
