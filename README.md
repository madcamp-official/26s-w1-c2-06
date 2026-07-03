# 26s-w1-c2-06

## 공통과제 I : 웹 기반 프로젝트 (2인 1팀)

**목적:** 공통 과제를 함께 수행하며 웹 개발의 전체 흐름을 빠르게 익히고 협업에 적응하기

**결과물:** 기획부터 배포까지 완료된 웹 서비스와 관련 문서 일체

---

## 팀원

| 이름 | GitHub | 역할 |
|---|---|---|
| 박서윤 | [banunas](https://github.com/banunas) |  |
| 김도현 | [dotori235](https://github.com/dotori235) |  |

---

## 기획안

> 프로젝트 주제, 목적, 핵심 기능, 예상 사용자, 팀원별 역할 등 정리

- **주제:** 2인 실시간 대전 타이핑 게임 "코드비" — 화면에 낙하하는 코드 스니펫을 보고 빠르게 타이핑해 맞히는 웹 게임
- **목적:** 방(room)에 입장한 두 유저가 동일한 화면을 실시간으로 공유하며 경쟁하는 서비스를 통해, WebSocket 기반 실시간 동기화와 동시성 제어(레이스 컨디션 방지)를 직접 설계·구현해본다
- **핵심 기능:**
  - 화면에 코드 텍스트가 무작위로 스폰되어 위에서 아래로 낙하, 바닥에 닿으면 자동 소멸
  - 유저가 텍스트를 입력 후 Enter로 제출 → 낙하 중인 코드와 완전히 일치하면 판정 (정답 +500 / 오답 -500 / 불일치 0점)
  - 매칭된 코드는 두 유저 화면에서 동시에 즉시 제거되어 실시간 반영
  - Redis 원자 연산 기반으로 동시 제출 시에도 한 명만 점수를 획득하도록 레이스 컨디션 방지
- **예상 사용자:** 같은 방에서 실시간으로 함께 게임을 즐기고 싶은 2인 (친구, 스터디 메이트 등)

---

## 기능 명세서

> 구현할 기능을 사용자 관점에서 정리하고, 필수 기능과 선택 기능을 구분

전체 아키텍처 설계는 [docs/architecture.md](./docs/architecture.md) 참고

### 필수 기능

- [ ]

### 선택 기능

- [ ]

---

## IA 및 화면 설계서

> 서비스의 전체 페이지 구조와 페이지 간 이동 흐름; 각 페이지의 주요 UI 구성, 입력 요소, 버튼, 사용자 행동 흐름 등을 간단한 와이어프레임 형태로 정리

<!-- Figma 링크 또는 이미지 첨부 -->

---

## DB 스키마

> 필요한 테이블, 주요 필드, 데이터 타입, 테이블 간 관계를 정리

낙하 중인 코드, 선점 상태, 진행 중 점수처럼 계속 바뀌는 상태는 DB가 아니라 Redis가 담당하고([docs/architecture.md](./docs/architecture.md) §6), 아래는 **영속 데이터만** 담는 스키마 초안이다.

```mermaid
erDiagram
    USER ||--o| PROFILE : has
    USER ||--o{ ROOM : "player1 / player2"
    USER ||--o{ GAMERESULT : submits
    ROOM ||--o{ GAMERESULT : produces

    USER {
        int id PK
        string username
        string email
    }
    PROFILE {
        int id PK
        int user_id FK
        int total_score
    }
    ROOM {
        int id PK
        string code UK
        string status
        int player1_id FK
        int player2_id FK
        datetime created_at
        datetime started_at
        datetime ended_at
    }
    GAMERESULT {
        int id PK
        int room_id FK
        int user_id FK
        int score
        datetime ended_at
    }
    CODESNIPPET {
        int id PK
        string text
        bool is_correct
        datetime created_at
    }
```

### 테이블 정의

| 테이블 | 필드 | 타입 | 설명 |
|---|---|---|---|
| **User** | (Django 기본 `auth.User`) | - | 로그인 계정 |
| **Profile** | user | OneToOne → User | |
| | total_score | int, default 0 | 지금까지 치른 모든 판을 합산한 누적 점수 |
| **Room** | code | string, unique | 초대/입장 코드 |
| | status | string (`waiting`/`playing`/`finished`) | 방 상태 |
| | player1, player2 | FK → User, null 허용 | 입장 순서대로 채워짐 |
| | created_at | datetime | 방 생성 시각 |
| | started_at | datetime, null 허용 | 두 유저가 다 들어와 게임이 시작된 시각 (Redis `game_started_at`과 동일 값을 영속화) |
| | ended_at | datetime, null 허용 | 60초 경과 후 종료 처리가 끝난 시각 |
| **GameResult** | room | FK → Room | |
| | user | FK → User | |
| | score | int | 이번 한 판의 최종 점수 (+500/-500 누적) |
| | ended_at | datetime, auto_now_add | 기록 생성 시각 |
| **CodeSnippet** | text | string | 화면에 낙하시킬 코드 텍스트 |
| | is_correct | bool | 정답 코드 여부 |
| | created_at | datetime | |

### 관계 및 제약

- `Room.player1`/`player2`는 입장 시점에 채워지는 **누가 이 방에 있는지에 대한 유일한 영속 기록**이다. 게임 진행 중 실제 낙하/점수 상태는 Redis가 갖고 있고(architecture.md §6), Room 레코드는 재접속 시 "이 유저가 이 방에 들어올 자격이 있는가"를 DB로 검증하는 용도로 쓴다.
- `GameResult(room, user)`에 **unique 제약**을 걸어, 같은 방·같은 유저에 대해 최종 점수가 두 번 기록되지 않게 한다 (architecture.md §8-1의 크래시 재시도 시나리오 대비).
- `CodeSnippet`은 특정 Room에 종속되지 않는 **전역 풀**이다. 어떤 스니펫이 어느 방에서 스폰됐는지는 Redis(`used_snippet_ids:{room}`)에서만 휘발성으로 관리하고 DB엔 남기지 않는다.
- `Profile.total_score`는 `GameResult`가 새로 생성될 때만(재시도로 인한 중복 생성이 아닐 때만) `F("total_score") + score`로 원자 증가한다 (architecture.md §8-1).

---

## API 문서

> API 주소, 요청 방식, 요청값, 응답값, 에러 상황을 정리

| Method | Endpoint | 설명 | 요청 | 응답 |
|---|---|---|---|---|
|  |  |  |  |  |

---

## 배포 결과물

> 접속 가능한 링크, 실행 방법, 주요 구현 내용

- **서비스 URL:**
- **실행 방법:**

```bash
# 실행 방법 작성
```

---

## 회고 문서

> 개발 과정에서의 어려움, 해결 방법, 역할 분담, 다음에 개선할 점 (KPT 방법론 참고)

### Keep

### Problem

### Try

---

## 참고 자료

- [SDD(스펙 주도 개발) 이해하기](https://news.hada.io/topic?id=21338)
- [Software Design Document Best Practices](https://www.atlassian.com/work-management/project-management/design-document)
- [IA 정보구조도 작성 방법](https://brunch.co.kr/@nyonyo/7)
- [기획자 화면설계서 작성법](https://brunch.co.kr/@soup/10)
- [Figma 와이어프레임 가이드](https://www.figma.com/ko-kr/resource-library/what-is-wireframing/)
- [무료 Figma 와이어프레임 키트](https://www.figma.com/ko-kr/templates/wireframe-kits/)
- [ERD/DB 설계 총정리](https://inpa.tistory.com/entry/DB-%F0%9F%93%9A-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EB%AA%A8%EB%8D%B8%EB%A7%81-%EA%B0%9C%EB%85%90-ERD-%EB%8B%A4%EC%9D%B4%EC%96%B4%EA%B7%B8%EB%9E%A8)
- [API 명세서 작성 가이드라인](https://velog.io/@sebinChu/BackEnd-API-%EB%AA%85%EC%84%B8%EC%84%9C-%EC%9E%91%EC%84%B1-%EA%B0%80%EC%9D%B4%EB%93%9C-%EB%9D%BC%EC%9D%B8)
- [좋은 README 작성하는 방법](https://velog.io/@sabo/good-readme)
- [단기 프로젝트 회고 KPT 방법론](https://velog.io/@habwa/%EB%8B%A8%EA%B8%B0-%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8-%ED%9A%8C%EA%B3%A0-KPT-%EB%B0%A9%EB%B2%95%EB%A1%A0)
