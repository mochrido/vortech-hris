import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server.js';
import { AppError, ErrorCodes } from '../auth/errors.ts';
import { guardRequestFrom, jsonError, extractClientIp } from './http.ts';

test('guardRequestFrom exposes the session cookie in the GuardRequest shape', () => {
  const req = new NextRequest('http://localhost/api/v1/me', {
    headers: { cookie: 'vortech_session=tok-123; other=x' },
  });
  const guardReq = guardRequestFrom(req);
  assert.equal(guardReq.cookies.vortech_session, 'tok-123');
  assert.equal(guardReq.cookies.other, 'x');
  assert.equal(guardReq.cookies.missing, undefined);
});

test('jsonError maps AppError code/message/status', async () => {
  const res = jsonError(new AppError(ErrorCodes.SESSION_EXPIRED, 'Session expired or invalid', 401));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
});

test('jsonError collapses unknown errors to a generic 500 without leaking details', async () => {
  const res = jsonError(new Error('db connection failed: password=secret'));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(body).includes('password=secret'), 'internal details must not leak');
});

test('extractClientIp prefers the first x-forwarded-for entry, then x-real-ip', () => {
  const forwarded = new NextRequest('http://localhost/api/x', {
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
  });
  assert.equal(extractClientIp(forwarded), '203.0.113.7');

  const realIp = new NextRequest('http://localhost/api/x', {
    headers: { 'x-real-ip': '198.51.100.9' },
  });
  assert.equal(extractClientIp(realIp), '198.51.100.9');

  const none = new NextRequest('http://localhost/api/x');
  assert.equal(extractClientIp(none), undefined);
});
