'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';

import { AppShell } from '../../../../components/app-shell.tsx';
import { SectionCard } from '../../../../components/section-card.tsx';
import { useSession } from '../../../../lib/api/use-session.ts';

/**
 * Admin schedules (`/{tenant}/admin/schedules`). No admin write API exists yet
 * (Phase 3 scope) — this is a clean shell marking management as coming soon.
 */
export default function AdminSchedulesPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const loginPath = `/${tenant}/login`;
  const { user, loading: sessionLoading } = useSession(loginPath);

  const isAdmin = (user?.roles.includes('admin') ?? false) || (user?.roles.includes('superadmin') ?? false);

  useEffect(() => {
    if (user && !isAdmin) window.location.replace(`/${tenant}/dashboard`);
  }, [user, isAdmin, tenant]);

  const nav = [
    { label: 'Beranda', href: `/${tenant}/dashboard` },
    { label: 'Lokasi', href: `/${tenant}/admin/locations` },
    { label: 'Kebijakan', href: `/${tenant}/admin/policies` },
    { label: 'Jadwal', href: `/${tenant}/admin/schedules` },
  ];

  if (sessionLoading || !user || !isAdmin) {
    return (
      <main className="auth-page">
        <p className="auth-subtitle">Memuat…</p>
      </main>
    );
  }

  return (
    <AppShell activeNav="Jadwal" loginPath={loginPath} nav={nav} tenantName={tenant} tenantSlug={tenant}>
      {() => (
        <div className="mgmt-view">
          <div className="mgmt-page-intro">
            <p className="eyebrow">Ruang kerja organisasi</p>
            <h1>Jadwal kerja</h1>
            <p>Pola jam kerja dan hari kerja yang menjadi acuan status kehadiran.</p>
          </div>

          <div className="mgmt-simulation-note" role="note">
            <span aria-hidden="true">ⓘ</span>
            Pengelolaan jadwal segera hadir pada Fase 3. Saat ini belum ada API daftar/tulis admin, sehingga halaman
            ini adalah kerangka siap pakai.
          </div>

          <SectionCard eyebrow="Segera hadir" title="Daftar jadwal">
            <p className="mgmt-empty">
              Daftar jadwal akan tampil di sini begitu API admin tersedia pada Fase 3. Penugasan jadwal saat ini
              dikelola melalui seed/migrasi basis data.
            </p>
          </SectionCard>
        </div>
      )}
    </AppShell>
  );
}
