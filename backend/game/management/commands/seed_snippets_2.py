from django.core.management.base import BaseCommand

from game.models import CodeSnippet

# seed_snippets.py 이후 추가하는 두 번째 배치 (정답, 오답) 쌍.
# 기존 SNIPPET_PAIRS와 텍스트가 겹치면 unique 제약 + ignore_conflicts로 어차피
# 무시되지만, 배치를 별도 파일/커맨드로 나눠서 어떤 걸 언제 추가했는지 추적하기
# 쉽게 하고 seed_snippets.py 원본은 건드리지 않는다.
SNIPPET_PAIRS = [
    ("nums = [x for x in items]", "nums = [x for x items]"),
    ("pairs = {k: v for k, v in d.items()}", "pairs = {k: v for k v in d.items()}"),
    ("s = {1, 2, 3}", "s = {1, 2, 3]"),
    ("x if cond else y", "x if cond y"),
    ("if (n := len(a)) > 0:", "if (n = len(a)) > 0:"),
    ("@staticmethod", "@statimethod"),
    ("@classmethod", "@classmethd"),
    ("@property", "@propery"),
    ("@dataclass", "@datclass"),
    ("def f(x: int) -> int:", "def f(x: int) - int:"),
    ("def f(*args):", "def f(*args)"),
    ("def f(**kwargs):", "def f(**kwargs)"),
    ("def f(x=1):", "def f(x=1)"),
    ("for i, v in enumerate(nums):", "for i, v enumerate(nums):"),
    ("for a, b in zip(x, y):", "for a, b in zip(x, y)"),
    ("nums[1:3]", "nums[1:3"),
    ("nums[-1]", "nums[-1)"),
    ("first, *rest = nums", "first *rest = nums"),
    ("','.join(items)", "','.join(items"),
    ("'{}'.format(x)", "'{}'.formt(x)"),
    ("global counter", "global counter:"),
    ("nonlocal total", "nonlocal total;"),
    ("del nums[0]", "del nums[0"),
    ("x not in nums", "x not nums"),
    ("x is None", "x iss None"),
    ("0 < x < 10", "0 < x < 10:"),
    ("except (TypeError, ValueError):", "except (TypeError, ValueError)"),
    ("raise ValueError from e", "raise ValueError form e"),
    ("with a, b:", "with a b:"),
    ("match x:", "match x"),
    ("case 1:", "case 1"),
    ("from abc import ABC", "form abc import ABC"),
    ("from enum import Enum", "from enum imprt Enum"),
    ("json.loads(s)", "json.loads(s"),
    ("json.dumps(d)", "json.dumps(d"),
    ("open('f', 'r')", "open('f', 'r'"),
    ("os.path.join(a, b)", "os.path.join(a, b"),
    ("nums.sort(key=len)", "nums.sort(key=len"),
    ("max(nums, key=abs)", "max(nums, key=abs"),
    ("min(nums)", "min(nums"),
    ("sum(nums)", "sum(nums"),
    ("any(nums)", "any(nums"),
    ("all(nums)", "all(nums"),
    ("round(x, 2)", "round(x, 2"),
    ("abs(-x)", "abs(-x"),
    ("str(x)", "str(x"),
    ("int('5')", "int('5'"),
    ("float('1.5')", "float('1.5'"),
]


class Command(BaseCommand):
    help = "CodeSnippet 정답/오답 시드 데이터 두 번째 배치를 넣는다 (재실행해도 안전, 중복은 무시)"

    def handle(self, *args, **options):
        objs = []
        for correct, incorrect in SNIPPET_PAIRS:
            objs.append(CodeSnippet(text=correct, is_correct=True))
            objs.append(CodeSnippet(text=incorrect, is_correct=False))

        before = CodeSnippet.objects.count()
        CodeSnippet.objects.bulk_create(objs, ignore_conflicts=True)
        after = CodeSnippet.objects.count()

        self.stdout.write(self.style.SUCCESS(
            f"{after - before}개 신규 추가 (이미 있던 중복 {len(objs) - (after - before)}개는 건너뜀). "
            f"현재 CodeSnippet 총 개수: {after}"
        ))
