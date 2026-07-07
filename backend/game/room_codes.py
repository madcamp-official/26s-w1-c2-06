from django.utils.crypto import get_random_string

from .models import Room

# 헷갈리는 문자(0/O, 1/I) 제외한 방 코드용 문자셋
ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_room_code():
    for _ in range(10):
        code = get_random_string(6, ROOM_CODE_CHARS)
        if not Room.objects.filter(code=code).exists():
            return code
    raise RuntimeError("방 코드 생성 실패 — 재시도 초과")
