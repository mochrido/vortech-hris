import type { DemoData } from './types';

export const demoData: DemoData = {
  tenant: { key: 'tenant-nusantara', name: 'PT Langkah Nusantara', timezone: 'Asia/Jakarta' },
  users: [
    { key: 'user-sari-utami', name: 'Sari Utami', email: 'sari@langkah.example', role: 'member', teamKey: 'team-operasional', active: true },
    { key: 'user-bima-santoso', name: 'Bima Santoso', email: 'bima@langkah.example', role: 'member', teamKey: 'team-operasional', active: true },
    { key: 'user-nadia-putri', name: 'Nadia Putri', email: 'nadia@langkah.example', role: 'member', teamKey: 'team-layanan', active: true },
    { key: 'user-raka-wijaya', name: 'Raka Wijaya', email: 'raka@langkah.example', role: 'manager', teamKey: 'team-operasional', active: true },
    { key: 'user-dewi-pranoto', name: 'Dewi Pranoto', email: 'dewi@langkah.example', role: 'manager', teamKey: 'team-layanan', active: true },
    { key: 'user-andi-rahman', name: 'Andi Rahman', email: 'andi@langkah.example', role: 'admin', teamKey: 'team-operasional', active: true },
  ],
  teams: [
    { key: 'team-operasional', name: 'Operasional', managerKey: 'user-raka-wijaya', memberKeys: ['user-sari-utami', 'user-bima-santoso'] },
    { key: 'team-layanan', name: 'Layanan Pelanggan', managerKey: 'user-dewi-pranoto', memberKeys: ['user-nadia-putri'] },
  ],
  locations: [
    { key: 'location-kantor-pusat', name: 'Kantor Pusat', address: 'Jl. Merdeka 10, Jakarta', latitude: -6.2, longitude: 106.816, radiusMeters: 150 },
    { key: 'location-gudang-timur', name: 'Gudang Timur', address: 'Jl. Industri 5, Bekasi', latitude: -6.238, longitude: 106.975, radiusMeters: 200 },
  ],
  schedules: [
    { key: 'schedule-reguler', name: 'Reguler', startTime: '08:00', endTime: '17:00', workDays: [1, 2, 3, 4, 5] },
    { key: 'schedule-shift-pagi', name: 'Shift Pagi', startTime: '06:00', endTime: '14:00', workDays: [1, 2, 3, 4, 5, 6] },
  ],
  attendance: [
    { key: 'attendance-sari-today', userKey: 'user-sari-utami', date: '2026-08-06', checkIn: '07:54', checkOut: null, status: 'present', locationKey: 'location-kantor-pusat', syncState: 'synced' },
    { key: 'attendance-bima-today', userKey: 'user-bima-santoso', date: '2026-08-06', checkIn: '08:19', checkOut: null, status: 'late', locationKey: 'location-kantor-pusat', syncState: 'synced' },
    { key: 'attendance-bima-aug5', userKey: 'user-bima-santoso', date: '2026-08-05', checkIn: '08:03', checkOut: null, status: 'review-required', locationKey: 'location-kantor-pusat', syncState: 'synced', note: 'Koreksi check-out menunggu tinjauan' },
    { key: 'attendance-nadia-today', userKey: 'user-nadia-putri', date: '2026-08-06', checkIn: null, checkOut: null, status: 'absent', locationKey: null, syncState: 'idle' },
    { key: 'attendance-raka-today', userKey: 'user-raka-wijaya', date: '2026-08-06', checkIn: '08:02', checkOut: null, status: 'outside-geofence', locationKey: 'location-gudang-timur', syncState: 'failed', note: 'Jarak 342 m dari lokasi terdaftar' },
    { key: 'attendance-dewi-today', userKey: 'user-dewi-pranoto', date: '2026-08-06', checkIn: '08:01', checkOut: null, status: 'anomaly', locationKey: 'location-kantor-pusat', syncState: 'synced', note: 'Perangkat berbeda dari biasanya' },
    { key: 'attendance-sari-yesterday', userKey: 'user-sari-utami', date: '2026-08-05', checkIn: '08:05', checkOut: '17:03', status: 'pending-sync', locationKey: 'location-kantor-pusat', syncState: 'queued' },
  ],
  correctionRequests: [{ key: 'correction-bima-aug5', attendanceKey: 'attendance-bima-aug5', userKey: 'user-bima-santoso', reason: 'Lupa melakukan check-out', status: 'review-required' }],
  tenantSubscriptions: [{ key: 'subscription-nusantara', tenantKey: 'tenant-nusantara', plan: 'business', status: 'active', seats: 50, renewalDate: '2026-12-01' }],
  featureFlags: [
    { key: 'flag-offline-sync', name: 'Sinkronisasi offline', enabled: true, scope: 'tenant' },
    { key: 'flag-camera-proof', name: 'Bukti foto', enabled: false, scope: 'tenant' },
    { key: 'flag-platform-audit', name: 'Audit platform', enabled: true, scope: 'platform' },
  ],
  syncState: { online: false, pendingCount: 1, lastSyncedAt: '2026-08-06T07:54:00+07:00', message: '1 data menunggu sinkronisasi' },
};
