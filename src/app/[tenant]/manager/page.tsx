'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '../../../components/app-shell.tsx';
import { MetricCard } from '../../../components/metric-card.tsx';
import { SectionCard } from '../../../components/section-card.tsx';
import { StatusBadge } from '../../../components/status-badge.tsx';
import { ApiError, apiFetch, type TeamMemberToday } from '../../../lib/api/client.ts';
import { useSession } from '../../../lib/api/use-session.ts';

/**
 * Manager view (`/{tenant}/manager`) — today's attendance for every member of
 * the session manager's assigned teams, from the real
 * GET /api/v1/manager/team/today (which 403s for non-managers; the page
 * redirects non-managers away and also handles a 403 defensively).
 */
export default function ManagerPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const loginPath = `/${tenant}/login`;
  const { user, loading: sessionLoading } = useSession(loginPath);

  const [members, setMembers] = useState<TeamMemberToday[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isManager = user?.roles.includes('manager') ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{ members: TeamMemberToday[] }>('/api/v1/manager/team/today');
      setMembers(data.members);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        window.location.replace(loginPath);
        return;
      }
      if (cause instanceof ApiError && cause.status === 403) {
        setError('forbidden');
        setLoading(false);
        return;
      }
      setError(cause instanceof ApiError ? cause.message : 'Gagal memuat data tim.');
    } finally {
      setLoading(false);
    }
  }, [loginPath]);

  useEffect(() => {
    if (!user) return;
    if (!isManager) {
      // Role guard: the API would 403 anyway; send non-managers home.
      window.location.replace(`/${tenant}/dashboard`);
      return;
    }
    void load();
  }, [user, isManager, load, tenant]);

  const nav = [
    { label: 'Beranda', href: `/${tenant}/dashboard` },
    { label: 'Riwayat', href: `/${tenant}/history` },
    ...(isManager ? [{ label: 'Tim', href: `/${tenant}/manager` }] : []),
    ...(user?.roles.includes('admin') || user?.roles.includes('superadmin')
      ? [{ label: 'Admin', href: `/${tenant}/admin/locations` }]
      : []),
  ];

  if (sessionLoading || !user || !isManager) {
    return (
      <main className="auth-page">
        <p className="auth-subtitle">Memuat…</p>
      </main>
    );
  }

  const rows = members ?? [];
  const metrics = {
    present: rows.filter((row) => row.checkInAt && row.lateMinutes === 0).length,
    late: rows.filter((row) => row.checkInAt && row.lateMinutes > 0).length,
    notCheckedIn: rows.filter((row) => !row.checkInAt).length,
    review: rows.filter((row) => row.reviewStatus === 'needs_review').length,
  };
  const today = rows.find((row) => row.workDate)?.workDate ?? null;

  return (
    <AppShell activeNav="Tim" loginPath={loginPath} nav={nav} tenantName={tenant} tenantSlug={tenant}>
      {() => (
        <div className="mgmt-view">
          <div className="mgmt-page-intro">
            <p className="eyebrow">Ruang kerja tim</p>
            <h1>Kehadiran tim hari ini</h1>
            <p>{today ? `Rekap ${formatDateLong(today)} untuk anggota tim yang Anda kelola.` : 'Rekap kehadiran anggota tim yang Anda kelola.'}</p>
          </div>

          {error === 'forbidden' ? (
            <div className="member-error" role="alert">
              <strong>Akses ditolak</strong>
              <span>Halaman ini hanya untuk manajer tim.</span>
            </div>
          ) : null}
          {error && error !== 'forbidden' ? (
            <div className="member-error" role="alert">
              <strong>Gagal memuat</strong>
              <span>{error}</span>
            </div>
          ) : null}

          {loading ? <p className="auth-subtitle">Memuat data tim…</p> : null}

          {!loading && !error ? (
            <>
              <div className="mgmt-metrics" role="list" aria-label="Ringkasan kehadiran tim hari ini">
                <MetricCard label="Hadir" symbol="✓" tone="success" value={metrics.present} />
                <MetricCard label="Terlambat" symbol="◷" tone="accent" value={metrics.late} />
                <MetricCard label="Belum check-in" symbol="–" tone="neutral" value={metrics.notCheckedIn} />
                <MetricCard label="Perlu tinjauan" symbol="▲" tone="warning" value={metrics.review} />
              </div>

              <SectionCard eyebrow="Hari ini" title="Tabel kehadiran tim">
                {rows.length === 0 ? (
                  <p className="mgmt-empty">Belum ada anggota tim yang ditugaskan kepada Anda.</p>
                ) : (
                  <div className="mgmt-table-wrap">
                    <table>
                      <caption className="sr-only">Kehadiran anggota tim hari ini</caption>
                      <thead>
                        <tr>
                          <th scope="col">Nama</th>
                          <th scope="col">Tim</th>
                          <th scope="col">Status</th>
                          <th scope="col">Check-in</th>
                          <th scope="col">Check-out</th>
                          <th scope="col">Terlambat</th>
                          <th scope="col">Bekerja</th>
                          <th scope="col">Tinjauan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const flagged = row.reviewStatus === 'needs_review';
                          return (
                            <tr className={flagged ? 'mgmt-row--flagged' : undefined} key={row.userId}>
                              <td data-th="Nama">
                                <strong>{row.displayName}</strong>
                              </td>
                              <td data-th="Tim">{row.teamName}</td>
                              <td data-th="Status">
                                <StatusBadge tone={row.checkInAt ? (row.lateMinutes > 0 ? 'accent' : 'success') : 'neutral'}>
                                  {row.checkInAt ? (row.lateMinutes > 0 ? 'Terlambat' : 'Hadir') : 'Belum check-in'}
                                </StatusBadge>
                              </td>
                              <td data-th="Check-in">{formatTime(row.checkInAt)}</td>
                              <td data-th="Check-out">{formatTime(row.checkOutAt)}</td>
                              <td data-th="Terlambat">{row.lateMinutes > 0 ? `${row.lateMinutes} mnt` : '—'}</td>
                              <td data-th="Bekerja">{formatWorked(row.workedMinutes)}</td>
                              <td data-th="Tinjauan">
                                {flagged ? (
                                  <StatusBadge tone="warning">Perlu tinjauan</StatusBadge>
                                ) : (
                                  <span className="mgmt-geofence">✓ Bersih</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            </>
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function formatWorked(minutes: number | null): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}j ${m}m` : `${m}m`;
}

function formatDateLong(workDate: string): string {
  const date = new Date(`${workDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return workDate;
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}
