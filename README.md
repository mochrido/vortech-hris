# Attendance Management Prototype

A locally runnable Next.js TypeScript project that hosts the Member, Manager, Admin, and Superadmin attendance-management previews.

## Local Startup

Requirements: Node.js `>=22.18.0` and npm. This baseline lets Node's built-in test runner discover and execute TypeScript tests without an external loader.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` after the development server starts. Use the "Pratinjau sebagai" (Preview as) switcher to move between the four role previews: Member (Anggota), Manager (Manajer), Admin (Administrator), and Superadmin. Each role renders from the same in-memory demo dataset.

Useful checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run start
```

`npm run lint` currently runs the TypeScript validation check because ESLint is deferred until application code exists. `npm test` uses Node's built-in test runner with native TypeScript type stripping.

## Database

Local dev expects a PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL` (and `TOTP_ENCRYPTION_KEY`), then:

```bash
npm run db:migrate   # apply migrations (idempotent)
npm run db:seed      # seed superadmin, demo tenant, and holidays (idempotent)
```

### Seed data

`npm run db:seed` is safe to run repeatedly (no duplicates). It creates:

- **Superadmin** — `superadmin@vortech.local` with a confirmed TOTP credential enrolled.
- **Demo tenant** `vortech-demo` (plan `trial`, 25 users) with three users:
  - `admin@vortech-demo.local` (admin)
  - `manager@vortech-demo.local` (manager)
  - `member@vortech-demo.local` (member)
- Two locations (Jakarta HQ, Bandung branch), one fixed Mon–Fri 09:00–17:00 schedule.
- Indonesian national holidays for 2026–2027 (superadmin-editable).

These are **dev-only** accounts. Passwords come from the `SEED_*_PASSWORD` variables in `.env`; when unset, well-known local defaults are used (see `.env.example`). Override them anywhere beyond local development.

## Prototype Limits

All displayed data and actions are mock-only and held in memory. The role switcher is a review tool, not authorization. This phase does not make camera or GPS calls, persist to a database, upload images, or provide real authentication, offline storage, or server-side access control.

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
