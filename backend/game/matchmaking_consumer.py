import asyncio
import contextlib
import json
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from . import tier
from .matchmaking_scripts import get_match_script
from .models import Profile, Room
from .redis_client import get_redis
from .room_codes import generate_room_code

QUEUE_KEY = "mm:queue"
QUEUED_AT_KEY = "mm:queued_at"

POLL_INTERVAL_S = 1.0

# 대기시간에 따른 매칭 범위 확장 — R 단위가 tier_score(0~99)와 같은 스케일이라, 0초는
# 반 티어 이내로 좁게 시작해서 10초마다 반 티어씩 넓어지고 약 3분이면 상한(사실상
# 전체 티어 범위)에 도달한다.
BASE_RANGE = 50
EXPAND_STEP = 50
EXPAND_INTERVAL_MS = 10_000
MAX_RANGE = 1000


class MatchmakingConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]
        if not self.user.is_authenticated:
            await self.close()
            return

        self.personal_group = f"mm_user_{self.user.id}"
        await self.channel_layer.group_add(self.personal_group, self.channel_name)
        await self.accept()

        profile = await self._get_profile()
        rating = tier.rating(profile.tier, profile.tier_score)

        r = get_redis()
        now_ms = int(time.time() * 1000)
        await r.zadd(QUEUE_KEY, {str(self.user.id): rating})
        await r.hset(QUEUED_AT_KEY, str(self.user.id), now_ms)

        await self._send_json({"type": "queue.joined", "rating": rating})

        if not await self._try_match():
            self._poll_task = asyncio.create_task(self._poll_loop())

    async def receive(self, text_data):
        data = json.loads(text_data)
        if data.get("type") == "queue.leave":
            await self._leave_queue()
            await self._send_json({"type": "queue.left"})
            await self.close()

    async def disconnect(self, close_code):
        if not hasattr(self, "personal_group"):
            return

        poll_task = getattr(self, "_poll_task", None)
        if poll_task is not None:
            poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poll_task

        await self._leave_queue()
        await self.channel_layer.group_discard(self.personal_group, self.channel_name)

    # --- 매칭 폴링 ---

    async def _poll_loop(self):
        while True:
            await asyncio.sleep(POLL_INTERVAL_S)
            if await self._try_match():
                return

    async def _try_match(self):
        script = get_match_script()
        now_ms = int(time.time() * 1000)
        result, detail = await script(
            keys=[QUEUE_KEY, QUEUED_AT_KEY],
            args=[str(self.user.id), now_ms, BASE_RANGE, EXPAND_STEP, EXPAND_INTERVAL_MS, MAX_RANGE],
        )
        if result == 0:
            return False

        partner_id = int(detail)
        room = await self._create_ranked_room(partner_id)

        for user_id in (self.user.id, partner_id):
            await self.channel_layer.group_send(
                f"mm_user_{user_id}", {"type": "match.found", "code": room.code}
            )
        return True

    async def _leave_queue(self):
        r = get_redis()
        await r.zrem(QUEUE_KEY, str(self.user.id))
        await r.hdel(QUEUED_AT_KEY, str(self.user.id))

    # --- group_send 브로드캐스트 수신 핸들러 ---

    async def match_found(self, event):
        poll_task = getattr(self, "_poll_task", None)
        if poll_task is not None:
            poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poll_task

        await self._send_json({"type": "match.found", "code": event["code"]})
        await self.close()

    # --- DB 접근 ---

    @database_sync_to_async
    def _get_profile(self):
        return Profile.objects.get(user_id=self.user.id)

    @database_sync_to_async
    def _create_ranked_room(self, partner_id):
        return Room.objects.create(
            code=generate_room_code(),
            is_ranked=True,
            player1_id=self.user.id,
            player2_id=partner_id,
        )

    async def _send_json(self, payload):
        await self.send(text_data=json.dumps(payload))
