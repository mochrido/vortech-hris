# Attendance Management UI Prototype Design

## Status

Approved by the product owner on 2026-08-06.

## Goal

Create a locally runnable, mock-data UI prototype for the Attendance Management PWA described in `docs/PRD.md - Attendance Management PWA.md`. The prototype lets the product owner review the UX for Member, Manager, Admin, and Superadmin roles before implementing authentication, PostgreSQL, GPS, camera capture, or real offline persistence.

## Scope

The prototype is one Next.js TypeScript application with a responsive member experience and a desktop-oriented administration experience. It includes representative screens and states for all four roles:

- Member: Beranda, simulated check-in/check-out, Riwayat, Profil, offline and pending-sync states.
- Manager: team summary, present/late/absent/anomaly lists, and correction review.
- Admin: users, teams, locations, schedules, policies, branding, and reports.
- Superadmin: tenants, subscriptions, feature access, retention, and platform settings.

The UI is Indonesian-first, light-theme only, accessible by keyboard where applicable, and responsive on mobile and desktop. A visible Demo Mode indicator and role switcher make clear that simulated role changes are not authorization.

Excluded from this prototype are real sessions, server-side authorization, database persistence, camera/GPS APIs, image uploads, service workers, IndexedDB, real tenant isolation, and production deployment. The prototype may simulate success, offline, pending, error, and anomaly states for review only.

## Architecture

Use a single Next.js App Router application. Keep domain types and mock records in a small data module. UI screens consume data through narrow functions or props rather than importing mock records throughout components. The first implementation may use local demo state for interactions such as role switching, navigation, simulated attendance submission, and filters.

The data boundary must be easy to replace later:

- Prototype implementation: deterministic in-memory mock data.
- Later implementation: server/API functions backed by PostgreSQL, while preserving screen-level data shapes where practical.

Do not add an ORM, authentication library, map SDK, component framework, or state-management library for the prototype unless an existing project dependency requires it. Use native CSS or CSS Modules and the existing platform features.

## Navigation And Interaction

The role switcher exposes four preview contexts. Member navigation uses the PRD labels `Beranda`, `Riwayat`, and `Profil`. Admin-facing roles use a responsive sidebar. The main dashboard action is a simulated check-in/check-out flow that shows location accuracy, geofence result, camera/selfie evidence, and resulting sync state without accessing hardware.

All screens need useful empty, loading, error, offline, pending-sync, rejected, and success presentation where that state is relevant. Color must not be the only attendance-state signal. Touch targets must be at least 44x44 pixels.

## Visual Direction

Use a distinctive but restrained operational interface: clear typography, strong status hierarchy, compact data cards, and a warm light canvas suitable for an Indonesian workforce product. Member views should feel fast and reassuring on a phone; management views should prioritize scanability and data density without becoming a generic dashboard template. Preserve the low-fidelity information hierarchy in the PRD while improving visual polish.

## Testing And Verification

The prototype must be verifiable locally with the project package scripts. Add focused tests only for non-trivial mock behavior, such as role-context selection or simulated attendance state transitions. The primary acceptance check is manual browser review at mobile and desktop widths for all four roles and the key simulated states.

## Repository And Release Hygiene

Initialize Git in the workspace and add public-repository-safe files: `README.md`, `CHANGELOG.md`, `.gitignore`, and `.env.example` as needed. Do not include secrets, personal data, uploaded images, database dumps, or local build artifacts. The initial reviewed prototype should be tagged later as a release such as `v0.1.0-ui-prototype`; pushing and creating the public GitHub repository require the owner's repository URL and explicit confirmation at that step.

## Migration Path

After UI approval, implement the PRD in vertical phases. Replace mock data with API/server functions, add PostgreSQL migrations and server-side authorization, then add real online attendance capture, offline queueing, administration, reports, and retention. The production target remains Docker Compose with the web app, PostgreSQL, and Caddy on one VPS, with private file storage initially.
