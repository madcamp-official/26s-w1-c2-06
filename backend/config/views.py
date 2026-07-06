from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotFound

FRONTEND_INDEX = Path(settings.BASE_DIR).parent / 'frontend' / 'codebee-frontend' / 'dist' / 'index.html'


def spa_index(request):
    """npm run build 산출물의 index.html을 그대로 서빙 — client-side 라우팅(react-router-dom)이
    새로고침/딥링크에서도 동작하도록 api/admin/static을 제외한 모든 경로를 여기로 받는다."""
    try:
        return HttpResponse(FRONTEND_INDEX.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return HttpResponseNotFound('프론트엔드 빌드가 없습니다 — frontend/codebee-frontend에서 npm run build를 먼저 실행하세요.')
