# 리서치: 웹소켓 + Redis + Postgres 구조에 가장 저렴하고 합리적인 배포처

## 배경

[docs/plan/architecture.md](../plan/architecture.md) §3은 AWS EC2(VM 한 대) + Docker(Postgres·Redis) + systemd(Django Channels 워커) 구조를 전제로 하고 있다. 이 프로젝트가 **1주 내외의 짧은 기간, 소규모 트래픽(데모용)** 프로젝트라는 걸 감안했을 때, AWS EC2가 정말 최선인지 다른 배포처와 비교해봤다.

## 요구사항 (이 구조가 배포처에 요구하는 것)

- **상시 연결 유지되는 WebSocket(ASGI) 프로세스 실행 가능** — Vercel Functions 같은 서버리스/엣지 함수 방식은 실행시간 제한 때문에 부적합. Django Channels 워커가 계속 떠 있어야 함
- **Redis 실행 가능** — `SET NX`, Lua 스크립트, pub/sub 채널 레이어에 씀 (셀프호스팅 또는 매니지드 둘 다 가능)
- **Postgres 실행 가능**
- **비용** — 1주짜리 학생 프로젝트 데모 수준 트래픽 기준

## 비교

| 플랫폼 | 방식 | WS 지원 | Redis | Postgres | 예상 월 비용 | 비고 |
|---|---|---|---|---|---|---|
| **AWS EC2** (t4g.micro) | VM 직접 관리 | O (그냥 프로세스) | 직접 설치 (Docker) | 직접 설치 (Docker) | 신규 계정 12개월 무료(750h/월), 이후 ~$6-8 | 무료 기간 끝나면 자동 과금, 데이터 전송료·EBS 스냅샷 등 부가 비용으로 "서프라이즈 청구서" 위험 있음 |
| **Hetzner Cloud** (CX22) | VM 직접 관리 | O | 직접 설치 (Docker) | 직접 설치 (Docker) | €4.50~5.49 (~$5-6) | 지금 §3 설계(Docker+systemd) **그대로 재사용 가능**. 트래픽 20TB 포함, 요금 단순·고정. EU 리전 위주라 한국 기준 레이턴시는 약간 있음(이 게임엔 문제 없는 수준) |
| **DigitalOcean Droplet** | VM 직접 관리 | O | 직접 설치 (Docker) | 직접 설치 (Docker) | $4~ (초당 과금) | Hetzner와 동일한 접근, 싱가포르 등 아시아 리전 있어 레이턴시 유리할 수 있음 |
| **Render** | PaaS (무료 티어) | O (Free는 15분 미사용 시 슬립) | Key Value 무료 티어 25MB/50커넥션, **비영속**(재시작 시 소멸) | 무료 티어, **30일 후 만료** | **$0** | 데모 트래픽엔 충분하지만, 발표 직전 "깨우기"(슬립 후 재기동 ~1분) 필요. Redis가 비영속이어도 이 게임은 원래 라운드 끝나면 키를 지우는 구조라 큰 문제 없음. 30일 만료는 2주 프로젝트엔 여유 있음 |
| **Railway** | PaaS (사용량 과금) | O | 플러그인 제공 | 플러그인 제공 | 실사용 시 대략 $15~40 (Redis+워커 추가 시 $40~60까지) | 배포 편의성(깃 푸시 배포, 대시보드)은 최고지만 위 옵션들보다 비쌈 |
| **Fly.io** | Pay-as-you-go | O (엣지 배포 강점) | 자체 미제공 (Upstash 연동 필요) | 자체 매니지드 소규모 $2~5 | 최소 인스턴스 ~$1.94부터 | 신규 가입 무료체험 사실상 없음(2시간/7일). 실사용 기준이라 데모 규모엔 저렴하지만 Redis를 별도 서비스로 붙여야 해서 구성 요소가 하나 늘어남 |

## 결론 — 추천

**둘 중 하나를 추천한다. 둘 다 지금 §3 설계 변경이 거의 필요 없다.**

1. **비용을 아예 안 쓰고 싶다면 → Render 무료 티어.** Web service + Postgres + Redis(Key Value)를 전부 $0으로 띄울 수 있다. 단점(슬립, 30일 만료, 25MB Redis)은 2주짜리 데모 프로젝트 성격상 실질적으로 문제가 안 된다. 다만 **발표 직전엔 미리 한 번 접속해서 깨워둬야** 한다(콜드스타트 ~1분).
2. **상시 구동(콜드스타트 없이)을 원하고 월 5천~6천원 정도는 써도 된다면 → Hetzner Cloud (CX22, ~$5-6/월).** 지금 architecture.md/backend-implementation.md에 이미 적어둔 "Docker(Postgres·Redis) + systemd(Django)" 구조를 **한 글자도 안 바꾸고** VM 제공처만 EC2 → Hetzner로 바꾸면 끝난다.

**AWS EC2는 굳이 고를 이유가 약함** — 무료 기간은 매력적이지만 신규 계정에서만 적용되고, 끝난 뒤엔 Hetzner/DigitalOcean보다 비싸며 부가 비용(데이터 전송, 미연결 EIP 등)으로 예상 밖 청구서가 나올 위험이 학생 프로젝트엔 더 크다. 팀에 이미 AWS 크레딧(교육 프로그램 등)이 있는 경우가 아니라면 우선순위가 낮다.

## 결정 — Render 무료 티어

비용 $0이 최우선 순위라 **Render 무료 티어로 확정**했다. 캠프 측에서 도메인을 무료로 제공해 실제 배포 URL로 데모하게 됐지만, Render 무료 티어도 커스텀 도메인을 지원하므로(무료 2개까지) 이 결정에 영향을 주지 않는다. 콜드스타트(15분 미사용 시 슬립, 재기동 ~1분)는 발표 직전 미리 접속해 깨워두는 것으로 감수한다. [docs/plan/architecture.md](../plan/architecture.md) §3, [docs/plan/backend-implementation.md](../plan/backend-implementation.md) §1에 반영함.

## 참고 자료

- [Pricing | Railway Docs](https://docs.railway.com/pricing)
- [Pricing · Fly](https://fly.io/pricing/)
- [Pricing | Render](https://render.com/pricing)
- [Deploy for Free – Render Docs](https://render.com/docs/free)
- [Platforms with a real free tier for developers in 2026 - Render](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Hetzner Cloud VPS Pricing Calculator (Jul 2026)](https://costgoat.com/pricing/hetzner)
- [Droplet Pricing | DigitalOcean](https://www.digitalocean.com/pricing/droplets)
- [Redis Pricing - Upstash](https://upstash.com/pricing/redis)
- [Amazon EC2 T4g Instances - AWS](https://aws.amazon.com/ec2/instance-types/t4/)
