import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdminOverview,
  getDemoContext,
  getManagerDashboard,
  getMemberDashboard,
  getSuperadminOverview,
  simulateAttendanceEvent,
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
  });
});
