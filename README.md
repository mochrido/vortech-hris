# Attendance Management Prototype

A locally runnable Next.js TypeScript prototype for reviewing the Member, Manager, Admin, and Superadmin attendance-management experiences.

## Local Startup

Requirements: Node.js LTS and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` after the development server starts. The available role previews are Member, Manager, Admin, and Superadmin.

Useful checks:

```bash
npm test
npm run lint
npm run build
npm run start
```

## Prototype Limits

All displayed data and actions are mock-only and held in memory. The role switcher is a review tool, not authorization. This phase does not make camera or GPS calls, persist to a database, upload images, or provide real authentication, offline storage, or server-side access control.

Do not add secrets to this repository. Use `.env.example` only as a list of non-secret local placeholders; local `.env` files are ignored.
