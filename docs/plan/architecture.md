# 게임 아키텍처 설계

[동시제출-레이스컨디션-옵션](./동시제출-레이스컨디션-옵션.md)에서 이어지는 논의를 최종 설계로 정리한 문서. 레이스 컨디션 옵션 문서에서 검토했던 여러 대안 중 **최종적으로 "대안 2: Redis 원자 연산" 방식으로 확정**했고, 그 결정 배경과 전체 그림을 여기에 담는다.

이 문서는 **왜 이렇게 설계했는지(의사결정과 근거, 전체 그림)** 를 다룬다. Redis 키 구조, Lua 스크립트, DB 모델 코드, 배포 설정 파일처럼 **실제로 어떻게 구현하는지**는 [백엔드 구현 상세](./backend-implementation.md)로 분리했다.

## 1. 게임 개요

- 한 방에 유저 2명, 같은 화면을 실시간으로 공유
- 화면에 코드 텍스트가 무작위로 스폰되어 위에서 아래로 낙하, 바닥에 닿으면 자동 소멸
- 유저가 텍스트를 입력(typed) 후 Enter로 제출 → 화면의 어떤 텍스트(active code)와 완전히 일치하면 판정
- 판정 매트릭스: 맞는 코드 정확히 제출 → **+500** / 틀린 코드 정확히 제출 → **-500** / 나머지 → **0**
- 매칭된 코드는 화면에서 즉시 사라지고, 두 유저 모두에게 실시간 반영
- **한 판은 60초** — 두 유저가 방에 다 들어온 시점을 시작으로, 60초가 지나면 자동 종료 ([백엔드 구현 상세](./backend-implementation.md) §6)

## 2. 전체 구조

```
                     ┌────────────┐
                     │ PostgreSQL │  ← 방 정보, 코드 스니펫 풀, 최종 점수 등 영속 데이터
                     └─────┬──────┘
                           │ (읽기 전용 캐시 로드)
        ┌──────────────────┴──────────────────┐
        │                                       │
 ┌──────────────┐                       ┌──────────────┐
 │  프로세스 1    │◄──────Redis──────────►│  프로세스 2    │
 │ (Channels     │  채널레이어(pub/sub)    │ (Channels     │
 │  ASGI worker) │  + 원자 연산(SET NX,   │  ASGI worker) │
 │               │    Lua Script)         │               │
 └──────┬───────┘                       └──────┬───────┘
        │ WebSocket                             │ WebSocket
        ▼                                       ▼
     유저 A                                   유저 B
```

- 그림의 "프로세스 1", "프로세스 2"는 Channels ASGI 워커 프로세스를 뜻한다. 물리적으로 다른 머신일 필요는 없다 — §3의 실제 계획은 VM(KCLOUD) **한 대** 위에 이런 프로세스를 여러 개 띄우는 구조다

## 3. 배포 토폴로지

| 환경 | 구성 |
|---|---|
| 로컬 개발 | Django Channels 워커 프로세스 여러 개(native) + Redis·Postgres(Docker) |
| 배포 (2026-07-08 기준, 실측) | VM(KCLOUD, 몰입캠프 제공) 위에 Channels 워커 1개(daphne, native, systemd `codebee.service`) + Postgres·Redis(같은 VM, Docker), 앞단은 Cloudflare Tunnel(`cloudflared`, systemd)이 daphne(`127.0.0.1:8000`)로 직결 |

[사용자]
    ↓
[Cloudflare 엣지] ← DNS + TLS 종료 + WebSocket 통과
    ↓ (Cloudflare Tunnel — outbound-only, VM 인바운드 포트 불필요)
[KCLOUD VM (한 대)]
    ├── cloudflared (systemd, `tunnel run --token ...` → 127.0.0.1:8000로 직결)
    ├── Channels 워커 1개 (daphne, systemd `codebee.service`, 127.0.0.1:8000)
    ├── Postgres (Docker 컨테이너)
    └── Redis (Docker 컨테이너)

**nginx는 안 쓴다 (계획 변경, 실측 확인됨).** 원래 계획은 방화벽이 22/80/443만 열려 있다는 전제로 nginx를 리버스 프록시로 뒀지만, 실제 배포는 **Cloudflare Tunnel**을 썼다 — `cloudflared`가 VM에서 Cloudflare 엣지로 아웃바운드 연결만 맺고, 그 터널을 통해 들어온 요청을 로컬 포트로 그대로 전달한다. 아웃바운드 연결이라 VM 방화벽에 인바운드 포트를 전혀 열 필요가 없고(80/443조차), 그 결과 nginx가 있어야 할 이유(포트 우회)도 사라졌다. 터널의 forward 대상은 nginx(80)가 아니라 **daphne(8000) 직결**로 설정돼 있음을 실제 트래픽으로 확인함(`nginx access.log`에 요청이 안 찍힘). nginx 설정 파일(`/etc/nginx/sites-enabled/codebee`)은 VM에 남아있지만 현재 요청 경로에는 관여하지 않는다.

**Render 대신 KCLOUD VM으로 결정** ([docs/research/deployment-hosting.md](../research/deployment-hosting.md) 참고). 이유는 두 가지: (1) 가상 머신을 직접 다뤄보는 경험 자체가 목적, (2) KCLOUD(카이스트 제공)와 서브도메인이 캠프 측에서 이미 무료로 제공되어, Render를 검토했던 원래 이유(비용 $0)도 VM 방식에서 그대로 달성된다 — 그러면서 Render의 콜드스타트/Postgres 30일 만료/Redis 용량 제한 같은 트레이드오프도 없음.

**Django(Channels 워커)는 Docker에 넣지 않는다.** Postgres·Redis만 컨테이너화하고, Django는 VM에서 native 프로세스로 띄운다(systemd로 관리). 이유:

- Docker로 DB류를 묶은 건 "팀원 OS(macOS/Windows)가 달라 Postgres 설치 방법이 갈린다"는 로컬 개발 문제 때문 — Django는 이 문제와 무관
- 코드 수정 → 확인까지의 반복 개발 루프가 이미지 재빌드 없이 프로세스 재시작만으로 끝나 훨씬 빠름 (짧은 기간에 빠르게 반복하는 프로젝트에 유리)
- Channels 워커를 여러 개 띄우는 구조(§2, [백엔드 구현 상세](./backend-implementation.md) §4)는 systemd 유닛으로 충분히 관리 가능 — 굳이 Docker의 `--scale`이 필요한 규모가 아님

배포 설정(`docker-compose.yml`, systemd 유닛, Cloudflare 서브도메인 연결) 전문은 [백엔드 구현 상세](./backend-implementation.md) §1 참고.

## 4. 데이터베이스: PostgreSQL

Django ORM과 궁합이 가장 좋고, 여러 워커 프로세스가 동시에 접근하는 구조라 SQLite(파일 단위 락)는 배포 단계에 부적합. VM에 Docker로 같이 띄우는 것을 추천(RDS는 이 규모엔 과함).

저장 대상: 방(room), 코드 스니펫 풀(문제 세트), 최종 점수/게임 기록. **실시간으로 계속 바뀌는 상태는 DB가 아니라 Redis가 담당**한다 (§6).

모델 코드(`Profile`, `Room`, `GameResult`, `CodeSnippet`)와 필드별 설명은 [백엔드 구현 상세](./backend-implementation.md) §2, 전체 스키마 요약과 ERD는 [README.md의 DB 스키마 섹션](../README.md#db-스키마) 참고.

## 5. 화면 동기화 — Django Channels Groups + Redis 채널 레이어

두 유저가 다른 프로세스에 붙어 있어도 같은 화면을 보게 하는 문제는 Channels의 핵심 기능으로 해결된다.

- 방 입장 시 유저는 자신이 붙은 프로세스와 무관하게 같은 `room_group_name`에 `group_add`
- 어느 프로세스가 됐든 `group_send(room_group_name, {...})`를 호출하면 Redis 채널 레이어가 그 방에 연결된 **모든 프로세스**로 메시지를 릴레이하고, 각 프로세스는 자신에게 붙은 유저에게 전달
- 낙하 애니메이션은 프로세스가 보낸 절대 타임스탬프(`spawn_ts`)와 고정 낙하 시간을 기준으로 각 클라이언트가 독립적으로 계산 (`(now - spawn_ts) / fall_duration`) → **클라이언트가 접속 시 서버와의 클럭 오프셋을 보정했다는 전제 하에**, 남는 네트워크 지연 몇십 ms 차이는 시각적으로 무시 가능 (오프셋 보정 없이 로컬 시계를 그대로 쓰면 클라이언트 시계 어긋남이 더 큰 오차를 만들 수 있음 — [클럭 동기화 리서치](../research/clock-sync.md), [백엔드 구현 상세](./backend-implementation.md) §9 참고)

## 6. 정적 데이터 vs 동적 상태 분리

이 구분이 전체 설계의 핵심 축이다.

| 구분 | 내용 | 저장 위치 | 갱신 빈도 |
|---|---|---|---|
| 정적 | 코드 스니펫 풀(id, text, is_correct) | 각 프로세스 **로컬 메모리** (DB에서 cache-aside로 로드) | 방 시작 시 1회, 이후 불변 |
| 동적 | 지금 실제로 낙하 중인 코드, 선점 상태, 점수 | **Redis** (모든 프로세스가 공유) | 매 스폰/제출마다 변경 |

cache-aside 구현과 Redis 키 전체 목록은 [백엔드 구현 상세](./backend-implementation.md) §3 참고.

## 7. 왜 게임 워커 프로세스(대안 1) 대신 Redis 원자 연산(대안 2)인가

`동시제출-레이스컨디션-옵션.md`에서 검토했던 대안들 중 두 가지를 심층 비교한 결론:

| | 대안 1: 전용 게임워커 | 대안 2: Redis 원자 연산 (채택) |
|---|---|---|
| 레이스 컨디션 방지 | 코드 규율(await 없는 동기 블록)에 의존 — 깨지기 쉬움 | Redis 엔진이 원자성 보장 — 코드와 무관하게 항상 안전 |
| 지연시간 | 프로세스→Redis→게임워커→Redis→프로세스 (홉 4번) | 프로세스→Redis(직접)→프로세스 (홉 2번) |
| SPOF | 게임워커 프로세스 자체가 추가 SPOF | Redis는 이미 채널레이어로 필수 의존성 — 추가 SPOF 아님 |
| 구축 비용 | 새 프로세스 + 양방향 pub/sub 채널 설계 필요 | 기존 프로세스 코드에 Redis 호출만 추가 |

결정적으로, **스폰 로직도 결국 Redis 원자 연산(선점)이 필요해지면서** 대안 1의 유일한 장점("Lua 불필요")이 사라졌다. 스폰 리더 선출·스니펫 중복 방지·제출 선점판정이 전부 같은 원자 연산 패턴으로 통일되므로 대안 2가 일관되고 단순하다.

## 8. 근본 질문 — 유저가 같은 프로세스에 있으면 설계가 무너지는가?

아니다. Redis 원자 연산과 Channels group broadcast는 두 유저가 같은 프로세스든 다른 프로세스든 동일하게 동작한다. Redis 원자성은 Redis 자체의 싱글스레드 보장이지 프로세스 토폴로지와 무관하고, `group_send`도 그룹 멤버 위치와 무관하게 Redis pub/sub으로 전파된다. 로드밸런서가 유저를 어느 프로세스에 배치하든 애플리케이션 로직이 신경 쓸 필요가 없도록 설계된 것이 Channels+Redis 조합의 핵심 목적이다.

> 참고: 지금은 프로세스 여러 개가 VM 한 대 위에 떠 있지만(§3), 나중에 VM을 여러 대로 늘려도 위 논리는 그대로 적용된다 — Redis가 단일 진실 공급원인 이상 프로세스가 같은 머신에 있는지 다른 머신에 있는지는 무관하다.

## 9. 매칭 알고리즘 선택지 (참고)

- **해시/딕셔너리 조회(채택)**: `text_index` Hash로 O(1) 조회. 제출(Enter) 시점 판정에 충분
- 선형 탐색: n이 작으면(방당 수십 개) 동등한 성능, 별도 인덱스 불필요할 정도로 규모가 작을 때 대안
- 접두사 트라이: 타이핑 도중 실시간 하이라이트 UX가 필요해지면 추가 고려 (현재 범위 밖)
- 퍼지 매칭(Levenshtein 등): 점수 판정엔 미사용, "아깝게 틀렸어요" 같은 UX 피드백용으로만 고려 가능

## 10. 남은 결정/TODO

- [ ] 타이핑 중 실시간 하이라이트 UX 여부 (필요 시 접두사 트라이 도입, §9)

구현 세부 TODO(데이터 구조 변경 등)는 [백엔드 구현 상세](./backend-implementation.md) §10 참고.
