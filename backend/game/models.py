from django.conf import settings
from django.db import models

User = settings.AUTH_USER_MODEL


class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    total_score = models.IntegerField(default=0)  # 역대 한 판 최고 기록 (누적 아님)


class Room(models.Model):
    STATUS_CHOICES = [
        ("waiting", "waiting"),
        ("playing", "playing"),
        ("finished", "finished"),
    ]

    code = models.CharField(max_length=16, unique=True)  # 초대/입장 코드
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default="waiting")
    player1 = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    player2 = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True)  # Redis game_started_at을 영속화한 값
    ended_at = models.DateTimeField(null=True)


class GameResult(models.Model):
    # 재대결(같은 room 재사용)로 한 room에 여러 판이 쌓일 수 있어 ForeignKey로 둔다.
    room = models.ForeignKey(Room, on_delete=models.CASCADE, related_name="results")
    # 이 판의 game_started_at epoch ms — room 재사용 시 판을 구분하고, 종료 처리
    # 크래시 재시도의 idempotency key로 쓴다(room만으로는 더 이상 유일하지 않음).
    started_at_ms = models.BigIntegerField(default=0)
    user1 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    user2 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    score1 = models.IntegerField()  # user1의 이번 한 판 점수
    score2 = models.IntegerField()  # user2의 이번 한 판 점수
    winner = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="+"
    )  # null = 무승부
    ended_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["room", "started_at_ms"], name="unique_game_result_per_round"),
        ]


class CodeSnippet(models.Model):
    text = models.CharField(max_length=255, unique=True)
    is_correct = models.BooleanField()
    created_at = models.DateTimeField(auto_now_add=True)
