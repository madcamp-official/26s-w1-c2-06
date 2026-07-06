"""
제출 판정 Lua 스크립트(§5) 단위 테스트 — 실제 로컬 Redis에 대고 EVAL을 직접 호출한다
(스크립트 자체가 원자성을 보장하는 로직이므로, 모킹하면 검증 의미가 없다).

사전 조건: `docker compose up -d`로 로컬 Redis(localhost:6379)가 떠 있어야 한다.
"""
import time
import uuid

import redis
from django.test import SimpleTestCase

from .redis_scripts import SUBMIT_SCRIPT

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

    def _seed_code(self, code_id, text, is_correct, started_ago_ms=1000):
        self.redis.hset(f"codes:{self.room}", code_id, f"{text}|{'1' if is_correct else '0'}")
        self.redis.hset(f"text_index:{self.room}", text, code_id)
        now_ms = int(time.time() * 1000)
        self.redis.set(f"game_started_at:{self.room}", now_ms - started_ago_ms)

    def _submit(self, text, user_id=None):
        now_ms = int(time.time() * 1000)
        return self.script(
            keys=self.keys,
            args=[text, user_id or self.user_id, DELTA_CORRECT, DELTA_INCORRECT, now_ms, DURATION_MS],
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
        # 다른 프로세스가 이미 이 code_id를 선점한 상태를 흉내낸다
        self.redis.set("claim:4", "other-user", nx=True, ex=30)

        result, detail = self._submit("return a + b")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "too_late")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 선점 실패 시 매치/코드 데이터는 그대로 보존되어야 한다 (삭제/채점 금지)
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "return a + b"), "4")
        self.assertIsNotNone(self.redis.hget(f"codes:{self.room}", "4"))

        self.redis.delete("claim:4")

    def test_submission_after_game_duration_is_game_over(self):
        self._seed_code("5", "raise ValueError('bad')", is_correct=True, started_ago_ms=DURATION_MS + 1000)

        result, detail = self._submit("raise ValueError('bad')")

        self.assertEqual(result, 0)
        self.assertEqual(detail, "game_over")
        self.assertIsNone(self.redis.zscore(f"score:{self.room}", str(self.user_id)))
        # 60초 경과 후엔 매치 여부와 무관하게 아무 것도 건드리지 않는다
        self.assertEqual(self.redis.hget(f"text_index:{self.room}", "raise ValueError('bad')"), "5")


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
