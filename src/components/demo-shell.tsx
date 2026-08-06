"use client";

import { useState } from "react";

import { getDemoContextView } from "../lib/demo/selectors";
import type { DemoRole } from "../lib/demo/types";
import { StatusBadge } from "./status-badge";
import { MemberView } from "./member-view";
import { ManagerView } from "./manager-view";
import { AdminView } from "./admin-view";
import { SuperadminView } from "./superadmin-view";

const roles: { key: DemoRole; label: string }[] = [
  { key: "member", label: "Anggota" },
  { key: "manager", label: "Manajer" },
  { key: "admin", label: "Administrator" },
  { key: "superadmin", label: "Superadmin" },
];

const navigation: Record<DemoRole, string[]> = {
  member: ["Beranda", "Riwayat", "Profil"],
  manager: ["Ringkasan", "Tim", "Koreksi"],
  admin: ["Ringkasan", "Pengguna", "Tim", "Lokasi", "Jadwal", "Kebijakan", "Merek", "Laporan"],
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
    description: "Pantau kehadiran tim, indikator geofence, dan koreksi yang menunggu keputusan dengan data simulasi.",
  },
  admin: {
    eyebrow: "Ruang kerja organisasi",
    title: "Administrasi perusahaan",
    description: "Kelola contoh pengguna, tim, lokasi, jadwal, kebijakan, merek, dan laporan dengan data simulasi.",
  },
  superadmin: {
    eyebrow: "Ruang kerja platform",
    title: "Operasional platform",
    description: "Tinjau contoh tenant, status langganan, akses fitur, dan pengaturan platform dengan data simulasi.",
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

          {role === "member" ? <MemberView activeNav={activeNav} /> : null}
          {role === "manager" ? <ManagerView activeNav={activeNav} /> : null}
          {role === "admin" ? <AdminView activeNav={activeNav} /> : null}
          {role === "superadmin" ? <SuperadminView activeNav={activeNav} /> : null}
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
