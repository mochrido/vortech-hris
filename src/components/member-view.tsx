"use client";

import { useEffect, useRef, useState } from "react";

import { getMemberDashboard, simulateAttendanceEvent } from "../lib/demo/selectors";
import type { AttendanceEventState } from "../lib/demo/types";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

type MemberViewProps = { activeNav: string };
type Scenario = "accepted" | "pending" | "accuracy" | "rejected" | "completed";
type CaptureMetadata = { accuracy: string; geofence: string; tone: "success" | "warning" | "danger" | "neutral"; note: string };

const scenarios: { key: Scenario; label: string; tone: "success" | "warning" | "danger" | "neutral" }[] = [
  { key: "accepted", label: "Diterima & tersinkron", tone: "success" },
  { key: "pending", label: "Pending / offline", tone: "warning" },
  { key: "accuracy", label: "Akurasi rendah, tinjau", tone: "warning" },
  { key: "rejected", label: "Ditolak geofence", tone: "danger" },
  { key: "completed", label: "Sudah selesai", tone: "neutral" },
];

const metadata: Record<Scenario, CaptureMetadata> = {
  accepted: { accuracy: "18 m · akurat", geofence: "Diterima", tone: "success", note: "Lokasi simulasi berada di dalam geofence Kantor Pusat." },
  pending: { accuracy: "18 m · akurat", geofence: "Diterima", tone: "success", note: "Presensi akan masuk antrean karena mode offline simulasi aktif." },
  accuracy: { accuracy: "142 m · rendah", geofence: "Tinjau", tone: "warning", note: "Akurasi terlalu rendah. Kirim untuk ditinjau, tanpa mengubah status hadir." },
  rejected: { accuracy: "342 m · akurat", geofence: "Ditolak", tone: "danger", note: "Jarak simulasi melewati radius lokasi terdaftar. Presensi tidak akan disimpan." },
  completed: { accuracy: "18 m · akurat", geofence: "Selesai", tone: "neutral", note: "Check-in dan check-out simulasi hari ini sudah lengkap." },
};

export function MemberView({ activeNav }: MemberViewProps) {
  const dashboard = getMemberDashboard();
  const [scenario, setScenario] = useState<Scenario>("accepted");
  const [eventState, setEventState] = useState<AttendanceEventState>({ status: "unknown", syncState: "idle" });
  const [completed, setCompleted] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [photoConfirmed, setPhotoConfirmed] = useState(false);
  const [photoVersion, setPhotoVersion] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [emptyHistory, setEmptyHistory] = useState(false);
  const [emptyProfile, setEmptyProfile] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const checkedIn = eventState.status !== "unknown" && eventState.status !== "absent" && !completed;
  const pendingCount = dashboard.syncState.pendingCount + (eventState.syncState === "queued" ? 1 : 0);

  function openCapture() {
    if (completed) return;
    setError("");
    setPhotoConfirmed(false);
    setCaptureOpen(true);
  }

  function closeCapture() {
    setCaptureOpen(false);
    setPhotoConfirmed(false);
    window.setTimeout(() => openerRef.current?.focus(), 0);
  }

  function confirmPhoto() { setPhotoConfirmed(true); }

  function submitAttendance() {
    if (completed) return;
    if (scenario === "rejected") { setError("Presensi ditolak: di luar geofence simulasi."); return; }
    if (scenario === "accuracy") { setError("Presensi ditahan untuk tinjauan karena akurasi GPS simulasi rendah."); return; }
    try {
      const next = simulateAttendanceEvent(eventState, checkedIn ? "check-out" : scenario === "pending" ? "check-in-offline" : "check-in");
      setEventState(next);
      if (checkedIn) setCompleted(true);
      closeCapture();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Presensi simulasi gagal.");
    }
  }

  function selectScenario(next: Scenario) {
    if (!completed) { setScenario(next); setCompleted(next === "completed"); setError(""); }
  }

  if (activeNav === "Riwayat") return <HistoryPanel dashboard={dashboard} empty={emptyHistory} onToggleEmpty={() => setEmptyHistory((value) => !value)} />;
  if (activeNav === "Profil") return <ProfilePanel user={dashboard.user} pendingCount={pendingCount} empty={emptyProfile} onToggleEmpty={() => setEmptyProfile((value) => !value)} />;

  const selectedMetadata = metadata[scenario];
  const actionLabel = completed ? "Presensi hari ini selesai" : checkedIn ? "Check-out sekarang" : "Check-in sekarang";
  return (
    <div className="member-view" aria-busy={loading}>
      <section className="member-hero" aria-labelledby="member-title"><div><p className="eyebrow">Kamis, 6 Agustus 2026</p><h1 id="member-title">Selamat pagi, {dashboard.user.name.split(" ")[0]}.</h1><p>Shift Pagi <strong>06:00–14:00</strong> · Operasional</p></div><StatusBadge tone={scenario === "rejected" ? "danger" : scenario === "pending" ? "warning" : "success"}>{completed ? "Sudah selesai" : scenario === "pending" ? "Menunggu sinkron" : scenario === "rejected" ? "Perlu perhatian" : checkedIn ? "Sudah check-in" : "Belum check-in"}</StatusBadge></section>
      <section className="member-attendance-card" aria-label="Presensi hari ini"><div className="member-attendance-card__top"><span>Presensi hari ini</span><span className="member-time">{dashboard.today?.checkIn ?? "--:--"}</span></div><div className="member-location"><span className="location-dot" aria-hidden="true" /><span><strong>Kantor Pusat</strong><small>GPS simulasi · {selectedMetadata.accuracy} · {selectedMetadata.geofence.toLowerCase()}</small></span></div><button className="member-primary-action" disabled={completed || loading} onClick={() => { openerRef.current = document.activeElement as HTMLButtonElement; openCapture(); }} ref={openerRef} type="button">{actionLabel}</button><p className="member-explanation">Foto dan lokasi hanya ditampilkan sebagai simulasi. Tidak ada kamera, GPS, atau data perangkat yang diakses.</p></section>
      <div className="member-notice"><span aria-hidden="true">↻</span><span><strong>{pendingCount} data menunggu sinkronisasi</strong><small>Mode offline aktif · data simulasi pending tetap terlihat</small></span></div>
      {error ? <div className="member-error" role="alert"><strong>Perlu perhatian</strong><span>{error}</span></div> : null}
      <section className="member-section" aria-labelledby="scenario-title"><div className="member-section-heading"><div><p className="eyebrow">Ruang uji</p><h2 id="scenario-title">Skenario simulasi</h2></div><span className="member-demo-label">MOCK ONLY</span></div><p className="member-muted">Pilihan mengubah metadata capture dan perilaku kirim, tanpa izin perangkat.</p><div className="scenario-list">{scenarios.map((item) => <button className={`scenario-button ${scenario === item.key ? "is-active" : ""}`} disabled={completed && item.key !== "completed"} key={item.key} onClick={() => selectScenario(item.key)} type="button"><StatusBadge tone={item.tone}>{item.label}</StatusBadge><span aria-hidden="true">›</span></button>)}</div><p className="scenario-description" aria-live="polite">{selectedMetadata.note}</p></section>
      <div className="member-metrics"><Metric value={`${Math.floor(dashboard.monthlySummary.workedMinutes / 60)}j ${dashboard.monthlySummary.workedMinutes % 60}m`} label="Total bekerja bulan ini" /><Metric value={`${dashboard.monthlySummary.lateCount}`} label="Terlambat bulan ini" /><Metric value={`${pendingCount}`} label="Pending sinkronisasi" /></div>
      <div className="member-demo-actions"><button className="button-secondary member-reload" disabled={loading} onClick={() => { setLoading(true); window.setTimeout(() => { setEventState({ status: "unknown", syncState: "idle" }); setCompleted(false); setScenario("accepted"); setError(""); setLoading(false); }, 500); }} type="button">{loading ? "Memuat contoh..." : "Muat ulang data demo"}</button><button className="button-secondary" onClick={() => setError("Contoh gangguan umum: data demo tidak dapat diproses. Coba lagi.")} type="button">Contoh galat umum</button></div>
      {captureOpen ? <CapturePanel checkedIn={checkedIn} confirmed={photoConfirmed} data={selectedMetadata} photoVersion={photoVersion} onConfirm={confirmPhoto} onRetake={() => { setPhotoVersion((value) => value + 1); setPhotoConfirmed(false); }} onCancel={closeCapture} onSubmit={submitAttendance} /> : null}
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }

function CapturePanel({ checkedIn, confirmed, data, photoVersion, onConfirm, onRetake, onCancel, onSubmit }: { checkedIn: boolean; confirmed: boolean; data: CaptureMetadata; photoVersion: number; onConfirm: () => void; onRetake: () => void; onCancel: () => void; onSubmit: () => void }) {
  const initialRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { initialRef.current?.focus(); }, []);
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { onCancel(); return; }
    if (event.key !== "Tab") return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)");
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  const toneClass = data.tone === "success" ? "text-success" : data.tone === "warning" ? "text-warning" : data.tone === "danger" ? "text-danger" : "";
  return <div className="capture-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation"><section className="capture-panel" onKeyDown={handleKeyDown} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="capture-title"><div className="capture-panel__header"><div><p className="eyebrow">Bukti presensi simulasi</p><h2 id="capture-title">{confirmed ? "Konfirmasi presensi" : `Ambil foto ${checkedIn ? "untuk check-out" : "untuk check-in"}`}</h2></div><button className="icon-button" onClick={onCancel} ref={initialRef} aria-label="Tutup" type="button">×</button></div><div className="fake-camera"><div className="camera-corner" /><span>PREVIEW KAMERA</span><small>Foto simulasi #{photoVersion}</small></div><div className="capture-details"><div><span>GPS</span><strong className={toneClass}>{data.accuracy}</strong></div><div><span>Geofence</span><strong className={toneClass}>{data.geofence}</strong></div><div><span>Watermark</span><strong>06/08/2026 · 07:54 WIB</strong></div></div><p className="member-explanation">Metadata watermark adalah contoh tampilan. Tidak ada kamera atau GPS sungguhan.</p><div className="capture-actions"><button className="button-secondary" onClick={onRetake} type="button">Ambil ulang</button><button className="button-secondary" onClick={onCancel} type="button">Batal</button>{confirmed ? <button className="button-primary" onClick={onSubmit} type="button">Kirim presensi simulasi</button> : <button className="button-primary" onClick={onConfirm} type="button">Gunakan foto</button>}</div></section></div>;
}

function HistoryPanel({ dashboard, empty, onToggleEmpty }: { dashboard: ReturnType<typeof getMemberDashboard>; empty: boolean; onToggleEmpty: () => void }) {
  return <div className="member-view"><PageIntro eyebrow="Catatan personal" title="Riwayat presensi" copy="Tujuh hari terakhir dan ringkasan bulan berjalan." /><SectionCard title="7 hari terakhir" eyebrow="Agustus 2026"><button className="button-secondary" onClick={onToggleEmpty} type="button">{empty ? "Tampilkan riwayat" : "Contoh keadaan kosong"}</button>{empty ? <p className="member-empty">Belum ada riwayat presensi untuk ditampilkan.</p> : <div className="history-list">{dashboard.history.map((row) => <div className="history-row" key={row.key}><span><strong>{formatDate(row.date)}</strong><small>{row.checkIn ?? "Belum check-in"} – {row.checkOut ?? "Belum check-out"}</small></span><StatusBadge tone={row.status === "pending-sync" ? "warning" : row.status === "late" ? "accent" : row.status === "unknown" ? "neutral" : "success"}>{row.status === "pending-sync" ? "Pending" : row.status === "late" ? "Terlambat" : row.status === "unknown" ? "Belum mulai" : "Hadir"}</StatusBadge></div>)}</div>}</SectionCard><div className="member-metrics"><Metric value={`${Math.floor(dashboard.monthlySummary.workedMinutes / 60)}j ${dashboard.monthlySummary.workedMinutes % 60}m`} label="Total bekerja" /><Metric value={`${dashboard.monthlySummary.lateCount}`} label="Terlambat" /></div></div>;
}

function ProfilePanel({ user, pendingCount, empty, onToggleEmpty }: { user: ReturnType<typeof getMemberDashboard>["user"]; pendingCount: number; empty: boolean; onToggleEmpty: () => void }) {
  return <div className="member-view"><PageIntro eyebrow="Akun personal" title="Profil saya" copy="Informasi akun yang digunakan dalam prototipe ini." /><SectionCard title={empty ? "Profil kosong" : user.name} eyebrow="Profil simulasi"><button className="button-secondary" onClick={onToggleEmpty} type="button">{empty ? "Tampilkan profil" : "Contoh profil kosong"}</button>{empty ? <p className="member-empty">Detail profil belum tersedia pada contoh keadaan kosong.</p> : <dl className="profile-list"><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Peran akun</dt><dd>Anggota</dd></div><div><dt>Tim</dt><dd>Operasional</dd></div><div><dt>Jenis kepegawaian</dt><dd>Penuh waktu</dd></div><div><dt>Status akun</dt><dd><StatusBadge tone="success">Aktif</StatusBadge></dd></div></dl>}</SectionCard><div className="logout-warning"><strong>Keluar dari akun?</strong><p>{pendingCount > 0 ? `Ada ${pendingCount} data pending. Keluar tidak menghapus data simulasi, tetapi sinkronisasi belum selesai.` : "Data prototipe tidak disimpan."}</p><button className="button-secondary" type="button">Batal</button><button className="button-secondary" disabled type="button">Keluar (simulasi)</button></div></div>;
}

function PageIntro({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <div className="member-page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>; }
function formatDate(date: string) { return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`)); }
