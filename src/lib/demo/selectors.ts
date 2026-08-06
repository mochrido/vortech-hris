import { demoData } from './data.ts';
import type { AttendanceEvent, AttendanceEventState, DemoData, DemoRole } from './types.ts';

const copy = <T>(value: T): T => structuredClone(value);
type ReadonlyDemoData = { readonly [Key in keyof DemoData]: DeepReadonly<DemoData[Key]> };
type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export function getDemoContext(role: DemoRole): DemoData & { role: DemoRole } {
  return { ...copy(demoData), role };
}

export function getDemoContextView(role: DemoRole): ReadonlyDemoData & { role: DemoRole } {
  return { ...demoData, role };
}

export function getMemberDashboard() {
  const context = getDemoContext('member');
  const attendance = context.attendance.filter((row) => row.userKey === 'user-sari-utami');
  const history = attendance.filter((row) => row.date >= '2026-07-31').sort((a, b) => b.date.localeCompare(a.date));
  const monthlyRows = attendance.filter((row) => row.date.startsWith('2026-08-') && row.checkIn && row.checkOut);
  const workedMinutes = monthlyRows.reduce((total, row) => {
    const [inHour, inMinute] = row.checkIn!.split(':').map(Number);
    const [outHour, outMinute] = row.checkOut!.split(':').map(Number);
    return total + (outHour * 60 + outMinute) - (inHour * 60 + inMinute);
  }, 0);
  return {
    role: context.role,
    user: context.users[0],
    today: attendance.find((row) => row.date === '2026-08-06'),
    attendance,
    history,
    monthlySummary: { lateCount: attendance.filter((row) => row.date.startsWith('2026-08-') && row.status === 'late').length, workedMinutes },
    syncState: context.syncState,
  };
}

export function getManagerDashboard() {
  const context = getDemoContext('manager');
  const team = context.teams[0];
  const userKeys = new Set([team.managerKey, ...team.memberKeys]);
  return {
    role: context.role,
    team,
    users: context.users.filter((user) => userKeys.has(user.key)),
    attendance: context.attendance.filter((row) => userKeys.has(row.userKey)),
    correctionRequests: context.correctionRequests.filter((request) => userKeys.has(request.userKey)),
  };
}

export function getAdminOverview() {
  const context = getDemoContext('admin');
  return { role: context.role, users: context.users, teams: context.teams, locations: context.locations, schedules: context.schedules, featureFlags: context.featureFlags };
}

export function getSuperadminOverview() {
  const context = getDemoContext('superadmin');
  return { role: context.role, tenant: context.tenant, tenantSubscriptions: context.tenantSubscriptions, featureFlags: context.featureFlags };
}

export function simulateAttendanceEvent(currentStatus: AttendanceEventState, eventType: AttendanceEvent): AttendanceEventState {
  const checkedIn = ['present', 'late', 'outside-geofence', 'anomaly', 'pending-sync', 'review-required'].includes(currentStatus.status);
  if ((eventType === 'check-in' || eventType === 'check-in-offline') && checkedIn) throw new Error('cannot check in while already checked in');
  if (eventType === 'check-out' && (currentStatus.status === 'unknown' || currentStatus.status === 'absent')) throw new Error('cannot check out before checking in');
  if (eventType === 'check-in-offline') return { status: 'pending-sync', syncState: 'queued' };
  if (eventType === 'sync') return { status: currentStatus.status === 'pending-sync' ? 'present' : currentStatus.status, syncState: 'synced' };
  if (eventType === 'check-in') return { status: 'present', syncState: 'synced' };
  return { status: currentStatus.status, syncState: 'synced' };
}
