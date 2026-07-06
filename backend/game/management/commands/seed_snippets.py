from django.core.management.base import BaseCommand

from game.models import CodeSnippet

# (정답 코드, 오답 코드) 쌍. 오답은 문법 오류/오타/잘못된 연산자 등으로 만든다.
# 텍스트는 전부 서로 달라야 한다 (CodeSnippet.text unique 제약).
SNIPPET_PAIRS = [
    ("x = 1", "x = ="),
    ("y = 2", "y == 2"),
    ("print(x)", "print(x"),
    ("print('hi')", "print('hi)"),
    ("if x == 1:", "if x = 1:"),
    ("if x > 0:", "if x > 0"),
    ("if x != y:", "if x !== y:"),
    ("while True:", "while True"),
    ("while x < 10:", "while x < 10)"),
    ("for i in range(10):", "for i in range(10)"),
    ("for i in items:", "for i in items"),
    ("def add(a, b):", "def add(a, b)"),
    ("def greet(name):", "def greet(name):return"),
    ("return a + b", "retrun a + b"),
    ("return None", "retun None"),
    ("import os", "improt os"),
    ("import sys", "import syss"),
    ("from math import sqrt", "form math import sqrt"),
    ("class Dog:", "clas Dog:"),
    ("class Cat(Animal):", "class Cat(Animal)"),
    ("self.name = name", "self.name = nam"),
    ("try:", "tyr:"),
    ("except ValueError:", "except ValueError"),
    ("finally:", "finaly:"),
    ("raise ValueError('bad')", "rise ValueError('bad')"),
    ("assert x > 0", "asert x > 0"),
    ("lambda x: x * 2", "lambda x: x * 2)"),
    ("nums = [1, 2, 3]", "nums = [1, 2, 3"),
    ("nums.append(4)", "nums.apend(4)"),
    ("d = {'a': 1}", "d = {'a': 1"),
    ("d.get('a')", "d.get('a'"),
    ("s = 'hello'", "s = 'hello"),
    ("s.upper()", "s.uper()"),
    ("s.split(',')", "s.split(','"),
    ("len(nums)", "len(nums"),
    ("range(0, 10, 2)", "range(0, 10, 2"),
    ("sorted(nums)", "sorted(nums"),
    ("x += 1", "x =+ 1"),
    ("x -= 1", "x =- 1"),
    ("x **= 2", "x =** 2"),
    ("a, b = b, a", "a, b = b a"),
    ("not x", "nott x"),
    ("x and y", "x adn y"),
    ("x or y", "x roo y"),
    ("None is not x", "None is nott x"),
    ("isinstance(x, int)", "isinstance(x, int"),
    ("super().__init__()", "super().__init()"),
    ("with open('f') as f:", "with open('f') as f"),
    ("yield x", "yeild x"),
    ("async def fetch():", "asnyc def fetch():"),
    ("await fetch()", "awiat fetch()"),
]


class Command(BaseCommand):
    help = "CodeSnippet 정답/오답 시드 데이터를 넣는다 (재실행해도 안전, 중복은 무시)"

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
