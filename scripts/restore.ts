import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../src/lib/test/env.ts';
import {
  parseArchivePath,
  validateRestoreConfirmation,
} from '../src/lib/backup/backup.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env } });
  return result.status === 0;
}

function usage(): void {
  console.log(
    [
      'Usage: npm run restore -- <archive.pg.dump[.enc]>',
      '',
      'Environment:',
      '  DATABASE_URL       Target database to restore INTO (destructive).',
      '  RESTORE_CONFIRM    Must equal the target database name (safety guard).',
      '  RESTORE_DECRYPT    "1"/"true" to force decryption, "0"/"false" to skip.',
      '  BACKUP_PASSPHRASE  Passphrase/key used to decrypt a .enc archive.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadEnvFile(path.join(repoRoot, '.env'));

  const archiveArg = process.argv[2];
  if (!archiveArg) {
    usage();
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (checked environment and .env)');
  }

  // Destructive-operation guard.
  const guardError = validateRestoreConfirmation(process.env.RESTORE_CONFIRM, databaseUrl);
  if (guardError) {
    console.error(guardError);
    process.exitCode = 1;
    return;
  }

  const decryptEnv = process.env.RESTORE_DECRYPT?.trim().toLowerCase();
  const decryptOverride =
    decryptEnv === '1' || decryptEnv === 'true'
      ? true
      : decryptEnv === '0' || decryptEnv === 'false'
        ? false
        : undefined;

  const { restoreInputPath, encrypted } = parseArchivePath(archiveArg, decryptOverride);

  let inputPath = restoreInputPath;
  if (encrypted) {
    const passphrase = process.env.BACKUP_PASSPHRASE?.trim();
    if (!passphrase) {
      throw new Error('Archive is encrypted but BACKUP_PASSPHRASE is not set.');
    }
    // Counterpart to backup.ts: openssl AES-256-CBC + PBKDF2, salt embedded in
    // the Salted__ header, so only the passphrase is needed to decrypt.
    const decryptedPath = restoreInputPath.replace(/\.enc$/, '') || `${restoreInputPath}.dec`;
    const ok = run('openssl', [
      'enc', '-d', '-aes-256-cbc', '-pbkdf2',
      '-k', passphrase,
      '-in', restoreInputPath,
      '-out', decryptedPath,
    ]);
    if (!ok) {
      throw new Error('openssl decryption failed.');
    }
    inputPath = decryptedPath;
    console.log(`Decrypted archive to: ${inputPath}`);
  }

  if (!existsSync(inputPath)) {
    throw new Error(`Archive not found: ${inputPath}`);
  }

  // Restore into the target database. --clean drops existing objects first.
  const ok = run('pg_restore', ['--clean', '--if-exists', '--no-owner', '-d', databaseUrl, inputPath]);
  if (!ok) {
    throw new Error('pg_restore failed.');
  }
  console.log('Restore complete.');
}

main().catch((error) => {
  console.error('Restore failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
