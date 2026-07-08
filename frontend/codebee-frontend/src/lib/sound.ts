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
    sfxGain.gain.value = getSfxVolume();
    sfxGain.connect(masterGain);

    bgmGain = ctx.createGain();
    bgmGain.gain.value = getBgmVolume();
    bgmGain.connect(masterGain);
  }
  return { ctx, sfxGain: sfxGain as GainNode, bgmGain: bgmGain as GainNode };
}

export function unlockAudio(): void {
  const { ctx } = getContext();
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  // 브라우저 자동재생 정책상 <audio>도 오디오와 별개로 제스처가 필요하다 —
  // startGameBgm()이 제스처 없이 불려서 재생이 막혔던 경우 여기서 다시 시도한다.
  if (currentBgm === 'game' && gameBgmAudio?.paused) {
    gameBgmAudio.play().catch(() => {});
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
  applyGameBgmVolume();
}

export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

// --- BGM/효과음 개별 볼륨(0~1) — 설정 팝업(SoundSettings)에서 조절 ---

const SFX_VOLUME_KEY = 'codebee:sfxVolume';
const BGM_VOLUME_KEY = 'codebee:bgmVolume';

function readVolume(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 1;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  } catch {
    return 1;
  }
}

export function getSfxVolume(): number {
  return readVolume(SFX_VOLUME_KEY);
}

export function getBgmVolume(): number {
  return readVolume(BGM_VOLUME_KEY);
}

export function setSfxVolume(volume: number): void {
  const clamped = Math.min(1, Math.max(0, volume));
  try {
    localStorage.setItem(SFX_VOLUME_KEY, String(clamped));
  } catch {
    // 저장 실패는 조용히 무시
  }
  if (sfxGain) sfxGain.gain.value = clamped;
}

export function setBgmVolume(volume: number): void {
  const clamped = Math.min(1, Math.max(0, volume));
  try {
    localStorage.setItem(BGM_VOLUME_KEY, String(clamped));
  } catch {
    // 저장 실패는 조용히 무시
  }
  if (bgmGain) bgmGain.gain.value = clamped;
  applyGameBgmVolume();
}

interface ToneOptions {
  duration?: number; // 초
  type?: OscillatorType;
  volume?: number; // 0~1
  sweepTo?: number; // Hz — 있으면 freq에서 이 값으로 선형 스윕
  delay?: number; // 초 — 시작 지연
  attack?: number; // 초 — 0에 가까울수록 타격감 있게 "탁" 치고 들어간다(기본은 부드러운 8ms)
}

// 오실레이터 하나 + 짧은 attack/decay 엔벨로프로 "삑" 소리 하나를 만든다.
// 모든 효과음/BGM 노트가 이 함수 위에서 조합된다. 호출자가 반환된 오실레이터를
// 붙잡아두면(BGM 루프가 그렇게 한다) 화면 전환 시 즉시 멈출 수 있다.
function playTone(freq: number, options: ToneOptions, destination: GainNode): OscillatorNode {
  const { ctx } = getContext();
  const { duration = 0.08, type = 'square', volume = 0.12, sweepTo, delay = 0, attack = 0.008 } = options;

  const osc = ctx.createOscillator();
  osc.type = type;
  const gain = ctx.createGain();

  const startAt = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(freq, startAt);
  if (sweepTo !== undefined) {
    osc.frequency.linearRampToValueAtTime(sweepTo, startAt + duration);
  }

  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
  return osc;
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

// 타이핑 — 스윕 없이 아주 짧은 고음 클릭 하나만 낸다. attack을 0에 가깝게 주고
// duration도 최소화해서, 소리가 "따라오는" 느낌(스윕/저음 꼬리) 없이 누른 순간
// 그대로 딱 끊어지게 들리도록 했다 — 이전 버전(스윕 섞인 저음 포함)은 꼬리가
// 남는 느낌 때문에 사운드가 밀려서 나오는 것처럼 느껴졌다.
export function playType(): void {
  playSfx(2000, { duration: 0.012, type: 'square', volume: 0.08, attack: 0.0004 });
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

// 게임 시작 전 3,2,1 카운트다운 — 숫자가 줄어들수록(3→2→1) 음이 올라가서
// "시작이 다가온다"는 긴장감을 준다.
export function playCountdownBeep(count: number): void {
  const freq = count >= 3 ? 587.33 : count === 2 ? 659.25 : 783.99; // D5, E5, G5
  playSfx(freq, { duration: 0.12, type: 'square', volume: 0.14, attack: 0.004 });
}

// --- BGM ---
// 로비는 합성 루프(짧은 반복 패턴을 예약 후 루프 길이만큼 재스케줄), 인게임은
// 실제 음원 파일(game-bgm.mp3, public/audio) 재생 — 둘 다 이 아래에서 전환을
// 관리하며, 전환 시 이전 소스가 확실히 멈추도록 신경 쓴다. 이걸 놓치면 예약해둔
// 오실레이터가 화면이 바뀐 뒤에도 계속 울리거나(합성 루프는 한 바퀴 분량을 미리
// 예약해두므로), <audio>가 결산화면까지 새어 들어가는 문제가 생긴다.

type BgmKind = 'lobby' | 'game' | null;
let currentBgm: BgmKind = null;
let bgmTimeoutId: number | null = null;
// 합성 루프가 미리 예약해둔(아직 재생 전이거나 재생 중인) 오실레이터들 — 화면
// 전환 시 이걸 즉시 stop()하지 않으면, 이미 예약된 나머지 음표들이 다음 화면
// 위로 계속 흘러나온다.
let activeSynthOscillators: OscillatorNode[] = [];

// 로비 — 통통 튀는 업비트 멜로디(사각파) + 저음 베이스(삼각파) 2성부, 빠른 템포로
// 신나는 느낌을 낸다. 0은 그 스텝에서 쉼표(음 없음).
const LOBBY_MELODY = [523.25, 0, 659.25, 783.99, 659.25, 987.77, 783.99, 659.25];
const LOBBY_BASS = [130.81, 130.81, 196.0, 130.81, 164.81, 164.81, 196.0, 130.81];
const LOBBY_STEP_S = 0.19;

// 배포 빌드에선 Django가 STATIC_URL(/static/) 아래로 서빙하므로(vite.config.ts의
// base 설정과 동일한 이유), public/ 에셋도 절대경로 대신 BASE_URL을 붙여 참조한다.
const GAME_BGM_SRC = `${import.meta.env.BASE_URL}audio/game-bgm.mp3`;
const GAME_BGM_VOLUME = 0.25;
let gameBgmAudio: HTMLAudioElement | null = null;

// masterGain(뮤트)과 bgmVolume 설정을 함께 반영 — <audio>는 Web Audio 그래프
// 바깥에 있어서 masterGain/bgmGain을 안 타므로 여기서 직접 계산해줘야 한다.
function applyGameBgmVolume(): void {
  if (!gameBgmAudio) return;
  gameBgmAudio.volume = isMuted() ? 0 : getBgmVolume() * GAME_BGM_VOLUME;
}

function getGameBgmAudio(): HTMLAudioElement {
  if (!gameBgmAudio) {
    gameBgmAudio = new Audio(GAME_BGM_SRC);
    gameBgmAudio.loop = true;
    applyGameBgmVolume();
  }
  return gameBgmAudio;
}

function scheduleBgmLoop(notes: number[], stepS: number, type: OscillatorType, volume: number): void {
  const { bgmGain } = getContext();
  notes.forEach((freq, i) => {
    if (freq <= 0) return; // 0은 쉼표
    const osc = playTone(freq, { duration: stepS * 0.85, type, volume, delay: i * stepS }, bgmGain);
    activeSynthOscillators.push(osc);
  });
}

// 예약됐지만 아직 안 끝난 합성 루프 오실레이터를 전부 즉시 멈춘다.
function haltSynthLoop(): void {
  if (bgmTimeoutId !== null) {
    window.clearTimeout(bgmTimeoutId);
    bgmTimeoutId = null;
  }
  if (activeSynthOscillators.length > 0) {
    const { ctx } = getContext();
    for (const osc of activeSynthOscillators) {
      try {
        osc.stop(ctx.currentTime);
      } catch {
        // 이미 끝난 오실레이터에 다시 stop()을 부르면 예외가 나는데, 무해하니 무시
      }
    }
    activeSynthOscillators = [];
  }
}

export function stopBgm(): void {
  haltSynthLoop();
  gameBgmAudio?.pause();
  currentBgm = null;
}

export function startLobbyBgm(): void {
  if (currentBgm === 'lobby') return;
  gameBgmAudio?.pause();
  haltSynthLoop();
  currentBgm = 'lobby';

  const loop = () => {
    if (currentBgm !== 'lobby') return;
    scheduleBgmLoop(LOBBY_MELODY, LOBBY_STEP_S, 'square', 0.05);
    scheduleBgmLoop(LOBBY_BASS, LOBBY_STEP_S, 'triangle', 0.06);
    bgmTimeoutId = window.setTimeout(loop, LOBBY_MELODY.length * LOBBY_STEP_S * 1000);
  };
  loop();
}

export function startGameBgm(): void {
  if (currentBgm === 'game') return;
  haltSynthLoop();
  currentBgm = 'game';

  const audio = getGameBgmAudio();
  audio.currentTime = 0;
  audio.play().catch(() => {
    // 자동재생 차단 — unlockAudio()가 다음 사용자 제스처에서 다시 재생을 시도한다
  });
}
