'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';

import { AppShell } from '../../../../components/app-shell.tsx';
import { SectionCard } from '../../../../components/section-card.tsx';
import { useSession } from '../../../../lib/api/use-session.ts';

/**
 * Admin locations (`/{tenant}/admin/locations`). There is NO admin list/write
 * API yet (that CRUD is Phase 3 scope), so this renders a clean admin shell
 * reusing the prototype look and clearly marks management as coming soon. It
 * deliberately does NOT invent endpoints or build working write forms.
 */
export default function AdminLocationsPage() {
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
    <AppShell activeNav="Lokasi" loginPath={loginPath} nav={nav} tenantName={tenant} tenantSlug={tenant}>
      {() => (
        <div className="mgmt-view">
          <div className="mgmt-page-intro">
            <p className="eyebrow">Ruang kerja organisasi</p>
            <h1>Lokasi presensi</h1>
            <p>Titik presensi dan radius geofence untuk tenant ini.</p>
          </div>

          <div className="mgmt-simulation-note" role="note">
            <span aria-hidden="true">ⓘ</span>
            Pengelolaan lokasi (buat/ubah/hapus) segera hadir pada Fase 3. Saat ini belum ada API daftar/tulis admin,
            sehingga halaman ini adalah kerangka siap pakai.
          </div>

          <SectionCard eyebrow="Segera hadir" title="Daftar lokasi">
            <p className="mgmt-empty">
              Daftar lokasi akan tampil di sini begitu API admin tersedia pada Fase 3. Konfigurasi lokasi saat ini
              dikelola melalui seed/migrasi basis data.
            </p>
          </SectionCard>
        </div>
      )}
    </AppShell>
  );
}
