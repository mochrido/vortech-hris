"use client";

import { useEffect, useRef, useState } from "react";

import { deriveMemberAttendanceDisplay, getMemberDashboard, submitMemberAttendance } from "../lib/demo/selectors";
import type { AttendanceEventState, AttendanceScenario } from "../lib/demo/types";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

type MemberViewProps = { activeNav: string };
type Scenario = AttendanceScenario;
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
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [photoConfirmed, setPhotoConfirmed] = useState(false);
  const [photoVersion, setPhotoVersion] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [emptyHistory, setEmptyHistory] = useState(false);
  const [emptyProfile, setEmptyProfile] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const checkedIn = eventState.status !== "unknown" && eventState.status !== "absent";
  const transitionLocked = eventState.checkOutCompleted === true || eventState.status === "pending-sync" || eventState.status === "review-required";
  const pendingCount = dashboard.syncState.pendingCount + (eventState.syncState === "queued" ? 1 : 0);
  const display = deriveMemberAttendanceDisplay(eventState, dashboard.today!, dashboard.history);

  function openCapture() {
    if (transitionLocked) return;
    setError("");
    setCaptureError("");
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
    if (transitionLocked) return;
    try {
      const result = submitMemberAttendance(eventState, scenario);
      if (!result.accepted) { setCaptureError(result.message); return; }
      setEventState(result.state);
      if (result.state.status === "review-required") setError("Presensi diterima untuk tinjauan. Status review-required tersimpan dalam simulasi.");
      closeCapture();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Presensi simulasi gagal.");
    }
  }

  function selectScenario(next: Scenario) {
    setScenario(next);
    setError("");
  }

  if (activeNav === "Riwayat") return <HistoryPanel dashboard={dashboard} history={display.history} empty={emptyHistory} onToggleEmpty={() => setEmptyHistory((value) => !value)} />;
  if (activeNav === "Profil") return <ProfilePanel user={dashboard.user} pendingCount={pendingCount} empty={emptyProfile} onToggleEmpty={() => setEmptyProfile((value) => !value)} />;

  const selectedMetadata = metadata[scenario];
  const actionLabel = eventState.checkOutCompleted ? "Presensi hari ini selesai" : eventState.status === "pending-sync" ? "Menunggu sinkronisasi" : eventState.status === "review-required" ? "Menunggu tinjauan" : checkedIn ? "Check-out sekarang" : "Check-in sekarang";
  const statusLabel = eventState.checkOutCompleted ? "Sudah selesai" : eventState.status === "review-required" ? "Menunggu tinjauan" : eventState.status === "pending-sync" ? "Menunggu sinkron" : checkedIn ? "Sudah check-in" : "Belum check-in";
  return (
    <div className="member-view" aria-busy={loading}>
      <section className="member-hero" aria-labelledby="member-title"><div><p className="eyebrow">Kamis, 6 Agustus 2026</p><h1 id="member-title">Selamat pagi, {dashboard.user.name.split(" ")[0]}.</h1><p>Shift Pagi <strong>06:00–14:00</strong> · Operasional</p></div><StatusBadge tone={eventState.status === "pending-sync" || eventState.status === "review-required" ? "warning" : "success"}>{statusLabel}</StatusBadge></section>
      <section className="member-attendance-card" aria-label="Presensi hari ini"><div className="member-attendance-card__top"><span>Presensi hari ini</span><span className="member-time">{display.today.checkIn ?? "--:--"}{display.today.checkOut ? <small> – {display.today.checkOut}</small> : null}</span></div><div className="member-location"><span className="location-dot" aria-hidden="true" /><span><strong>Kantor Pusat</strong><small>GPS simulasi · {selectedMetadata.accuracy} · {selectedMetadata.geofence.toLowerCase()}</small></span></div><button className="member-primary-action" disabled={transitionLocked || loading} onClick={() => { openerRef.current = document.activeElement as HTMLButtonElement; openCapture(); }} ref={openerRef} type="button">{actionLabel}</button><p className="member-explanation">Status hari ini: {statusLabel}. Foto dan lokasi hanya simulasi; tidak ada perangkat yang diakses.</p></section>
      <div className="member-notice"><span aria-hidden="true">↻</span><span><strong>{pendingCount} data menunggu sinkronisasi</strong><small>Mode offline aktif · data simulasi pending tetap terlihat</small></span></div>
      {error ? <div className="member-error" role="alert"><strong>Perlu perhatian</strong><span>{error}</span></div> : null}
      <section className="member-section" aria-labelledby="scenario-title"><div className="member-section-heading"><div><p className="eyebrow">Input demo, bukan status aktual</p><h2 id="scenario-title">Skenario simulasi</h2></div><span className="member-demo-label">MOCK ONLY</span></div><p className="member-muted">Pilihan hanya mengatur hasil kirim berikutnya dan tidak mengubah status presensi yang sudah ada.</p><div className="scenario-list">{scenarios.map((item) => <button aria-pressed={scenario === item.key} className={`scenario-button ${scenario === item.key ? "is-active" : ""}`} key={item.key} onClick={() => selectScenario(item.key)} type="button"><StatusBadge tone={item.tone}>{item.label}</StatusBadge><span aria-hidden="true">›</span></button>)}</div><p className="scenario-description" aria-live="polite">{selectedMetadata.note}</p></section>
      <div className="member-metrics"><Metric value={`${Math.floor(dashboard.monthlySummary.workedMinutes / 60)}j ${dashboard.monthlySummary.workedMinutes % 60}m`} label="Total bekerja bulan ini" /><Metric value={`${dashboard.monthlySummary.lateCount}`} label="Terlambat bulan ini" /><Metric value={`${pendingCount}`} label="Pending sinkronisasi" /></div>
      <div className="member-demo-actions"><button className="button-secondary member-reload" disabled={loading} onClick={() => { setLoading(true); window.setTimeout(() => { setEventState({ status: "unknown", syncState: "idle" }); setScenario("accepted"); setError(""); setLoading(false); }, 500); }} type="button">{loading ? "Memuat contoh..." : "Muat ulang data demo"}</button><button className="button-secondary" onClick={() => setError("Contoh gangguan umum: data demo tidak dapat diproses. Coba lagi.")} type="button">Contoh galat umum</button></div>
      {captureOpen ? <CapturePanel checkedIn={checkedIn} confirmed={photoConfirmed} data={selectedMetadata} error={captureError} photoVersion={photoVersion} onConfirm={confirmPhoto} onRetake={() => { setPhotoVersion((value) => value + 1); setPhotoConfirmed(false); setCaptureError(""); }} onCancel={closeCapture} onSubmit={submitAttendance} /> : null}
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }

function CapturePanel({ checkedIn, confirmed, data, error, photoVersion, onConfirm, onRetake, onCancel, onSubmit }: { checkedIn: boolean; confirmed: boolean; data: CaptureMetadata; error: string; photoVersion: number; onConfirm: () => void; onRetake: () => void; onCancel: () => void; onSubmit: () => void }) {
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
  return <div className="capture-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }} role="presentation"><section className="capture-panel" onKeyDown={handleKeyDown} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="capture-title"><div className="capture-panel__header"><div><p className="eyebrow">Bukti presensi simulasi</p><h2 id="capture-title">{confirmed ? "Konfirmasi presensi" : `Ambil foto ${checkedIn ? "untuk check-out" : "untuk check-in"}`}</h2></div><button className="icon-button" onClick={onCancel} ref={initialRef} aria-label="Tutup" type="button">×</button></div><div className="fake-camera"><div className="camera-corner" /><span>PREVIEW KAMERA</span><small>Foto simulasi #{photoVersion}</small></div><div className="capture-details"><div><span>GPS</span><strong className={toneClass}>{data.accuracy}</strong></div><div><span>Geofence</span><strong className={toneClass}>{data.geofence}</strong></div><div><span>Watermark</span><strong>06/08/2026 · 07:54 WIB</strong></div></div>{error ? <div className="capture-error" role="alert"><strong>Presensi tidak dikirim</strong><span>{error}</span></div> : null}<p className="member-explanation">Metadata watermark adalah contoh tampilan. Tidak ada kamera atau GPS sungguhan.</p><div className="capture-actions"><button className="button-secondary" onClick={onRetake} type="button">Ambil ulang</button><button className="button-secondary" onClick={onCancel} type="button">Batal</button>{confirmed ? <button className="button-primary" onClick={onSubmit} type="button">Kirim presensi simulasi</button> : <button className="button-primary" onClick={onConfirm} type="button">Gunakan foto</button>}</div></section></div>;
}

function HistoryPanel({ dashboard, history, empty, onToggleEmpty }: { dashboard: ReturnType<typeof getMemberDashboard>; history: ReturnType<typeof deriveMemberAttendanceDisplay>["history"]; empty: boolean; onToggleEmpty: () => void }) {
  return <div className="member-view"><PageIntro eyebrow="Catatan personal" title="Riwayat presensi" copy="Tujuh hari terakhir dan ringkasan bulan berjalan." /><SectionCard title="7 hari terakhir" eyebrow="Agustus 2026"><button className="button-secondary" onClick={onToggleEmpty} type="button">{empty ? "Tampilkan riwayat" : "Contoh keadaan kosong"}</button>{empty ? <p className="member-empty">Belum ada riwayat presensi untuk ditampilkan.</p> : <div className="history-list">{history.map((row) => <div className="history-row" key={row.key}><span><strong>{formatDate(row.date)}</strong><small>{row.checkIn ?? "Belum check-in"} – {row.checkOut ?? "Belum check-out"}</small></span><StatusBadge tone={row.status === "pending-sync" || row.status === "review-required" ? "warning" : row.status === "late" ? "accent" : row.status === "unknown" ? "neutral" : "success"}>{row.status === "pending-sync" ? "Pending" : row.status === "review-required" ? "Perlu tinjauan" : row.status === "late" ? "Terlambat" : row.status === "unknown" ? "Belum mulai" : row.checkOut ? "Selesai" : "Hadir"}</StatusBadge></div>)}</div>}</SectionCard><div className="member-metrics"><Metric value={`${Math.floor(dashboard.monthlySummary.workedMinutes / 60)}j ${dashboard.monthlySummary.workedMinutes % 60}m`} label="Total bekerja" /><Metric value={`${dashboard.monthlySummary.lateCount}`} label="Terlambat" /></div></div>;
}

function ProfilePanel({ user, pendingCount, empty, onToggleEmpty }: { user: ReturnType<typeof getMemberDashboard>["user"]; pendingCount: number; empty: boolean; onToggleEmpty: () => void }) {
  return <div className="member-view"><PageIntro eyebrow="Akun personal" title="Profil saya" copy="Informasi akun yang digunakan dalam prototipe ini." /><SectionCard title={empty ? "Profil kosong" : user.name} eyebrow="Profil simulasi"><button className="button-secondary" onClick={onToggleEmpty} type="button">{empty ? "Tampilkan profil" : "Contoh profil kosong"}</button>{empty ? <p className="member-empty">Detail profil belum tersedia pada contoh keadaan kosong.</p> : <dl className="profile-list"><div><dt>Email</dt><dd>{user.email}</dd></div><div><dt>Peran akun</dt><dd>Anggota</dd></div><div><dt>Tim</dt><dd>Operasional</dd></div><div><dt>Jenis kepegawaian</dt><dd>Penuh waktu</dd></div><div><dt>Status akun</dt><dd><StatusBadge tone="success">Aktif</StatusBadge></dd></div></dl>}</SectionCard><div className="logout-warning"><strong>Keluar dari akun?</strong><p>{pendingCount > 0 ? `Ada ${pendingCount} data pending. Keluar tidak menghapus data simulasi, tetapi sinkronisasi belum selesai.` : "Data prototipe tidak disimpan."}</p><button className="button-secondary" type="button">Batal</button><button className="button-secondary" disabled type="button">Keluar (simulasi)</button></div></div>;
}

function PageIntro({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) { return <div className="member-page-intro"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>; }
function formatDate(date: string) { return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`)); }
