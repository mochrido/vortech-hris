"use client";

import { useState } from "react";

import { getDemoContextView } from "../lib/demo/selectors";
import type { DemoRole } from "../lib/demo/types";
import { SectionCard } from "./section-card";
import { StatusBadge } from "./status-badge";
import { MemberView } from "./member-view";

const roles: { key: DemoRole; label: string }[] = [
  { key: "member", label: "Anggota" },
  { key: "manager", label: "Manajer" },
  { key: "admin", label: "Administrator" },
  { key: "superadmin", label: "Superadmin" },
];

const navigation: Record<DemoRole, string[]> = {
  member: ["Beranda", "Riwayat", "Profil"],
  manager: ["Ringkasan", "Tim", "Koreksi"],
  admin: ["Ringkasan", "Pengguna", "Lokasi"],
  superadmin: ["Ringkasan", "Tenant", "Platform"],
};

const roleCopy: Record<DemoRole, { eyebrow: string; title: string; description: string }> = {
  member: {
    eyebrow: "Ruang kerja personal",
    title: "Kehadiran hari ini",
    description: "Tinjau alur presensi, riwayat tujuh hari, dan profil Anggota dengan data simulasi.",
  },
  manager: {
    eyebrow: "Ruang kerja tim",
    title: "Operasional tim",
    description: "Ringkasan kehadiran tim dan peninjauan koreksi akan tersedia pada tahap berikutnya.",
  },
  admin: {
    eyebrow: "Ruang kerja organisasi",
    title: "Administrasi perusahaan",
    description: "Pengelolaan pengguna, lokasi, jadwal, dan kebijakan akan tersedia pada tahap berikutnya.",
  },
  superadmin: {
    eyebrow: "Ruang kerja platform",
    title: "Operasional platform",
    description: "Pengelolaan tenant, langganan, dan fitur platform akan tersedia pada tahap berikutnya.",
  },
};

export function DemoShell() {
  const [role, setRole] = useState<DemoRole>("member");
  const [activeNav, setActiveNav] = useState(navigation.member[0]);
  const context = getDemoContextView(role);
  const currentUser = context.users.find((user) => user.role === role);
  const copy = roleCopy[role];

  function selectRole(nextRole: DemoRole) {
    setRole(nextRole);
    setActiveNav(navigation[nextRole][0]);
  }

  return (
    <div className="demo-shell">
      <aside className="sidebar" aria-label="Navigasi utama">
        <Brand />
        <nav className="primary-nav">
          {navigation[role].map((item) => (
            <button
              aria-current={activeNav === item ? "page" : undefined}
              className="nav-button"
              key={item}
              onClick={() => setActiveNav(item)}
              type="button"
            >
              <span className="nav-button__mark" aria-hidden="true" />
              {item}
            </button>
          ))}
        </nav>
        <p className="sidebar__note">Prototipe lokal<br />Data tidak disimpan</p>
      </aside>

      <div className="shell-body">
        <header className="topbar">
          <div className="mobile-brand"><Brand /></div>
          <div className="context">
            <span className="context__tenant">{context.tenant.name}</span>
            <span className="context__user">
              {currentUser?.name ?? "Operator Platform Demo"} · {roles.find((item) => item.key === role)?.label}
            </span>
          </div>
          <StatusBadge tone="warning">Mode Demo</StatusBadge>
        </header>

        <p className="sr-only" aria-live="polite" aria-atomic="true">
          Pratinjau {roles.find((item) => item.key === role)?.label}, halaman {activeNav}.
        </p>

        <main className="main-content">
          <section className="page-heading" aria-labelledby="page-title">
            <div>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1 id="page-title">{copy.title}</h1>
              <p>{copy.description}</p>
            </div>
            <fieldset className="role-switcher">
              <legend>Pratinjau sebagai</legend>
              <div className="role-switcher__options">
                {roles.map((item) => (
                  <button
                    aria-pressed={role === item.key}
                    className="role-button"
                    key={item.key}
                    onClick={() => selectRole(item.key)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>

          {role === "member" ? <MemberView activeNav={activeNav} /> : <div className="overview-grid">
            <SectionCard eyebrow="Konteks aktif" title={activeNav}>
              <div className="placeholder-panel">
                <span className="placeholder-panel__number">0{roles.findIndex((item) => item.key === role) + 1}</span>
                <div>
                  <strong>Area pratinjau {roles.find((item) => item.key === role)?.label}</strong>
                  <p>Konten dashboard belum diaktifkan. Gunakan navigasi untuk meninjau struktur shell.</p>
                </div>
              </div>
            </SectionCard>

            <SectionCard eyebrow="Lingkungan" title="Konteks demo" className="context-card">
              <dl className="context-list">
                <div><dt>Tenant</dt><dd>{context.tenant.name}</dd></div>
                <div><dt>Zona waktu</dt><dd>{context.tenant.timezone}</dd></div>
                <div><dt>Pengguna</dt><dd>{currentUser?.email ?? "platform@demo.local"}</dd></div>
                <div><dt>Status</dt><dd><StatusBadge tone="success">Siap ditinjau</StatusBadge></dd></div>
              </dl>
            </SectionCard>
          </div>}
        </main>

        <nav className="bottom-nav" aria-label="Navigasi utama seluler">
          {navigation[role].map((item) => (
            <button
              aria-current={activeNav === item ? "page" : undefined}
              className="bottom-nav__button"
              key={item}
              onClick={() => setActiveNav(item)}
              type="button"
            >
              <span className="bottom-nav__mark" aria-hidden="true" />
              {item}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Vortech Hadir">
      <span className="brand__mark" aria-hidden="true">V</span>
      <span><strong>Vortech</strong><small>Hadir</small></span>
    </a>
  );
}
