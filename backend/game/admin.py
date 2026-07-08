from django.contrib import admin

from .models import GameResult, Profile, Room

# 공정 플레이 방어 Layer 4 — Layer 3 로그(journalctl -u codebee | grep fairplay)로
# 의심 계정을 찾았을 때, 코드 추가 없이 여기서 바로 조치할 수 있게 등록해둔다.
# 계정 정지는 Django 기본 admin의 User 편집 화면에서 is_active 체크만 해제하면 됨
# (authenticate()가 자동으로 거부 — login_view 수정 불필요).
admin.site.register(Profile)
admin.site.register(Room)
admin.site.register(GameResult)
