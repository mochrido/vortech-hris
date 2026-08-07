import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_BACKUP_DIR,
  buildArchiveFileName,
  encryptedArchivePath,
  parseArchivePath,
  plaintextArchivePath,
  resolveBackupDir,
  validateRestoreConfirmation,
} from './backup.ts';

test('resolveBackupDir falls back to the default when BACKUP_DIR is unset/blank', () => {
  assert.equal(resolveBackupDir({}), DEFAULT_BACKUP_DIR);
  assert.equal(resolveBackupDir({ BACKUP_DIR: '   ' }), DEFAULT_BACKUP_DIR);
});

test('resolveBackupDir honours BACKUP_DIR when set', () => {
  assert.equal(resolveBackupDir({ BACKUP_DIR: '/var/backups/vortech' }), '/var/backups/vortech');
  assert.equal(resolveBackupDir({ BACKUP_DIR: 'D:\\backups' }), 'D:\\backups');
});

test('buildArchiveFileName produces a timestamped, filesystem-safe name', () => {
  const name = buildArchiveFileName(new Date('2026-08-06T12:30:45.123Z'));
  assert.equal(name, 'vortech-2026-08-06T12-30-45-123Z.pg.dump');
  assert.match(name, /^vortech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.pg\.dump$/);
  assert.ok(!name.includes(':'), 'filename must not contain colons (Windows-unsafe)');
});

test('plaintext/encrypted archive path helpers compose correctly', () => {
  const plain = plaintextArchivePath('backups', 'vortech-x.pg.dump');
  assert.equal(plain, path.join('backups', 'vortech-x.pg.dump'));
  assert.equal(encryptedArchivePath(plain), `${plain}.enc`);
});

test('parseArchivePath detects encryption from the .enc suffix', () => {
  assert.deepEqual(parseArchivePath('a/b/vortech-x.pg.dump'), {
    restoreInputPath: 'a/b/vortech-x.pg.dump',
    encrypted: false,
  });
  assert.deepEqual(parseArchivePath('a/b/vortech-x.pg.dump.enc'), {
    restoreInputPath: 'a/b/vortech-x.pg.dump.enc',
    encrypted: true,
  });
});

test('parseArchivePath explicit decrypt override wins over suffix', () => {
  assert.equal(parseArchivePath('dump.pg.dump', true).encrypted, true);
  assert.equal(parseArchivePath('dump.pg.dump.enc', false).encrypted, false);
});

test('parseArchivePath rejects an empty path', () => {
  assert.throws(() => parseArchivePath(''), /archive path is required/i);
  assert.throws(() => parseArchivePath('   '), /archive path is required/i);
});

test('validateRestoreConfirmation requires the exact database name', () => {
  const url = 'postgresql://u:p@db:5432/vortech';
  assert.equal(validateRestoreConfirmation('vortech', url), null);
  assert.match(validateRestoreConfirmation('other', url) ?? '', /destructive/i);
  assert.match(validateRestoreConfirmation(undefined, url) ?? '', /destructive/i);
});

test('validateRestoreConfirmation rejects invalid or nameless DATABASE_URL', () => {
  assert.match(validateRestoreConfirmation('x', 'not-a-url') ?? '', /not a valid/i);
  assert.match(validateRestoreConfirmation('x', 'postgresql://u:p@db:5432/') ?? '', /no database name/i);
});
