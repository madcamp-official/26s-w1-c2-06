from django.urls import path

from . import views

urlpatterns = [
    path("csrf/", views.csrf),
    path("signup/", views.signup),
    path("login/", views.login_view),
    path("logout/", views.logout_view),
    path("me/", views.me),
    path("rooms/", views.create_room),
    path("rooms/<str:code>/", views.room_detail),
    path("rooms/<str:code>/join/", views.join_room),
]
