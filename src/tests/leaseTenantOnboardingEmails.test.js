/**
 * Unit tests: lease tenant onboarding email routing and invite template rendering.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const {
  resolveTenantScreeningForEmail,
  normalizeScreeningArray,
  hasTenantScreening,
  resolveSplitEntryForTenantEmail,
  normalizeSplitTenantId,
} = require('../portals/landlord/modules/leasing/service/leaseTenantInviteDelivery.service');

const emailHelper = require('../common/helpers/emailHelper');

describe('resolveTenantScreeningForEmail', () => {
  test('uses split entry screening when present (including empty array)', () => {
    assert.deepEqual(resolveTenantScreeningForEmail({ screening: [] }, ['application']), []);
    assert.deepEqual(resolveTenantScreeningForEmail({ screening: ['credit'] }, []), ['credit']);
  });

  test('falls back to request payload screening when split has no screening key', () => {
    assert.deepEqual(resolveTenantScreeningForEmail({ rentAmount: 100 }, ['application']), [
      'application',
    ]);
  });

  test('returns empty when neither split nor payload has screening', () => {
    assert.deepEqual(resolveTenantScreeningForEmail({ rentAmount: 50 }, undefined), []);
  });
});

describe('hasTenantScreening', () => {
  test('true when any screening type is assigned', () => {
    assert.equal(hasTenantScreening(['application']), true);
    assert.equal(hasTenantScreening(['credit']), true);
  });

  test('false for empty or missing screening', () => {
    assert.equal(hasTenantScreening([]), false);
    assert.equal(hasTenantScreening(undefined), false);
  });
});

describe('resolveSplitEntryForTenantEmail', () => {
  const tenantA = '6a12bfb96c5490a98e57d666';
  const tenantB = '69db8f2e328a2726e0ee4645';
  const split = [
    { key: '1', tenantId: tenantA, screening: [] },
    { key: '2', tenantId: tenantB, screening: ['application'] },
  ];

  test('matches by tenantId', () => {
    const entry = resolveSplitEntryForTenantEmail(split, tenantB, 0, '2');
    assert.deepEqual(normalizeScreeningArray(entry.screening), ['application']);
  });

  test('falls back to index when tenantId not yet on split row', () => {
    const splitNoIds = [{ key: '1', screening: [] }, { key: '2', screening: ['credit'] }];
    const entry = resolveSplitEntryForTenantEmail(splitNoIds, 'unknown', 1, '2');
    assert.deepEqual(normalizeScreeningArray(entry.screening), ['credit']);
  });
});

describe('normalizeSplitTenantId', () => {
  test('stringifies ObjectId-like values', () => {
    const oid = { toString: () => '6a12e1a11caa48f7b35c6e4e', constructor: { name: 'ObjectId' } };
    assert.equal(normalizeSplitTenantId(oid), '6a12e1a11caa48f7b35c6e4e');
  });
});

describe('invite email preview', () => {
  test('renders non-empty HTML and plain text with acknowledge URL', async () => {
    const acknowledgeUrl = 'http://localhost:8080/acknowledge/tenant123/lease/lease456';
    const preview = await emailHelper.composeEmailPreview(
      'invite',
      'tenant@example.com',
      {
        tenantName: 'Test Tenant',
        landlordName: 'Test Landlord',
        appName: 'PropMv',
        inviteUrl: acknowledgeUrl,
        acknowledgeLink: acknowledgeUrl,
        propertyName: 'Sunset Apts',
        propertyAddress: '1 Main St',
        leaseStartDate: 'May 25, 2026',
      },
      { template: 'invite', subject: 'Action required: Lease invitation - Sunset Apts' }
    );

    assert.ok(preview.html.length >= emailHelper.MIN_RENDERED_HTML_LENGTH);
    assert.ok(preview.html.includes(acknowledgeUrl), 'HTML must contain invite/acknowledge URL');
    assert.ok(preview.text.includes(acknowledgeUrl), 'Plain text must contain acknowledge URL');
    assert.match(preview.text, /Lease invitation/i);
    assert.match(preview.subject, /Lease invitation/i);
  });
});

describe('buildPlainTextBody', () => {
  test('screening plain text includes application URL', () => {
    const url = 'http://localhost:8080/application/screening?leaseId=1&tenantId=2';
    const text = emailHelper.buildPlainTextBody('screening-application', {
      tenantName: 'A',
      landlordName: 'L',
      propertyName: 'P',
      applicationUrl: url,
    });
    assert.ok(text.includes(url));
    assert.match(text, /screening/i);
  });
});
