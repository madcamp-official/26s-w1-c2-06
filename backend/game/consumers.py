import asyncio
import contextlib
import json
import random
import time
import uuid

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.db import transaction
from django.db.models.functions import Greatest
from django.utils import timezone

from . import tier
from .models import GameResult, Profile, Room
from .redis_client import get_redis
from .redis_scripts import get_submit_script
from .snippet_cache import clear_snippet_pool, get_snippet_pool

GAME_DURATION_MS = 60000
SCORE_DELTA_INCORRECT = -500

# 방해 아이템(alert/honey) — 정답 스니펫에만 붙고, 확률은 QA 조정용으로 .env에서
# 읽는다(ITEM_ATTACH_PROB, config/settings.py). docs/plan/game-items.md 참고.
ITEM_TYPES = ("alert", "honey")

# 게임 시작 전 카운트다운 — 프론트 3초 연출과 서버 스폰/타이머 가동 시점을
# 맞춰서, 카운트다운 중에 코드가 미리 낙하해버리는 것을 막는다.
PREGAME_COUNTDOWN_MS = 3000

# 정답 점수는 맞힌 스니펫 길이에 비례한다(길수록 더 어려우니 더 큰 점수) — 낙하 시간
# 공식(compute_fall_duration_ms)과 같은 선형 + 상한 패턴을 쓴다.
SCORE_CORRECT_BASE = 200
SCORE_CORRECT_PER_CHAR = 20
SCORE_CORRECT_MAX = 1000


def compute_correct_score(text):
    return min(SCORE_CORRECT_MAX, SCORE_CORRECT_BASE + len(text) * SCORE_CORRECT_PER_CHAR)

# codes:{room} 해시 값 패킹 구분자 — "|"는 코드 텍스트 자체에 나올 수 있어(예:
# `Optional[int] | None`) 쓰지 않는다. 제어문자라 실제 코드 스니펫에 나올 일이 없다.
PACK_SEP = "\x01"

# 코드 길이에 따라 낙하 시간을 다르게 준다(길수록 느리게) — 화면에 보이는 낙하는
# spawn_ts/duration을 code.spawn으로 그대로 클라이언트에 내려줘서 양쪽 화면이
# 동일하게 계산하므로 동기화는 그대로 유지된다.
FALL_BASE_MS = 5000
FALL_PER_CHAR_MS = 150
FALL_MAX_MS = 14000

# 난이도 프리셋 — spawn_tick_ms(코드 생성 주기, 짧을수록 자주 스폰)와
# fall_speed_mult(낙하 시간 배율, 작을수록 빨리 떨어짐)를 함께 조절한다.
DIFFICULTY_PRESETS = {
    "easy": {"spawn_tick_ms": 800, "fall_speed_mult": 1.4},
    "normal": {"spawn_tick_ms": 500, "fall_speed_mult": 1.0},
    "hard": {"spawn_tick_ms": 320, "fall_speed_mult": 0.7},
    # 랭킹전 전용 — 친선전 난이도 선택과 무관하게 항상 이 프리셋을 쓴다(§_handle_game_start).
    # 스폰 주기는 '보통'과 동일하게 두고 낙하 속도만 70%로 줄인다(즉 낙하 시간은 1/0.7배).
    "ranked": {"spawn_tick_ms": 500, "fall_speed_mult": round(1 / 0.7, 2)},
}
DEFAULT_DIFFICULTY = "normal"


def compute_fall_duration_ms(text, fall_speed_mult=1.0):
    base = min(FALL_MAX_MS, FALL_BASE_MS + len(text) * FALL_PER_CHAR_MS)
    return int(base * fall_speed_mult)


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

        pregame_task = getattr(self, "_pregame_task", None)
        if pregame_task is not None:
            pregame_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pregame_task
            # 취소되면 카운트다운 완료 시점의 정리(락 삭제)가 실행되지 못하므로
            # 여기서 대신 지운다 — 안 그러면 재대결/재시작이 최대 10초(EX) 막힌다.
            await get_redis().delete(f"game_starting_lock:{self.room_code}")

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
            await self._handle_game_start(data)
        elif msg_type == "clock.sync":
            await self._handle_clock_sync(data)
        elif msg_type == "code.submit":
            await self._handle_submit(data)
        elif msg_type == "rematch":
            await self._handle_rematch()
        elif msg_type == "forfeit":
            await self._handle_forfeit()

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

    async def _handle_game_start(self, data):
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

        # 랭킹전은 친선전의 난이도 선택 UI 자체가 없으므로(클라이언트가 뭘 보내든)
        # 항상 전용 프리셋을 강제한다 — 매칭으로 실력차가 이미 좁혀진 상태라 낙하
        # 속도를 늦춰 판정 실수(오탈자)의 비중을 줄이기 위함.
        if room.is_ranked:
            difficulty = "ranked"
        else:
            difficulty = data.get("difficulty")
            if difficulty not in DIFFICULTY_PRESETS:
                difficulty = DEFAULT_DIFFICULTY

        r = get_redis()
        acquired = await r.set(f"game_starting_lock:{self.room_code}", 1, nx=True, ex=10)
        if not acquired:
            return  # 이미 다른 프로세스가 카운트다운을 시작함

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "game.starting",
                "countdown": PREGAME_COUNTDOWN_MS,
                "difficulty": difficulty,
            },
        )
        self._pregame_task = asyncio.create_task(self._begin_game_after_countdown(difficulty))

    async def _begin_game_after_countdown(self, difficulty):
        await asyncio.sleep(PREGAME_COUNTDOWN_MS / 1000)

        r = get_redis()
        room = await self._get_room()
        if room is None or room.status != "waiting" or room.player2_id is None:
            # 카운트다운 중 한쪽이 이탈해 방이 재배정/종료된 경우 — 시작하지 않는다
            await r.delete(f"game_starting_lock:{self.room_code}")
            return

        now_ms = int(time.time() * 1000)
        acquired = await r.set(f"game_started_at:{self.room_code}", now_ms, nx=True)
        if not acquired:
            await r.delete(f"game_starting_lock:{self.room_code}")
            return  # 이미 다른 프로세스가 시작 처리를 마침

        await self._set_room_playing()

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "game.start",
                "started_at": now_ms,
                "duration": GAME_DURATION_MS,
                "difficulty": difficulty,
            },
        )
        await r.delete(f"game_starting_lock:{self.room_code}")

    @database_sync_to_async
    def _set_room_playing(self):
        Room.objects.filter(code=self.room_code).update(status="playing", started_at=timezone.now())

    # --- 재대결 (room 유지, 호스트 트리거) ---

    async def _handle_rematch(self):
        room = await self._get_room()
        if room is None:
            return

        if room.player1_id != self.user.id:
            await self._send_json({"type": "error", "error": "not_host"})
            return
        if room.status != "finished":
            await self._send_json({"type": "error", "error": "room_not_finished"})
            return

        await self._reset_room_to_waiting()
        await self.channel_layer.group_send(self.room_group_name, {"type": "room.update"})

    @database_sync_to_async
    def _reset_room_to_waiting(self):
        Room.objects.filter(code=self.room_code).update(status="waiting", started_at=None, ended_at=None)

    # --- 게임 포기 (플레이어가 직접 트리거, disconnect()의 강제 종료와 달리
    #     소켓을 열어둔 채 보내므로 포기한 본인도 game.over를 정상적으로 받는다) ---

    async def _handle_forfeit(self):
        room = await self._get_room()
        if room is None or room.status != "playing":
            return

        opponent_id = room.player2_id if room.player1_id == self.user.id else room.player1_id
        await self._try_end_game(forced_winner_id=opponent_id)

    # --- 스폰 틱 로직 (§4, "스폰도 선점 문제") ---

    async def _spawn_tick_loop(self, started_at, duration_ms, difficulty=DEFAULT_DIFFICULTY):
        preset = DIFFICULTY_PRESETS.get(difficulty, DIFFICULTY_PRESETS[DEFAULT_DIFFICULTY])
        spawn_tick_ms = preset["spawn_tick_ms"]
        fall_speed_mult = preset["fall_speed_mult"]

        last_tick = -1
        while True:
            await asyncio.sleep(0.1)  # tick 경계를 놓치지 않도록 짧게 자주 깨어남
            now_ms = int(time.time() * 1000)
            elapsed = now_ms - started_at
            if elapsed >= duration_ms:
                await self._try_end_game()
                break

            tick = elapsed // spawn_tick_ms
            if tick != last_tick:
                last_tick = tick
                await self._try_spawn(tick, fall_speed_mult)

    async def _try_spawn(self, tick, fall_speed_mult=1.0):
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

        code_id = uuid.uuid4().hex
        spawn_ts = int(time.time() * 1000)
        duration_ms = compute_fall_duration_ms(snippet["text"], fall_speed_mult)

        item = ""
        if snippet["is_correct"] and random.random() < settings.ITEM_ATTACH_PROB:
            item = random.choice(ITEM_TYPES)

        value = PACK_SEP.join(
            [snippet["text"], "1" if snippet["is_correct"] else "0", str(spawn_ts), str(duration_ms), item]
        )
        await r.hset(f"codes:{self.room_code}", code_id, value)
        await r.hset(f"text_index:{self.room_code}", snippet["text"], code_id)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "code.spawn",
                "code_id": code_id,
                "text": snippet["text"],
                "spawn_ts": spawn_ts,
                "duration": duration_ms,
                "item": item or None,
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

        # 재대결로 같은 room에 여러 판이 쌓일 수 있어, 이 판을 구분하는 idempotency
        # key로 game_started_at을 함께 쓴다(room만으로는 더 이상 유일하지 않음, §6 참고).
        started_at_raw = await r.get(f"game_started_at:{self.room_code}")
        started_at_ms = int(started_at_raw) if started_at_raw is not None else int(time.time() * 1000)

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

        await self._persist_game_result(
            room.id, started_at_ms, u1, u2, score1, score2, winner_id, room.is_ranked
        )

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
    def _persist_game_result(
        self, room_id, started_at_ms, user1_id, user2_id, score1, score2, winner_id, is_ranked
    ):
        with transaction.atomic():
            obj, created = GameResult.objects.get_or_create(
                room_id=room_id,
                started_at_ms=started_at_ms,
                defaults={
                    "user1_id": user1_id,
                    "user2_id": user2_id,
                    "score1": score1,
                    "score2": score2,
                    "winner_id": winner_id,
                },
            )
            if created:
                # total_score는 누적합이 아니라 유저의 역대 한 판 최고 기록이다
                Profile.objects.filter(user_id=user1_id).update(
                    total_score=Greatest("total_score", score1)
                )
                Profile.objects.filter(user_id=user2_id).update(
                    total_score=Greatest("total_score", score2)
                )
                Room.objects.filter(id=room_id).update(status="finished", ended_at=timezone.now())

                # 매칭 큐로 성사된 랭크 게임만 티어에 반영한다 — 방 코드로 만든 친선
                # 게임은 공모(짜고 치기)로 점수를 조작할 위험이 있어 제외한다. 이 블록이
                # 위 total_score와 같은 `if created:` 가드 안에 있어서, 크래시 후 같은
                # 판이 재시도돼도(get_or_create가 created=False를 반환) 티어 반영이
                # 중복되지 않는다.
                if is_ranked:
                    # user1/user2는 room.player1/player2 순서라 매칭 큐가 어느 쪽을
                    # player1로 잡았는지에 따라 같은 두 유저라도 방마다 순서가 뒤바뀔 수
                    # 있다 — 잠금 순서를 room 역할이 아니라 user_id로 고정해야, 이
                    # 두 유저가 동시에 다른 두 방에서 각각 게임을 끝내는 경우 잠금 순서가
                    # 서로 반대로 걸려 데드락이 나는 걸 막을 수 있다.
                    lo_id, hi_id = sorted((user1_id, user2_id))
                    profiles = {
                        p.user_id: p
                        for p in Profile.objects.select_for_update()
                        .filter(user_id__in=(lo_id, hi_id))
                        .order_by("user_id")
                    }
                    p1, p2 = profiles[user1_id], profiles[user2_id]
                    r1 = tier.rating(p1.tier, p1.tier_score)
                    r2 = tier.rating(p2.tier, p2.tier_score)
                    result1 = 0.5 if winner_id is None else (1 if winner_id == user1_id else 0)
                    delta1 = tier.tier_delta(r1, r2, result1)
                    tier.apply_tier_result(p1, delta1)
                    tier.apply_tier_result(p2, -delta1)
                    p1.save(update_fields=["tier", "tier_score"])
                    p2.save(update_fields=["tier", "tier_score"])

    # --- 제출 판정 (§5, 매칭+선점+채점+제거를 Lua 스크립트 하나로 원자 처리) ---

    async def _handle_submit(self, data):
        text = (data.get("text") or "").strip()
        if not text:
            return

        script = get_submit_script()
        now_ms = int(time.time() * 1000)
        correct_delta = compute_correct_score(text)
        result, detail, item = await script(
            keys=[
                f"text_index:{self.room_code}",
                f"codes:{self.room_code}",
                f"score:{self.room_code}",
                f"game_started_at:{self.room_code}",
            ],
            args=[
                text,
                self.user.id,
                correct_delta,
                SCORE_DELTA_INCORRECT,
                now_ms,
                GAME_DURATION_MS,
                self.room_code,
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
                "delta": correct_delta if result == 1 else SCORE_DELTA_INCORRECT,
                "item": item or None,
            },
        )

    # --- group_send 브로드캐스트 수신 핸들러 ---

    async def game_starting(self, event):
        await self._send_json({
            "type": "game.starting",
            "countdown": event["countdown"],
            "difficulty": event.get("difficulty"),
        })

    async def game_start(self, event):
        difficulty = event.get("difficulty", DEFAULT_DIFFICULTY)
        await self._send_json({
            "type": "game.start",
            "started_at": event["started_at"],
            "duration": event["duration"],
            "difficulty": difficulty,
        })
        self._spawn_task = asyncio.create_task(
            self._spawn_tick_loop(event["started_at"], event["duration"], difficulty)
        )

    async def code_spawn(self, event):
        await self._send_json({
            "type": "code.spawn",
            "code_id": event["code_id"],
            "text": event["text"],
            "spawn_ts": event["spawn_ts"],
            "duration": event["duration"],
            "item": event.get("item"),
        })

    async def code_result(self, event):
        await self._send_json({
            "type": "code.result",
            "code_id": event["code_id"],
            "correct": event["correct"],
            "user_id": event["user_id"],
            "delta": event["delta"],
            "item": event.get("item"),
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
