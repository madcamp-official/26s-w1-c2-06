from django.conf import settings
from django.db import models

User = settings.AUTH_USER_MODEL


class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    total_score = models.IntegerField(default=0)  # 전체 게임을 통틀은 누적 점수


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
    room = models.OneToOneField(Room, on_delete=models.CASCADE)  # 방(매치)당 결과 1행
    user1 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    user2 = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    score1 = models.IntegerField()  # user1의 이번 한 판 점수
    score2 = models.IntegerField()  # user2의 이번 한 판 점수
    winner = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="+"
    )  # null = 무승부
    ended_at = models.DateTimeField(auto_now_add=True)


class CodeSnippet(models.Model):
    text = models.CharField(max_length=255, unique=True)
    is_correct = models.BooleanField()
    created_at = models.DateTimeField(auto_now_add=True)
