import { it, expect, vi, beforeEach } from 'vitest';

// Characterization of withSession's lifecycle ORDER (launch -> context -> page
// -> validate -> login -> revalidate -> persist -> action -> close). Every
// collaborator appends to one shared log so a refactor cannot reorder steps
// unnoticed.
const log: string[] = [];

vi.mock('@/lib/connections', () => ({
  getDecryptedCredential: vi.fn(),
  rotateCredential: vi.fn(() => {
    log.push('rotateCredential');
  }),
  getConnection: vi.fn(() => ({ id: 'conn', platform: 'poshmark' })),
}));

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      log.push('launch');
      return {
        newContext: async (opts?: unknown) => {
          log.push(opts ? 'newContext(state)' : 'newContext(none)');
          return {
            newPage: async () => {
              log.push('newPage');
              return { url: () => 'https://example.com/dashboard' };
            },
            storageState: async () => {
              log.push('storageState');
              return { cookies: [], origins: [] };
            },
          };
        },
        close: async () => {
          log.push('close');
        },
      };
    },
  },
}));

import { getDecryptedCredential, rotateCredential } from '@/lib/connections';
import { withSession } from '../playwrightSession';

beforeEach(() => {
  log.length = 0;
  vi.mocked(rotateCredential).mockClear();
});

it('valid persisted session: validate, persist, action, then close', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({
    credential: 'pw',
    sessionState: { cookies: [], origins: [] },
  });
  const validateSession = vi.fn(async () => {
    log.push('validate');
    return true;
  });
  const action = vi.fn(async () => {
    log.push('action');
    return 'ok';
  });

  await expect(withSession('t', 'c-order-1', action, { validateSession })).resolves.toBe('ok');
  expect(log).toEqual([
    'launch',
    'newContext(state)',
    'newPage',
    'validate',
    'storageState',
    'rotateCredential',
    'action',
    'close',
  ]);
});

it('no persisted session: login, revalidate, persist, action, then close (no initial validate)', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({ credential: 'pw', sessionState: null });
  const validateSession = vi.fn(async () => {
    log.push('validate');
    return true;
  });
  const performLogin = vi.fn(async (_page: unknown, cred: string) => {
    log.push(`login(${cred})`);
  });
  const action = vi.fn(async () => {
    log.push('action');
    return 1;
  });

  await withSession('t', 'c-order-2', action, { validateSession, performLogin });
  expect(log).toEqual([
    'launch',
    'newContext(none)',
    'newPage',
    'login(pw)',
    'validate',
    'storageState',
    'rotateCredential',
    'action',
    'close',
  ]);
});

it('stale session, login ok: validate, login, revalidate, persist, action, close', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({
    credential: 'pw',
    sessionState: { cookies: [], origins: [] },
  });
  let calls = 0;
  const validateSession = vi.fn(async () => {
    log.push('validate');
    return ++calls > 1;
  });
  const performLogin = vi.fn(async () => {
    log.push('login');
  });
  await withSession('t', 'c-order-3', async () => 'x', { validateSession, performLogin });
  expect(log).toEqual([
    'launch',
    'newContext(state)',
    'newPage',
    'validate',
    'login',
    'validate',
    'storageState',
    'rotateCredential',
    'close',
  ]);
});

it('failed fresh login: throws, never persists or runs action, still closes', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({ credential: 'pw', sessionState: null });
  const validateSession = vi.fn(async () => false);
  const performLogin = vi.fn(async () => {});
  const action = vi.fn();
  await expect(
    withSession('t', 'c-order-4', action, { validateSession, performLogin }),
  ).rejects.toThrow('withSession: fresh login attempt failed for connection c-order-4');
  expect(action).not.toHaveBeenCalled();
  expect(rotateCredential).not.toHaveBeenCalled();
  expect(log.at(-1)).toBe('close');
});

it('missing performLogin: throws the exact hook error and closes', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({ credential: 'pw', sessionState: null });
  await expect(withSession('t', 'c-order-5', vi.fn())).rejects.toThrow(
    'withSession: no valid session for connection c-order-5 and no performLogin hook supplied -- the calling connector must pass SessionHooks.performLogin',
  );
  expect(rotateCredential).not.toHaveBeenCalled();
  expect(log.at(-1)).toBe('close');
});

it('action throwing: the error propagates after rotate, then close', async () => {
  vi.mocked(getDecryptedCredential).mockReturnValue({
    credential: 'pw',
    sessionState: { cookies: [], origins: [] },
  });
  const validateSession = vi.fn(async () => true);
  await expect(
    withSession(
      't',
      'c-order-6',
      async () => {
        log.push('action');
        throw new Error('boom');
      },
      { validateSession },
    ),
  ).rejects.toThrow('boom');
  expect(log.slice(-3)).toEqual(['rotateCredential', 'action', 'close']);
});
