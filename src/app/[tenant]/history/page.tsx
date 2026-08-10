'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '../../../components/app-shell.tsx';
import { SectionCard } from '../../../components/section-card.tsx';
import { StatusBadge } from '../../../components/status-badge.tsx';
import { ApiError, apiFetch, type DashboardEntry, type MyDashboard } from '../../../lib/api/client.ts';
import { useSession } from '../../../lib/api/use-session.ts';

/**
 * Member history (`/{tenant}/history`). Sourced from the REAL data that exists
 * today: the `recent` list of GET /api/v1/me/dashboard (the last 7 days of
 * work instances). The dedicated full-history endpoint is Phase 3 scope, so
 * the page clearly marks that as coming soon instead of inventing an API.
 */
export default function MemberHistoryPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const loginPath = `/${tenant}/login`;
  const { user, loading: sessionLoading } = useSession(loginPath);

  const [dashboard, setDashboard] = useState<MyDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setDashboard(await apiFetch<MyDashboard>('/api/v1/me/dashboard'));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        window.location.replace(loginPath);
        return;
      }
      setError(cause instanceof ApiError ? cause.message : 'Gagal memuat riwayat.');
    } finally {
      setLoading(false);
    }
  }, [loginPath]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const nav = [
    { label: 'Beranda', href: `/${tenant}/dashboard` },
    { label: 'Riwayat', href: `/${tenant}/history` },
    ...(user?.roles.includes('manager') ? [{ label: 'Tim', href: `/${tenant}/manager` }] : []),
    ...(user?.roles.includes('admin') || user?.roles.includes('superadmin')
      ? [{ label: 'Admin', href: `/${tenant}/admin/locations` }]
      : []),
  ];

  if (sessionLoading || !user) {
    return (
      <main className="auth-page">
        <p className="auth-subtitle">Memuat…</p>
      </main>
    );
  }

  const recent = dashboard?.recent ?? [];

  return (
    <AppShell activeNav="Riwayat" loginPath={loginPath} nav={nav} tenantName={tenant} tenantSlug={tenant}>
      {() => (
        <div className="member-view">
          <div className="member-page-intro">
            <p className="eyebrow">Catatan personal</p>
            <h1>Riwayat presensi</h1>
            <p>Tujuh hari terakhir dari catatan presensi Anda yang tercatat di server.</p>
          </div>

          <SectionCard eyebrow="7 hari terakhir" title="Riwayat terbaru">
            {loading ? <p className="auth-subtitle">Memuat riwayat…</p> : null}
            {error ? (
              <div className="member-error" role="alert">
                <strong>Gagal memuat</strong>
                <span>{error}</span>
              </div>
            ) : null}
            {!loading && !error && recent.length === 0 ? (
              <p className="member-empty">Belum ada riwayat presensi untuk ditampilkan.</p>
            ) : null}
            {!loading && !error && recent.length > 0 ? (
              <div className="history-list">
                {recent.map((row) => (
                  <HistoryRow key={row.workDate} row={row} />
                ))}
              </div>
            ) : null}
          </SectionCard>

          <div className="member-notice">
            <span aria-hidden="true">ⓘ</span>
            <span>
              <strong>Riwayat lengkap segera hadir (Fase 3).</strong>
              <small>
                Halaman ini menampilkan 7 hari terakhir dari dasbor Anda. Riwayat penuh dengan filter tanggal dan
                ekspor akan tersedia pada Fase 3.
              </small>
            </span>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function HistoryRow({ row }: { row: DashboardEntry }) {
  const date = new Date(`${row.workDate}T12:00:00`);
  const label = Number.isNaN(date.getTime())
    ? row.workDate
    : new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);

  const tone =
    row.reviewStatus === 'needs_review' ? 'warning' : row.lateMinutes > 0 ? 'accent' : row.checkInAt ? 'success' : 'neutral';
  const statusLabel =
    row.reviewStatus === 'needs_review'
      ? 'Perlu tinjauan'
      : row.lateMinutes > 0
        ? `Terlambat ${row.lateMinutes} mnt`
        : row.checkInAt
          ? 'Hadir'
          : row.isHoliday
            ? 'Libur'
            : 'Tidak ada catatan';

  return (
    <div className="history-row">
      <span>
        <strong>{label}</strong>
        <small>
          {formatTime(row.checkInAt)} – {formatTime(row.checkOutAt)}
          {row.workedMinutes != null ? ` · ${Math.floor(row.workedMinutes / 60)}j ${row.workedMinutes % 60}m` : ''}
        </small>
      </span>
      <StatusBadge tone={tone}>{statusLabel}</StatusBadge>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
