# feat(game): Add in-game screen, rematch, and leaderboard

## 1. 기본 정보

| 항목 | 내용 |
|------|------|
| 작성자 | dotori235 |
| 브랜치 | frontend_dh |
| 날짜 | 2026-07-06 |
| 버전 | v0.1.0 |

---

## 2. 커밋 메시지

```
feat(game): Add in-game screen, rematch, and leaderboard

Version: v0.1.0

인게임 화면과 낙하 코드 렌더링, 재대결, 결산 리더보드 기능을 구현함

- GameScreen 컴포넌트 신규 작성: 낙하 코드 렌더링, 타이머, 점수판,
  제출 폼, 클럭 오프셋 보정을 반영한 낙하 애니메이션
- LobbyPage에 WebSocket 이벤트 처리 추가: clock.sync, room.update,
  game.start, code.spawn, code.result, game.over, error
- 재대결(같은 방 유지) 기능 추가: rematch WS 메시지로 방을 waiting
  으로 리셋, GameResult가 방당 여러 판을 저장하도록 room을
  ForeignKey로 바꾸고 (room, started_at_ms)를 판 구분 키로 도입
- 결산화면에 전체 랭킹 표시: 0점 이하 제외, 상위 5명, 본인이 5위
  밖이면 별도로 순위/점수를 표시하는 /api/leaderboard/ 엔드포인트 추가
- Profile.total_score를 누적합에서 역대 한 판 최고 기록으로 변경
  (Greatest 사용)
- 백엔드 회귀 테스트 추가, 관련 설계 문서(backend-implementation.md,
  README.md)를 최신 스키마/정책에 맞게 동기화
```

---

## 3. 변경 파일

| 상태 | 파일 | 설명 |
|------|------|------|
| A | backend/game/migrations/0002_gameresult_started_at_ms_alter_gameresult_room_and_more.py | GameResult.room을 ForeignKey로, started_at_ms 필드/유니크 제약 추가 |
| M | backend/game/models.py | GameResult 스키마 변경, Profile.total_score 주석을 "역대 최고 기록"으로 정정 |
| M | backend/game/consumers.py | rematch 핸들러, 라운드 구분용 started_at_ms 처리, Greatest 기반 최고 기록 갱신 |
| M | backend/game/views.py | `/api/leaderboard/` 엔드포인트 추가(0점 이하 제외, 상위 5명, 본인 순위) |
| M | backend/game/urls.py | leaderboard 경로 등록 |
| M | backend/game/tests.py | 재대결 라운드 구분/멱등성/최고 기록 유지 회귀 테스트 추가 |
| A | frontend/codebee-frontend/src/components/GameScreen.tsx | 낙하 코드·타이머·점수판·제출 폼 인게임 화면 컴포넌트 신규 |
| A | frontend/codebee-frontend/src/components/GameScreen.css | 위 컴포넌트 스타일 |
| M | frontend/codebee-frontend/src/pages/LobbyPage.tsx | WebSocket 이벤트 처리, 재대결/리더보드 UI, 결산화면 확장 |
| M | frontend/codebee-frontend/src/pages/LobbyPage.css | 리더보드/결산화면 스타일 추가 |
| M | frontend/codebee-frontend/src/api/rooms.ts | getLeaderboard API 클라이언트 함수 추가 |
| M | frontend/codebee-frontend/src/types.ts | FallingCode, ScoreBoard, GameOverInfo, LeaderboardEntry 타입 추가 |
| M | docs/plan/backend-implementation.md | GameResult/Profile 스키마·정책 변경분 반영 |
| M | README.md | DB 스키마 문서, 선택 기능 체크리스트("재대결") 갱신 |

---

## 4. 변경 배경 및 결과

기존에는 방에 입장한 뒤 게임을 시작해도 실제로 낙하 코드를 보여주고 타이핑을 받는 화면이 없었고, 결산화면도 이번 판 점수만 보여줬다. 이번 변경으로 WebSocket 이벤트(`game.start`~`game.over`)를 받아 실제로 플레이할 수 있는 인게임 화면을 완성했다.

이어서 "게임을 다시 하려면 방을 나갔다 새로 만들어야 하는" 불편함을 없애기 위해 재대결 기능을 추가했는데, 이 과정에서 `GameResult`가 방(Room)당 정확히 1행만 가질 수 있던 기존 제약이 걸림돌이 됐다. 같은 방에서 여러 판을 치르면서도 판마다 결과를 남기고, 크래시 후 재시도해도 중복 기록되지 않아야 했기 때문에, `room`을 `ForeignKey`로 바꾸고 `(room, started_at_ms)` 조합을 판 구분 겸 idempotency key로 도입했다.

또한 결산화면에 전체 유저 랭킹을 보여달라는 요청에 따라 `/api/leaderboard/`를 신규 추가했는데, 테스트 중 "이번 판 점수(2000/-1000)와 리더보드 점수(1500/1500)가 다르다"는 보고가 있었다. 실제 DB를 확인한 결과 계산 자체는 정확했고(과거 여러 매치 점수를 합산한 값), `Profile.total_score`가 "누적 합"으로 설계돼 있어 생기는 당연한 결과였다. 이후 요구사항이 "누적이 아니라 한 판 최고 기록"으로 명확해져, `F() + score` 누적 방식을 `Greatest(total_score, score)` 방식으로 바꿨다.

결과적으로 실제 플레이 가능한 인게임 화면, 방을 유지한 채 반복 대결, 전체 랭킹 조회, "역대 최고 기록" 기준의 점수 체계까지 한 번에 갖추게 됐다.

---

## 5. 중요 변경 사항

- `GameResult.room`: `OneToOneField` → `ForeignKey` (재대결로 방당 여러 판 허용), `started_at_ms` 필드와 `(room, started_at_ms)` 유니크 제약 추가 — 마이그레이션 적용 완료, 기존 크래시 재시도 멱등성 로직은 이 새 키 기준으로 유지됨
- `Profile.total_score` 의미 변경: 전체 누적 합 → 역대 한 판 최고 기록(`Greatest` 사용). 기존 값보다 낮은 점수는 반영되지 않음
- 재대결은 방장만 트리거 가능(`room.status == "finished"`일 때만), 성공 시 `Room`을 `waiting`으로 리셋하고 같은 방 코드를 그대로 재사용
- 리더보드는 0점 이하 유저를 랭킹에서 제외하고 상위 5명만 반환하며, 요청 유저가 5위 밖이면 별도 필드(`me`)로 순위/점수를 함께 내려줌
- 클럭 오프셋 보정(§9)을 낙하 애니메이션 진행률 계산에 반영해 클라이언트 간 시계 차이로 인한 낙하 위치 오차를 줄임

---

## 6. 통계

| 항목 | 값 |
|------|-----|
| 변경 파일 수 | 14 |
| 추가 라인 | +766 |
| 삭제 라인 | -36 |

---

## 7. 요약

이제 방에서 "게임 시작"을 누르면 실제로 코드가 화면 위에서 떨어지고, 타이핑해서 맞히면 점수가 오르고, 60초가 지나면 결산화면에서 승패와 점수를 확인할 수 있다. 결산화면에서는 전체 유저 중 상위 5명의 점수 랭킹도 볼 수 있고, 방장이 "재대결" 버튼을 누르면 같은 방에서 바로 다시 붙을 수 있다. 각 유저의 랭킹 점수는 지금까지 친 판들의 합계가 아니라 "가장 잘했던 한 판의 점수"로 계산된다.
