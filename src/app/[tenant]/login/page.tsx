'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, apiFetch, homePathForRoles, type SessionUser } from '../../../lib/api/client.ts';

/**
 * Tenant login (`/{tenant}/login`). Posts to /api/v1/auth/login with the
 * tenant slug taken from the route param; the route sets the HttpOnly session
 * cookie. Errors surface the stable API code only (INVALID_CREDENTIALS stays
 * generic — no account enumeration; RATE_LIMITED asks to wait).
 */
export default function TenantLoginPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const router = useRouter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  // Already signed in? Skip the form. Superadmin stays put (uses /sa/login).
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: SessionUser }>('/api/v1/me')
      .then((data) => {
        if (cancelled) return;
        if (!data.user.roles.includes('superadmin')) {
          router.replace(homePathForRoles(data.user.roles, tenant));
          return;
        }
        setChecking(false);
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, tenant]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await apiFetch<{ user: SessionUser }>('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantSlug: tenant,
          identifier: identifier.trim(),
          password,
          deviceLabel: 'web',
        }),
      });
      router.replace(homePathForRoles(data.user.roles, tenant));
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === 'INVALID_CREDENTIALS') {
          setError('Email/telepon atau kata sandi salah.');
        } else if (cause.code === 'RATE_LIMITED') {
          setError('Terlalu banyak percobaan masuk. Tunggu beberapa menit, lalu coba lagi.');
        } else if (cause.code === 'VALIDATION_FAILED') {
          setError('Periksa kembali isian Anda.');
        } else {
          setError(cause.message);
        }
      } else {
        setError('Tidak dapat masuk. Coba lagi.');
      }
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <a className="brand" href={`/${tenant}/login`} aria-label="Vortech HRIS">
          <span className="brand__mark" aria-hidden="true">
            V
          </span>
          <span>
            <strong>Vortech</strong>
            <small>HRIS</small>
          </span>
        </a>
        <div>
          <p className="eyebrow">Masuk ke akun Anda</p>
          <h1>Presensi online.</h1>
          <p className="auth-subtitle">Gunakan email atau nomor telepon yang terdaftar untuk tenant ini.</p>
        </div>
        {checking ? (
          <p className="auth-subtitle">Memeriksa sesi…</p>
        ) : (
          <form className="auth-form" onSubmit={onSubmit}>
            <label className="mgmt-field" htmlFor="login-identifier">
              <span>Email atau nomor telepon</span>
              <input
                autoComplete="username"
                id="login-identifier"
                inputMode="email"
                onChange={(event) => setIdentifier(event.target.value)}
                required
                type="text"
                value={identifier}
              />
            </label>
            <label className="mgmt-field" htmlFor="login-password">
              <span>Kata sandi</span>
              <input
                autoComplete="current-password"
                id="login-password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error ? (
              <div className="member-error" role="alert">
                <strong>Gagal masuk</strong>
                <span>{error}</span>
              </div>
            ) : null}
            <button className="button-primary" disabled={busy} type="submit">
              {busy ? 'Memeriksa…' : 'Masuk'}
            </button>
          </form>
        )}
        <p className="auth-footnote">
          Tenant: <code>{tenant}</code> · Superadmin platform masuk melalui <a href="/sa/login">halaman khusus</a>.
        </p>
      </div>
    </main>
  );
}
