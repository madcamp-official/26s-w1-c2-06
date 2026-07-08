from .redis_client import get_redis

# 랭크 매칭 큐 — 대기열 조회 + 후보 선택 + 제거를 하나의 원자 연산으로 처리한다.
#
# KEYS[1]=mm:queue(ZSET, member=user_id, score=글로벌 티어 레이팅 R)
# KEYS[2]=mm:queued_at(Hash, user_id -> 대기열 진입 시각 epoch ms)
# ARGV[1]=본인 user_id, ARGV[2]=now_ms,
# ARGV[3]=base_range, ARGV[4]=expand_step, ARGV[5]=expand_interval_ms, ARGV[6]=max_range
#
# 반환: {1, 상대_user_id} 매칭 성사 / {0, "not_queued"} 이미 다른 쪽이 매칭해감(또는
# 큐 이탈) / {0, "no_match"} 아직 범위 안에 후보 없음.
#
# ZSCORE로 "내가 아직 큐에 있는지"를 스크립트 맨 앞에서 확인하는 게 핵심이다 — 이미
# 다른 프로세스의 스크립트 호출이 나를 매칭시켜 큐에서 제거했다면 여기서 즉시 빠져야
# 후보 탐색까지 진행해서 엉뚱한 제3자와 이중 매칭되는 사고를 막을 수 있다. 존재 확인
# +탐색+제거가 전부 이 Lua 스크립트 하나의 원자 실행 안에서 끝나므로, 두 유저가 동시에
# 서로를 찾는 경쟁 상황에서도 어느 쪽이 먼저 실행되든 정확히 한 번만 성사된다.
#
# range는 반드시 "본인과 후보 양쪽의 대기시간 중 더 긴 쪽" 기준으로 판정해야 한다 —
# 자기 자신의 range만 보면, A가 오래 기다려 범위가 넓어진 상태에서 B가 막 큐에
# 들어와 자기 range(초기값)로 A를 찾으려 할 때 A와의 점수 차가 B의 좁은 range를
# 넘으면 매칭에 실패한다(버그: 두 사람 다 매칭 중인데 안 잡힘). 그래서 앞으로도
# 계속 실패하다가, 두 사람의 range가 각자 우연히 동시에 넓어질 때까지 기다려야
# 했다 — 격차가 크면 체감상 "매칭이 아예 안 되는" 것처럼 보였다.
MATCH_SCRIPT = r"""
local now_ms = tonumber(ARGV[2])
local base_range = tonumber(ARGV[3])
local expand_step = tonumber(ARGV[4])
local expand_interval_ms = tonumber(ARGV[5])
local max_range = tonumber(ARGV[6])

local function range_for(user_id)
    local queued_at = tonumber(redis.call("HGET", KEYS[2], user_id) or now_ms)
    local wait_ms = now_ms - queued_at
    local range = base_range + math.floor(wait_ms / expand_interval_ms) * expand_step
    return math.min(range, max_range)
end

local self_score = redis.call("ZSCORE", KEYS[1], ARGV[1])
if not self_score then
    return {0, "not_queued"}
end
self_score = tonumber(self_score)
local self_range = range_for(ARGV[1])

-- 후보 자체는 max_range 기준으로 넉넉히 가져온 뒤(둘 중 누구의 range가 더 넓을지
-- 미리 알 수 없으므로), 각 후보마다 자기 range와 후보 자신의 range 중 더 관대한
-- 쪽을 기준으로 판정한다.
local lo, hi = self_score - max_range, self_score + max_range
local candidates = redis.call("ZRANGEBYSCORE", KEYS[1], lo, hi, "WITHSCORES")

local best_id, best_diff = nil, nil
for i = 1, #candidates, 2 do
    local member, score = candidates[i], tonumber(candidates[i + 1])
    if member ~= ARGV[1] then
        local diff = math.abs(score - self_score)
        local allowed = math.max(self_range, range_for(member))
        if diff <= allowed and (best_id == nil or diff < best_diff) then
            best_id, best_diff = member, diff
        end
    end
end

if best_id == nil then
    return {0, "no_match"}
end

redis.call("ZREM", KEYS[1], ARGV[1], best_id)
redis.call("HDEL", KEYS[2], ARGV[1], best_id)
return {1, best_id}
"""

_match_script = None


def get_match_script():
    """모든 MatchmakingConsumer가 공유하는 등록된 스크립트 (지연 등록, 프로세스당 1개)."""
    global _match_script
    if _match_script is None:
        _match_script = get_redis().register_script(MATCH_SCRIPT)
    return _match_script
