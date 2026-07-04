import json

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from .models import Profile

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
    return JsonResponse({"username": user.username}, status=201)


@require_POST
def login_view(request):
    data = json.loads(request.body)
    username = data.get("username", "")
    password = data.get("password", "")

    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse({"error": "invalid_credentials"}, status=401)

    login(request, user)
    return JsonResponse({"username": user.username})


@require_POST
def logout_view(request):
    logout(request)
    return JsonResponse({"detail": "logged out"})


@require_GET
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "not_authenticated"}, status=401)
    return JsonResponse({"username": request.user.username})
