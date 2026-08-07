# Changelog

All notable changes to this prototype are documented here.

## Unreleased

- Implemented the four-role mock UI prototype with previews for Member (Anggota), Manager (Manajer), Admin (Administrator), and Superadmin, switchable from a role switcher in the demo shell.
- Added demo state simulation for the Member attendance flow: check-in and check-out, plus the offline/pending, accuracy-review, rejected, and completed scenarios. Transitions are guarded (for example, duplicate check-in and check-out before check-in are rejected) and never mutate the source fixtures.
- Kept a replaceable demo data boundary: all tenants, users, teams, locations, schedules, attendance, correction requests, subscriptions, and feature flags live in `src/lib/demo/data.ts` behind narrow selectors in `src/lib/demo/selectors.ts`, so the mock dataset can be swapped without touching the views.
- Documented the local startup path (`npm install`, `npm run dev`, then open `http://localhost:3000`) and the verification commands (`npm test`, `npm run lint`, `npm run build`).
- This is a mock-only prototype: it does not include a real backend, authentication, database persistence, or camera/GPS hardware access. All data is held in memory and is not stored.
