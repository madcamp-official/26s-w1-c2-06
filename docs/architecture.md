# 게임 아키텍처 설계

[백엔드 플랜](./백엔드%20플랜.md), [동시제출-레이스컨디션-옵션](./동시제출-레이스컨디션-옵션.md)에서 이어지는 논의를 최종 설계로 정리한 문서. 레이스 컨디션 옵션 문서에서 검토했던 여러 대안 중 **최종적으로 "대안 2: Redis 원자 연산" 방식으로 확정**했고, 그 결정 배경과 전체 그림을 여기에 담는다.

## 1. 게임 개요

- 한 방에 유저 2명, 같은 화면을 실시간으로 공유
- 화면에 코드 텍스트가 무작위로 스폰되어 위에서 아래로 낙하, 바닥에 닿으면 자동 소멸
- 유저가 텍스트를 입력(typed) 후 Enter로 제출 → 화면의 어떤 텍스트(active code)와 완전히 일치하면 판정
- 판정 매트릭스: 맞는 코드 정확히 제출 → **+500** / 틀린 코드 정확히 제출 → **-500** / 나머지 → **0**
- 매칭된 코드는 화면에서 즉시 사라지고, 두 유저 모두에게 실시간 반영

## 2. 전체 구조

```
                     ┌────────────┐
                     │ PostgreSQL │  ← 방 정보, 코드 스니펫 풀, 최종 점수 등 영속 데이터
                     └─────┬──────┘
                           │ (읽기 전용 캐시 로드)
        ┌──────────────────┴──────────────────┐
        │                                       │
 ┌──────────────┐                       ┌──────────────┐
 │   서버 1      │◄──────Redis──────────►│   서버 2      │
 │ (Channels     │  채널레이어(pub/sub)    │ (Channels     │
 │  ASGI worker) │  + 원자 연산(SET NX,   │  ASGI worker) │
 │               │    Lua Script)         │               │
 └──────┬───────┘                       └──────┬───────┘
        │ WebSocket                             │ WebSocket
        ▼                                       ▼
     유저 A                                   유저 B
```

- 서버 1, 2는 로컬 개발 시 같은 머신에서 여러 워커 프로세스로, 배포 시엔 VM(AWS) 위에서 여러 프로세스로 띄운다 (Cloudflare가 앞단 프록시)
- 유저 A, B가 어느 서버에 붙는지는 로드밸런서가 결정하며, **애플리케이션 로직은 이를 신경 쓰지 않아도 되도록 설계**한다 (§8 참고)

## 3. 배포 토폴로지

| 환경 | 구성 |
|---|---|
| 로컬 개발 | Django Channels 워커 프로세스 여러 개 + Redis + Postgres, 전부 로컬 |
| 배포 | VM(AWS EC2) 위에 Channels 워커 여러 개 + Postgres(같은 VM, Docker) + Redis, 앞단은 Cloudflare(DNS/프록시, WebSocket 통과 가능) |

> `백엔드 플랜.md`에는 아직 "Railway 단일 배포"로 적혀 있음 — 실제 계획이 VM(AWS)+Cloudflare로 바뀌었으므로 별도로 업데이트 필요.

### 3-1. 로컬 개발 환경 — Docker Compose

팀원 OS가 macOS/Windows로 섞여 있어(Postgres 네이티브 설치 방식이 OS마다 달라짐), Postgres·Redis 둘 다 `docker-compose.yml`로 통일한다. 배포 환경(VM)과 동일한 이미지를 쓰므로 "로컬에선 되는데 배포하니 안 됨" 이슈도 줄어든다.

```yaml
# docker-compose.yml (프로젝트 루트)
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: codebee
      POSTGRES_USER: codebee
      POSTGRES_PASSWORD: codebee
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "6379:6379"

volumes:
  postgres_data:
```

```bash
docker compose up -d      # Postgres + Redis 실행
docker compose down       # 종료 (볼륨은 유지)
```

Django 쪽 연결 설정:

```python
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "codebee", "USER": "codebee", "PASSWORD": "codebee",
        "HOST": "localhost", "PORT": "5432",
    }
}
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [("localhost", 6379)]},
    }
}
```

## 4. 데이터베이스: PostgreSQL

Django ORM과 궁합이 가장 좋고, 여러 워커 프로세스가 동시에 접근하는 구조라 SQLite(파일 단위 락)는 배포 단계에 부적합. VM에 Docker로 같이 띄우는 것을 추천(RDS는 이 규모엔 과함).

저장 대상: 방(room), 코드 스니펫 풀(문제 세트), 최종 점수/게임 기록. **실시간으로 계속 바뀌는 상태는 DB가 아니라 Redis가 담당**한다 (§6).

## 5. 화면 동기화 — Django Channels Groups + Redis 채널 레이어

두 유저가 다른 서버에 붙어 있어도 같은 화면을 보게 하는 문제는 Channels의 핵심 기능으로 해결된다.

- 방 입장 시 유저는 자신이 붙은 서버와 무관하게 같은 `room_group_name`에 `group_add`
- 어느 서버가 됐든 `group_send(room_group_name, {...})`를 호출하면 Redis 채널 레이어가 그 방에 연결된 **모든 서버**로 메시지를 릴레이하고, 각 서버는 자신에게 붙은 유저에게 전달
- 낙하 애니메이션은 서버가 보낸 절대 타임스탬프(`spawn_ts`)와 고정 낙하 시간을 기준으로 각 클라이언트가 독립적으로 계산 (`(now - spawn_ts) / fall_duration`) → 네트워크 지연 몇십 ms 차이는 시각적으로 무시 가능

## 6. 정적 데이터 vs 동적 상태 분리

이 구분이 전체 설계의 핵심 축이다.

| 구분 | 내용 | 저장 위치 | 갱신 빈도 |
|---|---|---|---|
| 정적 | 코드 스니펫 풀(id, text, is_correct) | 각 서버 **로컬 메모리** (DB에서 cache-aside로 로드) | 방 시작 시 1회, 이후 불변 |
| 동적 | 지금 실제로 낙하 중인 코드, 선점 상태, 점수 | **Redis** (모든 서버가 공유) | 매 스폰/제출마다 변경 |

### 6-1. 정적 스니펫 풀 — cache-aside

```python
class GameConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        room_id = self.scope["url_route"]["kwargs"]["room_id"]
        if room_id not in local_snippet_cache:          # 프로세스 로컬 dict
            local_snippet_cache[room_id] = await get_snippets_from_db(room_id)
```

- 유저 A가 서버1에, 유저 B가 서버2에 붙으면 **각 서버가 독립적으로** DB를 조회해 자기 프로세스에 캐싱 — 읽기 전용 데이터라 조율 불필요, 레이스 컨디션 없음
- 방 종료(마지막 유저 disconnect) 시 `local_snippet_cache`에서 제거해 메모리 정리
- 로컬 캐시는 어디까지나 "스폰할 수 있는 후보 목록"일 뿐, **실제로 무엇이 스폰됐는지는 항상 Redis + group_send가 단일 진실 공급원**이다 (로컬 캐시를 클라이언트 렌더링에 직접 쓰지 않음)

### 6-2. 동적 상태 — Redis 키 구조

```
spawn_lock:{room}:{tick}     SET NX EX   — 이번 틱의 스폰 담당 서버 선출
used_snippet_ids:{room}      Set (SADD)  — 이번 라운드에 이미 스폰된 스니펫 id (중복 방지)
codes:{room}                 Hash        — code_id → "text|is_correct"
text_index:{room}            Hash        — text → code_id (매칭용 역인덱스)
claim:{code_id}               SET NX EX  — 제출 선점 클레임
score:{room}                 Sorted Set  — user_id → 누적 점수 (ZINCRBY)
```

## 7. 스폰 로직 — "스폰도 선점 문제"

낙하 코드는 게임 진행 중 계속 새로 생성되므로(정적 스케줄 아님), 여러 서버 중 정확히 하나만 스폰을 실행해야 한다. 제출 판정에 쓰는 것과 **동일한 원자적 선점 패턴**을 재사용한다.

```
매 스폰 틱(예: 500ms)마다 각 서버가 독립적으로:

1. SET spawn_lock:{room}:{tick} <server_id> NX EX 5
   → 실패하면 이번 틱은 아무것도 안 함

2. (성공한 서버만) 로컬 스니펫 풀에서 랜덤 후보 선택
   → SADD used_snippet_ids:{room} snippet_id
     반환값 1(신규)이면 확정, 0(중복)이면 다른 후보로 재시도

3. Redis에 기록
   HSET codes:{room} code_id "text|is_correct"
   HSET text_index:{room} text code_id

4. group_send(room_group, {type: "code.spawn", code_id, text, spawn_ts, ...})
   → Redis 채널레이어가 모든 서버(=양쪽 유저)에게 전파
```

패한 서버의 로컬 풀은 이번 틱에서 아무 역할이 없다 — 다음 틱에 이길 때 쓰인다.

## 8. 제출 판정 로직 — 매칭 + 선점 + 채점을 하나의 원자 연산으로

유저가 제출한 텍스트를 받은 서버가 아래 Lua 스크립트 하나로 매칭·선점·채점·제거를 전부 원자적으로 처리한다.

```lua
-- KEYS[1]=text_index:{room}, KEYS[2]=codes:{room}, KEYS[3]=score:{room}
-- ARGV[1]=제출 텍스트(정규화됨), ARGV[2]=user_id, ARGV[3]=+500, ARGV[4]=-500

local code_id = redis.call("HGET", KEYS[1], ARGV[1])
if not code_id then
    return {0, "no_match"}                 -- 화면에 없는 문자열 → 0점
end

local claimed = redis.call("SET", "claim:" .. code_id, ARGV[2], "NX", "EX", 30)
if not claimed then
    return {0, "too_late"}                 -- 이미 남이 먼저 가져감
end

local is_correct = redis.call("HGET", KEYS[2], code_id .. ":correct")
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[2], code_id .. ":correct")

if is_correct == "1" then
    redis.call("ZINCRBY", KEYS[3], ARGV[3], ARGV[2])
    return {1, code_id}                    -- 정답 코드 정확히 제출 → +500
else
    redis.call("ZINCRBY", KEYS[3], ARGV[4], ARGV[2])
    return {-1, code_id}                   -- 오답 코드 정확히 제출 → -500
end
```

- 텍스트 정규화: 앞뒤 공백/개행 `strip()`, 대소문자 구분 유지, 퍼지 매칭 없이 완전 일치만 허용("정확히 제출"이 조건이므로)
- 판정 결과를 받은 서버가 `group_send`로 양쪽 유저(다른 서버에 있어도) 화면에 점수/코드 제거 반영

## 9. 왜 게임 워커 프로세스(대안 1) 대신 Redis 원자 연산(대안 2)인가

`동시제출-레이스컨디션-옵션.md`에서 검토했던 대안들 중 두 가지를 심층 비교한 결론:

| | 대안 1: 전용 게임워커 | 대안 2: Redis 원자 연산 (채택) |
|---|---|---|
| 레이스 컨디션 방지 | 코드 규율(await 없는 동기 블록)에 의존 — 깨지기 쉬움 | Redis 엔진이 원자성 보장 — 코드와 무관하게 항상 안전 |
| 지연시간 | 서버→Redis→게임워커→Redis→서버 (홉 4번) | 서버→Redis(직접)→서버 (홉 2번) |
| SPOF | 게임워커 프로세스 자체가 추가 SPOF | Redis는 이미 채널레이어로 필수 의존성 — 추가 SPOF 아님 |
| 구축 비용 | 새 프로세스 + 양방향 pub/sub 채널 설계 필요 | 기존 서버 코드에 Redis 호출만 추가 |

결정적으로, **스폰 로직도 결국 Redis 원자 연산(선점)이 필요해지면서** 대안 1의 유일한 장점("Lua 불필요")이 사라졌다. 스폰 리더 선출·스니펫 중복 방지·제출 선점판정이 전부 같은 원자 연산 패턴으로 통일되므로 대안 2가 일관되고 단순하다.

## 10. 근본 질문 — 유저가 같은 서버에 있으면 설계가 무너지는가?

아니다. Redis 원자 연산과 Channels group broadcast는 두 유저가 같은 서버든 다른 서버든 동일하게 동작한다. Redis 원자성은 Redis 자체의 싱글스레드 보장이지 서버 토폴로지와 무관하고, `group_send`도 그룹 멤버 위치와 무관하게 Redis pub/sub으로 전파된다. 로드밸런서가 유저를 어느 서버에 배치하든 애플리케이션 로직이 신경 쓸 필요가 없도록 설계된 것이 Channels+Redis 조합의 핵심 목적이다.

## 11. 매칭 알고리즘 선택지 (참고)

- **해시/딕셔너리 조회(채택)**: `text_index` Hash로 O(1) 조회. 제출(Enter) 시점 판정에 충분
- 선형 탐색: n이 작으면(방당 수십 개) 동등한 성능, 별도 인덱스 불필요할 정도로 규모가 작을 때 대안
- 접두사 트라이: 타이핑 도중 실시간 하이라이트 UX가 필요해지면 추가 고려 (현재 범위 밖)
- 퍼지 매칭(Levenshtein 등): 점수 판정엔 미사용, "아깝게 틀렸어요" 같은 UX 피드백용으로만 고려 가능

## 12. 남은 결정/TODO

- [ ] `백엔드 플랜.md` 배포 섹션 업데이트 (Railway → VM(AWS)+Cloudflare)
- [ ] 방 종료 시 Redis 키(`codes`, `text_index`, `used_snippet_ids`, `claim:*`, `spawn_lock:*`) 정리 정책 (TTL vs 명시적 삭제)
- [ ] 동일 텍스트 중복 스폰 허용 여부 최종 확정 (허용 시 `text_index` 구조를 1:1 → 1:N으로 변경 필요)
- [ ] 타이핑 중 실시간 하이라이트 UX 여부 (필요 시 접두사 트라이 도입)
