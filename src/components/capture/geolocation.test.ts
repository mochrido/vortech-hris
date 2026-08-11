import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOLOCATION_MAX_ATTEMPTS,
  decideGeoAcquisition,
  decideRetryAfterError,
  geoErrorCodeFromCode,
  isAccuracyAcceptable,
} from './geolocation.ts';

test('geolocation accuracy boundary: exactly maxAccuracyM is acceptable, beyond it is not', () => {
  assert.equal(isAccuracyAcceptable(50, 50), true);
  assert.equal(isAccuracyAcceptable(51, 50), false);
  assert.equal(isAccuracyAcceptable(12, 50), true);
});

test('geolocation retries a poor fix up to the attempt budget, then reports accuracy_review', () => {
  // Attempts 1 and 2 with poor accuracy -> keep retrying.
  assert.equal(decideGeoAcquisition({ attempt: 1, accuracyM: 142, maxAccuracyM: 50 }), 'retry');
  assert.equal(decideGeoAcquisition({ attempt: 2, accuracyM: 142, maxAccuracyM: 50 }), 'retry');
  // Attempt 3 (budget exhausted) -> stop and submit the best fix for review.
  assert.equal(decideGeoAcquisition({ attempt: 3, accuracyM: 142, maxAccuracyM: 50 }), 'exhausted');
  assert.equal(GEOLOCATION_MAX_ATTEMPTS, 3);
});

test('geolocation accepts the first fix whose accuracy is within the limit', () => {
  assert.equal(decideGeoAcquisition({ attempt: 1, accuracyM: 18, maxAccuracyM: 50 }), 'fix');
  assert.equal(decideGeoAcquisition({ attempt: 2, accuracyM: 50, maxAccuracyM: 50 }), 'fix');
  assert.equal(decideGeoAcquisition({ attempt: 3, accuracyM: 49, maxAccuracyM: 50 }), 'fix');
});

test('geolocation honours a custom attempt budget (policy retryCount)', () => {
  assert.equal(decideGeoAcquisition({ attempt: 1, accuracyM: 142, maxAccuracyM: 50, maxAttempts: 1 }), 'exhausted');
  assert.equal(decideGeoAcquisition({ attempt: 4, accuracyM: 142, maxAccuracyM: 50, maxAttempts: 5 }), 'retry');
});

test('geolocation surfaces permission-denied immediately without retrying', () => {
  assert.equal(decideRetryAfterError({ attempt: 1, code: 'permission_denied' }), 'failed');
  assert.equal(decideRetryAfterError({ attempt: 2, code: 'permission_denied' }), 'failed');
});

test('geolocation retries timeout/unavailable within the budget, then gives up', () => {
  assert.equal(decideRetryAfterError({ attempt: 1, code: 'timeout' }), 'retry');
  assert.equal(decideRetryAfterError({ attempt: 2, code: 'position_unavailable' }), 'retry');
  assert.equal(decideRetryAfterError({ attempt: 3, code: 'timeout' }), 'failed');
  assert.equal(decideRetryAfterError({ attempt: 3, code: 'position_unavailable' }), 'failed');
});

test('geolocation maps the GeolocationPositionError codes to stable failure codes', () => {
  assert.equal(geoErrorCodeFromCode(1), 'permission_denied');
  assert.equal(geoErrorCodeFromCode(2), 'position_unavailable');
  assert.equal(geoErrorCodeFromCode(3), 'timeout');
  assert.equal(geoErrorCodeFromCode(99), 'position_unavailable');
});
