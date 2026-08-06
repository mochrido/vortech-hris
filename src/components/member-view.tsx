"use client";

import { useState } from "react";

import { getMemberDashboard, simulateAttendanceEvent } from "../lib/demo/selectors";
import type { AttendanceEventState } from "../lib/demo/types";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

type MemberViewProps = { activeNav: string };
type Scenario = "accepted" | "pending" | "accuracy" | "rejected" | "completed";

const scenarios: { key: Scenario; label: string; tone: "success" | "warning" | "danger" | "neutral" }[] = [
  { key: "accepted", label: "Diterima & tersinkron", tone: "success" },
  { key: "pending", label: "Pending / offline", tone: "warning" },
  { key: "accuracy", label: "Akurasi rendah, tinjau", tone: "warning" },
  { key: "rejected", label: "Ditolak geofence", tone: "danger" },
  { key: "completed", label: "Sudah selesai", tone: "neutral" },
];

const scenarioCopy: Record<Scenario, string> = {
  accepted: "Presensi diterima dan siap ditampilkan sebagai tersinkron.",
  pending: "Perangkat sedang offline. Data aman di antrean simulasi.",
  accuracy: "Akurasi GPS 142 m. Minta tinjauan sebelum mengirim presensi.",
  rejected: "Jarak 342 m dari lokasi terdaftar. Presensi simulasi ditolak.",
  completed: "Check-in dan check-out hari ini sudah lengkap.",
};

export function MemberView({ activeNav }: MemberViewProps) {
  const dashboard = getMemberDashboard();
  const today = dashboard.attendance.find((row) => row.date === "2026-08-06");
  const [scenario, setScenario] = useState<Scenario>("accepted");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [photoVersion, setPhotoVersion] = useState(1);
  const [eventState, setEventState] = useState<AttendanceEventState>({
    status: today?.status ?? "unknown",
    syncState: today?.syncState ?? "idle",
  });
  const checkedIn = ["present", "late", "outside-geofence", "anomaly", "pending-sync", "review-required"].includes(eventState.status);
  const pendingCount = eventState.syncState === "queued" ? dashboard.syncState.pendingCount + 1 : dashboard.syncState.pendingCount;

  function submitAttendance() {
    const next = simulateAttendanceEvent(eventState, checkedIn ? "check-out" : scenario === "pending" ? "check-in-offline" : "check-in");
    setEventState(next);
    setScenario(checkedIn ? "completed" : next.syncState === "queued" ? "pending" : "accepted");
    setCaptureOpen(false);
  }

  if (activeNav === "Riwayat") return <HistoryPanel dashboard={dashboard} />;
  if (activeNav === "Profil") return <ProfilePanel user={dashboard.user} pendingCount={pendingCount} />;

  return (
    <div className="member-view">
      <section className="member-hero" aria-labelledby="member-title">
        <div>
          <p className="eyebrow">Kamis, 6 Agustus 2026</p>
          <h1 id="member-title">Selamat pagi, {dashboard.user.name.split(" ")[0]}.</h1>
          <p>Shift Pagi <strong>06:00–14:00</strong> · Operasional</p>
        </div>
        <StatusBadge tone={scenario === "rejected" ? "danger" : scenario === "pending" ? "warning" : "success"}>
          {scenario === "pending" ? "Menunggu sinkron" : scenario === "rejected" ? "Perlu perhatian" : scenario === "completed" ? "Sudah selesai" : checkedIn ? "Sudah check-in" : "Belum check-in"}
        </StatusBadge>
      </section>

      <section className="member-attendance-card" aria-label="Presensi hari ini">
        <div className="member-attendance-card__top"><span>Presensi hari ini</span><span className="member-time">{today?.checkIn ?? "--:--"}</span></div>
        <div className="member-location"><span className="location-dot" aria-hidden="true" /><span><strong>Kantor Pusat</strong><small>GPS simulasi · akurasi 18 m · di dalam geofence</small></span></div>
        <button className="member-primary-action" onClick={() => setCaptureOpen(true)} type="button" disabled={scenario === "completed"}>{checkedIn ? "Check-out sekarang" : "Check-in sekarang"}</button>
        <p className="member-explanation">Foto dan lokasi hanya ditampilkan sebagai simulasi. Tidak ada kamera, GPS, atau data perangkat yang diakses.</p>
      </section>

      <div className="member-notice"><span aria-hidden="true">↻</span><span><strong>{pendingCount} data menunggu sinkronisasi</strong><small>Mode offline aktif · akan tersinkron saat koneksi tersedia</small></span></div>

      <section className="member-section" aria-labelledby="scenario-title">
        <div className="member-section-heading"><div><p className="eyebrow">Ruang uji</p><h2 id="scenario-title">Skenario simulasi</h2></div><span className="member-demo-label">MOCK ONLY</span></div>
        <p className="member-muted">Pilih status untuk meninjau acceptance case tanpa izin perangkat.</p>
        <div className="scenario-list">{scenarios.map((item) => <button className={`scenario-button ${scenario === item.key ? "is-active" : ""}`} key={item.key} onClick={() => setScenario(item.key)} type="button"><StatusBadge tone={item.tone}>{item.label}</StatusBadge><span aria-hidden="true">›</span></button>)}</div>
        <p className="scenario-description" aria-live="polite">{scenarioCopy[scenario]}</p>
      </section>

      <div className="member-metrics"><Metric value="20" label="Hari kerja bulan ini" /><Metric value="1" label="Terlambat" /><Metric value="7j 54m" label="Rata-rata kerja" /></div>

      {captureOpen ? <CapturePanel checkedIn={checkedIn} photoVersion={photoVersion} onRetake={() => setPhotoVersion((value) => value + 1)} onCancel={() => setCaptureOpen(false)} onSubmit={submitAttendance} /> : null}
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }

function CapturePanel({ checkedIn, photoVersion, onRetake, onCancel, onSubmit }: { checkedIn: boolean; photoVersion: number; onRetake: () => void; onCancel: () => void; onSubmit: () => void }) {
  return <div className="capture-backdrop" role="presentation"><section className="capture-panel" role="dialog" aria-modal="true" aria-labelledby="capture-title"><div className="capture-panel__header"><div><p className="eyebrow">Bukti presensi simulasi</p><h2 id="capture-title">Ambil foto {checkedIn ? "untuk check-out" : "untuk check-in"}</h2></div><button className="icon-button" onClick={onCancel} aria-label="Tutup" type="button">×</button></div><div className="fake-camera"><div className="camera-corner" /><span>PREVIEW KAMERA</span><small>Foto simulasi #{photoVersion}</small></div><div className="capture-details"><div><span>GPS</span><strong>18 m · akurat</strong></div><div><span>Geofence</span><strong className="text-success">Diterima</strong></div><div><span>Watermark</span><strong>06/08/2026 · 07:54 WIB</strong></div></div><p className="member-explanation">Metadata watermark adalah contoh tampilan. Ambil ulang tidak menggunakan kamera sungguhan.</p><div className="capture-actions"><button className="button-secondary" onClick={onRetake} type="button">Ambil ulang</button><button className="button-secondary" onClick={onCancel} type="button">Batal</button><button className="button-primary" onClick={onSubmit} type="button">Gunakan foto</button></div></section></div>;
}

function HistoryPanel({ dashboard }: { dashboard: ReturnType<typeof getMemberDashboard> }) {
  const rows = ["2026-08-06", "2026-08-05", "2026-08-04", "2026-08-03", "2026-08-02", "2026-08-01", "2026-07-31"].map((date, index) => dashboard.attendance.find((row) => row.date === date) ?? { date, checkIn: index === 2 ? "07:58" : "08:00", checkOut: index === 2 ? "17:02" : "17:00", status: "present" as const, syncState: "synced" as const });
  return <div className="member-view"><PageIntro eyebrow="Catatan personal" title="Riwayat presensi" copy="Tujuh hari terakhir dan ringkasan bulan berjalan." /><SectionCard title="7 hari terakhir" eyebrow="Agustus 2026"><div className="history-list">{rows.map((row) => <div className="history-row" key={row.date}><span><strong>{formatDate(row.date)}</strong><small>{row.checkIn ?? "Belum check-in"} – {row.checkOut ?? "Belum check-out"}</small></span><StatusBadge tone={row.status === "pending-sync" ? "warning" : row.status === "late" ? "accent" : "success"}>{row.status === "pending-sync" ? "Pending" : row.status === "late" ? "Terlambat" : "Hadir"}</StatusBadge></div>)}</div></SectionCard><div className="member-metrics"><Metric value="20" label="Hari kerja" /><Metric value="1" label="Terlambat" /><Metric value="155j" label="Total bekerja" /></div></div>;
}

function ProfilePanel({ user, pendingCount }: { user: ReturnType<typeof getMemberDashboard>["user"]; pendingCount: number }) {
  return <div className="member-view"><PageIntro eyebrow="Akun personal" title="Profil saya" copy="Informasi akun yang digunakan dalam prototipe ini." /><SectionCard title={user.name} eyebrow="Anggota aktif"><dl className="profile-list"><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Peran</dt><dd>Anggota</dd></div><div><dt>Tim</dt><dd>Operasional</dd></div><div><dt>Status pekerjaan</dt><dd><StatusBadge tone="success">Aktif</StatusBadge></dd></div></dl></SectionCard><div className="logout-warning"><strong>Keluar dari akun?</strong><p>{pendingCount > 0 ? `Ada ${pendingCount} data pending. Keluar tidak menghapus data simulasi, tetapi sinkronisasi belum selesai.` : "Data prototipe tidak disimpan."}</p><button className="button-secondary" type="button">Batal</button><button className="button-secondary" type="button" disabled>Keluar (simulasi)</button></div></div>;
}

function PageIntro({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <div className="member-page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>; }
function formatDate(date: string) { return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`)); }
