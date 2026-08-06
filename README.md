# Attendance Management Prototype

A locally runnable Next.js TypeScript project that will host the Member, Manager, Admin, and Superadmin attendance-management previews.

## Local Startup

Requirements: Node.js `>=20.9.0` and npm. This is the minimum required by the pinned Next.js `16.3.0` dependency.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` after the development server starts. The app entry point is intentionally minimal in Task 1; the role previews are added in later tasks.

Useful checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run start
```

`npm run lint` currently runs the TypeScript validation check because ESLint is deferred until application code exists. `npm test` uses Node's built-in test runner and currently discovers zero test files; demo boundary tests are added in Task 2.

## Prototype Limits

All displayed data and actions are mock-only and held in memory. The role switcher is a review tool, not authorization. This phase does not make camera or GPS calls, persist to a database, upload images, or provide real authentication, offline storage, or server-side access control.

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
