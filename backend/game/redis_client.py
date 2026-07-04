import redis.asyncio as redis

_redis_client = None


def get_redis():
    """모든 Consumer가 공유하는 비동기 Redis 클라이언트 (지연 생성, 프로세스당 1개)."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis(host="localhost", port=6379, decode_responses=True)
    return _redis_client
