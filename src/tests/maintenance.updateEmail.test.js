'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SERVICE_PATH = path.join(
  __dirname,
  '../shared/modules/maintenance/service/maintenance.service.js'
);

const BOARD_A = '507f1f77bcf86cd799439011';
const TICKET_ID = '507f1f77bcf86cd799439099';

function endsWithPath(request, ...segments) {
  const normalized = String(request).replace(/\\/g, '/');
  return segments.some((segment) => normalized.endsWith(segment));
}

describe('maintenance ticket update email', () => {
  afterEach(() => {
    delete require.cache[require.resolve(SERVICE_PATH)];
  });

  it('notifyMaintenanceRequestUpdated uses sendMaintenanceActivityEmails', () => {
    const src = fs.readFileSync(SERVICE_PATH, 'utf8');
    const start = src.indexOf('function notifyMaintenanceRequestUpdated');
    assert.ok(start >= 0);
    const nextFn = src.indexOf('\nfunction notifyMaintenanceResolved', start + 1);
    const body = src.slice(start, nextFn === -1 ? undefined : nextFn);
    assert.ok(body.includes('sendMaintenanceActivityEmails'));
    assert.ok(body.includes("eventKey = isReopened ? 'maintenance_reopened' : 'maintenance_updated'"));
    assert.equal(body.includes('notifyLandlordPortalEventInBackground'), false);
  });

  it('field/status update triggers activity email helper', async () => {
    delete require.cache[require.resolve(SERVICE_PATH)];
    const calls = { activity: [], inApp: [] };
    const originalLoad = Module._load;
    const originalSetImmediate = global.setImmediate;
    const pending = [];

    Module._load = function patched(request, parent, isMain) {
      if (endsWithPath(request, 'maintenanceEmailHelper.js', 'maintenanceEmailHelper')) {
        return {
          sendMaintenanceRequestCreatedEmail: async () => {},
          sendMaintenanceVendorAssignedEmail: async () => {},
          sendMaintenanceActivityEmails: async (doc, opts) => {
            calls.activity.push({ docId: String(doc?._id || ''), ...opts });
            return { attempted: 2, sent: 2, failed: 0 };
          },
        };
      }
      if (endsWithPath(request, 'hoaInAppNotify.helper.js', 'hoaInAppNotify.helper')) {
        return {
          ensureMaintenanceHoaId: async (doc) => doc,
          notifyMaintenanceUpdatedInAppInBackground: (_doc, _actor, opts) => {
            calls.inApp.push(opts || {});
          },
          notifyMaintenanceCommentInAppInBackground: () => {},
          notifyMaintenanceNoteInAppInBackground: () => {},
          notifyMaintenanceDocumentsInAppInBackground: () => {},
          notifyMaintenanceCreatedInAppInBackground: () => {},
          notifyMaintenanceVendorAssignedInAppInBackground: () => {},
        };
      }
      if (endsWithPath(request, 'actionUpdateEmail.service.js', 'actionUpdateEmail.service')) {
        return {
          notifyActionUpdateInBackground: () => {},
          sendActionUpdateEmail: async () => ({ sent: 0 }),
        };
      }
      if (endsWithPath(request, 'landlordPortalEventEmail.service.js', 'landlordPortalEventEmail.service')) {
        return { notifyLandlordPortalEventInBackground: () => {} };
      }
      if (endsWithPath(request, 'hoaRecipientResolver.js', 'hoaRecipientResolver')) {
        return { resolveMaintenanceNotificationRecipients: async () => [] };
      }
      if (endsWithPath(request, 'common/logger.js', 'common/logger')) {
        return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
      }
      return originalLoad(request, parent, isMain);
    };

    global.setImmediate = (fn) => {
      pending.push(fn);
      return 0;
    };

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { notifyMaintenanceRequestUpdated } = require(SERVICE_PATH);
      notifyMaintenanceRequestUpdated(
        {
          _id: TICKET_ID,
          title: 'Leak',
          status: 'InProgress',
          priority: 'High',
          updatedAt: '2026-10-11T12:00:00.000Z',
        },
        BOARD_A,
        {
          status: 'InProgress',
          previousStatus: 'Open',
          priority: 'High',
          previousPriority: 'Medium',
        }
      );

      for (const fn of pending) {
        // eslint-disable-next-line no-await-in-loop
        await fn();
      }

      assert.equal(calls.activity.length, 1);
      assert.equal(calls.activity[0].eventKey, 'maintenance_updated');
      assert.match(calls.activity[0].eventMessage, /Priority changed/i);
      assert.equal(calls.inApp.length, 1);
    } finally {
      global.setImmediate = originalSetImmediate;
      Module._load = originalLoad;
      delete require.cache[require.resolve(SERVICE_PATH)];
    }
  });
});
