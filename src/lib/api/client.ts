'use client';

/**
 * Browser-side API client for the /api/v1 routes. Centralizes fetch plumbing
 * (JSON parsing, stable error surface) so pages stay DRY. Session auth rides
 * on the HttpOnly cookie, so every request is same-origin with credentials.
 *
 * Types here mirror the route response shapes (camelCase, ISO strings):
 * - GET /api/v1/me                  -> { user: SessionUser }
 * - GET /api/v1/me/dashboard        -> MyDashboard
 * - GET /api/v1/attendance/context  -> AttendanceContextDto
 * - POST /api/v1/attendance/events  -> AttendanceEventResultDto
 * - GET /api/v1/manager/team/today  -> { members: TeamMemberToday[] }
 */

export class ApiError extends Error {
  public status: number;
  public code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseErrorBody(res: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    return {
      code: typeof body.code === 'string' ? body.code : 'INTERNAL_ERROR',
      message: typeof body.message === 'string' ? body.message : 'Permintaan gagal. Coba lagi.',
    };
  } catch {
    return { code: 'INTERNAL_ERROR', message: 'Permintaan gagal. Coba lagi.' };
  }
}

/** fetch() wrapper that parses JSON and throws ApiError with the stable code on non-2xx. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Tidak dapat terhubung ke server. Periksa koneksi Anda.');
  }
  if (!res.ok) {
    const err = await parseErrorBody(res);
    throw new ApiError(res.status, err.code, err.message);
  }
  return (await res.json()) as T;
}

// --------------------------------------------------------------------------
// /api/v1/me
// --------------------------------------------------------------------------

export interface SessionUser {
  id: string;
  displayName: string;
  emailNormalized: string | null;
  phoneE164: string | null;
  roles: string[];
}

// --------------------------------------------------------------------------
// /api/v1/me/dashboard
// --------------------------------------------------------------------------

export interface DashboardEntry {
  workDate: string;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  lateMinutes: number;
  workedMinutes: number | null;
  reviewStatus: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  isHoliday: boolean;
}

export interface MyDashboard {
  today: DashboardEntry | null;
  recent: DashboardEntry[];
}

// --------------------------------------------------------------------------
// /api/v1/attendance/context
// --------------------------------------------------------------------------

export interface EffectiveScheduleDto {
  scheduleId: string;
  workDate: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  crossesMidnight: boolean;
  graceMinutes: number;
  breakMinutes: number;
  isHoliday: boolean;
}

export interface EffectivePolicyDto {
  geofenceMode: 'mandatory' | 'optional';
  maxAccuracyM: number;
  retryCount: number;
  selfieRequired: boolean;
}

export interface AttendanceLocationDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number | null;
}

export interface AttendanceContextDto {
  schedule: EffectiveScheduleDto | null;
  policy: EffectivePolicyDto;
  locations: AttendanceLocationDto[];
  serverNow: string;
}

// --------------------------------------------------------------------------
// POST /api/v1/attendance/events
// --------------------------------------------------------------------------

export interface GeofenceVerdictDto {
  inside: boolean | null;
  blocked: boolean;
  accuracyAnomaly: boolean;
  locationId?: string;
  distanceM?: number;
}

export interface AttendanceEventDto {
  id: string;
  event_type: string;
  device_occurred_at: string;
  server_received_at: string;
  status: string;
  geofence_result: string;
  accuracy_m: number | null;
  distance_m: number | null;
  location_id: string | null;
  selfie_object_id: string | null;
}

export interface WorkInstanceDto {
  id: string;
  work_date: string;
  status: string;
  late_minutes: number;
  worked_minutes: number | null;
  review_status: string;
}

export interface AttendanceEventResultDto {
  created: boolean;
  outcome: 'accepted' | 'needs_review' | 'blocked' | 'rejected';
  event?: AttendanceEventDto;
  workInstance?: WorkInstanceDto;
  verdict?: GeofenceVerdictDto;
}

/**
 * Posts a check-in/out as multipart FormData: a `metadata` JSON field plus the
 * `selfie` JPEG file (field names fixed by the route). Returns the HTTP status
 * with the parsed body for every completion — including the business outcomes
 * 200 (idempotent replay), 422 (BLOCKED) and 409 (REJECTED), whose bodies the
 * caller needs — and throws ApiError only for network failures or bodies that
 * are not the expected JSON shape.
 */
export async function postAttendanceEvent(args: {
  eventType: 'check_in' | 'check_out';
  idempotencyKey: string;
  deviceOccurredAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locationAcquiredAt: string | null;
  clockOffsetMs: number | null;
  selfie: Blob;
}): Promise<{ status: number; body: AttendanceEventResultDto & { code?: string; message?: string } }> {
  const form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      eventType: args.eventType,
      idempotencyKey: args.idempotencyKey,
      deviceOccurredAt: args.deviceOccurredAt,
      ...(args.latitude != null ? { latitude: args.latitude } : {}),
      ...(args.longitude != null ? { longitude: args.longitude } : {}),
      ...(args.accuracyM != null ? { accuracyM: args.accuracyM } : {}),
      ...(args.locationAcquiredAt != null ? { locationAcquiredAt: args.locationAcquiredAt } : {}),
      ...(args.clockOffsetMs != null ? { clockOffsetMs: args.clockOffsetMs } : {}),
    }),
  );
  form.set('selfie', args.selfie, 'selfie.jpg');

  let res: Response;
  try {
    res = await fetch('/api/v1/attendance/events', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: form,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Tidak dapat terhubung ke server. Periksa koneksi Anda.');
  }
  const body = (await res.json().catch(() => ({}))) as AttendanceEventResultDto & { code?: string; message?: string };
  return { status: res.status, body };
}

// --------------------------------------------------------------------------
// /api/v1/manager/team/today
// --------------------------------------------------------------------------

export interface TeamMemberToday {
  userId: string;
  displayName: string;
  teamId: string;
  teamName: string;
  workDate: string | null;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  lateMinutes: number;
  workedMinutes: number | null;
  reviewStatus: string;
}

// --------------------------------------------------------------------------
// Role helpers
// --------------------------------------------------------------------------

/** The platform tenant slug hosting the superadmin account (decisions.md #11). */
export const PLATFORM_TENANT_SLUG = 'vortech-platform';

/** Where a user with the given roles should land after login. */
export function homePathForRoles(roles: string[], tenantSlug: string): string {
  if (roles.includes('admin') || roles.includes('superadmin')) return `/${tenantSlug}/admin/locations`;
  if (roles.includes('manager')) return `/${tenantSlug}/manager`;
  return `/${tenantSlug}/dashboard`;
}

export function roleLabel(roles: string[]): string {
  if (roles.includes('superadmin')) return 'Superadmin';
  if (roles.includes('admin')) return 'Administrator';
  if (roles.includes('manager')) return 'Manajer';
  return 'Anggota';
}
