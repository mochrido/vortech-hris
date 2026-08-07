"use client";

import { useState, type ReactElement } from "react";

import { getAdminOverview } from "../lib/demo/selectors";
import { MetricCard } from "./metric-card";
import { SectionCard } from "./section-card";
import { SimulationNote } from "./simulation-note";
import { StatusBadge } from "./status-badge";

type AdminViewProps = { activeNav: string };

const roleLabels: Record<string, string> = {
  member: "Anggota",
  manager: "Manajer",
  admin: "Administrator",
  superadmin: "Superadmin",
};

const workDayLabels = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

const reportTemplates = [
  { key: "report-recap", name: "Rekap kehadiran bulanan", format: "CSV", period: "Agustus 2026" },
  { key: "report-late", name: "Keterlambatan per tim", format: "CSV", period: "Agustus 2026" },
  { key: "report-anomaly", name: "Anomali & luar geofence", format: "CSV", period: "30 hari terakhir" },
];

const policyExamples = [
  { key: "policy-radius", name: "Radius geofence minimum", value: "100 m" },
  { key: "policy-late", name: "Batas toleransi keterlambatan", value: "10 menit" },
  { key: "policy-proof", name: "Bukti foto saat presensi", value: "Opsional" },
  { key: "policy-offline", name: "Presensi offline", value: "Diizinkan, wajib sinkron < 24 jam" },
];

const brandSwatches = [
  { key: "swatch-primary", label: "Primer", hex: "#b84c2b" },
  { key: "swatch-dark", label: "Gelap", hex: "#282a25" },
  { key: "swatch-canvas", label: "Latar", hex: "#f5f0e8" },
];

export function AdminView({ activeNav }: AdminViewProps) {
  const overview = getAdminOverview();
  const [showEmptyUsers, setShowEmptyUsers] = useState(false);
  const [locationName, setLocationName] = useState("");
  const [locationAttempted, setLocationAttempted] = useState(false);
  const [policyEmail, setPolicyEmail] = useState("");
  const [policyAttempted, setPolicyAttempted] = useState(false);

  const locationError = locationAttempted && locationName.trim() === "" ? "Nama lokasi wajib diisi." : "";
  const policyEmailError = policyAttempted && !/^\S+@\S+\.\S+$/.test(policyEmail) ? "Masukkan alamat email yang valid, contoh: admin@perusahaan.id." : "";

  const sections: Record<string, () => ReactElement> = {
    Ringkasan: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Ruang kerja organisasi</p>
          <h1>Administrasi perusahaan</h1>
          <p>Gambaran konfigurasi tenant demo. Gunakan navigasi untuk meninjau tiap area pengelolaan.</p>
        </div>
        <div className="mgmt-metrics" role="list" aria-label="Ringkasan administrasi">
          <MetricCard label="Pengguna terdaftar" value={overview.users.length} />
          <MetricCard label="Tim aktif" value={overview.teams.length} />
          <MetricCard label="Lokasi presensi" value={overview.locations.length} />
          <MetricCard label="Jadwal kerja" value={overview.schedules.length} />
        </div>
        <SectionCard eyebrow="Konfigurasi" title="Area pengelolaan">
          <ul className="admin-section-list">
            {["Pengguna — akun dan peran anggota", "Tim — struktur tim dan manajer", "Lokasi — titik presensi dan radius geofence", "Jadwal — jam kerja dan hari kerja", "Kebijakan — aturan presensi tenant", "Merek — logo dan warna tampilan", "Laporan — ekspor rekap CSV"].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </SectionCard>
      </>
    ),
    Pengguna: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Pengelolaan akun</p>
          <h1>Pengguna</h1>
          <p>Daftar akun tenant demo beserta peran dan status keaktifan.</p>
        </div>
        <SectionCard eyebrow={showEmptyUsers ? "Contoh keadaan kosong" : `${overview.users.length} akun`} title="Daftar pengguna">
          <div className="mgmt-toolbar">
            <button className="button-secondary" onClick={() => setShowEmptyUsers((value) => !value)} type="button">
              {showEmptyUsers ? "Tampilkan pengguna" : "Contoh keadaan kosong"}
            </button>
            <button className="button-primary mgmt-toolbar__primary" disabled title="Penambahan pengguna dinonaktifkan pada prototipe" type="button">
              Tambah pengguna (nonaktif)
            </button>
          </div>
          {showEmptyUsers ? (
            <div className="mgmt-empty">
              <strong>Belum ada pengguna.</strong>
              <p>Pada produk nyata, pengguna pertama biasanya ditambahkan melalui undangan email. Ini contoh keadaan kosong.</p>
            </div>
          ) : (
            <div className="mgmt-table-wrap">
              <table>
                <caption className="sr-only">Daftar pengguna tenant demo</caption>
                <thead>
                  <tr><th scope="col">Nama</th><th scope="col">Email</th><th scope="col">Peran</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {overview.users.map((user) => (
                    <tr key={user.key}>
                      <td data-th="Nama"><strong>{user.name}</strong></td>
                      <td data-th="Email">{user.email}</td>
                      <td data-th="Peran">{roleLabels[user.role]}</td>
                      <td data-th="Status">
                        <StatusBadge tone={user.active ? "success" : "neutral"}>
                          <span aria-hidden="true">{user.active ? "✓ " : "– "}</span>
                          {user.active ? "Aktif" : "Nonaktif"}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </>
    ),
    Tim: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Struktur organisasi</p>
          <h1>Tim</h1>
          <p>Susunan tim, manajer penanggung jawab, dan jumlah anggota.</p>
        </div>
        <SectionCard eyebrow={`${overview.teams.length} tim`} title="Daftar tim">
          <div className="mgmt-table-wrap">
            <table>
              <caption className="sr-only">Daftar tim tenant demo</caption>
              <thead>
                <tr><th scope="col">Tim</th><th scope="col">Manajer</th><th scope="col">Anggota</th><th scope="col">Aksi</th></tr>
              </thead>
              <tbody>
                {overview.teams.map((team) => {
                  const manager = overview.users.find((user) => user.key === team.managerKey);
                  return (
                    <tr key={team.key}>
                      <td data-th="Tim"><strong>{team.name}</strong></td>
                      <td data-th="Manajer">{manager?.name ?? "Belum diatur"}</td>
                      <td data-th="Anggota">{team.memberKeys.length} anggota</td>
                      <td data-th="Aksi">
                        <button className="button-secondary" disabled title="Pengelolaan tim dinonaktifkan pada prototipe" type="button">
                          Kelola (nonaktif)
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </>
    ),
    Lokasi: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Titik presensi</p>
          <h1>Lokasi</h1>
          <p>Lokasi terdaftar beserta koordinat dan radius geofence simulasi.</p>
        </div>
        <SectionCard eyebrow={`${overview.locations.length} lokasi`} title="Daftar lokasi">
          <div className="mgmt-table-wrap">
            <table>
              <caption className="sr-only">Daftar lokasi presensi tenant demo</caption>
              <thead>
                <tr><th scope="col">Lokasi</th><th scope="col">Alamat</th><th scope="col">Koordinat</th><th scope="col">Radius</th></tr>
              </thead>
              <tbody>
                {overview.locations.map((location) => (
                  <tr key={location.key}>
                    <td data-th="Lokasi"><strong>{location.name}</strong></td>
                    <td data-th="Alamat">{location.address}</td>
                    <td data-th="Koordinat">{location.latitude}, {location.longitude}</td>
                    <td data-th="Radius">{location.radiusMeters} m</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
        <SectionCard eyebrow="Contoh validasi formulir" title="Tambah lokasi (simulasi)">
          <form className="mgmt-form" noValidate onSubmit={(event) => { event.preventDefault(); setLocationAttempted(true); }}>
            <label className="mgmt-field" htmlFor="location-name">
              <span>Nama lokasi</span>
              <input
                aria-describedby={locationError ? "location-name-error" : "location-name-hint"}
                aria-invalid={locationError ? true : undefined}
                id="location-name"
                onChange={(event) => setLocationName(event.target.value)}
                placeholder="Contoh: Kantor Cabang Bandung"
                type="text"
                value={locationName}
              />
            </label>
            {locationError ? (
              <p className="mgmt-field-error" id="location-name-error" role="alert">{locationError}</p>
            ) : (
              <p className="mgmt-field-hint" id="location-name-hint">Kolom wajib. Formulir ini hanya contoh dan tidak menyimpan data.</p>
            )}
            <button className="button-primary mgmt-form__submit" type="submit">Simpan lokasi (simulasi)</button>
          </form>
        </SectionCard>
      </>
    ),
    Jadwal: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Jam kerja</p>
          <h1>Jadwal</h1>
          <p>Pola jam kerja dan hari kerja yang menjadi acuan status kehadiran.</p>
        </div>
        <SectionCard eyebrow={`${overview.schedules.length} jadwal`} title="Daftar jadwal">
          <div className="mgmt-table-wrap">
            <table>
              <caption className="sr-only">Daftar jadwal kerja tenant demo</caption>
              <thead>
                <tr><th scope="col">Jadwal</th><th scope="col">Jam kerja</th><th scope="col">Hari kerja</th><th scope="col">Aksi</th></tr>
              </thead>
              <tbody>
                {overview.schedules.map((schedule) => (
                  <tr key={schedule.key}>
                    <td data-th="Jadwal"><strong>{schedule.name}</strong></td>
                    <td data-th="Jam kerja">{schedule.startTime} – {schedule.endTime}</td>
                    <td data-th="Hari kerja">{schedule.workDays.map((day) => workDayLabels[day]).join(", ")}</td>
                    <td data-th="Aksi">
                      <button className="button-secondary" disabled title="Ubah jadwal dinonaktifkan pada prototipe" type="button">
                        Ubah (nonaktif)
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </>
    ),
    Kebijakan: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Aturan presensi</p>
          <h1>Kebijakan</h1>
          <p>Contoh kebijakan tenant. Semua kontrol pada halaman ini dinonaktifkan atau hanya simulasi.</p>
        </div>
        <SectionCard eyebrow="Aturan aktif" title="Ringkasan kebijakan">
          <dl className="mgmt-policy-list">
            {policyExamples.map((policy) => (
              <div key={policy.key}>
                <dt>{policy.name}</dt>
                <dd>{policy.value}</dd>
              </div>
            ))}
          </dl>
          <label className="mgmt-toggle">
            <input disabled type="checkbox" />
            <span>Wajibkan bukti foto untuk semua presensi (nonaktif pada prototipe)</span>
          </label>
        </SectionCard>
        <SectionCard eyebrow="Contoh validasi" title="Kontak pemberitahuan kebijakan">
          <form className="mgmt-form" noValidate onSubmit={(event) => { event.preventDefault(); setPolicyAttempted(true); }}>
            <label className="mgmt-field" htmlFor="policy-email">
              <span>Email penerima pemberitahuan</span>
              <input
                aria-describedby={policyEmailError ? "policy-email-error" : "policy-email-hint"}
                aria-invalid={policyEmailError ? true : undefined}
                id="policy-email"
                onChange={(event) => setPolicyEmail(event.target.value)}
                placeholder="admin@perusahaan.id"
                type="email"
                value={policyEmail}
              />
            </label>
            {policyEmailError ? (
              <p className="mgmt-field-error" id="policy-email-error" role="alert">{policyEmailError}</p>
            ) : (
              <p className="mgmt-field-hint" id="policy-email-hint">Contoh validasi format email. Tidak ada data yang dikirim.</p>
            )}
            <button className="button-primary mgmt-form__submit" type="submit">Simpan kontak (simulasi)</button>
          </form>
        </SectionCard>
      </>
    ),
    Merek: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Identitas tampilan</p>
          <h1>Merek &amp; branding</h1>
          <p>Contoh pengaturan logo dan warna yang tampil pada antarmuka karyawan.</p>
        </div>
        <SectionCard eyebrow="Pratinjau" title="Identitas saat ini">
          <div className="brand-preview">
            <span className="brand-preview__mark" aria-hidden="true">L</span>
            <div>
              <strong>PT Langkah Nusantara</strong>
              <p>Logo dan warna contoh. Pratinjau tidak mengubah tampilan produk.</p>
            </div>
          </div>
          <div className="brand-swatches" role="list" aria-label="Warna merek contoh">
            {brandSwatches.map((swatch) => (
              <div className="brand-swatch" key={swatch.key} role="listitem">
                <span className="brand-swatch__box" style={{ background: swatch.hex }} />
                <span>{swatch.label} · {swatch.hex}</span>
              </div>
            ))}
          </div>
          <div className="mgmt-form">
            <label className="mgmt-field" htmlFor="brand-color">
              <span>Warna primer</span>
              <input disabled id="brand-color" type="color" value="#b84c2b" />
            </label>
            <button className="button-primary mgmt-form__submit" disabled title="Unggah logo dinonaktifkan pada prototipe" type="button">
              Unggah logo (nonaktif)
            </button>
          </div>
        </SectionCard>
      </>
    ),
    Laporan: () => (
      <>
        <div className="mgmt-page-intro">
          <p className="eyebrow">Ekspor data</p>
          <h1>Laporan</h1>
          <p>Template rekap yang pada produk nyata dapat diunduh sebagai CSV. Unduhan dinonaktifkan pada prototipe.</p>
        </div>
        <SectionCard eyebrow={`${reportTemplates.length} template`} title="Laporan CSV">
          <ul className="report-list">
            {reportTemplates.map((report) => (
              <li className="report-row" key={report.key}>
                <div>
                  <strong>{report.name}</strong>
                  <small>{report.format} · {report.period}</small>
                </div>
                <button className="button-secondary" disabled title="Unduh laporan dinonaktifkan pada prototipe" type="button">
                  Unduh CSV (nonaktif)
                </button>
              </li>
            ))}
          </ul>
          <p className="mgmt-field-hint">Pratinjau contoh baris laporan: <code>tanggal,nama,status,check_in,check_out</code></p>
        </SectionCard>
      </>
    ),
  };

  const renderSection = sections[activeNav] ?? sections.Ringkasan;
  return (
    <div className="mgmt-view">
      <SimulationNote>Tampilan simulasi — formulir dan tombol administrasi tidak menyimpan perubahan dan tidak memberikan otorisasi apa pun.</SimulationNote>
      {renderSection()}
    </div>
  );
}
