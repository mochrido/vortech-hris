"use client";

import { useMemo, useState } from "react";

import { getManagerDashboard } from "../lib/demo/selectors";
import type { AttendanceStatus } from "../lib/demo/types";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

type ManagerViewProps = { activeNav: string };

type RowStatus = {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "accent";
  symbol: string;
};

type CorrectionDecision = "review-required" | "approved" | "rejected";

const TODAY = "2026-08-06";
const REVIEW_STATES: Record<CorrectionDecision, { label: string; tone: "warning" | "success" | "danger" }> = {
  "review-required": { label: "Menunggu tinjauan", tone: "warning" },
  approved: { label: "Disetujui (simulasi)", tone: "success" },
  rejected: { label: "Ditolak (simulasi)", tone: "danger" },
};

function rowStatus(status: AttendanceStatus, syncState: string): RowStatus {
  if (status === "outside-geofence") return { label: "Di luar geofence", tone: "danger", symbol: "▲" };
  if (status === "pending-sync" || syncState === "queued") return { label: "Menunggu sinkronisasi", tone: "warning", symbol: "↻" };
  if (syncState === "failed") return { label: "Sinkronisasi gagal", tone: "danger", symbol: "!" };
  if (status === "review-required") return { label: "Perlu tinjauan", tone: "warning", symbol: "?" };
  if (status === "anomaly") return { label: "Anomali", tone: "danger", symbol: "▲" };
  if (status === "late") return { label: "Terlambat", tone: "accent", symbol: "◷" };
  if (status === "present") return { label: "Hadir", tone: "success", symbol: "✓" };
  return { label: "Belum check-in", tone: "neutral", symbol: "–" };
}

export function ManagerView({ activeNav }: ManagerViewProps) {
  const dashboard = getManagerDashboard();
  const [decisions, setDecisions] = useState<Record<string, CorrectionDecision>>({});
  const locationNames = useMemo(
    () => ({ "location-kantor-pusat": "Kantor Pusat", "location-gudang-timur": "Gudang Timur" }) as Record<string, string>,
    [],
  );

  const todayRows = dashboard.attendance.filter((row) => row.date === TODAY);
  const metrics = {
    present: todayRows.filter((row) => row.status === "present").length,
    late: todayRows.filter((row) => row.status === "late").length,
    notCheckedIn: todayRows.filter((row) => row.status === "unknown" || row.status === "absent").length,
    anomaly: todayRows.filter((row) => ["outside-geofence", "anomaly", "pending-sync", "review-required"].includes(row.status) || row.syncState === "failed").length,
  };
  const pendingCorrections = dashboard.correctionRequests.filter((request) => (decisions[request.key] ?? request.status) === "review-required");

  if (activeNav === "Koreksi") {
    return (
      <div className="mgmt-view">
        <div className="mgmt-page-intro">
          <p className="eyebrow">Tinjauan tim · {dashboard.team.name}</p>
          <h1>Koreksi kehadiran</h1>
          <p>Semua pengajuan koreksi anggota tim. Keputusan pada halaman ini hanya simulasi di memori peramban.</p>
        </div>
        <SimulationNote />
        <SectionCard eyebrow={`${dashboard.correctionRequests.length} pengajuan`} title="Semua koreksi">
          <CorrectionList
            corrections={dashboard.correctionRequests}
            decisions={decisions}
            dashboard={dashboard}
            onDecide={(key, decision) => setDecisions((value) => ({ ...value, [key]: decision }))}
          />
        </SectionCard>
      </div>
    );
  }

  if (activeNav === "Tim") {
    return (
      <div className="mgmt-view">
        <div className="mgmt-page-intro">
          <p className="eyebrow">Tim {dashboard.team.name}</p>
          <h1>Kehadiran tim hari ini</h1>
          <p>Rekap Kamis, 6 Agustus 2026 untuk {dashboard.users.length} anggota tim, termasuk indikator lokasi dan sinkronisasi.</p>
        </div>
        <SimulationNote />
        <SectionCard eyebrow="Hari ini" title="Tabel kehadiran tim">
          <TeamTable dashboard={dashboard} rows={todayRows} locationNames={locationNames} showAllDays={false} />
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="mgmt-view">
      <div className="mgmt-page-intro">
        <p className="eyebrow">Ringkasan · Tim {dashboard.team.name}</p>
        <h1>Kamis, 6 Agustus 2026</h1>
        <p>Pantauan kehadiran tim hari ini dan koreksi yang menunggu keputusan Anda. Data berasal dari fixture demo.</p>
      </div>
      <SimulationNote />
      <div className="mgmt-metrics" role="list" aria-label="Ringkasan kehadiran tim hari ini">
        <Metric label="Hadir" symbol="✓" tone="success" value={metrics.present} />
        <Metric label="Terlambat" symbol="◷" tone="accent" value={metrics.late} />
        <Metric label="Belum check-in" symbol="–" tone="neutral" value={metrics.notCheckedIn} />
        <Metric label="Anomali & perlu tindakan" symbol="▲" tone="danger" value={metrics.anomaly} />
      </div>
      <SectionCard eyebrow="Hari ini" title="Tabel kehadiran tim">
        <TeamTable dashboard={dashboard} rows={todayRows} locationNames={locationNames} showAllDays={false} />
      </SectionCard>
      <SectionCard eyebrow={`${pendingCorrections.length} menunggu`} title="Koreksi menunggu keputusan">
        {pendingCorrections.length === 0 ? (
          <p className="mgmt-empty">Semua koreksi sudah ditinjau. Tidak ada antrean keputusan.</p>
        ) : (
          <CorrectionList
            corrections={pendingCorrections}
            decisions={decisions}
            dashboard={dashboard}
            onDecide={(key, decision) => setDecisions((value) => ({ ...value, [key]: decision }))}
          />
        )}
      </SectionCard>
    </div>
  );
}

type Dashboard = ReturnType<typeof getManagerDashboard>;

function Metric({ label, symbol, tone, value }: { label: string; symbol: string; tone: string; value: number }) {
  return (
    <div className={`mgmt-metric mgmt-metric--${tone}`} role="listitem">
      <span className="mgmt-metric__mark" aria-hidden="true">{symbol}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function TeamTable({
  dashboard,
  locationNames,
  rows,
  showAllDays,
}: {
  dashboard: Dashboard;
  locationNames: Record<string, string>;
  rows: Dashboard["attendance"];
  showAllDays: boolean;
}) {
  if (rows.length === 0) return <p className="mgmt-empty">Belum ada catatan kehadiran untuk ditampilkan.</p>;
  return (
    <div className="mgmt-table-wrap">
      <table>
        <caption className="sr-only">Kehadiran anggota tim {showAllDays ? "semua tanggal" : "hari ini"}</caption>
        <thead>
          <tr>
            <th scope="col">Nama</th>
            <th scope="col">Status</th>
            <th scope="col">Check-in</th>
            <th scope="col">Check-out</th>
            <th scope="col">Lokasi</th>
            <th scope="col">Geofence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const user = dashboard.users.find((item) => item.key === row.userKey);
            const status = rowStatus(row.status, row.syncState);
            const flagged = row.status === "outside-geofence" || row.syncState === "failed";
            return (
              <tr className={flagged ? "mgmt-row--flagged" : undefined} key={row.key}>
                <td data-th="Nama">
                  <strong>{user?.name ?? row.userKey}</strong>
                  {showAllDays ? <small className="mgmt-cell-sub">{row.date}</small> : null}
                </td>
                <td data-th="Status">
                  <StatusBadge tone={status.tone}>
                    <span aria-hidden="true">{status.symbol} </span>
                    {status.label}
                  </StatusBadge>
                </td>
                <td data-th="Check-in">{row.checkIn ?? "--:--"}</td>
                <td data-th="Check-out">{row.checkOut ?? "--:--"}</td>
                <td data-th="Lokasi">{row.locationKey ? locationNames[row.locationKey] ?? row.locationKey : "Belum ada"}</td>
                <td data-th="Geofence">
                  <span className={`mgmt-geofence ${flagged ? "mgmt-geofence--out" : ""}`}>
                    <span aria-hidden="true">{flagged ? "▲ " : "✓ "}</span>
                    {flagged ? "Di luar" : row.status === "unknown" || row.status === "absent" ? "Belum dinilai" : "Di dalam"}
                  </span>
                  {row.note ? <small className="mgmt-cell-sub">{row.note}</small> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CorrectionList({
  corrections,
  dashboard,
  decisions,
  onDecide,
}: {
  corrections: Dashboard["correctionRequests"];
  dashboard: Dashboard;
  decisions: Record<string, CorrectionDecision>;
  onDecide: (key: string, decision: CorrectionDecision) => void;
}) {
  if (corrections.length === 0) return <p className="mgmt-empty">Belum ada pengajuan koreksi dari tim.</p>;
  return (
    <ul className="correction-list">
      {corrections.map((request) => {
        const decision = decisions[request.key] ?? request.status;
        const state = REVIEW_STATES[decision];
        const user = dashboard.users.find((item) => item.key === request.userKey);
        const attendance = dashboard.attendance.find((row) => row.key === request.attendanceKey);
        return (
          <li className="correction-card" key={request.key}>
            <div className="correction-card__body">
              <div className="correction-card__heading">
                <strong>{user?.name ?? request.userKey}</strong>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </div>
              <p>
                {attendance ? `Kehadiran ${attendance.date} · check-in ${attendance.checkIn ?? "--:--"} · check-out ${attendance.checkOut ?? "--:--"}. ` : ""}
                Alasan: {request.reason}.
              </p>
            </div>
            <div className="correction-card__actions">
              {decision === "review-required" ? (
                <>
                  <button className="button-primary correction-approve" onClick={() => onDecide(request.key, "approved")} type="button">
                    Setujui (simulasi)
                  </button>
                  <button className="button-secondary" onClick={() => onDecide(request.key, "rejected")} type="button">
                    Tolak (simulasi)
                  </button>
                </>
              ) : (
                <button className="button-secondary" onClick={() => onDecide(request.key, "review-required")} type="button">
                  Batalkan keputusan
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SimulationNote() {
  return (
    <p className="mgmt-simulation-note" role="note">
      <span aria-hidden="true">ⓘ</span> Tampilan simulasi — keputusan dan perubahan hanya berlaku di sesi pratinjau ini, tidak tersimpan, dan tidak memberikan otorisasi apa pun.
    </p>
  );
}
