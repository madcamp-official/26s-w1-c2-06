import json
import re

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from . import tier
from .models import CodeSnippet, Profile, Room
from .room_codes import generate_room_code

User = get_user_model()


@ensure_csrf_cookie
@require_GET
def csrf(request):
    """프론트가 로그인/회원가입 전에 한 번 호출해서 CSRF 쿠키를 받아간다."""
    return JsonResponse({"detail": "csrf cookie set"})


@require_POST
def signup(request):
    data = json.loads(request.body)
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return JsonResponse({"error": "username_password_required"}, status=400)

    # 비밀번호는 로그인 화면의 슬라이더(0000~9999)와 형식을 맞춰야 한다 — 자유
    # 텍스트를 허용하면 슬라이더로는 재현할 수 없는 비밀번호가 만들어져 로그인이
    # 원천적으로 불가능해진다.
    if not re.fullmatch(r"\d{4}", password):
        return JsonResponse({"error": "invalid_password_format"}, status=400)

    if User.objects.filter(username=username).exists():
        return JsonResponse({"error": "duplicate_username"}, status=400)

    user = User.objects.create_user(username=username, password=password)
    Profile.objects.create(user=user)

    # 회원가입 후 자동 로그인하지 않음 — 로그인 화면으로 이동해서 다시 로그인
    return JsonResponse({"id": user.id, "username": user.username}, status=201)


@require_POST
def login_view(request):
    data = json.loads(request.body)
    username = data.get("username", "")
    password = data.get("password", "")

    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse({"error": "invalid_credentials"}, status=401)

    login(request, user)
    return JsonResponse({"id": user.id, "username": user.username})


@require_POST
def logout_view(request):
    logout(request)
    return JsonResponse({"detail": "logged out"})


@require_GET
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)
    return JsonResponse({"id": request.user.id, "username": request.user.username})


@require_GET
def my_tier(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    profile = Profile.objects.get(user_id=request.user.id)
    return JsonResponse({
        "tier": profile.tier,
        "tier_score": profile.tier_score,
        "rating": tier.rating(profile.tier, profile.tier_score),
    })


def _room_payload(room):
    return {
        "code": room.code,
        "status": room.status,
        "player1": room.player1.username if room.player1 else None,
        "player2": room.player2.username if room.player2 else None,
    }


@require_POST
def create_room(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    room = Room.objects.create(code=generate_room_code(), player1=request.user)
    return JsonResponse({**_room_payload(room), "is_host": True}, status=201)


@require_POST
def join_room(request, code):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    try:
        room = Room.objects.get(code=code)
    except Room.DoesNotExist:
        return JsonResponse({"error": "room_not_found"}, status=404)

    # 이미 이 방의 플레이어면(새로고침 등) 그대로 현재 상태 반환 — idempotent
    if room.player1_id == request.user.id:
        return JsonResponse({**_room_payload(room), "is_host": True})
    if room.player2_id == request.user.id:
        return JsonResponse({**_room_payload(room), "is_host": False})

    if room.status != "waiting":
        return JsonResponse({"error": "room_not_joinable"}, status=400)
    if room.player2_id is not None:
        return JsonResponse({"error": "room_full"}, status=400)

    room.player2 = request.user
    room.save(update_fields=["player2"])
    return JsonResponse({**_room_payload(room), "is_host": False})


CAP_TOP = 5
CAP_WORST = 3


def _ranked_groups(sorted_profiles, cap):
    """rating이 같은 그룹을 통째로 묶어 공동순위를 매긴다.

    첫 그룹은 인원수가 cap을 넘어도 항상 전부 포함한다(예: 공동 1위가 5명이면
    5명 다 표기). 그다음 그룹부터는 더했을 때 cap을 넘으면 그 그룹은 통째로
    제외한다(부분적으로 잘라서 보여주지 않음) — 표준 공동순위(동점자는 같은
    rank, 다음 그룹은 인원수만큼 rank를 건너뜀) 방식.
    """
    result = []
    i, n = 0, len(sorted_profiles)
    while i < n:
        j = i
        while j < n and sorted_profiles[j].rating_value == sorted_profiles[i].rating_value:
            j += 1
        group = sorted_profiles[i:j]
        if result and len(result) + len(group) > cap:
            break
        rank = i + 1
        result.extend((rank, p) for p in group)
        i = j
    return result


def _rank_of(user_id, sorted_profiles):
    """sorted_profiles 안에서 user_id의 공동순위 rank를 찾는다(동점 그룹의 시작
    인덱스+1). 없으면 None."""
    for i, p in enumerate(sorted_profiles):
        if p.user_id == user_id:
            start = i
            while start > 0 and sorted_profiles[start - 1].rating_value == p.rating_value:
                start -= 1
            return start + 1
    return None


@require_GET
def leaderboard(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    # 랭킹은 티어 점수(rating) 기준 — 실제로 한 판 이상 플레이한 유저만 대상으로
    # 한다(total_score>0을 "플레이 이력 있음"의 프록시로 사용).
    played = list(Profile.objects.select_related("user").filter(total_score__gt=0))
    for p in played:
        p.rating_value = tier.rating(p.tier, p.tier_score)

    def _entry(rank, p):
        return {"rank": rank, "username": p.user.username, "tier": p.tier, "tier_score": p.tier_score}

    # 전체 랭킹(top)은 rating이 0(아이언 0)을 초과하는 유저만 대상 — 티어 하락으로
    # 바닥까지 떨어진 유저는 순위표에 올리지 않는다.
    top_sorted = sorted((p for p in played if p.rating_value > 0), key=lambda p: (-p.rating_value, p.id))
    top_groups = _ranked_groups(top_sorted, CAP_TOP)
    entries = [_entry(rank, p) for rank, p in top_groups]
    top_user_ids = {p.user_id for _, p in top_groups}

    me = None
    if request.user.id not in top_user_ids:
        rank = _rank_of(request.user.id, top_sorted)
        if rank is not None:
            profile = next(p for p in top_sorted if p.user_id == request.user.id)
            me = _entry(rank, profile)

    # 하위권(worst)은 전체 랭킹에 이미 나온 유저와 절대 겹치지 않게 제외하고 매긴다.
    worst_sorted = sorted(
        (p for p in played if p.user_id not in top_user_ids), key=lambda p: (p.rating_value, p.id)
    )
    worst_groups = _ranked_groups(worst_sorted, CAP_WORST)
    worst = [_entry(rank, p) for rank, p in worst_groups]

    return JsonResponse({"entries": entries, "me": me, "worst": worst})


@require_GET
def practice_snippets(request):
    """연습모드 전용 — 프론트가 로컬로 스폰/낙하/봇 입력/점수를 시뮬레이션할 수 있도록
    스니펫 목록만 내려준다. Room/Redis 게임 파이프라인은 전혀 쓰지 않는다."""
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    snippets = list(CodeSnippet.objects.values("id", "text", "is_correct"))
    return JsonResponse({"snippets": snippets})


@require_GET
def room_detail(request, code):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    try:
        room = Room.objects.get(code=code)
    except Room.DoesNotExist:
        return JsonResponse({"error": "room_not_found"}, status=404)

    is_host = room.player1_id == request.user.id
    return JsonResponse({**_room_payload(room), "is_host": is_host})
