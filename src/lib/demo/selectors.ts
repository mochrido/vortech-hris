import { demoData } from './data.ts';
import type { AttendanceEvent, AttendanceEventState, AttendanceScenario, AttendanceSummary, DemoData, DemoRole } from './types.ts';

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
    user: context.users.find((user) => user.key === 'user-sari-utami')!,
    today: attendance.find((row) => row.date === '2026-08-06'),
    attendance,
    history,
    monthlySummary: { lateCount: attendance.filter((row) => row.date.startsWith('2026-08-') && row.status === 'late').length, workedMinutes },
    syncState: context.syncState,
  };
}

export function deriveMemberAttendanceDisplay(state: AttendanceEventState, sourceToday: AttendanceSummary, sourceHistory: AttendanceSummary[]) {
  const today = { ...sourceToday };
  if (state.status !== 'unknown') {
    today.status = state.status;
    today.syncState = state.syncState;
    today.checkIn = sourceToday.checkIn ?? '07:54';
    today.checkOut = state.checkOutCompleted ? '14:00' : sourceToday.checkOut;
  }
  const history = sourceHistory.map((row) => row.date === sourceToday.date && state.status !== 'unknown' ? { ...today } : { ...row });
  return { today, history };
}

export function getMemberAttendancePresentation(state: AttendanceEventState) {
  const pending = state.status === 'pending-sync';
  const review = state.status === 'review-required';
  const checkout = state.checkOutCompleted === true;
  return {
    todayLabel: checkout && pending ? 'Check-out tercatat · menunggu sinkronisasi' : checkout && review ? 'Check-out tercatat · menunggu tinjauan' : checkout ? 'Sudah selesai' : review ? 'Menunggu tinjauan' : pending ? 'Menunggu sinkronisasi' : state.status !== 'unknown' && state.status !== 'absent' ? 'Sudah check-in' : 'Belum check-in',
    historyLabel: checkout && pending ? 'Check-out menunggu sinkronisasi' : checkout && review ? 'Check-out menunggu tinjauan' : checkout ? 'Selesai' : review ? 'Perlu tinjauan' : pending ? 'Menunggu sinkronisasi' : 'Hadir',
    pendingCount: pending ? 1 : 0,
    reviewCount: review ? 1 : 0,
  };
}

export function getMemberScenarioState(state: AttendanceEventState, scenario: AttendanceScenario): AttendanceEventState {
  return scenario === 'completed'
    ? { status: 'present', syncState: 'synced', checkOutCompleted: true }
    : state;
}

export function getAttendanceHistoryLabel(row: AttendanceSummary) {
  if (row.status === 'pending-sync') return row.checkOut ? 'Check-out menunggu sinkronisasi' : 'Menunggu sinkronisasi';
  if (row.status === 'review-required') return row.checkOut ? 'Check-out menunggu tinjauan' : 'Perlu tinjauan';
  if (row.status === 'late') return 'Terlambat';
  if (row.status === 'unknown') return 'Belum mulai';
  return row.checkOut ? 'Selesai' : 'Hadir';
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
  const checkInEvent = eventType === 'check-in' || eventType === 'check-in-offline' || eventType === 'check-in-review';
  const checkOutEvent = eventType === 'check-out' || eventType === 'check-out-offline' || eventType === 'check-out-review';
  if (checkInEvent && checkedIn) throw new Error('cannot check in while already checked in');
  if (checkOutEvent && !checkedIn) throw new Error('cannot check out before checking in');
  if (checkOutEvent && ['pending-sync', 'review-required'].includes(currentStatus.status)) throw new Error('cannot check out from pending or review status');
  if (checkOutEvent && currentStatus.checkOutCompleted) throw new Error('cannot check out twice');
  if (eventType === 'check-in-offline') return { status: 'pending-sync', syncState: 'queued' };
  if (eventType === 'check-in-review') return { status: 'review-required', syncState: 'synced' };
  if (eventType === 'check-out-offline') return { status: 'pending-sync', syncState: 'queued', checkOutCompleted: true };
  if (eventType === 'check-out-review') return { status: 'review-required', syncState: 'synced', checkOutCompleted: true };
  if (eventType === 'sync') return { ...currentStatus, status: currentStatus.status === 'pending-sync' ? 'present' : currentStatus.status, syncState: 'synced' };
  if (eventType === 'check-in') return { status: 'present', syncState: 'synced' };
  return { status: 'present', syncState: 'synced', checkOutCompleted: true };
}

export function submitMemberAttendance(state: AttendanceEventState, scenario: AttendanceScenario) {
  if (scenario === 'rejected') return { accepted: false as const, state, message: 'Presensi ditolak: di luar geofence simulasi.' };
  if (scenario === 'completed') return { accepted: true as const, state: getMemberScenarioState(state, scenario), message: null };
  const checkedIn = state.status !== 'unknown' && state.status !== 'absent';
  const event: AttendanceEvent = checkedIn
    ? scenario === 'pending' ? 'check-out-offline' : scenario === 'accuracy' ? 'check-out-review' : 'check-out'
    : scenario === 'pending' ? 'check-in-offline' : scenario === 'accuracy' ? 'check-in-review' : 'check-in';
  return { accepted: true as const, state: simulateAttendanceEvent(state, event), message: null };
}
