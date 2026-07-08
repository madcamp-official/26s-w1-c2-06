from .redis_client import get_redis

# 제출 판정 — 매칭 + 선점 + 채점 + 제거를 하나의 원자 연산으로 처리한다
# (backend-implementation.md §5).
#
# KEYS[1]=text_index:{room}, KEYS[2]=codes:{room}, KEYS[3]=score:{room}, KEYS[4]=game_started_at:{room}
# ARGV[1]=제출 텍스트(정규화됨), ARGV[2]=user_id,
# ARGV[3]=정답 점수(스니펫 길이 비례, compute_correct_score로 호출 측에서 계산해 넘김), ARGV[4]=-500,
# ARGV[5]=now_ms, ARGV[6]=duration_ms(60000), ARGV[7]=room,
# ARGV[8]=MIN_REACTION_MS(공정 플레이 방어 Layer 1 — settings.MIN_REACTION_MS)
#
# codes:{room}의 값은 "text\\x01is_correct\\x01spawn_ts\\x01duration_ms\\x01item" 형태로
# 패킹된다(consumers.py의 PACK_SEP 참고) — "|" 대신 \\x01(제어문자)을 구분자로 쓰는 이유는
# 코드 텍스트 자체에 "|"가 나올 수 있어서다(예: `Optional[int] | None`, 셸 파이프 등).
# item은 방해 아이템(alert/honey) 종류 또는 빈 문자열(없음) — 정답 스니펫에만 붙는다
# (docs/plan/game-items.md).
#
# spawn_ts/duration_ms을 함께 저장해두는 이유: 프론트에서 이미 화면 밖으로 떨어져
# 사라진(= duration_ms가 지난) 코드를 서버가 매칭해버리면 "화면에 없는 코드에 점수가
# 오르는" 버그가 된다 — 매칭 직전에 이 판정을 여기서 원자적으로 함께 해야 한다.
#
# claim 키는 room으로 스코프한다("claim:{room}:{code_id}") — code_id는 CodeSnippet의
# 전역 PK라서, room으로 스코프하지 않으면 서로 다른 방(또는 같은 방의 재대결)이 같은
# code_id를 거의 동시에 스폰했을 때 한쪽의 정상 제출이 다른 쪽이 남긴 claim 때문에
# too_late로 잘못 거부될 수 있다.
# 반환 튜플은 항상 {result, detail, item, spawn_ts} 4개로 통일한다 — 성공 케이스에서만 필드를
# 더 얹으면 실패 케이스와 arity가 달라져서 호출 측 언패킹이 깨진다. spawn_ts는 공정 플레이
# 로깅(Layer 3)이 반응시간(now_ms - spawn_ts)을 계산하는 데 쓴다 — 아직 code_id를 못 찾은
# 케이스(game_over/no_match)는 스폰 정보 자체가 없으므로 0으로 채운다.
SUBMIT_SCRIPT = r"""
local started_at = redis.call("GET", KEYS[4])
if not started_at or (tonumber(ARGV[5]) - tonumber(started_at)) >= tonumber(ARGV[6]) then
    return {0, "game_over", "", 0}
end

local code_id = redis.call("HGET", KEYS[1], ARGV[1])
if not code_id then
    return {0, "no_match", "", 0}
end

local packed = redis.call("HGET", KEYS[2], code_id)
local sep = "\1"
local p1 = string.find(packed, sep, 1, true)
local p2 = string.find(packed, sep, p1 + 1, true)
local p3 = string.find(packed, sep, p2 + 1, true)
local p4 = string.find(packed, sep, p3 + 1, true)
local is_correct = string.sub(packed, p1 + 1, p2 - 1)
local spawn_ts = tonumber(string.sub(packed, p2 + 1, p3 - 1))
local duration_ms = tonumber(string.sub(packed, p3 + 1, p4 - 1))
local item = string.sub(packed, p4 + 1)

if (tonumber(ARGV[5]) - spawn_ts) < tonumber(ARGV[8]) then
    -- 사람의 반응시간으로 불가능할 만큼 빠른 제출 — 정답/오답 여부와 무관하게 무효
    -- (공정 플레이 방어 Layer 1, docs/plan 참고)
    return {0, "too_fast", "", spawn_ts}
end

if (tonumber(ARGV[5]) - spawn_ts) >= duration_ms then
    -- 이미 화면 바닥까지 떨어져 사라진 코드 — 매칭하지 않고 정리만 한다
    redis.call("HDEL", KEYS[1], ARGV[1])
    redis.call("HDEL", KEYS[2], code_id)
    return {0, "expired", "", spawn_ts}
end

local claimed = redis.call("SET", "claim:" .. ARGV[7] .. ":" .. code_id, ARGV[2], "NX", "EX", 30)
if not claimed then
    return {0, "too_late", "", spawn_ts}
end

redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[2], code_id)

if is_correct == "1" then
    redis.call("ZINCRBY", KEYS[3], ARGV[3], ARGV[2])
    return {1, code_id, item, spawn_ts}
else
    redis.call("ZINCRBY", KEYS[3], ARGV[4], ARGV[2])
    return {-1, code_id, item, spawn_ts}
end
"""

_submit_script = None


def get_submit_script():
    """모든 Consumer가 공유하는 등록된 스크립트 (지연 등록, 프로세스당 1개)."""
    global _submit_script
    if _submit_script is None:
        _submit_script = get_redis().register_script(SUBMIT_SCRIPT)
    return _submit_script
