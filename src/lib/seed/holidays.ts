/**
 * Indonesian national holidays (libur nasional) for 2026-2027, seeded with
 * tenant_id NULL and kind 'national' (PRD 7.4 / decisions.md #9).
 *
 * Fixed-date holidays are statutory. Movable religious dates (Islamic, lunar,
 * Balinese Saka) follow the widely published SKB 3 Menteri joint-decree
 * calendar; they are best-effort and the superadmin can correct them via the
 * holiday CRUD screens, so no external dependency is required.
 */
export interface IndonesianHoliday {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  name: string;
  kind: 'national';
}

function national(date: string, name: string): IndonesianHoliday {
  return { date, name, kind: 'national' };
}

export const INDONESIAN_HOLIDAYS: readonly IndonesianHoliday[] = [
  // ---- 2026 ----
  national('2026-01-01', 'Tahun Baru 2026'),
  national('2026-01-16', 'Isra Mikraj Nabi Muhammad SAW 1447 H'),
  national('2026-02-17', 'Tahun Baru Imlek 2577 Kongzili'),
  national('2026-03-19', 'Hari Suci Nyepi (Tahun Baru Saka 1948)'),
  national('2026-03-21', 'Idul Fitri 1447 H (Hari 1)'),
  national('2026-03-22', 'Idul Fitri 1447 H (Hari 2)'),
  national('2026-04-03', 'Wafat Isa Almasih (Jumat Agung)'),
  national('2026-04-05', 'Kebangkitan Isa Almasih (Paskah)'),
  national('2026-05-01', 'Hari Buruh Internasional'),
  national('2026-05-14', 'Kenaikan Isa Almasih'),
  national('2026-05-27', 'Idul Adha 1447 H'),
  national('2026-05-31', 'Hari Raya Waisak 2570 BE'),
  national('2026-06-01', 'Hari Lahir Pancasila'),
  national('2026-06-17', 'Tahun Baru Islam 1448 H'),
  national('2026-08-17', 'Hari Kemerdekaan Republik Indonesia'),
  national('2026-08-26', 'Maulid Nabi Muhammad SAW 1448 H'),
  national('2026-12-25', 'Hari Raya Natal'),

  // ---- 2027 ----
  national('2027-01-01', 'Tahun Baru 2027'),
  national('2027-01-05', 'Isra Mikraj Nabi Muhammad SAW 1448 H'),
  national('2027-02-06', 'Tahun Baru Imlek 2578 Kongzili'),
  national('2027-03-08', 'Hari Suci Nyepi (Tahun Baru Saka 1949)'),
  national('2027-03-10', 'Idul Fitri 1448 H (Hari 1)'),
  national('2027-03-11', 'Idul Fitri 1448 H (Hari 2)'),
  national('2027-03-26', 'Wafat Isa Almasih (Jumat Agung)'),
  national('2027-03-28', 'Kebangkitan Isa Almasih (Paskah)'),
  national('2027-05-01', 'Hari Buruh Internasional'),
  national('2027-05-06', 'Kenaikan Isa Almasih'),
  national('2027-05-17', 'Idul Adha 1448 H'),
  national('2027-05-20', 'Hari Raya Waisak 2571 BE'),
  national('2027-06-01', 'Hari Lahir Pancasila'),
  national('2027-06-06', 'Tahun Baru Islam 1449 H'),
  national('2027-08-15', 'Maulid Nabi Muhammad SAW 1449 H'),
  national('2027-08-17', 'Hari Kemerdekaan Republik Indonesia'),
  national('2027-12-25', 'Hari Raya Natal'),
];
