# 아이템 시스템 (alert, 꿀) 설계

## 1. 배경 및 목표

상대방을 방해하는 아이템 2종을 추가한다 — 스폰 시점에 서버가 부여 여부/종류를 결정하고, **정답 코드에만** 붙는다.

- **꿀(honey)**: 상대방 화면에 꿀 이미지를 덮어서 낙하 중인 코드가 잘 안 보이게 함
- **alert**: 상대방이 타이핑하는 도중에 경고창을 띄워서, 그걸 닫아야 다시 타이핑할 수 있게 함

두 효과 모두 **연출(지속시간, 애니메이션)은 프론트 책임**이고, 백엔드는 "어떤 코드에 어떤 아이템이 붙어있는지"와 "누가 그 코드를 맞혀서 발동시켰는지"만 원자적으로 결정해서 알려주면 된다. 아이템은 스폰된 낙하 코드에 배지로 보여서 **양쪽 플레이어 모두에게 미리 보인다** — 몰래 숨겨진 게 아니라 "이거 맞히면 상대 방해할 수 있다"를 알고 레이스하는 방식.

기존 게임 파이프라인(스폰/판정, `game/consumers.py`+`game/redis_scripts.py`)이 이 프로젝트에서 가장 위험한 코드라, 이 문서는 **기존 원자성 구조를 그대로 재사용**하고 필드만 하나 추가하는 방향으로 설계했다 — 새 Redis 키나 새 락은 필요 없다.

## 2. 데이터 모델 변경 — `codes:{room}` 패킹 포맷

현재(`consumers.py` PACK_SEP, `redis_scripts.py` 주석 참고):

```
"text\x01is_correct\x01spawn_ts\x01duration_ms"
```

변경 후:

```
"text\x01is_correct\x01spawn_ts\x01duration_ms\x01item"
```

`item`은 `""`(없음) 또는 `"alert"`/`"honey"`. 필드가 하나 늘어날 뿐 기존 4개 필드의 의미·순서는 그대로라, 이미 이 값을 읽는 다른 코드(없음 — `codes:{room}`는 SUBMIT_SCRIPT에서만 파싱함)에 영향 없음.

## 3. 백엔드 구현

### 3-1. 상수 (`consumers.py`) — `ITEM_ATTACH_PROB`는 `.env`로

QA 중 재배포 없이 조정할 수 있게 `.env`로 뺀다. 기존 `DEBUG`/`ALLOWED_HOSTS` 등과 동일하게 `config/settings.py`에서 읽어서 Django 설정으로 노출하고, `consumers.py`는 `django.conf.settings`를 통해 참조:

```python
# config/settings.py
ITEM_ATTACH_PROB = float(os.environ.get('ITEM_ATTACH_PROB', '0.2'))
```

```python
# consumers.py
from django.conf import settings

ITEM_TYPES = ("alert", "honey")
```

`backend/.env.example`에도 추가:

```
ITEM_ATTACH_PROB=0.2
```

### 3-2. 스폰 시점 결정 (`_try_spawn`)

```python
item = ""
if snippet["is_correct"] and random.random() < settings.ITEM_ATTACH_PROB:
    item = random.choice(ITEM_TYPES)

value = PACK_SEP.join([
    snippet["text"], "1" if snippet["is_correct"] else "0",
    str(spawn_ts), str(duration_ms), item,
])
```

`_try_spawn`은 이미 `spawn_lock:{room}:{tick}`(SET NX EX 5)으로 한 틱당 정확히 하나의 프로세스만 실행되도록 보장돼 있다(§4) — 아이템 추첨(`random.random()`)도 이 안에서 일어나므로 **새로운 동시성 보호 장치가 필요 없다**. 스폰 락이 이미 하는 일을 그대로 얹어 쓰는 것.

`code.spawn` 브로드캐스트에 필드 추가(배지 표시용):

```python
{
    "type": "code.spawn",
    "code_id": code_id,
    "text": snippet["text"],
    "spawn_ts": spawn_ts,
    "duration": duration_ms,
    "item": item or None,
}
```

### 3-3. `SUBMIT_SCRIPT` 수정 (`redis_scripts.py`) — ⚠️ 반환 튜플 arity 통일 필수

패킹 필드가 하나 늘었으니 구분자 탐색을 하나 더 해야 한다:

```lua
local p4 = string.find(packed, sep, p3 + 1, true)
local duration_ms = tonumber(string.sub(packed, p3 + 1, p4 - 1))  -- 기존엔 p3+1부터 끝까지였음, 이제 p4-1까지로 경계 지정
local item = string.sub(packed, p4 + 1)
```

**여기서 실수하기 쉬운 지점**: 지금 스크립트는 케이스에 따라 반환 튜플 길이가 다르다(`{0, "game_over"}`처럼 2개 vs 성공 시 `{1, code_id}`도 2개라 지금은 문제없음). `item`을 추가하면서 **성공 케이스만** `{1, code_id, item}`으로 3개로 늘리면, Python 쪽에서 `result, detail, item = await script(...)`로 언패킹할 때 실패 케이스(`{0, "game_over"}` 등, 여전히 2개)에서 "not enough values to unpack" 에러가 난다. **모든 반환 경로를 3-tuple로 통일**해야 한다:

```lua
if not started_at or (...) then
    return {0, "game_over", ""}
end
...
if not code_id then
    return {0, "no_match", ""}
end
...
    return {0, "expired", ""}
...
if not claimed then
    return {0, "too_late", ""}
end
...
if is_correct == "1" then
    redis.call("ZINCRBY", KEYS[3], ARGV[3], ARGV[2])
    return {1, code_id, item}
else
    redis.call("ZINCRBY", KEYS[3], ARGV[4], ARGV[2])
    return {-1, code_id, item}  -- item은 오답이라 항상 "" (정답에만 붙으므로)
end
```

이 변경은 매칭·선점·만료 판정 로직(4가지 케이스: 정답/오답/이미 선점됨/게임종료 후 제출) 자체는 전혀 안 건드리고 반환값에 필드 하나를 얹는 것뿐이라 위험도는 낮지만, 위 arity 문제는 실제로 서비스를 깨뜨리는 종류의 실수라 구현 시 반드시 모든 `return` 구문을 함께 고쳐야 한다.

### 3-4. `_handle_submit` (`consumers.py`)

```python
result, detail, item = await script(...)
...
await self.channel_layer.group_send(
    self.room_group_name,
    {
        "type": "code.result",
        "code_id": detail,
        "correct": result == 1,
        "user_id": self.user.id,
        "delta": correct_delta if result == 1 else SCORE_DELTA_INCORRECT,
        "item": item or None,
    },
)
```

### 3-5. group_send 수신 핸들러 relay

`code_spawn`/`code_result` 핸들러(클라이언트로 실제 전송하는 부분)에도 `"item"` 필드를 그대로 실어 보내야 한다 — 지금은 이 두 핸들러가 이벤트를 받아서 필요한 키만 골라 `_send_json`으로 다시 포장하는 구조라, item을 빠뜨리면 group_send엔 있어도 클라이언트엔 안 감:

```python
async def code_spawn(self, event):
    await self._send_json({
        "type": "code.spawn",
        "code_id": event["code_id"],
        "text": event["text"],
        "spawn_ts": event["spawn_ts"],
        "duration": event["duration"],
        "item": event.get("item"),
    })

async def code_result(self, event):
    await self._send_json({
        "type": "code.result",
        "code_id": event["code_id"],
        "correct": event["correct"],
        "user_id": event["user_id"],
        "delta": event["delta"],
        "item": event.get("item"),
    })
```

## 4. 안전성 검토

- **4가지 판정 케이스 무변화**: 정답/오답/이미 선점됨/게임종료 후 제출 — 어느 것도 새로 생기거나 없어지지 않음, item은 순수 부가 정보.
- **아이템 배정의 원자성**: 스폰 락(기존)이 이미 "이 틱은 정확히 한 프로세스만 처리"를 보장 → 아이템 추첨도 자동으로 exactly-once.
- **아이템 발동(제출 판정)의 원자성**: SUBMIT_SCRIPT 자체가 원자 연산이라, item을 읽어서 반환하는 것도 매칭+선점+채점과 한 번에 일어남 — "정답으로 판정됐는데 item 정보만 따로 경쟁 상태에 놓이는" 상황이 구조적으로 불가능.
- **신규 Redis 키/락 없음**: 기존 `codes:{room}` 값 포맷만 확장 — 키 생명주기(만료/삭제 시점)도 기존 그대로라 새로운 leak 경로 없음.
- **테스트 영향(파훼 주의)**: `game/tests.py`의 `SubmitScriptTests._seed_code`가 4필드로 패킹하는 헬퍼라 5필드로 바꿔야 하고, `self.script(...)` 호출부의 `result, detail = ...` 언패킹도 전부 `result, detail, item = ...`로 바꿔야 기존 테스트가 안 깨짐(§3-3의 arity 문제와 동일 원인).
- **배포 시점 알려진 한계(concurrency-reviewer 지적)**: 배포는 `systemctl restart codebee` 방식(무중단 롤링 배포 아님) — 재시작 시 모든 WS 연결이 끊기면서 `disconnect()`의 게임 중 이탈 처리가 진행 중이던 방의 `codes:{room}` 등을 정리하므로, 실제로는 재시작 순간에 옛 4필드 포맷 값이 남아있을 가능성이 낮다. 다만 만에 하나 남아있으면 새 스크립트의 `p4`가 `nil`이 돼 그 제출 건에서 Lua 런타임 에러가 난다 — 이번 배포에서 감수하는 리스크로 기록만 해둠(방어 코드 추가 안 함).

## 5. 프론트엔드 구현 방향

### 5-1. `code.spawn` — 배지 표시

`item` 필드가 `null`이 아니면 낙하하는 코드 박스에 작은 아이콘 배지(꿀 방울 / 느낌표 등)를 얹는다. 순수 표시용이라 상태는 `LobbyPage.tsx`의 `fallingCodes` 배열에 `item` 필드만 추가해서 저장하면 됨(`scores`/`fallingCodes` state 갱신 패턴은 이미 있음).

### 5-2. `code.result` — 발동 트리거

```ts
if (data.item && data.correct && userId !== myUserId) {
  // 상대방이 이 아이템 코드를 맞혔다 → 내 화면에 효과 발동
  triggerItemEffect(data.item as 'alert' | 'honey');
}
```

`userId === myUserId`(내가 맞힌 경우)면 아무 효과도 재생하지 않음 — 아이템은 상대방에게만 걸린다.

### 5-3. 꿀(honey) 효과

- 게임 화면(낙하 영역) 위에 반투명 꿀 이미지/SVG를 오버레이로 띄워서 코드 텍스트 식별을 방해
- 지속시간 `HONEY_EFFECT_MS = 3000`(3초) — `window.setTimeout`으로 제거. 이미 `scorePops` 배열에 id+타임아웃으로 추가/제거하는 패턴이 있으니 `activeHoneyEffects: { id, spawnedAt }[]` 같은 state를 동일한 방식으로 추가하면 기존 코드 스타일과 맞음
- **중첩 처리(결정됨)**: 연속으로 맞으면 기존 효과를 연장하지 않고 그냥 새 항목을 배열에 추가 — 여러 개가 동시에 화면에 겹쳐 보이다가 각자 자기 타임아웃에 맞춰 개별적으로 사라짐(가장 간단한 구현, 이미 있는 `scorePops` 패턴 그대로 재사용 가능). 오래 방해받고 싶으면 상대가 아이템 코드를 계속 맞혀야 하므로 자연스럽게 "누적 방해"가 됨

### 5-4. alert 효과 — 커스텀 모달(결정됨)

네이티브 `window.alert()` 대신 커스텀 모달로 구현한다 — 이미 프로젝트에 픽셀 폰트/캐릭터(BeeIcon 등) 테마가 있어서 시각적 일관성을 맞출 수 있고, 네이티브 alert이 JS 메인 스레드를 막아 WS 메시지 처리가 지연되는 부작용도 없다.

- 동작: 오버레이 표시 + 타이핑 입력창 비활성화(`disabled` 또는 blur) → `ALERT_EFFECT_MS = 3000`(3초) 후 자동으로 닫히거나 "확인" 버튼으로 닫으면 입력창 재활성화 + 포커스 복귀
- **중첩 처리(결정됨, honey와 동일 원칙)**: 연속으로 맞으면 모달을 여러 장 겹쳐 쌓는다(예: 살짝 어긋난 위치에 스택) — 전부 닫아야(또는 각자 타임아웃 지나야) 타이핑 재개. honey처럼 `activeAlerts: { id, spawnedAt }[]` 배열로 관리, 입력창은 "배열이 비어 있을 때만" 재활성화

## 6. 테스트 영향 체크리스트

- [ ] `SubmitScriptTests._seed_code`: 5필드 패킹으로 변경
- [ ] `SubmitScriptTests`의 모든 `self.script(...)` 호출/언패킹: `result, detail, item = ...`로 변경
- [ ] 신규 테스트: 정답 매칭 시 `item`이 스폰 시 지정한 값 그대로 반환되는지
- [ ] 신규 테스트: 오답 매칭 시 `item`이 항상 `""`인지
- [ ] 신규 테스트: `game_over`/`no_match`/`expired`/`too_late` 네 경로 모두 3-tuple로 정상 반환되는지(언패킹 에러 없이)
- [ ] (선택) `_try_spawn`의 아이템 추첨 로직을 `maybe_attach_item(is_correct)` 같은 순수 함수로 분리하면 `compute_correct_score`/`compute_fall_duration_ms`처럼 결정적으로 단위 테스트 가능(예: `random.random`을 몽키패치하거나 확률 인자를 주입)

## 7. 결정 사항

1. **alert는 커스텀 모달**(네이티브 `window.alert()` 안 씀) — §5-4
2. **아이템 중첩 처리는 겹쳐서 보여줌**(지속시간 연장 아님) — honey/alert 둘 다 동일 원칙, §5-3/§5-4
3. **`ITEM_ATTACH_PROB`는 `.env`로 분리**, 값 `0.2` — §3-1
4. **효과 지속시간은 honey/alert 둘 다 3초**(`HONEY_EFFECT_MS`/`ALERT_EFFECT_MS = 3000`) — §5-3/§5-4

## 8. 구현 순서 제안

1. `redis_scripts.py`: SUBMIT_SCRIPT 5필드 파싱 + 3-tuple 통일 (가장 위험한 부분 — 구현 직후 concurrency-reviewer 서브에이전트 검토 권장)
2. `game/tests.py`: 위 6절 체크리스트 반영, 기존 테스트 통과 확인
3. `consumers.py`: 상수 추가, `_try_spawn`/`_handle_submit`/`code_spawn`/`code_result` 핸들러 수정
4. 프론트: `code.spawn` 배지, `code.result` 트리거 분기, honey 오버레이, alert 커스텀 모달(§5-3/§5-4)
