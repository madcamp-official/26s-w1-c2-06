# 백엔드 구현 상세

[architecture.md](./architecture.md)에서 정한 설계(왜 이렇게 했는지, 전체 그림)를 실제로 어떻게 구현하는지 정리한 문서. Redis 키 구조, Lua 스크립트, DB 모델 코드, 배포 설정 파일처럼 구현하면서 계속 참조/갱신하게 될 내용이 여기 있다.

## 1. 로컬/배포 환경 구성

배포 여부와 상관없이 **Postgres·Redis만 Docker, Django(Channels 워커)는 native 프로세스**로 띄운다. 이유는 [architecture.md](./architecture.md) §3 참고.

### 1-1. 로컬 개발 — Docker Compose

팀원 OS가 macOS/Windows로 섞여 있어(Postgres 네이티브 설치 방식이 OS마다 달라짐), Postgres·Redis 둘 다 `docker-compose.yml`로 통일한다 (Django는 포함하지 않음). 배포 환경(VM)과 동일한 이미지를 쓰므로 "로컬에선 되는데 배포하니 안 됨" 이슈도 줄어든다.

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

### 1-2. 배포 — Render (무료 티어)

Render는 매니지드 PaaS라 systemd/Docker를 직접 설정할 필요가 없다. Render 대시보드에서 아래 세 가지를 만들고 서로 연결한다.

| 리소스 | 설정 |
|---|---|
| Web Service | Runtime: Python 3 / Build: `pip install -r requirements.txt` / Start: `daphne -b 0.0.0.0 -p $PORT config.asgi:application` |
| PostgreSQL | 무료 티어 인스턴스 생성 → Render가 자동으로 `DATABASE_URL` 환경변수를 Web Service에 주입 |
| Key Value (Redis) | 무료 티어 인스턴스 생성 → 내부 연결 문자열을 Web Service 환경변수(`REDIS_URL` 등, 정확한 이름은 Render 대시보드에서 확인)로 등록 |

```python
# settings.py — 환경변수 기반으로 변경
import dj_database_url

DATABASES = {"default": dj_database_url.config(default=os.environ["DATABASE_URL"])}
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [os.environ["REDIS_URL"]]},
    }
}
```

**커스텀 도메인**: Render 대시보드에서 캠프 측이 제공한 도메인을 Custom Domain으로 등록 → Cloudflare에서 해당 도메인의 CNAME을 Render가 안내하는 `*.onrender.com` 호스트로 설정 (WebSocket은 Cloudflare 프록시를 통과하므로 별도 설정 불필요).

**콜드스타트 대응**: 무료 Web Service는 15분 미사용 시 슬립된다. 발표 직전 미리 한 번 URL에 접속해 깨워둔다.

## 2. DB 모델 정의

```python
class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    total_score = models.IntegerField(default=0)   # 전체 게임을 통틀은 누적 점수

class Room(models.Model):
    STATUS_CHOICES = [("waiting", "waiting"), ("playing", "playing"), ("finished", "finished")]

    code = models.CharField(max_length=16, unique=True)          # 초대/입장 코드
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default="waiting")
    player1 = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    player2 = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)                 # Redis game_started_at을 영속화한 값
    ended_at = models.DateTimeField(null=True)

class GameResult(models.Model):
    room = models.OneToOneField(Room, on_delete=models.CASCADE)   # 방(매치)당 결과 1행
    user1 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    user2 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    score1 = models.IntegerField()                  # user1의 이번 한 판 점수
    score2 = models.IntegerField()                  # user2의 이번 한 판 점수
    winner = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")  # null = 무승부
    ended_at = models.DateTimeField(auto_now_add=True)

class CodeSnippet(models.Model):
    text = models.CharField(max_length=255, unique=True)
    is_correct = models.BooleanField()
    created_at = models.DateTimeField(auto_now_add=True)
```

`Room`은 어떤 유저가 이 방에 들어올 자격이 있는지를 DB로 검증하는 용도(재접속 시 인가)로 쓰고, 실제 낙하/점수 진행 상태는 여전히 Redis가 담당한다([architecture.md](./architecture.md) §6 참고). `CodeSnippet`은 특정 방에 종속되지 않는 전역 풀이다 — 어떤 스니펫이 어느 방에서 스폰됐는지는 Redis(`used_snippet_ids:{room}`)에서만 관리하고 DB엔 남기지 않는다.

`GameResult`는 방(매치)당 1행 — 두 유저와 각자의 점수, 승자를 한 행에 같이 기록한다(`room`이 `OneToOneField`라 방당 정확히 1행만 존재). `Profile.total_score`는 이걸 넘어 유저가 지금까지 치른 모든 판을 합산한 값이다. 게임 종료 시 이 둘을 어떻게 채우는지는 §6 참고. 전체 스키마 요약과 ERD는 [README.md의 DB 스키마 섹션](../README.md#db-스키마) 참고.

한 유저의 전체 전적을 조회할 땐 `GameResult.objects.filter(Q(user1=user) | Q(user2=user))`처럼 두 필드를 다 확인해야 한다 — 유저별 1행 구조보다 조회가 한 단계 더 필요하지만, "이 매치의 결과"가 한 행에 온전히 담기는 걸 우선한 설계다.

## 3. 정적 캐시 및 Redis 키 구조

정적 데이터 vs 동적 상태를 나누는 이유는 [architecture.md](./architecture.md) §6 참고.

### 3-1. 정적 스니펫 풀 — cache-aside

```python
class GameConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        room_id = self.scope["url_route"]["kwargs"]["room_id"]
        if room_id not in local_snippet_cache:          # 프로세스 로컬 dict
            local_snippet_cache[room_id] = await get_snippets_from_db(room_id)
```

- 유저 A가 프로세스1에, 유저 B가 프로세스2에 붙으면 **각 프로세스가 독립적으로** DB를 조회해 자기 로컬에 캐싱 — 읽기 전용 데이터라 조율 불필요, 레이스 컨디션 없음
- 방 종료(마지막 유저 disconnect) 시 `local_snippet_cache`에서 제거해 메모리 정리
- 로컬 캐시는 어디까지나 "스폰할 수 있는 후보 목록"일 뿐, **실제로 무엇이 스폰됐는지는 항상 Redis + group_send가 단일 진실 공급원**이다 (로컬 캐시를 클라이언트 렌더링에 직접 쓰지 않음)

### 3-2. 동적 상태 — Redis 키 구조

```
spawn_lock:{room}:{tick}     SET NX EX   — 이번 틱의 스폰 담당 프로세스 선출
used_snippet_ids:{room}      Set (SADD)  — 이번 라운드에 이미 스폰된 스니펫 id (중복 방지)
codes:{room}                 Hash        — code_id → "text|is_correct"
text_index:{room}            Hash        — text → code_id (매칭용 역인덱스)
claim:{code_id}               SET NX EX  — 제출 선점 클레임
score:{room}                 Sorted Set  — user_id → 이번 판 누적 점수 (ZINCRBY, §5)
game_started_at:{room}       SET NX      — 게임 시작 절대 타임스탬프 (전 프로세스 공통 기준시각, §6)
game_end_lock:{room}         SET NX EX   — 게임 종료 처리 담당 프로세스 선출 (§6)
```

## 4. 스폰 로직 — "스폰도 선점 문제"

낙하 코드는 게임 진행 중 계속 새로 생성되므로(정적 스케줄 아님), 여러 프로세스 중 정확히 하나만 스폰을 실행해야 한다. 제출 판정에 쓰는 것과 **동일한 원자적 선점 패턴**을 재사용한다.

```
매 스폰 틱(예: 500ms)마다 각 프로세스가 독립적으로:

1. SET spawn_lock:{room}:{tick} <process_id> NX EX 5
   → 실패하면 이번 틱은 아무것도 안 함

2. (성공한 프로세스만) 로컬 스니펫 풀에서 랜덤 후보 선택
   → SADD used_snippet_ids:{room} snippet_id
     반환값 1(신규)이면 확정, 0(중복)이면 다른 후보로 재시도

3. Redis에 기록
   HSET codes:{room} code_id "text|is_correct"
   HSET text_index:{room} text code_id

4. group_send(room_group, {type: "code.spawn", code_id, text, spawn_ts, ...})
   → Redis 채널레이어가 모든 프로세스(=양쪽 유저)에게 전파
```

패한 프로세스의 로컬 풀은 이번 틱에서 아무 역할이 없다 — 다음 틱에 이길 때 쓰인다.

## 5. 제출 판정 로직 — 매칭 + 선점 + 채점을 하나의 원자 연산으로

유저가 제출한 텍스트를 받은 프로세스가 아래 Lua 스크립트 하나로 매칭·선점·채점·제거를 전부 원자적으로 처리한다.

```lua
-- KEYS[1]=text_index:{room}, KEYS[2]=codes:{room}, KEYS[3]=score:{room}, KEYS[4]=game_started_at:{room}
-- ARGV[1]=제출 텍스트(정규화됨), ARGV[2]=user_id, ARGV[3]=+500, ARGV[4]=-500, ARGV[5]=now_ms, ARGV[6]=duration_ms(60000)

local started_at = redis.call("GET", KEYS[4])
if not started_at or (tonumber(ARGV[5]) - tonumber(started_at)) >= tonumber(ARGV[6]) then
    return {0, "game_over"}                -- 60초 경과 후 도착한 제출 → 채점하지 않음
end

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
- 판정 결과를 받은 프로세스가 `group_send`로 양쪽 유저(다른 프로세스에 있어도) 화면에 점수/코드 제거 반영
- 스크립트 맨 앞의 시간 체크는 §6의 종료 처리와 마지막 제출이 겹치는 걸 막기 위한 것 — 종료 처리가 아직 안 끝났어도(락만 딴 상태) 60초가 지났으면 그 즉시 모든 제출을 거부하므로, "종료 직전에 도착한 제출이 최종 점수에 반영되는지 여부"가 프로세스마다 갈리지 않는다

## 6. 게임 종료 및 최종 점수 반영

한 판은 **60초**다. §4의 스폰 틱 루프에 종료 조건 체크를 끼워 넣어, 스폰과 동일한 원자적 선점 패턴으로 "정확히 한 프로세스만" 종료 처리를 수행하게 한다.

**게임 시작 — 단일 기준시각 기록**

방에 두 유저가 다 들어온 시점에, 먼저 도착한 프로세스가:

```
SET game_started_at:{room} <now_ms> NX
→ 성공한 프로세스가 group_send(room_group, {type: "game.start", started_at, duration: 60000})
```

`spawn_ts`([architecture.md](./architecture.md) §5)와 같은 이유로, 모든 프로세스·클라이언트가 "60초가 지났는지"를 같은 기준시각으로 판단하게 하기 위함이다.

**매 틱 종료 조건 체크 (스폰 루프 확장)**

```
매 틱마다 각 프로세스가 독립적으로:

0. now_ms - game_started_at:{room} >= 60000 ?
   → 아니면: 기존 §4 스폰 로직 그대로 진행
   → 맞으면: 스폰은 스킵하고 아래 종료 처리로 분기

종료 처리:
1. SET game_end_lock:{room} <process_id> NX EX 30
   → 실패하면 이번 프로세스는 아무것도 안 함 (이미 남이 처리 중이거나 끝남)

2. (성공한 프로세스만)
   a. ZRANGE score:{room} 0 -1 WITHSCORES        ← Redis에서 이번 판 최종 점수 읽기 (u1, u2 = 이 방의 두 유저)
   b. 점수 비교로 승자 계산:
      scores[u1] == scores[u2]  → winner_id = None (무승부)
      scores[u1] >  scores[u2]  → winner_id = u1
      scores[u1] <  scores[u2]  → winner_id = u2
   c. Postgres에 기록 (database_sync_to_async로 감싼 동기 ORM 호출):

      with transaction.atomic():
          obj, created = GameResult.objects.get_or_create(
              room_id=room_id,
              defaults={
                  "user1_id": u1, "user2_id": u2,
                  "score1": scores[u1], "score2": scores[u2],
                  "winner_id": winner_id,
              },
          )
          if created:
              Profile.objects.filter(user_id=u1).update(total_score=F("total_score") + scores[u1])
              Profile.objects.filter(user_id=u2).update(total_score=F("total_score") + scores[u2])

   d. group_send(room_group, {type: "game.over", scores: {...}, winner_id: winner_id})
      → 두 유저 화면에 "게임 종료 + 최종 점수 + 승자" 반영 (다른 프로세스에 있어도 architecture.md §5와 동일하게 전파)

   e. Redis 방 전용 키 정리:
      codes:{room}, text_index:{room}, used_snippet_ids:{room},
      score:{room}, game_started_at:{room} 삭제
      (spawn_lock:*, claim:*, game_end_lock:{room}은 이미 EX가 걸려 있어 자연 만료에 맡김)
```

**안전성**

- **정확히 한 번만 실행됨:** `game_end_lock`이 §4 `spawn_lock`과 동일한 `SET NX` 패턴이라, 두 프로세스가 같은 틱에 종료를 감지해도 Redis가 하나만 통과시킨다
- **막판 제출과의 레이스 없음:** §5 Lua 스크립트가 매 제출마다 자체적으로 60초 경과 여부를 체크하므로, 종료 처리가 시작된 후 도착한 제출은 `ZINCRBY` 자체가 실행되지 않는다 — 즉 2a에서 읽는 점수는 더 이상 바뀌지 않는 확정값이다
- **크래시 내구성:** 락을 딴 프로세스가 2c(DB 기록) 전에 죽으면 `EX 30` 후 다른 프로세스가 재시도하지만, `GameResult.room`이 `OneToOneField`(방당 1행)라 재시도해도 같은 행을 다시 찾아올 뿐이고, `get_or_create`의 `created` 체크 덕분에 `total_score`가 중복 반영되지 않는다 (idempotent)

## 7. 방 생명주기 — 입장/이탈/방장 위임

방 정원은 **정확히 2명**으로 고정한다 (`Room.player1`/`player2`, README 예상 사용자와 일치). `player1`이 방장이다.

**대기 중(`status=waiting`) 이탈**

- 비방장(`player2`)이 나가면: `player2 = null`로 비우고 방은 계속 `waiting` — 새 유저가 들어올 수 있음
- 방장(`player1`)이 나가고 `player2`가 있으면: `player1`, `player2` 값을 맞바꿔 방장을 위임 (남은 유저가 새 `player1`이 됨)
- 방장이 나가고 아무도 없으면: `status = finished`로 소프트 종료. **Room row는 삭제하지 않는다** — `GameResult`가 이 Room을 참조할 수 있으므로 하드 삭제 시 연결된 기록이 함께 사라짐

**게임 중(`status=playing`) 이탈**

한쪽이 WebSocket 연결을 끊으면(Channels `disconnect()`), 60초 타이머를 기다리지 않고 즉시 §6과 같은 종료 처리를 트리거한다:

```
disconnect() 호출 시:
1. SET game_end_lock:{room} <process_id> NX EX 30   ← §6과 동일한 락
   → 실패하면 이미 다른 프로세스가 처리 중/완료 → 아무것도 안 함
2. (성공한 프로세스만) §6의 2a, 2c~2e를 그대로 수행하되, 2b(점수 비교)는 건너뛰고
   winner_id를 강제로 남은 유저로 지정 (이탈한 유저는 score와 무관하게 승자가 될 수 없음)
```

같은 `game_end_lock`을 재사용하므로, 60초 타이머 종료와 이탈 종료가 동시에 발생해도(예: 59.9초에 나감) 둘 중 하나만 실행된다.

## 8. 구현 TODO

- [x] 동일 텍스트 중복 스폰 — 금지로 확정. `CodeSnippet.text`에 `unique=True` 제약을 걸어 애초에 중복 text가 DB에 존재할 수 없게 함 (`text_index` 1:1 Hash 구조는 그대로 유지)
- [x] 방 정원/방장 위임/이탈 처리 — §7 참고
- [x] 승/패 판정 필드 — `GameResult.winner`(FK → User, null=무승부) 추가, 정상 종료는 점수 비교, 이탈 종료는 남은 유저로 강제 지정 — §6, §7 참고
