import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdminOverview,
  getAttendanceHistoryLabel,
  getDemoContext,
  getManagerDashboard,
  getMemberDashboard,
  getSuperadminOverview,
  deriveMemberAttendanceDisplay,
  getMemberAttendancePresentation,
  getMemberScenarioState,
  simulateAttendanceEvent,
  submitMemberAttendance,
} from './selectors.ts';
import type { AttendanceEventState } from './types.ts';

test('returns deterministic role contexts with stable internal keys', () => {
  const member = getDemoContext('member');
  const manager = getDemoContext('manager');
  const admin = getDemoContext('admin');
  const superadmin = getDemoContext('superadmin');

  assert.equal(member.role, 'member');
  assert.equal(member.tenant.key, 'tenant-nusantara');
  assert.notEqual(member.tenant.key, member.tenant.name);
  assert.equal(manager.role, 'manager');
  assert.equal(admin.role, 'admin');
  assert.equal(superadmin.role, 'superadmin');
  assert.ok(member.users.some((user) => user.key === 'user-sari-utami'));
});

test('exposes representative dashboard data through narrow selectors', () => {
  const member = getMemberDashboard();
  const manager = getManagerDashboard();
  const admin = getAdminOverview();
  const superadmin = getSuperadminOverview();

  assert.ok(member.attendance.some((row) => row.status === 'pending-sync'));
  assert.ok(manager.attendance.some((row) => row.status === 'outside-geofence'));
  assert.ok(manager.correctionRequests.some((request) => request.status === 'review-required'));
  assert.equal(admin.teams.length, 2);
  assert.ok(admin.locations.length >= 2);
  assert.ok(admin.schedules.length >= 2);
  assert.ok(superadmin.tenantSubscriptions.length >= 1);
  assert.ok(superadmin.featureFlags.some((flag) => flag.enabled === false));
});

test('provides a check-in-capable member history and monthly summary', () => {
  const member = getMemberDashboard();

  assert.equal(member.today?.status, 'unknown');
  assert.equal(member.history.length, 7);
  assert.equal(member.monthlySummary.lateCount, 1);
  assert.equal(member.monthlySummary.workedMinutes, 2679);
  assert.ok(member.history.every((row) => row.userKey === member.user.key));
});

test('scopes manager users and records to the assigned team', () => {
  const manager = getManagerDashboard();
  const teamUserKeys = new Set([manager.team.managerKey, ...manager.team.memberKeys]);

  assert.deepEqual(manager.users.map((user) => user.key).sort(), [...teamUserKeys].sort());
  assert.ok(manager.attendance.every((row) => teamUserKeys.has(row.userKey)));
  assert.ok(manager.correctionRequests.every((request) => teamUserKeys.has(request.userKey)));
  assert.ok(manager.attendance.some((row) => row.status === 'late'));
  assert.ok(!manager.attendance.some((row) => row.userKey === 'user-dewi-pranoto'));
});

test('keeps correction requests date-consistent with their attendance event', () => {
  const manager = getManagerDashboard();
  const correction = manager.correctionRequests.find((request) => request.key === 'correction-bima-aug5');
  const attendance = manager.attendance.find((row) => row.key === correction?.attendanceKey);

  assert.equal(attendance?.date, '2026-08-05');
});

test('simulates attendance transitions without mutating the current status', () => {
  const current = { status: 'pending-sync' as const, syncState: 'queued' as const };
  const next = simulateAttendanceEvent(current, 'sync');

  assert.deepEqual(current, { status: 'pending-sync', syncState: 'queued' });
  assert.deepEqual(next, { status: 'present', syncState: 'synced' });
  assert.notEqual(next, current);
});

test('simulates offline check-in and rejects unsupported transitions', () => {
  assert.deepEqual(
    simulateAttendanceEvent({ status: 'unknown', syncState: 'idle' }, 'check-in-offline'),
    { status: 'pending-sync', syncState: 'queued' },
  );
  assert.throws(
    () => simulateAttendanceEvent({ status: 'present', syncState: 'synced' }, 'check-in'),
    /cannot check in/,
  );
});

test('returns a new state for successful check-in without changing its source fixture', () => {
  const sourceFixture: AttendanceEventState = { status: 'unknown', syncState: 'idle' };
  const simulated = simulateAttendanceEvent(sourceFixture, 'check-in');

  assert.deepEqual(sourceFixture, { status: 'unknown', syncState: 'idle' });
  assert.deepEqual(simulated, { status: 'present', syncState: 'synced' });
  assert.notEqual(simulated, sourceFixture);
});

test('allows check-out after check-in', () => {
  const afterCheckIn = simulateAttendanceEvent(
    { status: 'unknown', syncState: 'idle' },
    'check-in',
  );

  assert.deepEqual(simulateAttendanceEvent(afterCheckIn, 'check-out'), {
    status: 'present',
    syncState: 'synced',
    checkOutCompleted: true,
  });
});

test('rejects duplicate check-in for every checked-in state', () => {
  const checkedInStates: AttendanceEventState['status'][] = [
    'present',
    'late',
    'outside-geofence',
    'anomaly',
    'pending-sync',
    'review-required',
  ];

  for (const status of checkedInStates) {
    assert.throws(
      () => simulateAttendanceEvent({ status, syncState: 'synced' }, 'check-in'),
      /cannot check in/,
    );
  }
});

test('rejects check-out before attendance starts', () => {
  for (const status of ['unknown', 'absent'] as const) {
    assert.throws(
      () => simulateAttendanceEvent({ status, syncState: 'idle' }, 'check-out'),
      /cannot check out/,
    );
  }
});

test('accepts low-accuracy review transitions without falsely syncing them', () => {
  assert.deepEqual(
    simulateAttendanceEvent({ status: 'unknown', syncState: 'idle' }, 'check-in-review'),
    { status: 'review-required', syncState: 'synced' },
  );
  assert.deepEqual(
    simulateAttendanceEvent({ status: 'present', syncState: 'synced' }, 'check-out-review'),
    { status: 'review-required', syncState: 'synced', checkOutCompleted: true },
  );
});

test('keeps offline check-out pending and rejects duplicate check-out', () => {
  assert.deepEqual(
    simulateAttendanceEvent({ status: 'present', syncState: 'synced' }, 'check-out-offline'),
    { status: 'pending-sync', syncState: 'queued', checkOutCompleted: true },
  );
  assert.throws(
    () => simulateAttendanceEvent({ status: 'present', syncState: 'synced', checkOutCompleted: true }, 'check-out'),
    /cannot check out twice/,
  );
});

test('applies transition guards to offline and review variants', () => {
  for (const event of ['check-out-offline', 'check-out-review'] as const) {
    assert.throws(
      () => simulateAttendanceEvent({ status: 'unknown', syncState: 'idle' }, event),
      /cannot check out before checking in/,
    );
  }
  assert.throws(
    () => simulateAttendanceEvent({ status: 'present', syncState: 'synced' }, 'check-in-review'),
    /cannot check in/,
  );
});

test('projects simulated attendance into today and history without mutating fixtures', () => {
  const member = getMemberDashboard();
  const today = member.today!;
  const display = deriveMemberAttendanceDisplay(
    { status: 'pending-sync', syncState: 'queued' },
    today,
    member.history,
  );

  assert.equal(display.today.status, 'pending-sync');
  assert.equal(display.today.checkIn, '07:54');
  assert.equal(display.today.syncState, 'queued');
  assert.equal(display.history[0].status, 'pending-sync');
  assert.equal(today.checkIn, null);
  assert.equal(today.status, 'unknown');
});

test('projects the completed scenario into a finished today card without changing fixtures', () => {
  const member = getMemberDashboard();
  const sourceState: AttendanceEventState = { status: 'unknown', syncState: 'idle' };
  const scenarioState = getMemberScenarioState(sourceState, 'completed');
  const display = deriveMemberAttendanceDisplay(
    scenarioState,
    member.today!,
    member.history,
  );

  assert.deepEqual(
    { checkIn: display.today.checkIn, checkOut: display.today.checkOut, status: display.today.status, syncState: display.today.syncState },
    { checkIn: '07:54', checkOut: '14:00', status: 'present', syncState: 'synced' },
  );
  assert.equal(member.today?.checkIn, null);
  assert.equal(member.today?.checkOut, null);
  assert.deepEqual(sourceState, { status: 'unknown', syncState: 'idle' });
});

test('keeps checkout completion distinct from pending synchronization and review', () => {
  const pending = getMemberAttendancePresentation({ status: 'pending-sync', syncState: 'queued', checkOutCompleted: true });
  const review = getMemberAttendancePresentation({ status: 'review-required', syncState: 'synced', checkOutCompleted: true });

  assert.equal(pending.todayLabel, 'Check-out tercatat · menunggu sinkronisasi');
  assert.equal(pending.historyLabel, 'Check-out menunggu sinkronisasi');
  assert.equal(pending.pendingCount, 1);
  assert.equal(pending.reviewCount, 0);
  assert.equal(review.todayLabel, 'Check-out tercatat · menunggu tinjauan');
  assert.equal(review.historyLabel, 'Check-out menunggu tinjauan');
  assert.equal(review.pendingCount, 0);
  assert.equal(review.reviewCount, 1);
});

test('labels pending and review checkout history as completed attendance awaiting resolution', () => {
  const member = getMemberDashboard();
  const row = member.today!;

  assert.equal(getAttendanceHistoryLabel({ ...row, status: 'pending-sync', checkIn: '07:54', checkOut: '14:00', syncState: 'queued' }), 'Check-out menunggu sinkronisasi');
  assert.equal(getAttendanceHistoryLabel({ ...row, status: 'review-required', checkIn: '07:54', checkOut: '14:00', syncState: 'synced' }), 'Check-out menunggu tinjauan');
});

test('does not convert pending or review check-in to online checkout', () => {
  assert.throws(
    () => simulateAttendanceEvent({ status: 'pending-sync', syncState: 'queued' }, 'check-out'),
    /pending or review/,
  );
  assert.throws(
    () => simulateAttendanceEvent({ status: 'review-required', syncState: 'synced' }, 'check-out'),
    /pending or review/,
  );
});

test('runs successful member check-in and check-out through one workflow', () => {
  const checkedIn = submitMemberAttendance({ status: 'unknown', syncState: 'idle' }, 'accepted');
  assert.equal(checkedIn.accepted, true);
  assert.deepEqual(checkedIn.state, { status: 'present', syncState: 'synced' });

  const checkedOut = submitMemberAttendance(checkedIn.state, 'accepted');
  assert.equal(checkedOut.accepted, true);
  assert.deepEqual(checkedOut.state, { status: 'present', syncState: 'synced', checkOutCompleted: true });
});

test('preserves pending state and rejected submissions in member workflow', () => {
  const pending = submitMemberAttendance({ status: 'unknown', syncState: 'idle' }, 'pending');
  assert.deepEqual(pending.state, { status: 'pending-sync', syncState: 'queued' });
  assert.throws(() => submitMemberAttendance(pending.state, 'accepted'), /pending or review/);

  const source: AttendanceEventState = { status: 'unknown', syncState: 'idle' };
  const rejected = submitMemberAttendance(source, 'rejected');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.state, source);
  assert.deepEqual(source, { status: 'unknown', syncState: 'idle' });
});
