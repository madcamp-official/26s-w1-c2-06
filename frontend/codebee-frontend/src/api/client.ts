export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, body: unknown) {
    const code =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: unknown }).error)
        : undefined;
    super(code ?? `request_failed_${status}`);
    this.status = status;
    this.code = code;
  }
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

let csrfReady: Promise<void> | null = null;

async function ensureCsrfCookie(): Promise<void> {
  if (getCookie('csrftoken')) return;
  if (!csrfReady) {
    csrfReady = fetch('/api/csrf/', { credentials: 'include' }).then(() => undefined);
  }
  await csrfReady;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  if (method !== 'GET') {
    await ensureCsrfCookie();
    const token = getCookie('csrftoken');
    if (token) headers.set('X-CSRFToken', token);
  }

  const res = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: 'include',
  });

  const body = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, body);
  }

  return body as T;
}

const ERROR_MESSAGES: Record<string, string> = {
  duplicate_username: '이미 사용 중인 아이디입니다.',
  username_password_required: '아이디와 비밀번호를 모두 입력해주세요.',
  invalid_credentials: '아이디 또는 비밀번호가 올바르지 않습니다.',
  not_authenticated: '로그인이 필요합니다.',
  room_not_found: '존재하지 않는 방입니다.',
  room_full: '방이 가득 찼습니다.',
  room_not_joinable: '지금은 참가할 수 없는 방입니다.',
};

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code && ERROR_MESSAGES[err.code]) {
    return ERROR_MESSAGES[err.code];
  }
  return '알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
}
