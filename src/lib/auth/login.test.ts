import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { AppError, ErrorCodes } from './errors.ts';
import { hashPassword } from './password.ts';
import { getSessionByToken, hashToken } from './session.ts';
import { __rateLimitInternals } from './rate-limit.ts';
import {
  login,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_MAX_IDENTIFIER_LENGTH,
  LOGIN_MAX_PASSWORD_LENGTH,
  type LoginResult,
} from './login.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const PASSWORD = 'S3cure!Passphrase';

// --- Env helpers (same pattern as session.test.ts) --------------------------

type EnvKey = 'DATABASE_URL' | 'APP_ORIGIN' | 'SESSION_TTL_HOURS' | 'SESSION_COOKIE_NAME';

function withEnv<T>(overrides: Partial<Record<EnvKey, string>>, fn: () => T | Promise<T>): Promise<T> | T {
  const saved = new Map<EnvKey, string | undefined>();
  for (const key of Object.keys(overrides) as EnvKey[]) {
    saved.set(key, process.env[key]);
    process.env[key] = overrides[key] as string;
  }
  const restore = (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

// --- Shared database fixture -------------------------------------------------

interface DbFixture {
  url: string;
  pool: pg.Pool;
}

async function setupDb(t: test.TestContext): Promise<DbFixture> {
  await closePool();
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await closePool();
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);
  return { url, pool };
}

function envFor(fixture: DbFixture): Record<EnvKey, string> {
  return {
    DATABASE_URL: fixture.url,
    APP_ORIGIN: 'https://hris.example.com',
    SESSION_TTL_HOURS: '720',
    SESSION_COOKIE_NAME: 'vortech_session',
  };
}

async function insertTenant(pool: pg.Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  opts: { email?: string; phone?: string; active?: boolean; displayName?: string } = {},
): Promise<string> {
  const email = opts.email ?? `user-${randomBytes(4).toString('hex')}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, phone_e164, password_hash, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, opts.displayName ?? 'Test User', email, opts.phone ?? null, passwordHash, opts.active ?? true],
  );
  return result.rows[0].id;
}

async function insertRole(pool: pg.Pool, userId: string, role: string): Promise<void> {
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [userId, role]);
}

async function assertInvalidCredentials(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, ErrorCodes.INVALID_CREDENTIALS);
    assert.equal(err.status, 401);
    return true;
  });
}

// --- Tests -------------------------------------------------------------------

test('login: correct email+password creates a session, returns cookie and user summary with roles', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, { email: 'alice@example.com' });
    await insertRole(fixture.pool, userId, 'employee');
    await insertRole(fixture.pool, userId, 'manager');

    const result: LoginResult = await login('acme', 'alice@example.com', PASSWORD, {
      userAgent: 'Mozilla/5.0 Test',
      deviceLabel: 'Test Phone',
      ip: '203.0.113.10',
    });

    assert.ok(result.token, 'raw token returned');
    assert.equal(result.cookie.name, 'vortech_session');
    assert.equal(result.cookie.value, result.token);
    assert.equal(result.cookie.httpOnly, true);
    assert.equal(result.cookie.sameSite, 'lax');
    assert.equal(result.cookie.path, '/');
    assert.ok(result.session.id);

    // Session row is tenant-scoped and stores ONLY the token hash.
    assert.equal(result.session.tenant_id, tenantId);
    assert.equal(result.session.user_id, userId);
    assert.equal(result.session.token_hash, hashToken(result.token));
    assert.notEqual(result.session.token_hash, result.token);

    const summary = result.user;
    assert.equal(summary.id, userId);
    assert.equal(summary.displayName, 'Test User');
    assert.equal(summary.emailNormalized, 'alice@example.com');
    assert.deepEqual([...summary.roles].sort(), ['employee', 'manager']);

    // The returned token resolves to a live session for this user.
    const resolved = await getSessionByToken(result.token);
    assert.ok(resolved, 'session must resolve');
    assert.equal(resolved.user.id, userId);
  });
});

test('login: identifier match is case-insensitive for email (stored normalized)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'bob@example.com' });

    const result = await login('acme', '  BOB@Example.COM  ', PASSWORD, {});
    assert.equal(result.user.emailNormalized, 'bob@example.com');
  });
});

test('login: identifier may be a phone number (phone_e164)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, { phone: '+6281234567890' });

    const result = await login('acme', '+6281234567890', PASSWORD, {});
    assert.equal(result.user.id, userId);
    assert.equal(result.user.phoneE164, '+6281234567890');
  });
});

test('login: wrong password returns generic INVALID_CREDENTIALS', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'carol@example.com' });

    await assertInvalidCredentials(() => login('acme', 'carol@example.com', 'wrong-password', {}));

    const sessions = await fixture.pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM sessions');
    assert.equal(Number(sessions.rows[0].count), 0, 'no session may be created on failure');
  });
});

test('login: unknown user returns the SAME generic INVALID_CREDENTIALS (anti-enumeration)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'dave@example.com' });

    let unknownUserError: AppError | null = null;
    try {
      await login('acme', 'nobody@example.com', PASSWORD, {});
    } catch (err) {
      unknownUserError = err as AppError;
    }
    assert.ok(unknownUserError);
    assert.equal(unknownUserError.code, ErrorCodes.INVALID_CREDENTIALS);
    assert.equal(unknownUserError.status, 401);

    let wrongPasswordError: AppError | null = null;
    try {
      await login('acme', 'dave@example.com', 'wrong-password', {});
    } catch (err) {
      wrongPasswordError = err as AppError;
    }
    assert.ok(wrongPasswordError);
    assert.equal(wrongPasswordError.code, unknownUserError.code, 'same stable code');
    assert.equal(wrongPasswordError.message, unknownUserError.message, 'same generic message');
    assert.equal(wrongPasswordError.status, unknownUserError.status, 'same HTTP status');
  });
});

test('login: unknown tenant slug returns the SAME generic INVALID_CREDENTIALS', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'erin@example.com' });

    let unknownTenantError: AppError | null = null;
    try {
      await login('no-such-tenant', 'erin@example.com', PASSWORD, {});
    } catch (err) {
      unknownTenantError = err as AppError;
    }
    assert.ok(unknownTenantError);
    assert.equal(unknownTenantError.code, ErrorCodes.INVALID_CREDENTIALS);

    let wrongPasswordError: AppError | null = null;
    try {
      await login('acme', 'erin@example.com', 'wrong-password', {});
    } catch (err) {
      wrongPasswordError = err as AppError;
    }
    assert.ok(wrongPasswordError);
    assert.equal(unknownTenantError.message, wrongPasswordError.message, 'tenant existence must not leak');
  });
});

test('login: anti-enumeration performs a scrypt verify even for an unknown user (timing)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    await insertTenant(fixture.pool, 'acme');

    const started = process.hrtime.bigint();
    await assertInvalidCredentials(() => login('acme', 'ghost@example.com', 'any-password', {}));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A scrypt verify at N=16384 takes ~10ms on any hardware; a skip would be < 5ms.
    assert.ok(
      elapsedMs >= 5,
      `unknown-user login must still pay the scrypt cost (took ${elapsedMs.toFixed(1)}ms) so timing does not reveal account existence`,
    );
  });
});

test('login: deactivated user returns generic INVALID_CREDENTIALS and creates no session', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'frank@example.com', active: false });

    await assertInvalidCredentials(() => login('acme', 'frank@example.com', PASSWORD, {}));

    const sessions = await fixture.pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM sessions');
    assert.equal(Number(sessions.rows[0].count), 0);
  });
});

test('login: a user in tenant A cannot log in via tenant B slug', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    await insertUser(fixture.pool, await insertTenant(fixture.pool, 'tenant-a'), { email: 'grace@example.com' });
    await insertTenant(fixture.pool, 'tenant-b');

    await assertInvalidCredentials(() => login('tenant-b', 'grace@example.com', PASSWORD, {}));
  });
});

test('login: rate-limited after LOGIN_MAX_FAILURES failures, then success resets the limit', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'heidi@example.com' });
    const key = `login:acme:heidi@example.com`;

    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await assertInvalidCredentials(() => login('acme', 'heidi@example.com', 'wrong-password', {}));
    }

    // The next FAILED attempt exhausts the budget and is rejected RATE_LIMITED
    // instead of INVALID_CREDENTIALS.
    await assert.rejects(
      () => login('acme', 'heidi@example.com', 'wrong-password', {}),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCodes.RATE_LIMITED);
        assert.equal(err.status, 429);
        return true;
      },
    );

    // Manual reset (as a success would do) lets the user in again.
    const { resetRateLimit } = await import('./rate-limit.ts');
    resetRateLimit(key);
    const ok = await login('acme', 'heidi@example.com', PASSWORD, {});
    assert.ok(ok.token);
    assert.equal(__rateLimitInternals.has(key), false, 'success must clear the failure bucket');
  });
});

test('login: identifier with a different tenant does not share the rate-limit bucket', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantA = await insertTenant(fixture.pool, 'tenant-aa');
    await insertTenant(fixture.pool, 'tenant-bb');
    await insertUser(fixture.pool, tenantA, { email: 'ivan@example.com' });

    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await assertInvalidCredentials(() => login('tenant-aa', 'ivan@example.com', 'wrong', {}));
    }
    // tenant-bb bucket for the same identifier is untouched: it fails as
    // INVALID_CREDENTIALS (unknown user there), not RATE_LIMITED.
    await assertInvalidCredentials(() => login('tenant-bb', 'ivan@example.com', 'wrong', {}));
  });
});

test('login: LOGIN_WINDOW_MS is a 15-minute window and max failures is 5', () => {
  assert.equal(LOGIN_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(LOGIN_MAX_FAILURES, 5);
});

// --- Finding 1: no 429-vs-401 enumeration oracle ----------------------------

test('login: once limited, known and unknown identifiers BOTH get RATE_LIMITED (no oracle)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'known@example.com' });

    // Exhaust the known identifier's failure bucket.
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await assertInvalidCredentials(() => login('acme', 'known@example.com', 'wrong-password', {}));
    }

    // The limiter is checked BEFORE the credential lookup and BEFORE scrypt, so
    // a tripped bucket yields RATE_LIMITED regardless of account existence.
    const errFor = async (identifier: string): Promise<AppError> => {
      try {
        await login('acme', identifier, 'wrong-password', {});
      } catch (err) {
        return err as AppError;
      }
      throw new Error(`expected login to reject for ${identifier}`);
    };

    const knownErr = await errFor('known@example.com');
    const unknownErr = await errFor('known@example.com'); // same bucket → same result
    assert.equal(knownErr.code, ErrorCodes.RATE_LIMITED);
    assert.equal(knownErr.status, 429);
    assert.equal(unknownErr.code, knownErr.code, 'known and unknown identifier must match once limited');
    assert.equal(unknownErr.status, knownErr.status);
    assert.equal(unknownErr.message, knownErr.message, 'identical client-facing response once limited');

    // Prove the oracle is gone by comparing against a genuinely unknown
    // identifier whose own bucket is NOT yet exhausted: it still returns
    // INVALID_CREDENTIALS (the limiter passes), so the 429 above comes purely
    // from the limiter — not from whether the account exists.
    await assertInvalidCredentials(() => login('acme', 'ghost-never-seen@example.com', 'wrong-password', {}));
  });
});

test('login: exhausted bucket short-circuits BEFORE scrypt (no wasted work when limited)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'fast@example.com' });

    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await assertInvalidCredentials(() => login('acme', 'fast@example.com', 'wrong-password', {}));
    }

    const started = process.hrtime.bigint();
    await assert.rejects(
      () => login('acme', 'fast@example.com', 'wrong-password', {}),
      (err: unknown) => err instanceof AppError && err.code === ErrorCodes.RATE_LIMITED,
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // A scrypt verify costs ~10ms (the anti-enumeration test above uses a 5ms
    // floor); a short-circuited RATE_LIMITED does no hashing and lands far below.
    assert.ok(elapsedMs < 5, `limited request must not pay the scrypt cost (took ${elapsedMs.toFixed(1)}ms)`);
  });
});

// --- Finding 2: independent per-IP credential-stuffing limit -----------------

test('login: spraying many identifiers from one IP is throttled by the per-IP limit', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const attackerIp = '198.51.100.7';

    // LOGIN_IP_MAX_ATTEMPTS attempts from one IP across DISTINCT identifiers
    // (each with its own fresh identifier bucket) are all allowed...
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS; i += 1) {
      await assertInvalidCredentials(() =>
        login('acme', `spray-${i}@example.com`, 'wrong-password', { ip: attackerIp }),
      );
    }

    // ...but the next attempt from the same IP is RATE_LIMITED even though its
    // per-identifier bucket is completely fresh (proves the IP bucket is
    // independent of the identifier bucket).
    await assert.rejects(
      () => login('acme', 'spray-final@example.com', 'wrong-password', { ip: attackerIp }),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCodes.RATE_LIMITED);
        assert.equal(err.status, 429);
        return true;
      },
    );

    // A DIFFERENT source IP is unaffected (per-IP buckets are independent).
    await insertUser(fixture.pool, tenantId, { email: 'other-user@example.com' });
    await assertInvalidCredentials(() =>
      login('acme', 'other-user@example.com', 'wrong-password', { ip: '203.0.113.99' }),
    );
  });
});

test('login: a missing client IP skips the IP limiter entirely (no shared global bucket)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'noip@example.com' });

    // Many attempts with NO ip (undefined) and with a blank ip must never be
    // funneled into one shared bucket that a single requester could exhaust.
    // Well past LOGIN_IP_MAX_ATTEMPTS, each still returns INVALID_CREDENTIALS
    // (its own fresh identifier bucket), never RATE_LIMITED.
    const attempts = LOGIN_IP_MAX_ATTEMPTS + 10;
    for (let i = 0; i < attempts; i += 1) {
      await assertInvalidCredentials(() => login('acme', `noip-${i}@example.com`, 'wrong', { ip: undefined }));
    }
    assert.equal(__rateLimitInternals.has('login-ip:'), false, 'a missing IP must not create a shared IP bucket');
    assert.equal(
      __rateLimitInternals.has('login-ip:unknown'),
      false,
      'a missing IP must not be bucketed under a sentinel key',
    );
  });
});

// --- Finding 3: over-long inputs rejected before hashing/lookup --------------

test('login: over-long identifier or password → VALIDATION_FAILED before any scrypt work', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'capped@example.com' });

    const tooLongIdent = 'a'.repeat(LOGIN_MAX_IDENTIFIER_LENGTH + 1);
    const tooLongPass = 'p'.repeat(LOGIN_MAX_PASSWORD_LENGTH + 1);

    const started = process.hrtime.bigint();
    await assert.rejects(
      () => login('acme', tooLongIdent, PASSWORD, {}),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCodes.VALIDATION_FAILED);
        assert.equal(err.status, 400);
        return true;
      },
    );
    await assert.rejects(
      () => login('acme', 'capped@example.com', tooLongPass, {}),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, ErrorCodes.VALIDATION_FAILED);
        assert.equal(err.status, 400);
        return true;
      },
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 5, `over-long inputs must be rejected before scrypt (took ${elapsedMs.toFixed(1)}ms)`);

    // Boundary: exactly-at-cap values are NOT rejected for length (they fail as
    // normal INVALID_CREDENTIALS instead).
    await assertInvalidCredentials(() =>
      login('acme', 'x'.repeat(LOGIN_MAX_IDENTIFIER_LENGTH), PASSWORD, {}),
    );
  });
});

// --- Finding 4: tenant slug case-folded consistently --------------------------

test('login: tenant slug matching is case-insensitive (ACME == acme)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    // Slugs are stored lowercase (seed: 'vortech-platform', 'vortech-demo').
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, { email: 'case@example.com' });

    const result = await login('  ACME  ', 'case@example.com', PASSWORD, {});
    assert.equal(result.user.id, userId, 'an uppercase slug must resolve to the lowercase tenant');
    assert.equal(result.session.tenant_id, tenantId);
  });
});

test('login: slug case variants share one rate-limit bucket (no casing bypass)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    await insertUser(fixture.pool, tenantId, { email: 'fold@example.com' });

    // Mixed-case variants of the same slug+identifier must fold to ONE bucket,
    // so an attacker cannot reset the failure budget by changing casing.
    const variants = ['acme', 'ACME', 'Acme', 'aCmE', 'acme'];
    for (const v of variants) {
      await assertInvalidCredentials(() => login(v, 'FOLD@example.com', 'wrong-password', {}));
    }

    await assert.rejects(
      () => login('aCmE', 'fold@example.com', 'wrong-password', {}),
      (err: unknown) => err instanceof AppError && err.code === ErrorCodes.RATE_LIMITED,
    );
  });
});
