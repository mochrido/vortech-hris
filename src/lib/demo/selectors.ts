import { demoData } from './data.ts';
import type { AttendanceEvent, AttendanceEventState, DemoData, DemoRole } from './types.ts';

const copy = <T>(value: T): T => structuredClone(value);

export function getDemoContext(role: DemoRole): DemoData & { role: DemoRole } {
  return { ...copy(demoData), role };
}

export function getMemberDashboard() {
  const context = getDemoContext('member');
  return { role: context.role, user: context.users[0], attendance: context.attendance.filter((row) => row.userKey === 'user-sari-utami'), syncState: context.syncState };
}

export function getManagerDashboard() {
  const context = getDemoContext('manager');
  return { role: context.role, team: context.teams[0], users: context.users, attendance: context.attendance, correctionRequests: context.correctionRequests };
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
  if (eventType === 'check-in' && currentStatus.status === 'present') throw new Error('cannot check in while already present');
  if (eventType === 'check-in-offline') return { status: 'pending-sync', syncState: 'queued' };
  if (eventType === 'sync') return { status: currentStatus.status === 'pending-sync' ? 'present' : currentStatus.status, syncState: 'synced' };
  if (eventType === 'check-in') return { status: 'present', syncState: 'synced' };
  return { status: currentStatus.status, syncState: 'synced' };
}
