from .redis_client import get_redis

# 제출 판정 — 매칭 + 선점 + 채점 + 제거를 하나의 원자 연산으로 처리한다
# (backend-implementation.md §5).
#
# KEYS[1]=text_index:{room}, KEYS[2]=codes:{room}, KEYS[3]=score:{room}, KEYS[4]=game_started_at:{room}
# ARGV[1]=제출 텍스트(정규화됨), ARGV[2]=user_id, ARGV[3]=+500, ARGV[4]=-500,
# ARGV[5]=now_ms, ARGV[6]=duration_ms(60000), ARGV[7]=room
#
# codes:{room}의 값은 "text|is_correct" 형태로 패킹되어 있다(§3-2, §4에서 이미 이렇게
# 기록함) — §5 문서의 Lua 예시는 `code_id .. ":correct"`라는 별도 필드를 가정하는데,
# 실제 스폰 로직(§4)이 채우는 구조와 맞지 않아 여기서는 실제 데이터 구조에 맞게 패킹된
# 값을 "|" 기준으로 분리해서 읽는다.
#
# claim 키는 room으로 스코프한다("claim:{room}:{code_id}") — code_id는 CodeSnippet의
# 전역 PK라서, room으로 스코프하지 않으면 서로 다른 방(또는 같은 방의 재대결)이 같은
# code_id를 거의 동시에 스폰했을 때 한쪽의 정상 제출이 다른 쪽이 남긴 claim 때문에
# too_late로 잘못 거부될 수 있다.
SUBMIT_SCRIPT = """
local started_at = redis.call("GET", KEYS[4])
if not started_at or (tonumber(ARGV[5]) - tonumber(started_at)) >= tonumber(ARGV[6]) then
    return {0, "game_over"}
end

local code_id = redis.call("HGET", KEYS[1], ARGV[1])
if not code_id then
    return {0, "no_match"}
end

local claimed = redis.call("SET", "claim:" .. ARGV[7] .. ":" .. code_id, ARGV[2], "NX", "EX", 30)
if not claimed then
    return {0, "too_late"}
end

local packed = redis.call("HGET", KEYS[2], code_id)
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[2], code_id)

local sep = string.find(packed, "|")
local is_correct = string.sub(packed, sep + 1)

if is_correct == "1" then
    redis.call("ZINCRBY", KEYS[3], ARGV[3], ARGV[2])
    return {1, code_id}
else
    redis.call("ZINCRBY", KEYS[3], ARGV[4], ARGV[2])
    return {-1, code_id}
end
"""

_submit_script = None


def get_submit_script():
    """모든 Consumer가 공유하는 등록된 스크립트 (지연 등록, 프로세스당 1개)."""
    global _submit_script
    if _submit_script is None:
        _submit_script = get_redis().register_script(SUBMIT_SCRIPT)
    return _submit_script
