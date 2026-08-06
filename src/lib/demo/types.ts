export type DemoRole = 'member' | 'manager' | 'admin' | 'superadmin';

export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'absent'
  | 'outside-geofence'
  | 'anomaly'
  | 'pending-sync'
  | 'unknown';
export type SyncState = 'idle' | 'queued' | 'synced' | 'failed';

export interface Tenant { key: string; name: string; timezone: string }
export interface User { key: string; name: string; email: string; role: DemoRole; teamKey: string; active: boolean }
export interface Team { key: string; name: string; managerKey: string; memberKeys: string[] }
export interface Location { key: string; name: string; address: string; latitude: number; longitude: number; radiusMeters: number }
export interface Schedule { key: string; name: string; startTime: string; endTime: string; workDays: number[] }
export interface AttendanceSummary { key: string; userKey: string; date: string; checkIn: string | null; checkOut: string | null; status: AttendanceStatus; locationKey: string | null; syncState: SyncState; note?: string }
export interface CorrectionRequest { key: string; attendanceKey: string; userKey: string; reason: string; status: 'review-required' | 'approved' | 'rejected' }
export interface TenantSubscription { key: string; tenantKey: string; plan: 'starter' | 'business' | 'enterprise'; status: 'trial' | 'active' | 'past-due'; seats: number; renewalDate: string }
export interface FeatureFlag { key: string; name: string; enabled: boolean; scope: 'tenant' | 'platform' }
export interface UiSyncState { online: boolean; pendingCount: number; lastSyncedAt: string | null; message: string }

export interface DemoData {
  tenant: Tenant;
  users: User[];
  teams: Team[];
  locations: Location[];
  schedules: Schedule[];
  attendance: AttendanceSummary[];
  correctionRequests: CorrectionRequest[];
  tenantSubscriptions: TenantSubscription[];
  featureFlags: FeatureFlag[];
  syncState: UiSyncState;
}

export interface AttendanceEventState { status: AttendanceStatus; syncState: SyncState }
export type AttendanceEvent = 'check-in' | 'check-in-offline' | 'check-out' | 'sync';
