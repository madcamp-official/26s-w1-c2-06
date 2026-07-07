"""
제출 판정 Lua 스크립트(§5) 단위 테스트 — 실제 로컬 Redis에 대고 EVAL을 직접 호출한다
(스크립트 자체가 원자성을 보장하는 로직이므로, 모킹하면 검증 의미가 없다).

사전 조건: `docker compose up -d`로 로컬 Redis(localhost:6379)가 떠 있어야 한다.
"""
import json
import time
import uuid

import redis
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TransactionTestCase

from .consumers import GameConsumer, compute_correct_score
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

    def _seed_code(self, code_id, text, is_correct, started_ago_ms=1000, code_age_ms=100, fall_duration_ms=9000):
        now_ms = int(time.time() * 1000)
        spawn_ts = now_ms - code_age_ms
        packed = "\x01".join([text, "1" if is_correct else "0", str(spawn_ts), str(fall_duration_ms)])
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

        result, detail = self._submit("print(x)")

        self.assertEqual(result, 1)
        self.assertEqual(detail, "1")
        self.assertEqual(self.redis.zscore(f"score:{self.room}", str(self.user_id)), DELTA_CORRECT)
        self.assertIsNone(self.redis.hget(f"text_index:{self.room}", "print(x)"))
        self.assertIsNone(self.redis.hget(f"codes:{self.room}", "1"))

    def test_incorrect_submission_scores_minus_500_and_removes_code(self):
        self._seed_code("2", "print(x", is_correct=False)

        result, detail = self._submit("print(x")

        self.assertEqual(result, -1)
        self.assertEqual(detail, "2")
        self.assertEqual(self.redis.zscore(f"score:{self.room}", str(self.user_id)), DELTA_INCORRECT)

    def test_text_not_on_screen_is_no_match(self):
        self._seed_code("3", "def f():", is_correct=True)

        result, detail = self._submit("이 텍스트는 화면에 없음")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "no_match")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 매치가 안 났으니 기존 코드는 그대로 남아 있어야 한다
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "def f():"), "3")

    def test_already_claimed_code_is_too_late_and_does_not_double_score(self):
        self._seed_code("4", "return a + b", is_correct=True)
        # 다른 프로세스가 이미 이 code_id를 선점한 상태를 흉내낸다 (claim은 room으로 스코프됨)
        claim_key = f"claim:{self.room}:4"
        self.redis.set(claim_key, "other-user", nx=True, ex=30)

        result, detail = self._submit("return a + b")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "too_late")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 선점 실패 시 매치/코드 데이터는 그대로 보존되어야 한다 (삭제/채점 금지)
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "return a + b"), "4")
        self.assertIsNotNone(self.redis.hget(f"codes:{self.room}", "4"))

        self.redis.delete(claim_key)

    def test_submission_after_game_duration_is_game_over(self):
        self._seed_code("5", "raise ValueError('bad')", is_correct=True, started_ago_ms=DURATION_MS + 1000)

        result, detail = self._submit("raise ValueError('bad')")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "game_over")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 60초 경과 후엔 매치 여부와 무관하게 아무 것도 건드리지 않는다
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "raise ValueError('bad')"), "5")

    def test_code_already_fallen_off_screen_does_not_score(self):
        # 이 코드의 개별 낙하 시간(fall_duration_ms)이 이미 지난 상태 — 화면에서는
        # 이미 사라진 코드인데 서버가 여전히 매칭해버리면 "화면에 없는 코드에 점수가
        # 오르는" 버그가 재현된다.
        self._seed_code("6", "def g():", is_correct=True, code_age_ms=10_000, fall_duration_ms=9000)

        result, detail = self._submit("def g():")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "expired")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 만료된 코드는 더 이상 매치되면 안 되므로 인덱스/코드 해시에서 함께 제거된다
        self.assertIsNone(self.redis.hget(f"text_index:{self.room}", "def g():"))
        self.assertIsNone(self.redis.hget(f"codes:{self.room}", "6"))


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

        # 호스트(user1)가 게임 시작 → 양쪽 다 game.start 브로드캐스트를 받는다
        await comm1.send_to(text_data=json.dumps({"type": "game.start"}))

        start1 = await comm1.receive_json_from(timeout=2)
        start2 = await comm2.receive_json_from(timeout=2)
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

        await comm1.disconnect()
        await comm2.disconnect()


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

    async def _persist(self, started_at_ms, score1, score2, winner_id):
        await self.consumer._persist_game_result(
            self.room.id, started_at_ms, self.user1.id, self.user2.id, score1, score2, winner_id
        )

    @database_sync_to_async
    def _result_count(self):
        return GameResult.objects.filter(room_id=self.room.id).count()

    @database_sync_to_async
    def _total_score(self, user):
        return Profile.objects.get(user_id=user.id).total_score

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
        self.assertEqual(await self._total_score(self.user1), 500)
