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

## Prototype Limits

All displayed data and actions are mock-only and held in memory. The role switcher is a review tool, not authorization. This phase does not make camera or GPS calls, persist to a database, upload images, or provide real authentication, offline storage, or server-side access control.

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
