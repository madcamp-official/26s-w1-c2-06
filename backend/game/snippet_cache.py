from channels.db import database_sync_to_async

from .models import CodeSnippet

# 정적 스니펫 풀 cache-aside (backend-implementation.md §3-1).
# 프로세스 로컬 메모리 캐시 — 방 시작 시 1회 로드, 이후 방이 끝날 때까지 불변.
_local_snippet_cache = {}


async def get_snippet_pool(room_code):
    if room_code not in _local_snippet_cache:
        _local_snippet_cache[room_code] = await _load_snippets()
    return _local_snippet_cache[room_code]


def clear_snippet_pool(room_code):
    _local_snippet_cache.pop(room_code, None)


@database_sync_to_async
def _load_snippets():
    return list(CodeSnippet.objects.values("id", "text", "is_correct"))
