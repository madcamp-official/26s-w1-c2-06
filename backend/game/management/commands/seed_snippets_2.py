from django.core.management.base import BaseCommand

from game.models import CodeSnippet

# (정답 코드, 오답 코드) 쌍 — 연습모드 전용 풀(pool="practice").
# seed_snippets.py(실전 풀)와 문법 범위가 겹치지 않게 컴프리헨션/데코레이터/타입힌트 등
# 조금 더 다양한 패턴 위주로 구성했다. 텍스트는 전부 서로 달라야 한다 (CodeSnippet.text
# unique 제약, seed_snippets.py의 실전 풀과도 겹치면 안 됨).
SNIPPET_PAIRS = [
    ("nums2 = [v * 2 for v in nums]", "nums2 = [v * 2 for v nums]"),
    ("evens = [v for v in nums if v % 2 == 0]", "evens = [v for v if v % 2 == 0]"),
    ("squares = {v: v**2 for v in nums}", "squares = {v: v**2 for v nums}"),
    ("uniq = {v for v in nums}", "uniq = {v for v nums}"),
    ("gen = (v for v in nums)", "gen = (v for v nums)"),
    ("count if count else 0", "count if count else"),
    ("@property", "@propety"),
    ("@staticmethod", "@staticmehod"),
    ("@classmethod", "@classmehod"),
    ("@dataclass", "@dataclas"),
    ("def greet(name: str) -> str:", "def greet(name: str) - str:"),
    ("def add(*args):", "def add(*args)"),
    ("def merge(**kwargs):", "def merge(**kwargs)"),
    ("def scale(x, factor=2):", "def scale(x, factor=2)"),
    ("f'{name} is here'", "f'{name is here}'"),
    ("f'{n:.2f}'", "f'{n:.2f'"),
    ("first, *rest = nums", "first *rest = nums"),
    ("*init, last = nums", "*init last = nums"),
    ("x, (y, z) = 1, (2, 3)", "x, (y z) = 1, (2, 3)"),
    ("with open('f') as fh:", "with open('f') as fh"),
    ("with a, b:", "with a b:"),
    ("match cmd:", "match cmd"),
    ("case 'start':", "case 'start'"),
    ("case _:", "case _"),
    ("if (total := sum(nums)) > 0:", "if (total = sum(nums)) > 0:"),
    ("for i, v in enumerate(nums):", "for i, v enumerate(nums):"),
    ("for x, y in zip(a, b):", "for x, y in zip(a, b)"),
    ("nums[::2]", "nums[::2"),
    ("nums[1:-1]", "nums[1:-1)"),
    ("sorted(nums, key=abs)", "sorted(nums, key=abs"),
    ("max(nums, key=len)", "max(nums, key=len"),
    ("min(nums, default=0)", "min(nums, default=0"),
    ("any(v > 0 for v in nums)", "any(v > 0 for v nums)"),
    ("all(v > 0 for v in nums)", "all(v > 0 for v nums)"),
    ("from abc import ABC", "form abc import ABC"),
    ("from enum import Enum", "form enum import Enum"),
    ("from pathlib import Path", "form pathlib import Path"),
    ("from typing import Optional", "form typing import Optional"),
    ("json.dumps(data)", "json.dumps(data"),
    ("json.loads(raw)", "json.loads(raw"),
    ("Path('f').exists()", "Path('f').exsits()"),
    ("Optional[int] | None", "Optional[int] | Nonee"),
    ("isinstance(x, (int, float))", "isinstance(x, (int, float)"),
    ("super().__init__(name)", "super().__init(name)"),
    ("raise ValueError from exc", "raise ValueError form exc"),
    ("except (KeyError, TypeError):", "except (KeyError, TypeError)"),
    ("async with lock:", "async with lock"),
    ("async for item in stream:", "async for item stream:"),
    ("yield from gen", "yeild from gen"),
    ("nonlocal total", "nonlocal total;"),
]


class Command(BaseCommand):
    help = "CodeSnippet 정답/오답 시드 데이터(연습 풀)를 넣는다 (재실행해도 안전, 중복은 무시)"

    def handle(self, *args, **options):
        objs = []
        for correct, incorrect in SNIPPET_PAIRS:
            objs.append(CodeSnippet(text=correct, is_correct=True, pool="practice"))
            objs.append(CodeSnippet(text=incorrect, is_correct=False, pool="practice"))

        before = CodeSnippet.objects.count()
        CodeSnippet.objects.bulk_create(objs, ignore_conflicts=True)
        after = CodeSnippet.objects.count()

        self.stdout.write(self.style.SUCCESS(
            f"{after - before}개 신규 추가 (이미 있던 중복 {len(objs) - (after - before)}개는 건너뜀). "
            f"현재 CodeSnippet 총 개수: {after}"
        ))
