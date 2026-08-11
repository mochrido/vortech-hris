'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

import { roleLabel } from '../lib/api/client.ts';
import { useSession } from '../lib/api/use-session.ts';

/**
 * Authenticated app shell for the real (non-demo) pages. Reuses the prototype
 * look (sidebar + topbar + bottom nav) but swaps the mock context for the
 * real session: the user comes from /api/v1/me, navigation is real links, and
 * sign-out revokes the server session.
 *
 * Guard: while the session loads (or a 401 redirects to login) a neutral
 * loading state renders — protected content is never shown unauthenticated.
 */
export function AppShell({
  activeNav,
  children,
  loginPath,
  nav,
  tenantSlug,
  tenantName,
}: {
  activeNav: string;
  children: (user: { displayName: string; roles: string[]; emailNormalized: string | null }) => ReactNode;
  loginPath: string;
  nav: { label: string; href: string }[];
  tenantSlug: string;
  tenantName: string;
}) {
  const router = useRouter();
  const { user, loading, error, logout } = useSession(loginPath);

  useEffect(() => {
    for (const item of nav) router.prefetch(item.href);
  }, [nav, router]);

  if (loading || !user) {
    return (
      <div className="demo-shell app-loading-shell">
        <main className="app-loading" aria-busy="true">
          <p>{error ?? 'Memuat sesi…'}</p>
          {error ? (
            <p>
              <button className="button-secondary" onClick={() => window.location.reload()} type="button">
                Muat ulang
              </button>
            </p>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="demo-shell">
      <aside className="sidebar" aria-label="Navigasi utama">
        <Brand tenantSlug={tenantSlug} />
        <nav className="primary-nav">
          {nav.map((item) => (
            <Link
              aria-current={activeNav === item.label ? 'page' : undefined}
              className="nav-button"
              href={item.href}
              key={item.href}
            >
              <span className="nav-button__mark" aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="sidebar__note">
          Vortech HRIS
          <br />
          {tenantName}
        </p>
      </aside>

      <div className="shell-body">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand tenantSlug={tenantSlug} />
          </div>
          <div className="context">
            <span className="context__tenant">{tenantName}</span>
            <span className="context__user">
              {user.displayName} · {roleLabel(user.roles)}
            </span>
          </div>
          <button className="button-secondary app-signout" onClick={() => void logout()} type="button">
            Keluar
          </button>
        </header>

        <main className="main-content">{children(user)}</main>

        <nav className="bottom-nav" aria-label="Navigasi utama seluler">
          {nav.map((item) => (
            <Link
              aria-current={activeNav === item.label ? 'page' : undefined}
              className="bottom-nav__button"
              href={item.href}
              key={item.href}
            >
              <span className="bottom-nav__mark" aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Brand({ tenantSlug }: { tenantSlug: string }) {
  return (
    <a className="brand" href={`/${tenantSlug}/dashboard`} aria-label="Vortech HRIS">
      <span className="brand__mark" aria-hidden="true">
        V
      </span>
      <span>
        <strong>Vortech</strong>
        <small>HRIS</small>
      </span>
    </a>
  );
}
