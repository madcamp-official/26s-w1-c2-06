import json

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

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


def _room_payload(room):
    return {
        "code": room.code,
        "status": room.status,
        "difficulty": room.difficulty,
        "player1": room.player1.username if room.player1 else None,
        "player2": room.player2.username if room.player2 else None,
    }


@require_POST
def create_room(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    data = json.loads(request.body or b"{}")
    difficulty = data.get("difficulty", "medium")
    if difficulty not in dict(Room.DIFFICULTY_CHOICES):
        return JsonResponse({"error": "invalid_difficulty"}, status=400)

    room = Room.objects.create(code=generate_room_code(), player1=request.user, difficulty=difficulty)
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


@require_GET
def leaderboard(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    # 랭킹은 0점 이하 유저를 제외하고 매긴다 — id를 타이브레이커로 둬서
    # 동점자 순서가 요청마다 흔들리지 않게 한다.
    ranked = list(
        Profile.objects.select_related("user").filter(total_score__gt=0).order_by("-total_score", "id")
    )

    entries = [
        {"rank": i + 1, "username": p.user.username, "total_score": p.total_score}
        for i, p in enumerate(ranked[:5])
    ]

    me = None
    for i, p in enumerate(ranked):
        if p.user_id == request.user.id:
            if i >= 5:  # 5위 밖일 때만 별도로 내려준다
                me = {"rank": i + 1, "username": p.user.username, "total_score": p.total_score}
            break

    return JsonResponse({"entries": entries, "me": me})


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
