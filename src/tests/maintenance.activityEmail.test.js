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

describe('maintenance activity emails (comment / note / documents)', () => {
  afterEach(() => {
    delete require.cache[require.resolve(SERVICE_PATH)];
  });

  it('activity notify helpers call sendMaintenanceActivityEmails', () => {
    const src = fs.readFileSync(SERVICE_PATH, 'utf8');
    assert.ok(src.includes('sendMaintenanceActivityEmails'));
    assert.ok(src.includes('function notifyMaintenanceActivityEmail'));
    assert.ok(src.includes("eventKey: 'maintenance_comment_added'"));
    assert.ok(src.includes("eventKey: 'maintenance_note_added'"));
    assert.ok(src.includes("eventKey: 'maintenance_documents_updated'"));
  });

  it('notifyMaintenanceCommentAdded triggers activity email helper', async () => {
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
            return { attempted: 3, sent: 3, failed: 0 };
          },
        };
      }
      if (endsWithPath(request, 'hoaInAppNotify.helper.js', 'hoaInAppNotify.helper')) {
        return {
          ensureMaintenanceHoaId: async (doc) => doc,
          notifyMaintenanceUpdatedInAppInBackground: () => {},
          notifyMaintenanceCommentInAppInBackground: () => { calls.inApp.push('comment'); },
          notifyMaintenanceNoteInAppInBackground: () => { calls.inApp.push('note'); },
          notifyMaintenanceDocumentsInAppInBackground: () => { calls.inApp.push('documents'); },
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
        return {
          resolveMaintenanceNotificationRecipients: async () => [],
        };
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
      const { notifyMaintenanceCommentAdded } = require(SERVICE_PATH);
      notifyMaintenanceCommentAdded(
        {
          _id: TICKET_ID,
          title: 'Leak',
          status: 'Open',
          comments: [{ text: 'hi' }],
          updatedAt: '2026-10-11T12:00:00.000Z',
        },
        BOARD_A
      );
      for (const fn of pending) {
        // eslint-disable-next-line no-await-in-loop
        await fn();
      }
      assert.equal(calls.activity.length, 1);
      assert.equal(calls.activity[0].eventKey, 'maintenance_comment_added');
      assert.equal(calls.activity[0].actorUserId, BOARD_A);
      assert.deepEqual(calls.inApp, ['comment']);
    } finally {
      global.setImmediate = originalSetImmediate;
      Module._load = originalLoad;
      delete require.cache[require.resolve(SERVICE_PATH)];
    }
  });
});
