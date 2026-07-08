TIERS = ["iron", "bronze", "silver", "gold", "platinum", "diamond", "challenger"]
TIER_INDEX = {tier: i for i, tier in enumerate(TIERS)}

K = 40


def quantized_gap(diff):
    magnitude = abs(diff)
    if magnitude <= 20:
        return 0
    step = (magnitude - 1) // 20
    return step * 20 if diff > 0 else -(step * 20)


def expected_score(rating_a, rating_b):
    gap = quantized_gap(rating_a - rating_b)
    return 1 / (1 + 10 ** (-gap / 400))


def tier_delta(rating_a, rating_b, result_a):
    e_a = expected_score(rating_a, rating_b)
    return round(K * (result_a - e_a))


def rating(tier, tier_score):
    return TIER_INDEX[tier] * 100 + tier_score


def apply_tier_result(obj, delta):
    idx = TIER_INDEX[obj.tier]
    score = obj.tier_score + delta

    # 승급: 초과분 이월. 챌린저는 이 루프에 안 걸려서(idx가 이미 최댓값) tier_score가
    # 상한 없이 계속 누적된다.
    while idx < TIER_INDEX["challenger"] and score >= 100:
        score -= 100
        idx += 1

    # 강등: 100 이월(borrow). 챌린저도 동일하게 강등 대상이다.
    while score < 0 and idx > TIER_INDEX["iron"]:
        score += 100
        idx -= 1

    if idx == TIER_INDEX["iron"] and score < 0:
        score = 0  # 아이언 하한 고정

    obj.tier, obj.tier_score = TIERS[idx], score
    return obj
