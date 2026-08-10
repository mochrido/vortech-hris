'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell } from '../../../components/app-shell.tsx';
import { CameraCapture, type CapturedSelfie } from '../../../components/capture/CameraCapture.tsx';
import { useGeolocation } from '../../../components/capture/useGeolocation.ts';
import { matchLocation, type CaptureLocation } from '../../../components/capture/watermark.ts';
import { StatusBadge } from '../../../components/status-badge.tsx';
import {
  ApiError,
  apiFetch,
  postAttendanceEvent,
  type AttendanceContextDto,
  type AttendanceEventResultDto,
  type MyDashboard,
} from '../../../lib/api/client.ts';
import { useSession } from '../../../lib/api/use-session.ts';

/**
 * Member dashboard (`/{tenant}/dashboard`) — the online attendance capture
 * screen, wired to the real APIs:
 *   GET  /api/v1/attendance/context  (schedule, policy, locations, serverNow)
 *   GET  /api/v1/me/dashboard        (today's status + recent)
 *   POST /api/v1/attendance/events   (multipart metadata + selfie)
 *
 * Flow: not checked in → Check-In (GPS fix + camera selfie with watermark) →
 * POST → result (accepted / needs_review / idempotent replay / blocked /
 * rejected). Checked in → Check-Out the same way. Completed → summary.
 * A 422 BLOCKED (mandatory geofence) shows a clear "outside the permitted
 * area" message; a 200 replay (same idempotency key) is reported as already
 * recorded, never an error. Permissions are requested in context (on capture).
 */

type Phase = 'loading' | 'ready' | 'error';

interface GeoFixSnapshot {
  latitude: number;
  longitude: number;
  accuracyM: number;
  acquiredAt: string;
}

interface CaptureResult {
  kind: 'accepted' | 'needs_review' | 'replay' | 'blocked' | 'rejected';
  eventAt: string | null;
  locationLabel: string | null;
}

export default function MemberDashboardPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const loginPath = `/${tenant}/login`;
  const { user, loading: sessionLoading } = useSession(loginPath);

  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState('');
  const [context, setContext] = useState<AttendanceContextDto | null>(null);
  const [dashboard, setDashboard] = useState<MyDashboard | null>(null);

  const [captureOpen, setCaptureOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [result, setResult] = useState<CaptureResult | null>(null);
  const idempotencyKeyRef = useRef<string>('');

  const load = useCallback(async () => {
    setPhase('loading');
    setLoadError('');
    try {
      const [ctx, dash] = await Promise.all([
        apiFetch<AttendanceContextDto>('/api/v1/attendance/context'),
        apiFetch<MyDashboard>('/api/v1/me/dashboard'),
      ]);
      setContext(ctx);
      setDashboard(dash);
      setPhase('ready');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        window.location.replace(loginPath);
        return;
      }
      setLoadError(cause instanceof ApiError ? cause.message : 'Gagal memuat data presensi.');
      setPhase('error');
    }
  }, [loginPath]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const today = dashboard?.today ?? null;
  const checkedIn = today?.checkInAt != null;
  const checkedOut = today?.checkOutAt != null;
  const completed = checkedIn && checkedOut;
  const eventType = checkedIn ? 'check_out' : 'check_in';

  function openCapture() {
    idempotencyKeyRef.current = crypto.randomUUID();
    setCaptureError('');
    setResult(null);
    setCaptureOpen(true);
  }

  function locationLabelFor(verdict: AttendanceEventResultDto['verdict']): string | null {
    if (!verdict || !context) return null;
    if (verdict.locationId) {
      const found = context.locations.find((loc) => loc.id === verdict.locationId);
      if (found) return `Di dalam area: ${found.name}`;
    }
    if (verdict.inside === false && typeof verdict.distanceM === 'number') {
      return `Di luar area terdaftar (±${Math.round(verdict.distanceM)} m dari lokasi terdekat)`;
    }
    if (verdict.inside === null) return 'Tanpa koordinat GPS';
    return null;
  }

  async function submitCapture(selfie: CapturedSelfie, fix: GeoFixSnapshot | null) {
    if (submitting) return;
    setSubmitting(true);
    setCaptureError('');
    try {
      // Skew between device clock and the server's authoritative clock.
      const clockOffsetMs = context ? Date.parse(context.serverNow) - Date.now() : null;
      const { status, body } = await postAttendanceEvent({
        eventType,
        idempotencyKey: idempotencyKeyRef.current,
        deviceOccurredAt: new Date().toISOString(),
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
        accuracyM: fix?.accuracyM ?? null,
        locationAcquiredAt: fix?.acquiredAt ?? null,
        clockOffsetMs,
        selfie: selfie.blob,
      });

      if (status === 201 || status === 200) {
        setResult({
          kind: !body.created ? 'replay' : body.outcome === 'needs_review' ? 'needs_review' : 'accepted',
          eventAt: body.event?.device_occurred_at ?? null,
          locationLabel: locationLabelFor(body.verdict),
        });
        setCaptureOpen(false);
        await load();
        return;
      }
      if (status === 422) {
        setResult({ kind: 'blocked', eventAt: null, locationLabel: locationLabelFor(body.verdict) });
        setCaptureOpen(false);
        return;
      }
      if (status === 409) {
        setResult({ kind: 'rejected', eventAt: null, locationLabel: null });
        setCaptureOpen(false);
        await load();
        return;
      }
      if (status === 401) {
        window.location.replace(loginPath);
        return;
      }
      setCaptureError(typeof body.message === 'string' ? body.message : 'Presensi tidak terkirim. Coba lagi.');
    } catch (cause) {
      setCaptureError(cause instanceof ApiError ? cause.message : 'Presensi tidak terkirim. Coba lagi.');
    } finally {
      setSubmitting(false);
    }
  }

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

  return (
    <AppShell activeNav="Beranda" loginPath={loginPath} nav={nav} tenantName={tenant} tenantSlug={tenant}>
      {(sessionUser) => (
        <div className="member-view">
          <section className="member-hero" aria-labelledby="member-title">
            <div>
              <p className="eyebrow">{today ? formatDateLong(today.workDate) : 'Presensi online'}</p>
              <h1 id="member-title">Halo, {sessionUser.displayName.split(' ')[0]}.</h1>
              <p>
                {context?.schedule
                  ? `Jadwal ${formatTime(context.schedule.scheduledStartAt)}–${formatTime(context.schedule.scheduledEndAt)}`
                  : 'Tidak ada jadwal kerja hari ini.'}
                {context?.schedule?.isHoliday ? ' · Hari libur' : ''}
              </p>
            </div>
            <StatusBadge tone={completed ? 'success' : checkedIn ? 'accent' : 'neutral'}>
              {completed ? 'Selesai' : checkedIn ? 'Sudah check-in' : 'Belum check-in'}
            </StatusBadge>
          </section>

          {phase === 'loading' ? <p className="auth-subtitle">Memuat status presensi…</p> : null}
          {phase === 'error' ? (
            <div className="member-error" role="alert">
              <strong>Gagal memuat</strong>
              <span>{loadError}</span>
            </div>
          ) : null}

          {phase === 'ready' ? (
            <>
              <section className="member-attendance-card" aria-label="Presensi hari ini">
                <div className="member-attendance-card__top">
                  <span>Presensi hari ini</span>
                  <span className="member-time">
                    {formatTime(today?.checkInAt ?? null)}
                    {today?.checkOutAt ? <small> – {formatTime(today.checkOutAt)}</small> : null}
                  </span>
                </div>
                <div className="member-location">
                  <span className="location-dot" aria-hidden="true" />
                  <span>
                    <strong>
                      {context && context.locations.length > 0
                        ? context.locations.map((loc) => loc.name).join(' · ')
                        : 'Lokasi belum ditetapkan'}
                    </strong>
                    <small>
                      {context?.policy.geofenceMode === 'mandatory'
                        ? `Geofence wajib · akurasi maks ${context.policy.maxAccuracyM} m`
                        : 'Geofence opsional (pekerja lapangan)'}
                    </small>
                  </span>
                </div>
                {completed ? (
                  <p className="member-explanation">
                    Check-in dan check-out hari ini sudah lengkap. Terlambat {today?.lateMinutes ?? 0} menit · bekerja{' '}
                    {formatWorked(today?.workedMinutes ?? null)}.
                    {today?.reviewStatus === 'needs_review' ? ' Presensi ini menunggu tinjauan.' : ''}
                  </p>
                ) : (
                  <button className="member-primary-action" disabled={!context} onClick={openCapture} type="button">
                    {checkedIn ? 'Check-out sekarang' : 'Check-in sekarang'}
                  </button>
                )}
                {!context?.schedule && !completed ? (
                  <p className="member-explanation">
                    Tidak ada jadwal aktif hari ini. Presensi yang dikirim dapat ditolak server bila tidak ada jadwal
                    efektif.
                  </p>
                ) : null}
                {!completed && today?.reviewStatus === 'needs_review' ? (
                  <p className="member-explanation">Presensi check-in Anda ditandai untuk ditinjau.</p>
                ) : null}
              </section>

              {result ? <ResultPanel result={result} onDismiss={() => setResult(null)} /> : null}

              {today?.isHoliday ? (
                <div className="member-notice">
                  <span aria-hidden="true">ⓘ</span>
                  <span>
                    <strong>Hari ini hari libur.</strong>
                    <small>Presensi tetap dicatat bila Anda memang dijadwalkan bekerja.</small>
                  </span>
                </div>
              ) : null}
            </>
          ) : null}

          {captureOpen && context ? (
            <CaptureDialog
              checkedIn={checkedIn}
              context={context}
              displayName={sessionUser.displayName}
              error={captureError}
              submitting={submitting}
              onCancel={() => setCaptureOpen(false)}
              onSubmit={submitCapture}
            />
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

function ResultPanel({ result, onDismiss }: { result: CaptureResult; onDismiss: () => void }) {
  if (result.kind === 'blocked') {
    return (
      <div className="member-error" role="alert">
        <strong>Anda berada di luar area yang diizinkan</strong>
        <span>
          Presensi ditolak oleh kebijakan geofence wajib.
          {result.locationLabel ? ` ${result.locationLabel}.` : ''} Dekati lokasi terdaftar, lalu kirim ulang.
        </span>
        <button className="button-secondary" onClick={onDismiss} type="button">
          Mengerti
        </button>
      </div>
    );
  }
  if (result.kind === 'rejected') {
    return (
      <div className="member-error" role="alert">
        <strong>Presensi tidak dicatat</strong>
        <span>Server menolak presensi ini (misalnya presensi ganda atau urutan check-in/out tidak valid).</span>
        <button className="button-secondary" onClick={onDismiss} type="button">
          Mengerti
        </button>
      </div>
    );
  }
  const tone = result.kind === 'accepted' ? 'success' : result.kind === 'needs_review' ? 'warning' : 'neutral';
  const title =
    result.kind === 'accepted'
      ? 'Presensi diterima'
      : result.kind === 'needs_review'
        ? 'Presensi diterima — menunggu tinjauan'
        : 'Presensi sudah tercatat';
  return (
    <div className="member-notice" role="status">
      <span aria-hidden="true">✓</span>
      <span>
        <strong>
          <StatusBadge tone={tone}>{title}</StatusBadge>
        </strong>
        <small>
          {result.eventAt ? `Tercatat pukul ${formatTime(result.eventAt)}.` : 'Tidak ada perubahan baru.'}
          {result.locationLabel ? ` ${result.locationLabel}.` : ''}
          {result.kind === 'needs_review' ? ' Akurasi GPS rendah; presensi ditandai untuk ditinjau.' : ''}
          {result.kind === 'replay' ? ' Pengiriman ulang dengan kunci idempotensi yang sama aman — tidak ada duplikat.' : ''}
        </small>
        <button className="button-secondary" onClick={onDismiss} type="button">
          Tutup
        </button>
      </span>
    </div>
  );
}

function CaptureDialog({
  checkedIn,
  context,
  displayName,
  error,
  submitting,
  onCancel,
  onSubmit,
}: {
  checkedIn: boolean;
  context: AttendanceContextDto;
  displayName: string;
  error: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (selfie: CapturedSelfie, fix: GeoFixSnapshot | null) => void;
}) {
  const [selfie, setSelfie] = useState<CapturedSelfie | null>(null);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  // GPS requested IN CONTEXT: only because the member opened the capture
  // dialog. Accuracy/attempt budget come from the effective policy.
  const geo = useGeolocation({
    maxAccuracyM: context.policy.maxAccuracyM,
    maxAttempts: context.policy.retryCount,
  });
  useEffect(() => {
    geo.request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fix: GeoFixSnapshot | null = geo.position
    ? {
        latitude: geo.position.latitude,
        longitude: geo.position.longitude,
        accuracyM: geo.position.accuracyM,
        acquiredAt: geo.position.acquiredAt,
      }
    : null;

  const locations: CaptureLocation[] = context.locations;
  const match = matchLocation(fix?.latitude ?? null, fix?.longitude ?? null, locations);

  // Object URL lifecycle for the captured preview image.
  useEffect(() => {
    if (!selfie) {
      setSelfieUrl(null);
      return;
    }
    const url = URL.createObjectURL(selfie.blob);
    setSelfieUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selfie]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const geoRequesting = geo.status === 'requesting' || geo.status === 'idle';
  const geoFailed = geo.status === 'permission_denied' || geo.status === 'unavailable' || geo.status === 'timeout';
  const geoLabel = geoRequesting
    ? `Mengambil GPS… (percobaan ${Math.max(geo.attempt, 1)})`
    : fix
      ? `±${fix.accuracyM} m`
      : 'Tanpa GPS';
  const geoTone = geoFailed && !fix ? 'text-danger' : fix && fix.accuracyM > context.policy.maxAccuracyM ? 'text-warning' : 'text-success';
  const geofenceLabel = geoRequesting && !fix ? 'Menilai…' : match.inside && match.matched ? 'Di dalam area' : fix ? 'Di luar area' : '—';
  const canSubmit = selfie !== null && !submitting && !geoRequesting;

  return (
    <div
      className="capture-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <section
        aria-labelledby="capture-title"
        aria-modal="true"
        className="capture-panel"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="capture-panel__header">
          <div>
            <p className="eyebrow">Bukti presensi</p>
            <h2 id="capture-title">
              {selfie ? 'Konfirmasi presensi' : `Ambil foto ${checkedIn ? 'untuk check-out' : 'untuk check-in'}`}
            </h2>
          </div>
          <button aria-label="Tutup" className="icon-button" onClick={onCancel} type="button">
            ×
          </button>
        </div>

        {selfie && selfieUrl ? (
          <div className="fake-camera camera-preview">
            {/* Preview of the exact watermarked JPEG that will be uploaded. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="Foto presensi dengan watermark" className="camera-video" src={selfieUrl} />
          </div>
        ) : (
          <CameraCapture
            accuracyM={fix?.accuracyM ?? null}
            displayName={displayName}
            latitude={fix?.latitude ?? null}
            longitude={fix?.longitude ?? null}
            locations={locations}
            onCancel={onCancel}
            onCapture={setSelfie}
          />
        )}

        <div className="capture-details">
          <div>
            <span>GPS</span>
            <strong className={geoTone}>{geoLabel}</strong>
          </div>
          <div>
            <span>Geofence</span>
            <strong className={geoTone}>{geofenceLabel}</strong>
          </div>
          <div>
            <span>Ukuran foto</span>
            <strong>{selfie ? `${Math.round(selfie.bytes / 1024)} KB` : '—'}</strong>
          </div>
        </div>

        {geoFailed && geo.error ? (
          <div className="capture-error" role="alert">
            <strong>Lokasi bermasalah</strong>
            <span>
              {geo.error} Anda tetap dapat mengirim; server menilai kebijakan geofence.
              {geo.errorCode !== 'permission_denied' && geo.errorCode !== 'unsupported' ? (
                <>
                  {' '}
                  <button className="button-secondary" onClick={geo.retry} type="button">
                    Coba lagi GPS
                  </button>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="capture-error" role="alert">
            <strong>Presensi tidak dikirim</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <p className="member-explanation">
          Foto diberi watermark waktu, nama, dan koordinat sebelum dikirim. Server menilai ulang geofence secara
          independen.
        </p>

        <div className="capture-actions">
          {selfie ? (
            <button className="button-secondary" disabled={submitting} onClick={() => setSelfie(null)} type="button">
              Ambil ulang
            </button>
          ) : null}
          <button className="button-secondary" disabled={submitting} onClick={onCancel} type="button">
            Batal
          </button>
          {selfie ? (
            <button className="button-primary" disabled={!canSubmit} onClick={() => onSubmit(selfie, fix)} type="button">
              {submitting ? 'Mengirim…' : `Kirim ${checkedIn ? 'check-out' : 'check-in'}`}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
