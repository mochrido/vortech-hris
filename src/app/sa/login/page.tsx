'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, PLATFORM_TENANT_SLUG, apiFetch, type SessionUser } from '../../../lib/api/client.ts';

/**
 * Superadmin login (`/sa/login`). Posts to the same /api/v1/auth/login, pinned
 * to the platform tenant (`vortech-platform`, decisions.md #11) where the
 * superadmin account lives. Minimal by design.
 */
export default function SuperadminLoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: SessionUser }>('/api/v1/me')
      .then((data) => {
        if (!cancelled && data.user.roles.includes('superadmin')) router.replace(`/${PLATFORM_TENANT_SLUG}/admin/locations`);
        else if (!cancelled) setChecking(false);
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

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
          tenantSlug: PLATFORM_TENANT_SLUG,
          identifier: identifier.trim(),
          password,
          deviceLabel: 'web',
        }),
      });
      if (!data.user.roles.includes('superadmin')) {
        setError('Akun ini bukan superadmin platform.');
        setBusy(false);
        return;
      }
      router.replace(`/${PLATFORM_TENANT_SLUG}/admin/locations`);
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === 'INVALID_CREDENTIALS') setError('Email atau kata sandi salah.');
        else if (cause.code === 'RATE_LIMITED') setError('Terlalu banyak percobaan. Tunggu beberapa menit.');
        else setError(cause.message);
      } else {
        setError('Tidak dapat masuk. Coba lagi.');
      }
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <a className="brand" href="/sa/login" aria-label="Vortech HRIS">
          <span className="brand__mark" aria-hidden="true">
            V
          </span>
          <span>
            <strong>Vortech</strong>
            <small>Platform</small>
          </span>
        </a>
        <div>
          <p className="eyebrow">Akses platform</p>
          <h1>Superadmin.</h1>
          <p className="auth-subtitle">Masuk dengan akun superadmin platform.</p>
        </div>
        {checking ? (
          <p className="auth-subtitle">Memeriksa sesi…</p>
        ) : (
          <form className="auth-form" onSubmit={onSubmit}>
            <label className="mgmt-field" htmlFor="sa-identifier">
              <span>Email</span>
              <input
                autoComplete="username"
                id="sa-identifier"
                onChange={(event) => setIdentifier(event.target.value)}
                required
                type="email"
                value={identifier}
              />
            </label>
            <label className="mgmt-field" htmlFor="sa-password">
              <span>Kata sandi</span>
              <input
                autoComplete="current-password"
                id="sa-password"
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
        <p className="auth-footnote">Tenant platform: <code>{PLATFORM_TENANT_SLUG}</code></p>
      </div>
    </main>
  );
}
