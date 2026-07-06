import json

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import JsonResponse
from django.utils.crypto import get_random_string
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .models import Profile, Room

User = get_user_model()

# 헷갈리는 문자(0/O, 1/I) 제외한 방 코드용 문자셋
ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


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


def _generate_room_code():
    for _ in range(10):
        code = get_random_string(6, ROOM_CODE_CHARS)
        if not Room.objects.filter(code=code).exists():
            return code
    raise RuntimeError("방 코드 생성 실패 — 재시도 초과")


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

    room = Room.objects.create(code=_generate_room_code(), player1=request.user)
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
def room_detail(request, code):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)

    try:
        room = Room.objects.get(code=code)
    except Room.DoesNotExist:
        return JsonResponse({"error": "room_not_found"}, status=404)

    is_host = room.player1_id == request.user.id
    return JsonResponse({**_room_payload(room), "is_host": is_host})
