"""
제출 판정 Lua 스크립트(§5) 단위 테스트 — 실제 로컬 Redis에 대고 EVAL을 직접 호출한다
(스크립트 자체가 원자성을 보장하는 로직이므로, 모킹하면 검증 의미가 없다).

사전 조건: `docker compose up -d`로 로컬 Redis(localhost:6379)가 떠 있어야 한다.
"""
import json
import time
import unittest
import uuid

import redis
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from . import matchmaking_scripts, redis_client, redis_scripts, tier
from .consumers import GameConsumer, compute_correct_score
from .matchmaking_consumer import QUEUE_KEY, QUEUED_AT_KEY, MatchmakingConsumer
from .matchmaking_scripts import MATCH_SCRIPT
from .models import CodeSnippet, GameResult, Profile, Room
from .redis_scripts import SUBMIT_SCRIPT
from .snippet_cache import clear_snippet_pool

User = get_user_model()

DELTA_CORRECT = 500
DELTA_INCORRECT = -500
DURATION_MS = 60000


class SubmitScriptTests(SimpleTestCase):
    databases = set()  # 이 테스트는 DB를 쓰지 않는다 — Redis만 대상

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 이름을 `client`로 하면 Django SimpleTestCase가 매 테스트마다 인스턴스에
        # 새로 얹는 HTTP 테스트 클라이언트(self.client)에 가려지므로 `redis`로 둔다.
        cls.redis = redis.Redis(host="localhost", port=6379, decode_responses=True)
        cls.script = cls.redis.register_script(SUBMIT_SCRIPT)

    def setUp(self):
        self.room = f"test-{uuid.uuid4().hex[:8]}"
        self.keys = [
            f"text_index:{self.room}",
            f"codes:{self.room}",
            f"score:{self.room}",
            f"game_started_at:{self.room}",
        ]
        self.user_id = 1

    def tearDown(self):
        self.redis.delete(*self.keys)

    def _seed_code(
        self, code_id, text, is_correct, started_ago_ms=1000, code_age_ms=100, fall_duration_ms=9000, item=""
    ):
        now_ms = int(time.time() * 1000)
        spawn_ts = now_ms - code_age_ms
        packed = "\x01".join([text, "1" if is_correct else "0", str(spawn_ts), str(fall_duration_ms), item])
        self.redis.hset(f"codes:{self.room}", code_id, packed)
        self.redis.hset(f"text_index:{self.room}", text, code_id)
        self.redis.set(f"game_started_at:{self.room}", now_ms - started_ago_ms)

    def _submit(self, text, user_id=None):
        now_ms = int(time.time() * 1000)
        return self.script(
            keys=self.keys,
            args=[
                text,
                user_id or self.user_id,
                DELTA_CORRECT,
                DELTA_INCORRECT,
                now_ms,
                DURATION_MS,
                self.room,
            ],
        )

    def test_correct_submission_scores_plus_500_and_removes_code(self):
        self._seed_code("1", "print(x)", is_correct=True)

        result, detail, item = self._submit("print(x)")

        self.assertEqual(result, 1)
        self.assertEqual(detail, "1")
        self.assertEqual(item, "")  # 아이템 안 붙은 경우
        self.assertEqual(self.redis.zscore(f"score:{self.room}", str(self.user_id)), DELTA_CORRECT)
        self.assertIsNone(self.redis.hget(f"text_index:{self.room}", "print(x)"))
        self.assertIsNone(self.redis.hget(f"codes:{self.room}", "1"))

    def test_correct_submission_with_item_returns_item(self):
        self._seed_code("1b", "print(y)", is_correct=True, item="honey")

        result, detail, item = self._submit("print(y)")

        self.assertEqual(result, 1)
        self.assertEqual(detail, "1b")
        self.assertEqual(item, "honey")

    def test_incorrect_submission_scores_minus_500_and_removes_code(self):
        self._seed_code("2", "print(x", is_correct=False)

        result, detail, item = self._submit("print(x")

        self.assertEqual(result, -1)
        self.assertEqual(detail, "2")
        self.assertEqual(item, "")  # 아이템은 정답에만 붙으므로 오답은 항상 빈 문자열
        self.assertEqual(self.redis.zscore(f"score:{self.room}", str(self.user_id)), DELTA_INCORRECT)

    def test_text_not_on_screen_is_no_match(self):
        self._seed_code("3", "def f():", is_correct=True)

        result, detail, item = self._submit("이 텍스트는 화면에 없음")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "no_match")
        self.assertEqual(item, "")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 매치가 안 났으니 기존 코드는 그대로 남아 있어야 한다
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "def f():"), "3")

    def test_already_claimed_code_is_too_late_and_does_not_double_score(self):
        self._seed_code("4", "return a + b", is_correct=True)
        # 다른 프로세스가 이미 이 code_id를 선점한 상태를 흉내낸다 (claim은 room으로 스코프됨)
        claim_key = f"claim:{self.room}:4"
        self.redis.set(claim_key, "other-user", nx=True, ex=30)

        result, detail, item = self._submit("return a + b")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "too_late")
        self.assertEqual(item, "")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 선점 실패 시 매치/코드 데이터는 그대로 보존되어야 한다 (삭제/채점 금지)
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "return a + b"), "4")
        self.assertIsNotNone(self.redis.hget(f"codes:{self.room}", "4"))

        self.redis.delete(claim_key)

    def test_submission_after_game_duration_is_game_over(self):
        self._seed_code("5", "raise ValueError('bad')", is_correct=True, started_ago_ms=DURATION_MS + 1000)

        result, detail, item = self._submit("raise ValueError('bad')")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "game_over")
        self.assertEqual(item, "")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 60초 경과 후엔 매치 여부와 무관하게 아무 것도 건드리지 않는다
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "raise ValueError('bad')"), "5")

    def test_code_already_fallen_off_screen_does_not_score(self):
        # 이 코드의 개별 낙하 시간(fall_duration_ms)이 이미 지난 상태 — 화면에서는
        # 이미 사라진 코드인데 서버가 여전히 매칭해버리면 "화면에 없는 코드에 점수가
        # 오르는" 버그가 재현된다.
        self._seed_code("6", "def g():", is_correct=True, code_age_ms=10_000, fall_duration_ms=9000)

        result, detail, item = self._submit("def g():")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "expired")
        self.assertEqual(item, "")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 만료된 코드는 더 이상 매치되면 안 되므로 인덱스/코드 해시에서 함께 제거된다
        self.assertIsNone(self.redis.hget(f"text_index:{self.room}", "def g():"))
        self.assertIsNone(self.redis.hget(f"codes:{self.room}", "6"))


class MatchScriptTests(SimpleTestCase):
    """랭크 매칭 큐 Lua 스크립트 단위 테스트 — 실제 로컬 Redis에 대고 EVAL 직접 호출."""

    databases = set()

    QUEUE_KEY = "mm:queue:test"
    QUEUED_AT_KEY = "mm:queued_at:test"
    BASE_RANGE = 50
    EXPAND_STEP = 50
    EXPAND_INTERVAL_MS = 10_000
    MAX_RANGE = 1000

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.redis = redis.Redis(host="localhost", port=6379, decode_responses=True)
        cls.script = cls.redis.register_script(MATCH_SCRIPT)

    def tearDown(self):
        self.redis.delete(self.QUEUE_KEY, self.QUEUED_AT_KEY)

    def _join(self, user_id, rating, queued_ago_ms=0):
        now_ms = int(time.time() * 1000)
        self.redis.zadd(self.QUEUE_KEY, {str(user_id): rating})
        self.redis.hset(self.QUEUED_AT_KEY, str(user_id), now_ms - queued_ago_ms)

    def _try_match(self, user_id):
        now_ms = int(time.time() * 1000)
        return self.script(
            keys=[self.QUEUE_KEY, self.QUEUED_AT_KEY],
            args=[
                str(user_id),
                now_ms,
                self.BASE_RANGE,
                self.EXPAND_STEP,
                self.EXPAND_INTERVAL_MS,
                self.MAX_RANGE,
            ],
        )

    def test_matches_closest_candidate_within_base_range(self):
        self._join(1, 100)
        self._join(2, 120)  # diff 20, base_range 50 이내
        self._join(3, 300)  # 범위 밖

        result, detail = self._try_match(1)

        self.assertEqual(result, 1)
        self.assertEqual(detail, "2")
        self.assertIsNone(self.redis.zscore(self.QUEUE_KEY, "1"))
        self.assertIsNone(self.redis.zscore(self.QUEUE_KEY, "2"))
        # 매칭 안 된 3번은 큐에 그대로 남아야 한다
        self.assertIsNotNone(self.redis.zscore(self.QUEUE_KEY, "3"))

    def test_no_candidate_in_range_stays_queued(self):
        self._join(1, 100)
        self._join(2, 300)  # base_range 밖

        result, detail = self._try_match(1)

        self.assertEqual(result, 0)
        self.assertEqual(detail, "no_match")
        self.assertIsNotNone(self.redis.zscore(self.QUEUE_KEY, "1"))
        self.assertIsNotNone(self.redis.zscore(self.QUEUE_KEY, "2"))

    def test_self_not_queued_returns_not_queued(self):
        result, detail = self._try_match(999)

        self.assertEqual(result, 0)
        self.assertEqual(detail, "not_queued")

    def test_already_matched_user_cannot_match_again(self):
        """이중 매칭 방지 — A가 B를 이미 매칭해간 뒤, B 자신의 재시도가 다른 후보(C)와
        엉뚱하게 다시 매칭되지 않고 not_queued로 즉시 빠져야 한다."""
        self._join(1, 100)  # A
        self._join(2, 110)  # B
        self._join(3, 105)  # C — A/B 둘 다와 범위 안

        result_a, detail_a = self._try_match(1)
        self.assertEqual(result_a, 1)  # A가 먼저 매칭 성사 (B 또는 C 중 가장 가까운 쪽)

        # B가 매칭되어 사라졌든 아니든, matched partner를 제외한 나머지가 자기 자신으로
        # 재시도했을 때 이미 없어진 유저는 not_queued여야 한다
        matched_partner = detail_a
        result_b, detail_b = self._try_match(int(matched_partner))
        self.assertEqual((result_b, detail_b), (0, "not_queued"))

    def test_range_expands_with_wait_time(self):
        # base_range(50) 밖이지만, 오래 대기해서 확장된 범위 안에 들어오는 경우
        self._join(1, 100, queued_ago_ms=self.EXPAND_INTERVAL_MS * 2)  # range: 50+100=150
        self._join(2, 220)  # diff 120 — base_range 밖, 확장된 range(150) 안

        result, detail = self._try_match(1)

        self.assertEqual(result, 1)
        self.assertEqual(detail, "2")

    def test_range_expands_from_waiting_candidate_perspective(self):
        """비대칭 range 버그 회귀 테스트 — 오래 기다려 range가 넓어진 쪽이 후보(2번)이고,
        방금 큐에 들어온 나(1번)의 range는 아직 base_range(50)뿐이어도, 둘 중 더 관대한
        쪽(후보의 range)을 적용받아 매칭돼야 한다. 이 대칭 처리가 없으면 diff(120)가
        내 range(50)만으로는 안 잡혀서 "매칭이 안 되는" 버그가 재현된다."""
        self._join(2, 220, queued_ago_ms=self.EXPAND_INTERVAL_MS * 2)  # range: 50+100=150
        self._join(1, 100)  # 방금 큐에 들어옴 — 자기 range는 50뿐

        result, detail = self._try_match(1)

        self.assertEqual(result, 1)
        self.assertEqual(detail, "2")


class GameEndLockTests(SimpleTestCase):
    """게임 종료 동시 트리거 방지(§6) — 같은 방에 대해 game_end_lock 획득 요청을
    두 번 보냈을 때 정확히 하나만 통과하는지 확인한다."""

    databases = set()

    def setUp(self):
        self.redis = redis.Redis(host="localhost", port=6379, decode_responses=True)
        self.room = f"test-{uuid.uuid4().hex[:8]}"
        self.key = f"game_end_lock:{self.room}"

    def tearDown(self):
        self.redis.delete(self.key)

    def test_only_one_process_can_acquire_end_lock(self):
        first = self.redis.set(self.key, "process-a", nx=True, ex=30)
        second = self.redis.set(self.key, "process-b", nx=True, ex=30)

        self.assertTrue(first)
        self.assertIsNone(second)
        self.assertEqual(self.redis.get(self.key), "process-a")


class GameConsumerIntegrationTests(TransactionTestCase):
    """connect → game.start → code.spawn → code.submit → code.result 흐름을
    실제 Channels WebsocketCommunicator + 로컬 Redis 채널 레이어로 검증한다.

    TransactionTestCase를 쓰는 이유: 컨슈머의 DB 접근은 database_sync_to_async로
    별도 스레드에서 실행되는데, 일반 TestCase의 트랜잭션 롤백 방식은 스레드 간에
    보이지 않아 Channels 공식 문서도 이 경우 TransactionTestCase를 권장한다.
    """

    def setUp(self):
        # 전역 비동기 Redis 클라이언트(redis_client.get_redis())가 이전 async 테스트의
        # (이미 닫힌) 이벤트 루프에 묶인 채로 재사용되면서 깨지는 걸 막는다 — 이 클래스에
        # async 테스트 메서드가 두 개 이상이라 매번 리셋 필요 (MatchmakingConsumerIntegrationTests
        # 에서 같은 이유로 이미 쓰던 패턴).
        redis_client._redis_client = None
        redis_scripts._submit_script = None  # 위와 동일한 이유 — Script 객체도 옛 클라이언트를 들고 있다
        self.room_code = f"RM{uuid.uuid4().hex[:6].upper()}"
        self.user1 = User.objects.create_user(username=f"alice-{uuid.uuid4().hex[:6]}", password="pw12345")
        self.user2 = User.objects.create_user(username=f"bob-{uuid.uuid4().hex[:6]}", password="pw12345")
        Profile.objects.create(user=self.user1)
        Profile.objects.create(user=self.user2)

        self.correct_text = "print('ok')"
        self.wrong_text = "print('ok'"
        CodeSnippet.objects.create(text=self.correct_text, is_correct=True)
        CodeSnippet.objects.create(text=self.wrong_text, is_correct=False)

        self.room = Room.objects.create(
            code=self.room_code, player1=self.user1, player2=self.user2, status="waiting"
        )

    def tearDown(self):
        clear_snippet_pool(self.room_code)

    async def _connect(self, user):
        communicator = WebsocketCommunicator(GameConsumer.as_asgi(), f"/ws/room/{self.room_code}/")
        communicator.scope["url_route"] = {"kwargs": {"code": self.room_code}}
        communicator.scope["user"] = user
        connected, _ = await communicator.connect()
        self.assertTrue(connected)
        return communicator

    async def test_connect_spawn_submit_score_flow(self):
        comm1 = await self._connect(self.user1)
        comm2 = await self._connect(self.user2)

        # 호스트(user1)가 게임 시작 → 양쪽 다 먼저 game.starting(카운트다운)을 받는다
        await comm1.send_to(text_data=json.dumps({"type": "game.start"}))

        starting1 = await comm1.receive_json_from(timeout=2)
        starting2 = await comm2.receive_json_from(timeout=2)
        self.assertEqual(starting1["type"], "game.starting")
        self.assertEqual(starting2["type"], "game.starting")

        # PREGAME_COUNTDOWN_MS(3000ms) 경과 후 game.start 브로드캐스트
        start1 = await comm1.receive_json_from(timeout=5)
        start2 = await comm2.receive_json_from(timeout=5)
        self.assertEqual(start1["type"], "game.start")
        self.assertEqual(start2["type"], "game.start")

        # 스폰 틱 로직이 곧 코드를 하나 스폰해 양쪽에 동일하게 브로드캐스트한다
        spawn1 = await comm1.receive_json_from(timeout=2)
        spawn2 = await comm2.receive_json_from(timeout=2)
        self.assertEqual(spawn1["type"], "code.spawn")
        self.assertEqual(spawn1["code_id"], spawn2["code_id"])
        self.assertEqual(spawn1["text"], spawn2["text"])

        # user1이 스폰된 텍스트를 그대로 제출 → 판정 결과가 양쪽에 동일하게 브로드캐스트
        await comm1.send_to(text_data=json.dumps({"type": "code.submit", "text": spawn1["text"]}))

        result1 = await comm1.receive_json_from(timeout=2)
        result2 = await comm2.receive_json_from(timeout=2)
        self.assertEqual(result1["type"], "code.result")
        self.assertEqual(result1, result2)
        self.assertEqual(result1["code_id"], spawn1["code_id"])
        self.assertEqual(result1["user_id"], self.user1.id)
        is_correct = spawn1["text"] == self.correct_text
        self.assertEqual(result1["correct"], is_correct)
        expected_delta = compute_correct_score(spawn1["text"]) if is_correct else DELTA_INCORRECT
        self.assertEqual(result1["delta"], expected_delta)

    async def test_item_forced_probability_attaches_to_correct_spawn_and_relays_through_result(self):
        # ITEM_ATTACH_PROB=1.0으로 강제해서 정답 스니펫엔 반드시 아이템이 붙게 만들고,
        # 오답 스니펫엔 절대 안 붙는지까지 같이 확인한다 (스폰 → code.spawn → 제출 →
        # code.result 전체 경로에 item이 실제로 실려가는지 검증 — Lua 스크립트 단위
        # 테스트는 이미 있던 item을 다루는 것만 확인하므로, _try_spawn의 확률 로직
        # 자체는 여기서만 커버된다).
        with override_settings(ITEM_ATTACH_PROB=1.0):
            comm1 = await self._connect(self.user1)
            comm2 = await self._connect(self.user2)

            await comm1.send_to(text_data=json.dumps({"type": "game.start"}))
            await comm1.receive_json_from(timeout=2)  # game.starting
            await comm2.receive_json_from(timeout=2)
            await comm1.receive_json_from(timeout=5)  # game.start (카운트다운 이후)
            await comm2.receive_json_from(timeout=5)

            # 스니펫 풀이 2개(정답/오답)뿐이라, 틱마다 하나씩 총 2번 스폰된다
            spawn1 = await comm1.receive_json_from(timeout=2)
            spawn2 = await comm1.receive_json_from(timeout=2)

            for spawn in (spawn1, spawn2):
                if spawn["text"] == self.correct_text:
                    self.assertIn(spawn["item"], ("alert", "honey"))
                    correct_code_id = spawn["code_id"]
                else:
                    self.assertIsNone(spawn["item"])

            await comm1.send_to(
                text_data=json.dumps({"type": "code.submit", "text": self.correct_text})
            )
            result1 = await comm1.receive_json_from(timeout=2)
            self.assertEqual(result1["code_id"], correct_code_id)
            self.assertIn(result1["item"], ("alert", "honey"))

            await comm2.receive_json_from(timeout=2)  # comm2도 동일한 code.result를 받음(큐 비움)

            await comm1.disconnect()
            await comm2.disconnect()


class MatchmakingConsumerIntegrationTests(TransactionTestCase):
    """랭크 매칭 큐 connect → queue.joined → match.found 흐름을 실제 Channels
    WebsocketCommunicator + 로컬 Redis로 검증한다."""

    def setUp(self):
        # 컨슈머가 쓰는 전역 비동기 Redis 클라이언트(redis_client.get_redis())는 프로세스당
        # 1개로 캐시되는데, Django가 async 테스트 메서드마다 새 이벤트 루프를 만들어서
        # 돌리는 탓에 이전 테스트의 루프에 묶인 커넥션을 재사용하면 "Event loop is
        # closed"로 깨진다 — 매 테스트마다 리셋해서 이번 테스트의 루프에서 새로 만들게 한다.
        redis_client._redis_client = None
        matchmaking_scripts._match_script = None  # 위와 동일한 이유 — Script 객체도 옛 클라이언트를 들고 있다
        self.user1 = User.objects.create_user(username=f"mm1-{uuid.uuid4().hex[:6]}", password="pw12345")
        self.user2 = User.objects.create_user(username=f"mm2-{uuid.uuid4().hex[:6]}", password="pw12345")
        Profile.objects.create(user=self.user1)  # 기본 iron/0 — 둘 다 R=0, 같은 범위
        Profile.objects.create(user=self.user2)
        self.redis = redis.Redis(host="localhost", port=6379, decode_responses=True)

    def tearDown(self):
        self.redis.zrem(QUEUE_KEY, str(self.user1.id), str(self.user2.id))
        self.redis.hdel(QUEUED_AT_KEY, str(self.user1.id), str(self.user2.id))

    async def _connect(self, user):
        communicator = WebsocketCommunicator(MatchmakingConsumer.as_asgi(), "/ws/matchmaking/")
        communicator.scope["user"] = user
        connected, _ = await communicator.connect()
        self.assertTrue(connected)
        return communicator

    async def test_two_queued_users_get_matched_into_ranked_room(self):
        comm1 = await self._connect(self.user1)
        joined1 = await comm1.receive_json_from(timeout=2)
        self.assertEqual(joined1["type"], "queue.joined")

        comm2 = await self._connect(self.user2)
        joined2 = await comm2.receive_json_from(timeout=2)
        self.assertEqual(joined2["type"], "queue.joined")

        # user2가 접속하자마자 대기 중이던 user1과 즉시 매칭 성사 — 둘 다 동일한 room
        # 코드를 담은 match.found를 받는다
        found1 = await comm1.receive_json_from(timeout=2)
        found2 = await comm2.receive_json_from(timeout=2)
        self.assertEqual(found1["type"], "match.found")
        self.assertEqual(found2["type"], "match.found")
        self.assertEqual(found1["code"], found2["code"])

        # 대기 화면에 상대 티어를 보여주기 위한 필드 — 둘 다 기본 iron/0 프로필이라
        # 서로에게 상대의(자기 자신이 아닌) 티어가 내려와야 한다
        self.assertEqual(found1["opponent_tier"], "iron")
        self.assertEqual(found1["opponent_tier_score"], 0)
        self.assertEqual(found2["opponent_tier"], "iron")
        self.assertEqual(found2["opponent_tier_score"], 0)

        room = await self._get_room(found1["code"])
        self.assertTrue(room.is_ranked)
        self.assertEqual({room.player1_id, room.player2_id}, {self.user1.id, self.user2.id})

        # 매칭 성사와 함께 서버가 양쪽 다 close() 하므로 큐에는 아무도 안 남아야 한다
        self.assertIsNone(self.redis.zscore(QUEUE_KEY, str(self.user1.id)))
        self.assertIsNone(self.redis.zscore(QUEUE_KEY, str(self.user2.id)))

        await comm1.disconnect()
        await comm2.disconnect()

    async def test_disconnect_before_match_leaves_queue(self):
        comm1 = await self._connect(self.user1)
        await comm1.receive_json_from(timeout=2)  # queue.joined

        await comm1.disconnect()

        self.assertIsNone(self.redis.zscore(QUEUE_KEY, str(self.user1.id)))

    @database_sync_to_async
    def _get_room(self, code):
        return Room.objects.get(code=code)


class GameResultRematchPersistenceTests(TransactionTestCase):
    """재대결로 같은 room에 여러 판이 쌓일 때 GameResult 저장이 올바른지 검증한다.

    started_at_ms가 판을 구분하는 idempotency key이므로(§6, models.GameResult 참고),
    (1) 판마다 새 행이 쌓이며 total_score가 누적이 아니라 역대 최고 기록으로 남는지,
    (2) 크래시 재시도로 같은 판(started_at_ms 동일)이 두 번 들어와도 중복 반영되지
        않는지를 확인한다.
    """

    def setUp(self):
        self.user1 = User.objects.create_user(username=f"p1-{uuid.uuid4().hex[:6]}", password="pw12345")
        self.user2 = User.objects.create_user(username=f"p2-{uuid.uuid4().hex[:6]}", password="pw12345")
        Profile.objects.create(user=self.user1)
        Profile.objects.create(user=self.user2)
        self.room = Room.objects.create(
            code=f"RM{uuid.uuid4().hex[:6].upper()}", player1=self.user1, player2=self.user2, status="playing"
        )
        self.consumer = GameConsumer()
        self.consumer.room_code = self.room.code

    async def _persist(self, started_at_ms, score1, score2, winner_id, is_ranked=False):
        await self.consumer._persist_game_result(
            self.room.id, started_at_ms, self.user1.id, self.user2.id, score1, score2, winner_id, is_ranked
        )

    @database_sync_to_async
    def _result_count(self):
        return GameResult.objects.filter(room_id=self.room.id).count()

    @database_sync_to_async
    def _total_score(self, user):
        return Profile.objects.get(user_id=user.id).total_score

    @database_sync_to_async
    def _tier_state(self, user):
        p = Profile.objects.get(user_id=user.id)
        return (p.tier, p.tier_score)

    async def test_ranked_game_applies_tier_delta_to_winner_and_loser(self):
        # 둘 다 기본 iron/0(동급전)이라 승/패는 정확히 ±20이어야 한다
        await self._persist(1_000, 500, -500, self.user1.id, is_ranked=True)

        self.assertEqual(await self._tier_state(self.user1), ("iron", 20))
        self.assertEqual(await self._tier_state(self.user2), ("iron", 0))  # 아이언 하한 고정(-20)

    async def test_friendly_game_does_not_touch_tier(self):
        await self._persist(1_000, 500, -500, self.user1.id, is_ranked=False)

        self.assertEqual(await self._tier_state(self.user1), ("iron", 0))
        self.assertEqual(await self._tier_state(self.user2), ("iron", 0))

    async def test_retrying_same_ranked_round_does_not_double_apply_tier(self):
        await self._persist(1_000, 500, -500, self.user1.id, is_ranked=True)
        # 크래시 후 같은 판 재시도를 흉내낸다 — get_or_create가 created=False라 스킵돼야 함
        await self._persist(1_000, 500, -500, self.user1.id, is_ranked=True)

        self.assertEqual(await self._tier_state(self.user1), ("iron", 20))

    async def test_rematch_rounds_create_separate_rows_and_keep_best_score(self):
        await self._persist(1_000, 500, -500, self.user1.id)
        await self._persist(2_000, 200, 900, self.user1.id)

        self.assertEqual(await self._result_count(), 2)
        # user1: 두 판 중 최고인 500이 남아야 한다(두 번째 판의 200으로 낮아지면 안 됨)
        self.assertEqual(await self._total_score(self.user1), 500)
        # user2: 두 판 중 최고인 900이 남아야 한다
        self.assertEqual(await self._total_score(self.user2), 900)

    async def test_retrying_same_round_does_not_double_count(self):
        await self._persist(1_000, 500, -500, self.user1.id)
        # 종료 처리 도중 크래시 후 다른 프로세스가 같은 판을 재시도하는 상황을 흉내낸다
        await self._persist(1_000, 500, -500, self.user1.id)

        self.assertEqual(await self._result_count(), 1)


class _FakeProfile:
    def __init__(self, tier_name, tier_score):
        self.tier = tier_name
        self.tier_score = tier_score


class TierFormulaTests(unittest.TestCase):
    def test_quantized_gap_within_threshold_is_zero(self):
        self.assertEqual(tier.quantized_gap(0), 0)
        self.assertEqual(tier.quantized_gap(20), 0)
        self.assertEqual(tier.quantized_gap(-20), 0)

    def test_quantized_gap_steps_by_20_beyond_threshold(self):
        self.assertEqual(tier.quantized_gap(21), 20)
        self.assertEqual(tier.quantized_gap(40), 20)
        self.assertEqual(tier.quantized_gap(41), 40)
        self.assertEqual(tier.quantized_gap(-41), -40)

    def test_expected_score_even_match_is_half(self):
        self.assertEqual(tier.expected_score(100, 100), 0.5)
        self.assertEqual(tier.expected_score(100, 110), 0.5)  # gap 10 <= 20 문턱

    def test_tier_delta_even_match_win_loss_are_exactly_20(self):
        self.assertEqual(tier.tier_delta(100, 100, 1), 20)
        self.assertEqual(tier.tier_delta(100, 100, 0), -20)
        self.assertEqual(tier.tier_delta(100, 100, 0.5), 0)

    def test_rating_combines_tier_index_and_score(self):
        self.assertEqual(tier.rating("iron", 0), 0)
        self.assertEqual(tier.rating("gold", 42), 342)
        self.assertEqual(tier.rating("challenger", 150), 750)

    def test_promotion_carries_over_excess(self):
        p = _FakeProfile("bronze", 95)
        tier.apply_tier_result(p, 20)  # 95+20=115
        self.assertEqual(p.tier, "silver")
        self.assertEqual(p.tier_score, 15)

    def test_demotion_borrows_100(self):
        p = _FakeProfile("gold", 10)
        tier.apply_tier_result(p, -35)  # 10-35=-25
        self.assertEqual(p.tier, "silver")
        self.assertEqual(p.tier_score, 75)

    def test_iron_floors_at_zero(self):
        p = _FakeProfile("iron", 5)
        tier.apply_tier_result(p, -40)
        self.assertEqual(p.tier, "iron")
        self.assertEqual(p.tier_score, 0)

    def test_challenger_has_no_promotion_ceiling(self):
        p = _FakeProfile("challenger", 90)
        tier.apply_tier_result(p, 40)  # 90+40=130, 승급 상한 없음
        self.assertEqual(p.tier, "challenger")
        self.assertEqual(p.tier_score, 130)

    def test_challenger_can_be_demoted(self):
        p = _FakeProfile("challenger", 10)
        tier.apply_tier_result(p, -30)  # 10-30=-20
        self.assertEqual(p.tier, "diamond")
        self.assertEqual(p.tier_score, 80)
