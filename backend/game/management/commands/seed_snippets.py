from django.core.management.base import BaseCommand

from game.models import CodeSnippet

# (정답 코드, 오답 코드) 쌍 — 실전(친선전/랭킹전) 전용 풀(pool="match").
# 오답은 문법 오류/오타/잘못된 연산자 등으로 만든다.
# 텍스트는 전부 서로 달라야 한다 (CodeSnippet.text unique 제약, seed_snippets_2.py의
# 연습 풀과도 겹치면 안 됨).
SNIPPET_PAIRS = [
    ("a = 5", "a = ="),
    ("b = 10", "b == 10"),
    ("print(a)", "print(a"),
    ("print('go')", "print('go)"),
    ("name = 'sam'", "name = 'sam\""),
    ("if a == 5:", "if a = 5:"),
    ("if b > 0:", "if b > 0"),
    ("if a != b:", "if a !== b:"),
    ("elif b < 0:", "elif b < 0"),
    ("while b > 0:", "while b > 0"),
    ("while True:", "while True"),
    ("for i in range(5):", "for i in range(5)"),
    ("for ch in name:", "for ch in name"),
    ("for k, v in d.items():", "for k v in d.items():"),
    ("def mul(a, b):", "def mul(a, b)"),
    ("def square(n):", "def square(n):return"),
    ("return a * b", "retrun a * b"),
    ("return", "retun"),
    ("import re", "improt re"),
    ("import json", "import jsno"),
    ("from datetime import date", "form datetime import date"),
    ("class Cat:", "clas Cat:"),
    ("class Bird(Animal):", "class Bird(Animal)"),
    ("self.age = age", "self.age = aeg"),
    ("try:", "tyr:"),
    ("except KeyError:", "except KeyError"),
    ("finally:", "finaly:"),
    ("raise TypeError('bad')", "rise TypeError('bad')"),
    ("assert b != 0", "asert b != 0"),
    ("nums = [4, 5, 6]", "nums = [4, 5, 6"),
    ("nums.pop()", "nums.pob()"),
    ("nums.remove(4)", "nums.remvoe(4)"),
    ("d2 = {'x': 1}", "d2 = {'x': 1"),
    ("d2.keys()", "d2.keys("),
    ("d2.values()", "d2.valuse()"),
    ("s2 = 'world'", "s2 = 'world"),
    ("s2.lower()", "s2.lwoer()"),
    ("s2.strip()", "s2.strip("),
    ("s2.replace('a', 'b')", "s2.replace('a' 'b')"),
    ("list(nums)", "list(nums"),
    ("tuple(nums)", "tupel(nums)"),
    ("b += 2", "b =+ 2"),
    ("b -= 2", "b =- 2"),
    ("b //= 2", "b =// 2"),
    ("c, d = d, c", "c, d = d c"),
    ("not b", "nott b"),
    ("a in nums", "a int nums"),
    ("a not in nums", "a nott in nums"),
    ("bool(a)", "bool(a"),
    ("type(a)", "tpye(a)"),
]


class Command(BaseCommand):
    help = "CodeSnippet 정답/오답 시드 데이터(실전 풀)를 넣는다 (재실행해도 안전, 중복은 무시)"

    def handle(self, *args, **options):
        objs = []
        for correct, incorrect in SNIPPET_PAIRS:
            objs.append(CodeSnippet(text=correct, is_correct=True, pool="match"))
            objs.append(CodeSnippet(text=incorrect, is_correct=False, pool="match"))

        before = CodeSnippet.objects.count()
        CodeSnippet.objects.bulk_create(objs, ignore_conflicts=True)
        after = CodeSnippet.objects.count()

        self.stdout.write(self.style.SUCCESS(
            f"{after - before}개 신규 추가 (이미 있던 중복 {len(objs) - (after - before)}개는 건너뜀). "
            f"현재 CodeSnippet 총 개수: {after}"
        ))
