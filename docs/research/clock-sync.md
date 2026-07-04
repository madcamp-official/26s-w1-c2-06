# 리서치: 두 유저가 "완전히 동일한 화면"을 보게 하려면

## 배경

[docs/plan/architecture.md](../plan/architecture.md) §5는 낙하 애니메이션을 다음과 같이 계산한다고 되어 있다.

> 낙하 애니메이션은 프로세스가 보낸 절대 타임스탬프(`spawn_ts`)와 고정 낙하 시간을 기준으로 각 클라이언트가 독립적으로 계산 (`(now - spawn_ts) / fall_duration`) → 네트워크 지연 몇십 ms 차이는 시각적으로 무시 가능

이 문장은 오차 요인을 "네트워크 전달 지연" 하나만 고려하고 있다. 실제로는 그보다 큰 오차 요인이 하나 더 있다: **클라이언트 로컬 시계와 서버 시계 사이의 어긋남(clock skew)**. 두 유저의 OS 시계가 몇 초씩 어긋나 있으면, 공식의 `now`가 서로 다른 기준으로 계산되어 "몇십 ms"가 아니라 훨씬 큰 시각적 불일치가 생길 수 있다. 즉 지금 문장은 클라이언트 시계가 우연히 서버와 맞아떨어질 때만 참이다.

## 조사한 방법 3가지

### 방법 1 — 클럭 오프셋 보정 (NTP 방식)

접속 시 클라이언트가 서버와 핑퐁을 몇 번 주고받아 `offset = server_time - client_time`을 추정하고, 이후 계산에 `now + offset`을 사용한다 (`(now + offset - spawn_ts) / fall_duration`).

- **장점**: 프로토콜/아키텍처 변경 없이 접속 초기 보정 로직 하나만 추가하면 됨. 지금 설계를 거의 그대로 유지
- **효과**: 가장 큰 오차 요인(클라이언트 시계 어긋남)을 제거 → 문서에 적힌 "네트워크 지연 몇십 ms만 남음"이 실제로 참이 되게 만듦
- **비용**: 낮음 — 접속 시 RTT 측정 로직만 추가

### 방법 2 — 서버 권위 스냅샷 브로드캐스트 + 보간 (Snapshot Interpolation)

클라이언트가 각자 계산하지 않고, 서버(스폰 틱 담당 프로세스)가 주기적으로(예: 50~100ms마다) 낙하 중인 코드들의 실제 y좌표를 계산해 `group_send`로 뿌린다. 클라이언트는 최근 받은 두 스냅샷 사이를 보간해서 렌더링한다.

- **장점**: 오차가 클라이언트 시계와 완전히 무관해짐 — "브로드캐스트 주기 + 그 순간 네트워크 지터"로만 좁혀짐. Source 엔진 등 실제 멀티플레이어 게임의 표준 기법
- **비용**: 높음 — Redis/네트워크 트래픽 증가(스폰 이벤트 1번 대신 초당 10~20회 위치 브로드캐스트), 클라이언트 렌더링에 보간 버퍼 필요

### 방법 3 — 결정론적 락스텝 (Deterministic Lockstep)

두 클라이언트가 같은 틱 번호에서 동일한 시뮬레이션을 돌리고, 서로의 입력을 다 받아야 다음 틱으로 진행한다. StarCraft/Age of Empires 같은 RTS에서 쓰는 방식.

- **장점**: 비트 단위로 완전히 동일한 상태 보장
- **단점**: 상대방 핑이 느리면 그 순간 모두가 멈춤(입력 반영이 지연됨) — "누가 먼저 Enter를 쳤는가"가 중요한 이 게임엔 부적합

## 결론 — 방법 1 채택

**클럭 오프셋 보정(방법 1)을 채택한다.**

- 이 게임은 60초짜리 캐주얼 미니게임이고 개발 기간이 짧다 — 방법 2(서버 스냅샷 브로드캐스트)나 방법 3(락스텝)의 구현/트래픽 비용을 들일 규모가 아니다
- 방법 1은 지금 설계(§5의 타임스탬프 기반 클라이언트 독립 계산)를 그대로 유지하면서, 실제로 문제가 되는 오차 요인(클라이언트 시계 어긋남)만 제거한다 — 비용 대비 효과가 가장 좋음
- 단, **"완전히 동일한 화면"은 엄밀히는 불가능하다**는 전제는 남는다 — 두 클라이언트가 물리적으로 떨어져 있는 한 정보 전달엔 항상 시간이 걸리고, 어떤 기법을 써도 이 지연을 없앨 수는 없고 줄일 수만 있다. 방법 1은 그 오차를 "몇십 ms 수준(네트워크 지연)"까지 줄이는 것이지 "0"으로 만드는 게 아니다

### 반영 필요 사항

- 접속(WebSocket 연결) 시 클라이언트-서버 간 RTT 측정 및 `offset` 계산 로직을 클라이언트/백엔드 양쪽에 추가해야 함 — [docs/plan/backend-implementation.md](../plan/backend-implementation.md)에 반영 필요
- [docs/plan/architecture.md](../plan/architecture.md) §5의 "네트워크 지연 몇십 ms 차이는 시각적으로 무시 가능"이라는 문장 앞에 "클럭 오프셋 보정을 전제로" 같은 조건을 명시해야 함

## 참고 자료

- [Netcode Architectures Part 3: Snapshot Interpolation | SnapNet](https://snapnet.dev/blog/netcode-architectures-part-3-snapshot-interpolation/)
- [Source Multiplayer Networking - Valve Developer Community](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
- [Deterministic Lockstep | Gaffer On Games](https://gafferongames.com/post/deterministic_lockstep/)
- [Netcode Architectures Part 1: Lockstep | SnapNet](https://www.snapnet.dev/blog/netcode-architectures-part-1-lockstep/)
