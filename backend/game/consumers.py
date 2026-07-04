import json
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.utils import timezone

from .models import Room
from .redis_client import get_redis

GAME_DURATION_MS = 60000


class GameConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_code = self.scope["url_route"]["kwargs"]["code"]
        self.room_group_name = f"room_{self.room_code}"
        self.user = self.scope["user"]

        if not self.user.is_authenticated:
            await self.close()
            return

        room = await self._get_room()
        if room is None or self.user.id not in (room.player1_id, room.player2_id):
            await self.close()
            return

        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if not hasattr(self, "room_group_name"):
            return

        await self._handle_waiting_leave()
        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        msg_type = data.get("type")

        if msg_type == "game.start":
            await self._handle_game_start()
        elif msg_type == "clock.sync":
            await self._handle_clock_sync(data)
        # submit 등은 Day 2에서 추가

    # --- 클럭 동기화 (§9, stateless — 상태 저장 없이 즉시 응답만) ---

    async def _handle_clock_sync(self, data):
        await self._send_json({
            "type": "clock.sync.reply",
            "client_sent_at": data.get("client_sent_at"),
            "server_time": int(time.time() * 1000),
        })

    # --- 방 생명주기 (§7 전반부 — 대기 중 이탈) ---

    @database_sync_to_async
    def _get_room(self):
        try:
            # player1/player2를 미리 join해서 가져옴 — 안 그러면 room_update()처럼
            # async 핸들러 안에서 room.player1.username을 나중에 접근할 때
            # Django가 동기 쿼리를 새로 날리려다 SynchronousOnlyOperation으로 죽는다.
            return Room.objects.select_related("player1", "player2").get(code=self.room_code)
        except Room.DoesNotExist:
            return None

    @database_sync_to_async
    def _promote_or_close_room(self):
        try:
            room = Room.objects.get(code=self.room_code)
        except Room.DoesNotExist:
            return

        if room.status != "waiting":
            return  # 게임 중 이탈은 Day 2에서 별도 처리

        if room.player1_id == self.user.id:
            if room.player2_id is not None:
                room.player1_id, room.player2_id = room.player2_id, None
                room.save(update_fields=["player1", "player2"])
            else:
                room.status = "finished"
                room.save(update_fields=["status"])
        elif room.player2_id == self.user.id:
            room.player2_id = None
            room.save(update_fields=["player2"])

    async def _handle_waiting_leave(self):
        await self._promote_or_close_room()
        await self.channel_layer.group_send(self.room_group_name, {"type": "room.update"})

    # --- 게임 시작 (§6 "게임 시작" 파트, 호스트 트리거) ---

    async def _handle_game_start(self):
        room = await self._get_room()
        if room is None:
            return

        if room.player1_id != self.user.id:
            await self._send_json({"type": "error", "error": "not_host"})
            return
        if room.player2_id is None:
            await self._send_json({"type": "error", "error": "room_not_full"})
            return
        if room.status != "waiting":
            await self._send_json({"type": "error", "error": "room_not_waiting"})
            return

        r = get_redis()
        now_ms = int(time.time() * 1000)
        acquired = await r.set(f"game_started_at:{self.room_code}", now_ms, nx=True)
        if not acquired:
            return  # 이미 다른 프로세스가 시작 처리를 마침

        await self._set_room_playing()

        await self.channel_layer.group_send(
            self.room_group_name,
            {"type": "game.start", "started_at": now_ms, "duration": GAME_DURATION_MS},
        )

    @database_sync_to_async
    def _set_room_playing(self):
        Room.objects.filter(code=self.room_code).update(status="playing", started_at=timezone.now())

    # --- group_send 브로드캐스트 수신 핸들러 ---

    async def game_start(self, event):
        await self._send_json({
            "type": "game.start",
            "started_at": event["started_at"],
            "duration": event["duration"],
        })

    async def room_update(self, event):
        room = await self._get_room()
        await self._send_json({
            "type": "room.update",
            "status": room.status if room else None,
            "player1": room.player1.username if room and room.player1 else None,
            "player2": room.player2.username if room and room.player2 else None,
        })

    async def _send_json(self, payload):
        await self.send(text_data=json.dumps(payload))
