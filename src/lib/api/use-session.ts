'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch, type SessionUser } from './client.ts';

/**
 * Session hook shared by every authenticated page: fetches /api/v1/me once on
 * mount, redirects to the tenant login on 401, and exposes logout().
 *
 * Guard model: the HttpOnly session cookie is the single source of truth; the
 * API routes derive tenant + roles from it server-side. This hook only decides
 * WHERE to send an unauthenticated browser — it never grants access itself.
 */
export interface UseSessionResult {
  user: SessionUser | null;
  /** True while the initial /api/v1/me call is in flight. */
  loading: boolean;
  /** Non-401 failure message (network/5xx); null otherwise. */
  error: string | null;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

export function useSession(loginPath: string): UseSessionResult {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const redirectingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: SessionUser }>('/api/v1/me');
      setUser(data.user);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        if (!redirectingRef.current) {
          redirectingRef.current = true;
          window.location.replace(loginPath);
        }
        return;
      }
      setError(cause instanceof ApiError ? cause.message : 'Gagal memuat sesi. Muat ulang halaman.');
    } finally {
      setLoading(false);
    }
  }, [loginPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // A dead session still ends at the login page; the cookie clear is best-effort.
    }
    window.location.assign(loginPath);
  }, [loginPath]);

  return { user, loading, error, logout, reload: load };
}
