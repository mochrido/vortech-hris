import path from 'node:path';

/**
 * Pure helpers for backup/restore path construction and filename parsing.
 * No I/O and no database access, so these are unit-testable without a live DB.
 */

export const DEFAULT_BACKUP_DIR = 'backups';
export const ENCRYPTED_SUFFIX = '.enc';

/** Minimal env shape read by these helpers (satisfied by `process.env`). */
export type EnvLike = Record<string, string | undefined>;

/** Returns the directory that backups are written to (BACKUP_DIR or default). */
export function resolveBackupDir(env: EnvLike = process.env): string {
  const dir = env.BACKUP_DIR?.trim();
  return dir && dir.length > 0 ? dir : DEFAULT_BACKUP_DIR;
}

/**
 * Builds a timestamped archive filename like
 * `vortech-2026-08-06T12-30-45-123Z.pg.dump` (safe for all filesystems).
 */
export function buildArchiveFileName(date: Date, prefix = 'vortech'): string {
  const ts = date
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+$/, (ms) => ms.replace('.', '-')); // keep ms, drop the dot
  return `${prefix}-${ts}.pg.dump`;
}

/** Absolute/relative path of the plaintext (unencrypted) archive. */
export function plaintextArchivePath(backupDir: string, fileName: string): string {
  return path.join(backupDir, fileName);
}

/** Path of the encrypted archive (plaintext path + `.enc`). */
export function encryptedArchivePath(plaintextPath: string): string {
  return `${plaintextPath}${ENCRYPTED_SUFFIX}`;
}

export interface ParsedArchive {
  /** Path handed to `pg_restore`. */
  restoreInputPath: string;
  /** True when the archive must be decrypted before restoring. */
  encrypted: boolean;
}

/**
 * Given a user-supplied archive path, decide whether it is encrypted and what
 * path should be fed to the restore tool. An explicit `decrypt` override wins:
 * pass `true` to force decryption, `false` to force plaintext.
 */
export function parseArchivePath(archivePath: string, decrypt?: boolean): ParsedArchive {
  if (!archivePath || archivePath.trim().length === 0) {
    throw new Error('An archive path is required.');
  }
  const looksEncrypted = archivePath.endsWith(ENCRYPTED_SUFFIX);
  const encrypted = decrypt !== undefined ? decrypt : looksEncrypted;
  return { restoreInputPath: archivePath, encrypted };
}

/** Validates the restore confirmation token. Returns an error message or null. */
export function validateRestoreConfirmation(
  provided: string | undefined,
  databaseUrl: string,
): string | null {
  let dbName = '';
  try {
    dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return 'DATABASE_URL is not a valid connection URL; refusing to restore.';
  }
  if (!dbName) {
    return 'DATABASE_URL has no database name; refusing to restore.';
  }
  if (provided !== dbName) {
    return (
      `Restore is destructive. Re-run with RESTORE_CONFIRM=${dbName} ` +
      `(the target database name) to proceed.`
    );
  }
  return null;
}
