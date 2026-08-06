# Attendance Management UI Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable Next.js TypeScript mock-data prototype that lets the product owner review Member, Manager, Admin, and Superadmin experiences before real backend implementation.

**Architecture:** Use one Next.js App Router application with a client-side demo shell, deterministic in-memory data, and focused domain functions in `src/lib/demo`. UI screens consume typed view data through the demo boundary instead of importing records directly. The prototype is intentionally not an authorization or persistence implementation; its visible Demo Mode label and role switcher are review tooling.

**Tech Stack:** Node.js LTS, Next.js stable App Router, React, TypeScript, native CSS/CSS Modules, and Node's built-in test runner. Do not add a database, ORM, authentication library, map SDK, or component framework for this phase.

---

## File Map

- Create: `package.json` for scripts and minimal dependencies.
- Create: `tsconfig.json`, `next.config.ts`, `next-env.d.ts` for the Next.js TypeScript project.
- Create: `.gitignore`, `.env.example`, `README.md`, and `CHANGELOG.md` for public-repository hygiene and local startup instructions.
- Create: `src/app/layout.tsx` for metadata and the global app frame.
- Create: `src/app/page.tsx` for the demo entry point.
- Create: `src/app/globals.css` for the responsive visual system.
- Create: `src/lib/demo/types.ts` for domain and UI-facing types.
- Create: `src/lib/demo/data.ts` for deterministic mock tenant, user, attendance, team, administration, and platform records.
- Create: `src/lib/demo/selectors.ts` for role-specific dashboard data and simulated attendance transitions.
- Create: `src/lib/demo/selectors.test.ts` for high-risk mock behavior tests.
- Create: `src/components/demo-shell.tsx` for role switching, navigation, and shared responsive chrome.
- Create: `src/components/member-view.tsx` for the mobile Member experience.
- Create: `src/components/manager-view.tsx` for the Manager dashboard and correction review.
- Create: `src/components/admin-view.tsx` for Admin management sections.
- Create: `src/components/superadmin-view.tsx` for Superadmin platform sections.
- Create: `src/components/status-badge.tsx` and `src/components/section-card.tsx` for small reusable presentation primitives.

### Task 1: Initialize the Local Next.js Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `next-env.d.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Add project metadata and scripts**

Use scripts for `dev`, `build`, `start`, `lint`, and the Node test runner. Keep dependencies limited to Next.js, React, and React DOM plus development TypeScript and type packages.

- [ ] **Step 2: Add safe local configuration files**

Ignore `node_modules`, `.next`, coverage, local environment files, and any future uploads/data directories. Put only non-secret placeholder variable names in `.env.example`.

- [ ] **Step 3: Document local startup and prototype limits**

Explain `npm install`, `npm run dev`, the four role previews, and that all data is mock-only. Explicitly state that the role switcher is not authorization and no camera/GPS/database calls exist yet.

- [ ] **Step 4: Verify the project toolchain**

Run `npm install`, then `npm run build`. Expected: dependency installation succeeds and the initial Next.js application builds once the entry files exist in Task 2.

### Task 2: Create the Demo Data Boundary

**Files:**
- Create: `src/lib/demo/types.ts`
- Create: `src/lib/demo/data.ts`
- Create: `src/lib/demo/selectors.ts`
- Test: `src/lib/demo/selectors.test.ts`

- [ ] **Step 1: Define typed demo domain values**

Define `DemoRole` as `member | manager | admin | superadmin`, plus typed records for users, attendance summaries, teams, locations, schedules, tenant subscriptions, feature flags, and UI sync state. Keep stable internal keys separate from visible Indonesian labels.

- [ ] **Step 2: Add deterministic records**

Create one tenant, several users, two teams, locations, schedules, attendance rows, correction requests, and platform records. Use fictional names and no real personal data. Include present, late, absent, outside-geofence, anomaly, pending-sync, and review-required examples.

- [ ] **Step 3: Implement narrow selectors and simulation functions**

Export functions such as `getDemoContext(role)`, `getMemberDashboard()`, `getManagerDashboard()`, `getAdminOverview()`, `getSuperadminOverview()`, and `simulateAttendanceEvent(currentStatus, eventType)`. The simulation must return a new state and never mutate the source fixture.

- [ ] **Step 4: Write failing tests for boundary behavior**

Test that each role gets the expected context, a check-in changes only the simulated member state, duplicate check-in is rejected, check-out is allowed after check-in, and pending sync remains visible. Use `node:test` and strict assertions.

- [ ] **Step 5: Run the focused test before implementation**

Run `npm test -- --test-name-pattern="demo"`. Expected: the tests fail because the selectors and project test configuration are not complete yet.

- [ ] **Step 6: Implement the minimum selectors and test configuration**

Make the tests pass using pure TypeScript-compatible Node test execution. Do not introduce a test framework or state library.

- [ ] **Step 7: Run the focused test after implementation**

Run `npm test -- --test-name-pattern="demo"`. Expected: all demo boundary tests pass.

### Task 3: Build the Shared Responsive Demo Shell

**Files:**
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/app/globals.css`
- Create: `src/components/demo-shell.tsx`
- Create: `src/components/status-badge.tsx`
- Create: `src/components/section-card.tsx`

- [ ] **Step 1: Add the root metadata and page entry**

Set Indonesian page metadata and render `DemoShell` from `page.tsx`. Keep the first page server-safe; client interactivity belongs in the shell and role views.

- [ ] **Step 2: Implement the role preview shell**

Render the product brand, Demo Mode indicator, role switcher, current tenant/user context, responsive sidebar or bottom navigation, and the selected role view. Use a local React state for role selection and navigation.

- [ ] **Step 3: Add the visual system**

Define CSS custom properties for a warm light canvas, ink, muted text, accent, success, warning, danger, borders, shadows, spacing, and radii. Add responsive breakpoints, visible focus states, semantic button styles, 44px minimum controls, cards, tables, badges, and mobile layout rules.

- [ ] **Step 4: Verify shell rendering**

Run `npm run build` and `npm run dev`, open `http://localhost:3000`, and confirm the shell loads without runtime errors. Verify keyboard focus and mobile-width layout using browser resizing.

### Task 4: Implement the Member Prototype

**Files:**
- Create: `src/components/member-view.tsx`
- Modify: `src/components/demo-shell.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Render the Beranda state**

Show greeting, date/shift, today status, location and accuracy, primary Check-in or Check-out action, camera/location explanation, sync count, summary metrics, and bottom navigation labels `Beranda`, `Riwayat`, `Profil`.

- [ ] **Step 2: Add the simulated capture flow**

Open an in-app capture panel that displays a fake camera preview, simulated GPS accuracy, geofence result, watermark preview metadata, and explicit actions for `Ambil ulang`, `Gunakan foto`, `Batal`, and submission. Submission calls `simulateAttendanceEvent` only.

- [ ] **Step 3: Add visible state variants**

Allow the demo to show accepted/synced, pending/offline, poor-accuracy review, rejected, and already-completed states without browser permissions or hardware. Explain that these are simulations.

- [ ] **Step 4: Add history and profile panels**

Render seven-day history, monthly late/worked summaries, profile details, employment label, and a non-functional logout warning when pending items exist.

- [ ] **Step 5: Verify Member acceptance cases**

Manually verify the check-in/check-out transition, duplicate prevention, pending count, Indonesian copy, focus visibility, and mobile layout at approximately 390px width.

### Task 5: Implement Manager, Admin, And Superadmin Views

**Files:**
- Create: `src/components/manager-view.tsx`
- Create: `src/components/admin-view.tsx`
- Create: `src/components/superadmin-view.tsx`
- Modify: `src/components/demo-shell.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Build the Manager dashboard**

Show present, late, not-yet-checked-in, and anomaly metrics; a scannable team table; outside-geofence and offline indicators; and pending correction cards with simulated approve/reject actions.

- [ ] **Step 2: Build the Admin sections**

Provide navigable mock sections for users, teams, locations, schedules, policies, branding, and CSV reports. Use representative tables/forms with disabled or clearly simulated actions, empty states, and validation/error examples.

- [ ] **Step 3: Build the Superadmin sections**

Provide tenant list, subscription/status cards, feature access, retention settings, and platform branding sections. Include trial, active, past-due, and suspended examples.

- [ ] **Step 4: Make desktop views responsive**

Use the shared sidebar and data-density rules on desktop, then collapse navigation and tables appropriately on narrow screens without hiding essential status information.

- [ ] **Step 5: Verify all role views**

Switch through all four roles and verify that each has distinct navigation, representative data, and no misleading claim that demo actions are persisted or authorized.

### Task 6: Public-Repository Verification And Handoff

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `.gitignore` if verification finds generated files not excluded

- [ ] **Step 1: Run the complete checks**

Run `npm test`, `npm run lint`, and `npm run build`. Expected: tests, lint, and production build all pass.

- [ ] **Step 2: Inspect repository safety**

Run `git status --short`, inspect the staged file list, and search for credential-like values. Confirm no `.env` file, generated build output, uploaded media, database dump, or personal data is tracked.

- [ ] **Step 3: Update the changelog**

Add an `Unreleased` section describing the four-role mock UI, demo state simulation, and local startup path. Do not call real backend capabilities complete.

- [ ] **Step 4: Commit the prototype**

After local Git identity is configured, commit the intended files with `git add .` followed by `git commit -m "feat: add mock attendance UI prototype"`. Do not push or create a public GitHub repository until the product owner supplies or confirms the target repository and explicitly authorizes the push.

## Self-Review

- Spec coverage: all four roles, mock-only behavior, replaceable data boundary, responsive UI, Indonesian-first UX, demo labeling, local verification, public-repository hygiene, and VPS migration path have explicit tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation step is required by the plan.
- Type consistency: `DemoRole`, role selectors, shell role state, and role views use the same four stable role keys.
- Scope: the plan excludes backend, database, permissions, hardware APIs, and deployment implementation as approved.
