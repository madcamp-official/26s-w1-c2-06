// 실제 음원 파일 없이 Web Audio API 오실레이터로 직접 합성한 8비트/칩튠 스타일
// 효과음·BGM — BeeIcon/TierIcon이 이미지 파일 대신 인라인 SVG로 그려지는 것과
// 같은 맥락. AudioContext는 브라우저 자동재생 정책상 실제 사용자 제스처(클릭/
// 키다운) 없이는 소리를 못 내므로, unlockAudio()를 그런 이벤트 핸들러 안에서
// 호출해야 한다(App.tsx의 전역 클릭 리스너 참고). suspended 상태에서는
// AudioContext의 currentTime 자체가 멈춰있어서, resume 전에 예약해둔 오실레이터도
// resume 시점부터 정확히 이어서 재생된다 — 유실되지 않는다.

const MUTE_KEY = 'codebee:muted';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let sfxGain: GainNode | null = null;
let bgmGain: GainNode | null = null;

function getContext(): { ctx: AudioContext; sfxGain: GainNode; bgmGain: GainNode } {
  if (!ctx) {
    ctx = new AudioContext();

    masterGain = ctx.createGain();
    masterGain.gain.value = isMuted() ? 0 : 1;
    masterGain.connect(ctx.destination);

    sfxGain = ctx.createGain();
    sfxGain.connect(masterGain);

    bgmGain = ctx.createGain();
    bgmGain.connect(masterGain);
  }
  return { ctx, sfxGain: sfxGain as GainNode, bgmGain: bgmGain as GainNode };
}

export function unlockAudio(): void {
  const { ctx } = getContext();
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // 저장 실패(프라이빗 모드 등)는 조용히 무시 — 이번 세션 동안만 적용된다
  }
  if (masterGain) masterGain.gain.value = muted ? 0 : 1;
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

interface ToneOptions {
  duration?: number; // 초
  type?: OscillatorType;
  volume?: number; // 0~1
  sweepTo?: number; // Hz — 있으면 freq에서 이 값으로 선형 스윕
  delay?: number; // 초 — 시작 지연
}

// 오실레이터 하나 + 짧은 attack/decay 엔벨로프로 "삑" 소리 하나를 만든다.
// 모든 효과음/BGM 노트가 이 함수 위에서 조합된다.
function playTone(freq: number, options: ToneOptions, destination: GainNode): void {
  const { ctx } = getContext();
  const { duration = 0.08, type = 'square', volume = 0.12, sweepTo, delay = 0 } = options;

  const osc = ctx.createOscillator();
  osc.type = type;
  const gain = ctx.createGain();

  const startAt = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(freq, startAt);
  if (sweepTo !== undefined) {
    osc.frequency.linearRampToValueAtTime(sweepTo, startAt + duration);
  }

  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function playSfx(freq: number, options: ToneOptions): void {
  const { sfxGain } = getContext();
  playTone(freq, options, sfxGain);
}

export function playHover(): void {
  playSfx(1046, { duration: 0.035, type: 'sine', volume: 0.05 });
}

export function playClick(): void {
  playSfx(784, { duration: 0.05, type: 'square', volume: 0.09, sweepTo: 523 });
}

export function playType(): void {
  playSfx(1200, { duration: 0.02, type: 'sine', volume: 0.035 });
}

export function playSubmit(): void {
  playSfx(440, { duration: 0.09, type: 'triangle', volume: 0.1, sweepTo: 880 });
}

// 정답 — 경쾌한 3음 상승 아르페지오
export function playCorrect(): void {
  playSfx(523, { duration: 0.07, type: 'square', volume: 0.12 });
  playSfx(659, { duration: 0.07, type: 'square', volume: 0.12, delay: 0.06 });
  playSfx(784, { duration: 0.09, type: 'square', volume: 0.13, delay: 0.12 });
}

// 오답 — 화면에 있던 코드였지만 틀린 코드를 낸 경우, 하강하는 거친 버즈
export function playWrong(): void {
  playSfx(300, { duration: 0.15, type: 'sawtooth', volume: 0.12, sweepTo: 150 });
}

// 오타 — 화면에 없는 문자열을 제출한 경우(미스), 짧고 밋밋한 "툭" 소리로
// 오답과 구분되게 한다
export function playTypo(): void {
  playSfx(180, { duration: 0.08, type: 'square', volume: 0.09 });
}

// --- BGM: 짧은 반복 패턴을 예약 후 루프 길이만큼 재스케줄 ---

type BgmKind = 'lobby' | 'game' | null;
let currentBgm: BgmKind = null;
let bgmTimeoutId: number | null = null;

// 로비 — 차분한 5음계 아르페지오 (C4 D4 E4 G4 A4 G4 E4 D4)
const LOBBY_NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 392.0, 329.63, 293.66];
const LOBBY_STEP_S = 0.42;

// 인게임 — 더 빠르고 급박한 베이스라인 (C3 C3 G3 C3 Eb3 C3 G3 Bb3)
const GAME_NOTES = [130.81, 130.81, 196.0, 130.81, 155.56, 130.81, 196.0, 233.08];
const GAME_STEP_S = 0.22;

function scheduleBgmLoop(notes: number[], stepS: number, type: OscillatorType, volume: number): void {
  const { bgmGain } = getContext();
  notes.forEach((freq, i) => {
    playTone(freq, { duration: stepS * 0.85, type, volume, delay: i * stepS }, bgmGain);
  });
}

function stopBgmTimer(): void {
  if (bgmTimeoutId !== null) {
    window.clearTimeout(bgmTimeoutId);
    bgmTimeoutId = null;
  }
}

export function stopBgm(): void {
  stopBgmTimer();
  currentBgm = null;
}

function startBgmLoop(kind: 'lobby' | 'game', notes: number[], stepS: number, type: OscillatorType, volume: number) {
  if (currentBgm === kind) return;
  stopBgmTimer();
  currentBgm = kind;

  const loop = () => {
    if (currentBgm !== kind) return;
    scheduleBgmLoop(notes, stepS, type, volume);
    bgmTimeoutId = window.setTimeout(loop, notes.length * stepS * 1000);
  };
  loop();
}

export function startLobbyBgm(): void {
  startBgmLoop('lobby', LOBBY_NOTES, LOBBY_STEP_S, 'triangle', 0.045);
}

export function startGameBgm(): void {
  startBgmLoop('game', GAME_NOTES, GAME_STEP_S, 'square', 0.05);
}
