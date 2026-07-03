---
name: commit-format
description: 커밋 메시지 및 커밋 로그 형식 규칙 정의. SKILL.md에서 참조됨.
---

# 커밋 형식 규칙

---

## 1. 커밋 메시지 형식

```
<type>(<scope>): <subject>

Version: <version>

<body>

<footer>
```

---

### Type (필수)

| Type | 설명 | 예시 |
|------|------|------|
| `feat` | 새로운 기능 추가 | feat(worker): Add Systemd service support |
| `fix` | 버그 수정 | fix(api): Resolve timezone issue |
| `docs` | 문서 수정 | docs: Update deployment checklist |
| `style` | 코드 포맷팅 (기능 변경 없음) | style: Fix indentation |
| `refactor` | 코드 리팩토링 | refactor(processor): Extract methods |
| `perf` | 성능 개선 | perf(db): Optimize connection pool |
| `test` | 테스트 추가/수정 | test: Add validation tests |
| `chore` | 빌드, 설정 파일 수정 | chore: Update docker-compose |
| `ci` | CI/CD 설정 | ci: Add GitHub Actions workflow |

---

### Scope (선택)

| Scope | 설명 |
|-------|------|
| `api` | API 관련 |
| `worker` | Worker 관련 |
| `cli` | CLI 관련 |
| `config` | 설정 파일 관련 |
| `docs` | 문서 관련 |
| `ui` | UI/UX 관련 |

---

### Subject (필수)

- 50자 이내
- 마침표 없이
- 명령문으로 작성 (Add, Fix, Update 등)
- 첫 글자 대문자
- **영어로 작성**

---

### Body (필수)

**구조:**
1. 첫 줄: 변경 내용 한글 요약 (한 문장)
2. 빈 줄
3. 불릿 리스트: 상세 변경사항 (`-` 사용)

**규칙:**
- 72자 줄바꿈
- **한글로 작성**
- `##` 마크다운 헤딩 사용하지 않음

**예시:**
```
다중뷰 모드에서 뷰별 측정 데이터 표시 기능 구현

- view_data 타입 및 Store 상태 추가
- NativeViewer에 viewIndex prop 추가
- 다중뷰 전용 오버레이 컴포넌트 신규 구현
```

---

### Version (권장)

- `VERSION` 파일 참조 우선
- 형식: `vX.Y.Z`
- 예시: `Version: v1.0.0`

---

### Footer (선택)

```
Refs: #48, #49
Breaking Change: API endpoint changed
```

**금지 사항:**
- `Generated with [Claude Code]` 문구 사용 금지
- `Co-Authored-By:` 문구 사용 금지

---

### 언어 규칙

| 항목 | 언어 |
|------|------|
| Subject (제목) | 영어 |
| Body (본문) | 한글 |
| Footer | 영어/한글 |

---

## 2. 커밋 로그 형식

### 파일 위치

`docs/git/commit-logs/`

### 파일명 형식

```
YYYY-MM-DD[-N]_[브랜치명]_[GitHub사용자명].md
```

| 요소 | 설명 | 예시 |
|------|------|------|
| `YYYY-MM-DD` | 커밋 날짜 | `2025-01-27` |
| `-N` | 같은 날짜 동일 브랜치 순번 (선택) | `-2`, `-3` |
| `브랜치명` | 브랜치 이름 (`/` → `-` 변환) | `feature-auth` |
| `GitHub사용자명` | `git config user.name` 값 | `vbody` |

---

### 로그 파일 구조 (7개 섹션)

```markdown
# 커밋 메시지 제목

## 1. 기본 정보

| 항목 | 내용 |
|------|------|
| 작성자 | (GitHub 사용자명) |
| 브랜치 | main |
| 날짜 | YYYY-MM-DD |
| 버전 | vX.Y.Z |

---

## 2. 커밋 메시지

(실제 커밋된 메시지 - git log -1로 확인)

---

## 3. 변경 파일

| 상태 | 파일 | 설명 |
|------|------|------|
| A/M/D/R | 파일경로 | 변경 내용 |

---

## 4. 변경 배경 및 결과

(Why: 왜 변경했는가)
(What: 무엇이 개선되었는가)

---

## 5. 중요 변경 사항

(개발자 관점 핵심 변경점)

---

## 6. 통계

| 항목 | 값 |
|------|-----|
| 변경 파일 수 | N |
| 추가 라인 | +N |
| 삭제 라인 | -N |

---

## 7. 요약

(비개발자용 - 기능/정책 변화, UX 영향 등을 기술 용어 없이 정리)
```

---

### 작성 원칙

**결과 중심으로 작성한다.** 세션 대화의 흐름이 아니라, "커밋 전 코드 대비 커밋 후 코드가 어떻게 달라졌는가"를 기준으로 기술한다. 세션에서 디버깅이나 시행착오가 많았더라도 과정에서 발생한 부수적 작업이 원래 의도를 덮지 않도록 주의.

### 각 섹션 작성 가이드

#### 4. 변경 배경 및 결과

- 어떤 문제 또는 요구사항이 존재했는지
- 해당 문제를 해결하기 위해 어떤 방향으로 변경했는지
- 변경 이후 시스템/UX에 어떤 변화가 발생했는지

**"무엇을 수정했는가"보다 "왜 수정했고, 무엇이 개선되었는가"에 초점**

#### 5. 중요 변경 사항

- 주요 로직 변경 사항
- 구조적 개선, 리팩토링, 성능/안정성 관련 변경
- 기존 동작과 달라진 부분

#### 7. 요약

- 기능 또는 정책이 어떻게 달라졌는지
- 사용자 경험(UX)이나 업무 흐름에 어떤 영향이 있는지
- 기술 용어 최소화, 모든 팀원이 이해할 수 있게 작성
