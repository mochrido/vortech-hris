import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { getObjectPath, readObject, storeObject } from './objects.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

interface DbFixture {
  url: string;
  pool: pg.Pool;
  tenantId: string;
}

async function setupDb(t: test.TestContext): Promise<DbFixture> {
  await closePool();
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await closePool();
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    ['objects-test', 'Objects Test Legal', 'Objects Test'],
  );
  return { url, pool, tenantId: tenant.rows[0].id };
}

/** Creates an isolated temp storage dir for one test and registers cleanup. */
async function setupStorageDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(repoRoot, '.tmp-objects-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('objects: storeObject writes an opaque-UUID file under STORAGE_DIR and inserts a stored_objects row', async (t) => {
  const fixture = await setupDb(t);
  const storageDir = await setupStorageDir(t);
  const buffer = Buffer.from('fake-jpeg-bytes-for-storage-test');

  const result = await storeObject(fixture.pool, {
    tenantId: fixture.tenantId,
    kind: 'selfie',
    buffer,
    mediaType: 'image/jpeg',
    storageDir,
  });

  assert.ok(UUID_RE.test(result.id), `expected an opaque UUID id, got: ${result.id}`);
  assert.ok(result.relativePath.includes(result.id), 'relative path should be organized by the object id');

  // File exists on disk under the storage dir with the exact bytes.
  const absolute = getObjectPath(result.relativePath, storageDir);
  assert.ok(absolute.startsWith(path.resolve(storageDir) + path.sep), `path ${absolute} must stay inside ${storageDir}`);
  const onDisk = await fs.readFile(absolute);
  assert.deepEqual(onDisk, buffer);

  // Row persisted with correct metadata.
  const rows = await fixture.pool.query<{
    id: string;
    tenant_id: string;
    kind: string;
    relative_path: string;
    media_type: string;
    byte_size: string;
    sha256: string;
  }>(`SELECT id, tenant_id, kind, relative_path, media_type, byte_size, sha256 FROM stored_objects WHERE id = $1`, [result.id]);
  assert.equal(rows.rows.length, 1);
  const row = rows.rows[0];
  assert.equal(row.tenant_id, fixture.tenantId);
  assert.equal(row.kind, 'selfie');
  assert.equal(row.relative_path, result.relativePath);
  assert.equal(row.media_type, 'image/jpeg');
  assert.equal(Number(row.byte_size), buffer.length);
  assert.equal(row.sha256, createHash('sha256').update(buffer).digest('hex'));
});

test('objects: readObject returns the stored bytes for a known id', async (t) => {
  const fixture = await setupDb(t);
  const storageDir = await setupStorageDir(t);
  const buffer = Buffer.from('read-me-back');

  const stored = await storeObject(fixture.pool, {
    tenantId: fixture.tenantId,
    kind: 'selfie',
    buffer,
    mediaType: 'image/jpeg',
    storageDir,
  });

  const read = await readObject(fixture.pool, { tenantId: fixture.tenantId, id: stored.id, storageDir });
  assert.deepEqual(read.buffer, buffer);
  assert.equal(read.mediaType, 'image/jpeg');
});

test('objects: getObjectPath resolves a stored relative_path inside STORAGE_DIR', async (t) => {
  const storageDir = await setupStorageDir(t);

  const resolved = getObjectPath(`selfie/${randomUUID()}.jpg`, storageDir);

  assert.equal(resolved, path.join(path.resolve(storageDir), 'selfie', `${path.basename(resolved)}`));
  assert.ok(resolved.startsWith(path.resolve(storageDir) + path.sep));
});

test('objects: a relative_path containing ".." is rejected (path traversal)', async (t) => {
  const storageDir = await setupStorageDir(t);

  assert.throws(() => getObjectPath('../escape.txt', storageDir), /traversal|outside|invalid/i);
  assert.throws(() => getObjectPath('selfie/../../escape.txt', storageDir), /traversal|outside|invalid/i);
  assert.throws(() => getObjectPath('/absolute/escape.txt', storageDir), /traversal|outside|invalid/i);
});

test('objects: readObject rejects an id that does not belong to the tenant', async (t) => {
  const fixture = await setupDb(t);
  const storageDir = await setupStorageDir(t);

  const stored = await storeObject(fixture.pool, {
    tenantId: fixture.tenantId,
    kind: 'selfie',
    buffer: Buffer.from('tenant-a-bytes'),
    mediaType: 'image/jpeg',
    storageDir,
  });

  const otherTenant = await fixture.pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('other-tenant', 'Other Legal', 'Other') RETURNING id`,
  );

  await assert.rejects(
    readObject(fixture.pool, { tenantId: otherTenant.rows[0].id, id: stored.id, storageDir }),
    /not found|forbidden/i,
  );
});
