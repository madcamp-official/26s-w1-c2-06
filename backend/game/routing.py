from django.urls import re_path

from . import consumers, matchmaking_consumer

websocket_urlpatterns = [
    re_path(r"^ws/room/(?P<code>\w+)/$", consumers.GameConsumer.as_asgi()),
    re_path(r"^ws/matchmaking/$", matchmaking_consumer.MatchmakingConsumer.as_asgi()),
]
