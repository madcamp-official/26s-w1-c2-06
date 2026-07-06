import asyncio
import contextlib
import json
import random
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import GameResult, Profile, Room
from .redis_client import get_redis
from .redis_scripts import get_submit_script
from .snippet_cache import clear_snippet_pool, get_snippet_pool

GAME_DURATION_MS = 60000
SPAWN_TICK_MS = 500
SCORE_DELTA_CORRECT = 500
SCORE_DELTA_INCORRECT = -500


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

        spawn_task = getattr(self, "_spawn_task", None)
        if spawn_task is not None:
            spawn_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await spawn_task

        room = await self._get_room()
        if room is not None and room.status == "playing":
            # 게임 중 이탈 (§7 후반부) — 60초를 기다리지 않고 즉시 종료 처리,
            # 남은 유저를 점수와 무관하게 승자로 강제 지정
            remaining_id = room.player2_id if room.player1_id == self.user.id else room.player1_id
            await self._try_end_game(forced_winner_id=remaining_id)
        else:
            await self._handle_waiting_leave()

        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        msg_type = data.get("type")

        if msg_type == "game.start":
            await self._handle_game_start()
        elif msg_type == "clock.sync":
            await self._handle_clock_sync(data)
        elif msg_type == "code.submit":
            await self._handle_submit(data)

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
                clear_snippet_pool(self.room_code)
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

    # --- 스폰 틱 로직 (§4, "스폰도 선점 문제") ---

    async def _spawn_tick_loop(self, started_at, duration_ms):
        last_tick = -1
        while True:
            await asyncio.sleep(0.1)  # tick 경계를 놓치지 않도록 짧게 자주 깨어남
            now_ms = int(time.time() * 1000)
            elapsed = now_ms - started_at
            if elapsed >= duration_ms:
                await self._try_end_game()
                break

            tick = elapsed // SPAWN_TICK_MS
            if tick != last_tick:
                last_tick = tick
                await self._try_spawn(tick)

    async def _try_spawn(self, tick):
        r = get_redis()
        acquired = await r.set(
            f"spawn_lock:{self.room_code}:{tick}", self.channel_name, nx=True, ex=5
        )
        if not acquired:
            return  # 이미 다른 프로세스(연결)가 이번 틱을 처리함

        pool = await get_snippet_pool(self.room_code)
        if not pool:
            return

        snippet = None
        for _ in range(10):
            candidate = random.choice(pool)
            added = await r.sadd(f"used_snippet_ids:{self.room_code}", candidate["id"])
            if added:
                snippet = candidate
                break
        if snippet is None:
            return  # 후보를 10번 뽑아도 전부 중복 — 이번 틱은 스킵 (풀 소진에 가까움)

        code_id = str(snippet["id"])
        value = f"{snippet['text']}|{'1' if snippet['is_correct'] else '0'}"
        await r.hset(f"codes:{self.room_code}", code_id, value)
        await r.hset(f"text_index:{self.room_code}", snippet["text"], code_id)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "code.spawn",
                "code_id": code_id,
                "text": snippet["text"],
                "spawn_ts": int(time.time() * 1000),
            },
        )

    # --- 게임 종료 및 최종 점수 반영 (§6) ---

    async def _try_end_game(self, forced_winner_id=None):
        r = get_redis()
        acquired = await r.set(
            f"game_end_lock:{self.room_code}", self.channel_name, nx=True, ex=30
        )
        if not acquired:
            return  # 이미 다른 프로세스가 종료 처리 중이거나 끝냄

        room = await self._get_room()
        if room is None:
            return

        u1, u2 = room.player1_id, room.player2_id
        score1 = int(await r.zscore(f"score:{self.room_code}", str(u1)) or 0)
        score2 = int(await r.zscore(f"score:{self.room_code}", str(u2)) or 0)

        if forced_winner_id is not None:
            # 게임 중 이탈로 트리거된 강제 종료 (§7) — 점수 비교 없이 남은 유저가 승자
            winner_id = forced_winner_id
        elif score1 == score2:
            winner_id = None
        elif score1 > score2:
            winner_id = u1
        else:
            winner_id = u2

        await self._persist_game_result(room.id, u1, u2, score1, score2, winner_id)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "game.over",
                "scores": {str(u1): score1, str(u2): score2},
                "winner_id": winner_id,
            },
        )

        await r.delete(
            f"codes:{self.room_code}",
            f"text_index:{self.room_code}",
            f"used_snippet_ids:{self.room_code}",
            f"score:{self.room_code}",
            f"game_started_at:{self.room_code}",
        )
        # spawn_lock:*, claim:*, game_end_lock:{room}은 이미 EX가 걸려 있어 자연 만료에 맡긴다

    @database_sync_to_async
    def _persist_game_result(self, room_id, user1_id, user2_id, score1, score2, winner_id):
        with transaction.atomic():
            obj, created = GameResult.objects.get_or_create(
                room_id=room_id,
                defaults={
                    "user1_id": user1_id,
                    "user2_id": user2_id,
                    "score1": score1,
                    "score2": score2,
                    "winner_id": winner_id,
                },
            )
            if created:
                Profile.objects.filter(user_id=user1_id).update(total_score=F("total_score") + score1)
                Profile.objects.filter(user_id=user2_id).update(total_score=F("total_score") + score2)
                Room.objects.filter(id=room_id).update(status="finished", ended_at=timezone.now())

    # --- 제출 판정 (§5, 매칭+선점+채점+제거를 Lua 스크립트 하나로 원자 처리) ---

    async def _handle_submit(self, data):
        text = (data.get("text") or "").strip()
        if not text:
            return

        script = get_submit_script()
        now_ms = int(time.time() * 1000)
        result, detail = await script(
            keys=[
                f"text_index:{self.room_code}",
                f"codes:{self.room_code}",
                f"score:{self.room_code}",
                f"game_started_at:{self.room_code}",
            ],
            args=[
                text,
                self.user.id,
                SCORE_DELTA_CORRECT,
                SCORE_DELTA_INCORRECT,
                now_ms,
                GAME_DURATION_MS,
            ],
        )

        if result == 0:
            # 화면에 없는 문자열이거나, 이미 남이 선점했거나, 60초가 지난 뒤 도착한 제출
            # — 이번 판 점수에는 아무 영향 없음. 제출한 유저에게만 알려준다.
            await self._send_json({"type": "code.submit.ack", "outcome": detail, "delta": 0})
            return

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "code.result",
                "code_id": detail,
                "correct": result == 1,
                "user_id": self.user.id,
                "delta": SCORE_DELTA_CORRECT if result == 1 else SCORE_DELTA_INCORRECT,
            },
        )

    # --- group_send 브로드캐스트 수신 핸들러 ---

    async def game_start(self, event):
        await self._send_json({
            "type": "game.start",
            "started_at": event["started_at"],
            "duration": event["duration"],
        })
        self._spawn_task = asyncio.create_task(
            self._spawn_tick_loop(event["started_at"], event["duration"])
        )

    async def code_spawn(self, event):
        await self._send_json({
            "type": "code.spawn",
            "code_id": event["code_id"],
            "text": event["text"],
            "spawn_ts": event["spawn_ts"],
        })

    async def code_result(self, event):
        await self._send_json({
            "type": "code.result",
            "code_id": event["code_id"],
            "correct": event["correct"],
            "user_id": event["user_id"],
            "delta": event["delta"],
        })

    async def game_over(self, event):
        # 상대방이 이탈해서 강제 종료된 경우, 이 컨슈머의 스폰 루프는 아직 자기 로컬
        # `started_at` 기준 60초가 안 지나 계속 돌고 있을 수 있다 — 그대로 두면 나중에
        # (Redis 키가 이미 정리된 뒤) 스스로 또 `_try_end_game()`을 호출하게 되므로,
        # game.over를 받는 즉시 멈춘다.
        spawn_task = getattr(self, "_spawn_task", None)
        if spawn_task is not None:
            spawn_task.cancel()

        await self._send_json({
            "type": "game.over",
            "scores": event["scores"],
            "winner_id": event["winner_id"],
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
