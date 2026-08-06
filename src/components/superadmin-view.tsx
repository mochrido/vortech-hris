"use client";

import { getSuperadminOverview } from "../lib/demo/selectors";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";

type SuperadminViewProps = { activeNav: string };

type SubscriptionStatus = "trial" | "active" | "past-due" | "suspended";

const subscriptionCopy: Record<SubscriptionStatus, { label: string; tone: "neutral" | "success" | "warning" | "danger"; symbol: string }> = {
  trial: { label: "Uji coba", tone: "neutral", symbol: "◔" },
  active: { label: "Aktif", tone: "success", symbol: "✓" },
  "past-due": { label: "Tagihan jatuh tempo", tone: "warning", symbol: "!" },
  suspended: { label: "Ditangguhkan", tone: "danger", symbol: "✕" },
};

const planLabels: Record<string, string> = {
  starter: "Starter",
  business: "Business",
  enterprise: "Enterprise",
};

const retentionPolicies = [
  { key: "retention-attendance", name: "Catatan presensi", period: "24 bulan", note: "Setelah itu data diagregasi tanpa identitas." },
  { key: "retention-photos", name: "Foto bukti presensi", period: "3 bulan", note: "Dihapus permanen dari penyimpanan utama." },
  { key: "retention-logs", name: "Log audit platform", period: "12 bulan", note: "Arsip hanya-baca untuk keperluan kepatuhan." },
];

export function SuperadminView({ activeNav }: SuperadminViewProps) {
  const overview = getSuperadminOverview();
  const tenantFlags = overview.featureFlags.filter((flag) => flag.scope === "tenant");
  const platformFlags = overview.featureFlags.filter((flag) => flag.scope === "platform");

  if (activeNav === "Tenant") {
    return (
      <div className="mgmt-view">
        <div className="mgmt-page-intro">
          <p className="eyebrow">Direktori platform</p>
          <h1>Tenant</h1>
          <p>Daftar tenant demo beserta paket, status langganan, dan tanggal pembaruan.</p>
        </div>
        <SimulationNote />
        <SectionCard eyebrow={`${overview.tenantSubscriptions.length} tenant`} title="Daftar tenant">
          <TenantTable subscriptions={overview.tenantSubscriptions} />
        </SectionCard>
        <SectionCard eyebrow="Contoh status" title="Kartu status langganan">
          <SubscriptionCards subscriptions={overview.tenantSubscriptions} />
        </SectionCard>
      </div>
    );
  }

  if (activeNav === "Platform") {
    return (
      <div className="mgmt-view">
        <div className="mgmt-page-intro">
          <p className="eyebrow">Konfigurasi platform</p>
          <h1>Pengaturan platform</h1>
          <p>Akses fitur, retensi data, dan branding platform. Seluruh kontrol hanya contoh tampilan.</p>
        </div>
        <SimulationNote />
        <SectionCard eyebrow="Fitur tenant" title="Akses fitur per tenant">
          <p className="mgmt-field-hint">Sakelar contoh untuk tenant {overview.tenant.name}. Status tidak tersimpan.</p>
          <FeatureList flags={tenantFlags} />
        </SectionCard>
        <SectionCard eyebrow="Fitur platform" title="Fitur tingkat platform">
          <FeatureList flags={platformFlags} />
        </SectionCard>
        <SectionCard eyebrow="Kepatuhan" title="Pengaturan retensi data">
          <ul className="retention-list">
            {retentionPolicies.map((policy) => (
              <li className="retention-row" key={policy.key}>
                <div>
                  <strong>{policy.name}</strong>
                  <small>{policy.note}</small>
                </div>
                <div className="retention-row__control">
                  <StatusBadge tone="accent">{policy.period}</StatusBadge>
                  <button className="button-secondary" disabled title="Pengaturan retensi dinonaktifkan pada prototipe" type="button">
                    Ubah (nonaktif)
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
        <SectionCard eyebrow="Branding platform" title="Tampilan platform">
          <div className="brand-preview">
            <span className="brand-preview__mark" aria-hidden="true">V</span>
            <div>
              <strong>Vortech Hadir</strong>
              <p>Nama produk, domain masuk, dan warna platform. Perubahan dinonaktifkan pada prototipe.</p>
            </div>
          </div>
          <dl className="mgmt-policy-list">
            <div><dt>Domain masuk</dt><dd>hadir.vortech.example</dd></div>
            <div><dt>Email pengirim</dt><dd>no-reply@vortech.example</dd></div>
            <div><dt>Bahasa bawaan</dt><dd>Bahasa Indonesia</dd></div>
          </dl>
          <button className="button-primary mgmt-form__submit" disabled title="Pengaturan branding dinonaktifkan pada prototipe" type="button">
            Simpan branding (nonaktif)
          </button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="mgmt-view">
      <div className="mgmt-page-intro">
        <p className="eyebrow">Ruang kerja platform</p>
        <h1>Operasional platform</h1>
        <p>Gambaran seluruh tenant demo dan kesehatan langganan. Gunakan navigasi untuk detail tenant dan pengaturan platform.</p>
      </div>
      <SimulationNote />
      <div className="mgmt-metrics" role="list" aria-label="Ringkasan langganan platform">
        <div className="mgmt-metric mgmt-metric--success" role="listitem"><span className="mgmt-metric__mark" aria-hidden="true">✓</span><div><strong>{overview.tenantSubscriptions.filter((item) => item.status === "active").length}</strong><span>Langganan aktif</span></div></div>
        <div className="mgmt-metric" role="listitem"><span className="mgmt-metric__mark" aria-hidden="true">◔</span><div><strong>{overview.tenantSubscriptions.filter((item) => item.status === "trial").length}</strong><span>Masa uji coba</span></div></div>
        <div className="mgmt-metric mgmt-metric--warning" role="listitem"><span className="mgmt-metric__mark" aria-hidden="true">!</span><div><strong>{overview.tenantSubscriptions.filter((item) => item.status === "past-due").length}</strong><span>Jatuh tempo</span></div></div>
        <div className="mgmt-metric mgmt-metric--danger" role="listitem"><span className="mgmt-metric__mark" aria-hidden="true">✕</span><div><strong>{overview.tenantSubscriptions.filter((item) => item.status === "suspended").length}</strong><span>Ditangguhkan</span></div></div>
      </div>
      <SectionCard eyebrow="Semua tenant" title="Status langganan">
        <SubscriptionCards subscriptions={overview.tenantSubscriptions} />
      </SectionCard>
    </div>
  );
}

type Overview = ReturnType<typeof getSuperadminOverview>;

function TenantTable({ subscriptions }: { subscriptions: Overview["tenantSubscriptions"] }) {
  return (
    <div className="mgmt-table-wrap">
      <table>
        <caption className="sr-only">Daftar tenant dan status langganan</caption>
        <thead>
          <tr><th scope="col">Tenant</th><th scope="col">Paket</th><th scope="col">Kursi</th><th scope="col">Status</th><th scope="col">Pembaruan</th></tr>
        </thead>
        <tbody>
          {subscriptions.map((subscription) => {
            const status = subscriptionCopy[subscription.status];
            return (
              <tr key={subscription.key}>
                <td data-th="Tenant"><strong>{subscription.tenantName}</strong></td>
                <td data-th="Paket">{planLabels[subscription.plan]}</td>
                <td data-th="Kursi">{subscription.seats}</td>
                <td data-th="Status">
                  <StatusBadge tone={status.tone}>
                    <span aria-hidden="true">{status.symbol} </span>
                    {status.label}
                  </StatusBadge>
                </td>
                <td data-th="Pembaruan">{formatDate(subscription.renewalDate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SubscriptionCards({ subscriptions }: { subscriptions: Overview["tenantSubscriptions"] }) {
  return (
    <ul className="subscription-cards">
      {subscriptions.map((subscription) => {
        const status = subscriptionCopy[subscription.status];
        return (
          <li className={`subscription-card subscription-card--${status.tone}`} key={subscription.key}>
            <div className="subscription-card__top">
              <strong>{subscription.tenantName}</strong>
              <StatusBadge tone={status.tone}>
                <span aria-hidden="true">{status.symbol} </span>
                {status.label}
              </StatusBadge>
            </div>
            <dl className="subscription-card__meta">
              <div><dt>Paket</dt><dd>{planLabels[subscription.plan]}</dd></div>
              <div><dt>Kursi</dt><dd>{subscription.seats}</dd></div>
              <div><dt>Pembaruan</dt><dd>{formatDate(subscription.renewalDate)}</dd></div>
            </dl>
            <div className="subscription-card__actions">
              <button className="button-secondary" disabled title="Tindakan langganan dinonaktifkan pada prototipe" type="button">
                Kelola langganan (nonaktif)
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function FeatureList({ flags }: { flags: Overview["featureFlags"] }) {
  return (
    <ul className="feature-list">
      {flags.map((flag) => (
        <li className="feature-row" key={flag.key}>
          <div>
            <strong>{flag.name}</strong>
            <small>{flag.scope === "platform" ? "Berlaku untuk seluruh platform" : "Berlaku per tenant"}</small>
          </div>
          <label className="mgmt-toggle">
            <input defaultChecked={flag.enabled} type="checkbox" />
            <span>{flag.enabled ? "Aktif (contoh)" : "Nonaktif (contoh)"}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function SimulationNote() {
  return (
    <p className="mgmt-simulation-note" role="note">
      <span aria-hidden="true">ⓘ</span> Tampilan simulasi — pengelolaan tenant, langganan, dan pengaturan platform tidak tersimpan dan tidak memberikan otorisasi apa pun.
    </p>
  );
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`));
}
