import { mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../src/lib/test/env.ts';
import {
  buildArchiveFileName,
  encryptedArchivePath,
  plaintextArchivePath,
  resolveBackupDir,
} from '../src/lib/backup/backup.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command, returning true on exit code 0. Never throws on non-zero exit. */
function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env } });
  return result.status === 0;
}

/**
 * Encrypts `plaintextPath` to `plaintextPath + '.enc'` using openssl AES-256-CBC
 * with PBKDF2 key derivation and a random salt (openssl embeds a Salted__ header
 * so restore only needs the passphrase — no separate IV handling). This is the
 * documented, symmetric counterpart to scripts/restore.ts.
 */
function encrypt(plaintextPath: string, passphrase: string): boolean {
  const out = encryptedArchivePath(plaintextPath);
  return run('openssl', [
    'enc', '-aes-256-cbc', '-pbkdf2', '-salt',
    '-k', passphrase,
    '-in', plaintextPath,
    '-out', out,
  ]);
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, '.env'));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (checked environment and .env)');
  }

  const backupDir = resolveBackupDir();
  mkdirSync(backupDir, { recursive: true });

  const fileName = buildArchiveFileName(new Date());
  const plaintextPath = plaintextArchivePath(backupDir, fileName);

  // Custom-format compressed dump; restorable with pg_restore.
  const dumpOk = run('pg_dump', ['-Fc', '-f', plaintextPath, databaseUrl]);
  if (!dumpOk) {
    throw new Error(`pg_dump failed for ${fileName}`);
  }

  const passphrase = process.env.BACKUP_PASSPHRASE?.trim();
  if (passphrase) {
    if (!encrypt(plaintextPath, passphrase)) {
      throw new Error(`openssl encryption failed; plaintext archive retained at ${plaintextPath}`);
    }
    // Keep only the encrypted archive.
    unlinkSync(plaintextPath);
    const out = encryptedArchivePath(plaintextPath);
    console.log(`Encrypted backup written: ${out}`);
    console.log('Keep BACKUP_PASSPHRASE somewhere safe and OFF this host.');
    console.log('Move this archive off the VPS — a backup on the same VPS is not a backup (PRD 15).');
  } else {
    console.log(`Backup written: ${plaintextPath}`);
    console.warn(
      'WARNING: BACKUP_PASSPHRASE is not set; this archive is UNENCRYPTED. ' +
        'Set BACKUP_PASSPHRASE to encrypt, and move the archive off the VPS.',
    );
  }
}

main().catch((error) => {
  console.error('Backup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
