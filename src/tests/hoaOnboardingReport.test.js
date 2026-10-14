'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  buildPeriodWindows,
  reportTimezone,
} = require('../shared/modules/system/reports/service/hoaOnboardingReport.service');
const {
  buildTemplateData,
  reportRecipients,
  formatHoaRowsForEmail,
  resolveDashboardUrl,
} = require('../shared/modules/system/reports/service/hoaOnboardingReportNotify.service');
const {
  listHoasQuerySchema,
  sendEmailBodySchema,
} = require('../shared/modules/system/reports/validators/hoaOnboardingReport.validator');
const requireInternalStaff = require('../middleware/requireInternalStaff');
const User = require('../shared/modules/users/models/user.model');
const companyRoleHelper = require('../common/helpers/companyRoleHelper');

describe('HOA Onboarding Reporting - Unit & Security Suite', () => {
  // -------------------------------------------------------------
  // 1. DATE BOUNDARIES & REPORTING WINDOWS
  // -------------------------------------------------------------
  describe('Date Boundaries & Reporting Windows', () => {
    test('uses America/New_York as default reporting timezone', () => {
      const tz = reportTimezone();
      assert.ok(tz === 'America/New_York' || tz === 'US/Eastern');
    });

    test('builds today, weekly (trailing 7d), and monthly (MTD) windows correctly', () => {
      // 2026-06-15 14:30:00 UTC = 2026-06-15 10:30:00 EDT
      const refDate = new Date('2026-06-15T14:30:00.000Z');
      const { todayKey, windows } = buildPeriodWindows(refDate);

      assert.equal(todayKey, '2026-06-15');
      assert.ok(windows.daily.start instanceof Date);
      assert.ok(windows.daily.end instanceof Date);
      assert.ok(windows.daily.start < windows.daily.end);

      // Trailing 7 days starts 6 days prior: 2026-06-09
      assert.ok(windows.weekly.start < windows.daily.start);

      // Month-to-date starts on 2026-06-01
      assert.ok(windows.monthly.start < windows.weekly.start);

      // All windows end at the start of tomorrow
      assert.equal(windows.daily.end.toISOString(), windows.weekly.end.toISOString());
      assert.equal(windows.daily.end.toISOString(), windows.monthly.end.toISOString());
    });

    test('correctly handles midnight boundary in America/New_York', () => {
      // 2026-03-10 03:59:00 UTC = 2026-03-09 23:59:00 EDT (UTC-4)
      const lateEvening = new Date('2026-03-10T03:59:00.000Z');
      const { todayKey: keyLate } = buildPeriodWindows(lateEvening);
      assert.equal(keyLate, '2026-03-09');

      // 2026-03-10 04:01:00 UTC = 2026-03-10 00:01:00 EDT (UTC-4)
      const earlyMorning = new Date('2026-03-10T04:01:00.000Z');
      const { todayKey: keyEarly } = buildPeriodWindows(earlyMorning);
      assert.equal(keyEarly, '2026-03-10');
    });

    test('handles DST spring-forward and fall-back dates properly', () => {
      // Spring forward 2026: March 8, 2026
      const springDate = new Date('2026-03-08T17:00:00.000Z');
      const springWindows = buildPeriodWindows(springDate);
      assert.equal(springWindows.todayKey, '2026-03-08');
      assert.ok(springWindows.windows.daily.start < springWindows.windows.daily.end);

      // Fall back 2026: November 1, 2026
      const fallDate = new Date('2026-11-01T17:00:00.000Z');
      const fallWindows = buildPeriodWindows(fallDate);
      assert.equal(fallWindows.todayKey, '2026-11-01');
      assert.ok(fallWindows.windows.daily.start < fallWindows.windows.daily.end);
    });
  });

  // -------------------------------------------------------------
  // 2. QUERY & BODY VALIDATORS
  // -------------------------------------------------------------
  describe('Request Validation', () => {
    test('accepts valid query parameters with defaults', () => {
      const { value, error } = listHoasQuerySchema.validate({});
      assert.equal(error, undefined);
      assert.equal(value.page, 1);
      assert.equal(value.limit, 10);
      assert.equal(value.period, 'all');
      assert.equal(value.status, 'all');
      assert.equal(value.sortBy, 'createdAt');
      assert.equal(value.sortOrder, 'desc');
    });

    test('enforces maximum page limit of 100', () => {
      const { error } = listHoasQuerySchema.validate({ limit: 101 });
      assert.ok(error);
      assert.match(error.message, /limit/);
    });

    test('rejects negative or zero page number', () => {
      const { error } = listHoasQuerySchema.validate({ page: 0 });
      assert.ok(error);
      assert.match(error.message, /page/);
    });

    test('rejects invalid period', () => {
      const { error } = listHoasQuerySchema.validate({ period: 'yesterday' });
      assert.ok(error);
      assert.match(error.message, /period/);
    });

    test('rejects invalid status', () => {
      const { error } = listHoasQuerySchema.validate({ status: 'archived_invalid' });
      assert.ok(error);
      assert.match(error.message, /status/);
    });

    test('forbids client-supplied email recipients in send-email payload', () => {
      const { error: errRecipients } = sendEmailBodySchema.validate({
        recipients: ['attacker@evil.com'],
      });
      assert.ok(errRecipients);
      assert.match(errRecipients.message, /Client-provided recipients are not permitted/);

      const { error: errTo } = sendEmailBodySchema.validate({
        to: 'attacker@evil.com',
      });
      assert.ok(errTo);

      const { error: errEmail } = sendEmailBodySchema.validate({
        email: 'attacker@evil.com',
      });
      assert.ok(errEmail);

      const { error: validBody } = sendEmailBodySchema.validate({
        force: true,
      });
      assert.equal(validBody, undefined);
    });
  });

  // -------------------------------------------------------------
  // 3. EMAIL PREPARATION & RECIPIENTS
  // -------------------------------------------------------------
  describe('Email Preparation & Security', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test('resolves strictly to admin@propmv.com regardless of environment variables', () => {
      process.env.HOA_ONBOARDING_REPORT_EMAIL = 'other@propmv.com, second@propmv.com';
      process.env.DEMO_REQUEST_NOTIFY_EMAIL = 'demo@propmv.com';
      process.env.SUPPORT_EMAIL = 'support@propmv.com';
      const recipients = reportRecipients();
      assert.deepEqual(recipients, ['admin@propmv.com']);

      delete process.env.HOA_ONBOARDING_REPORT_EMAIL;
      delete process.env.DEMO_REQUEST_NOTIFY_EMAIL;
      delete process.env.SUPPORT_EMAIL;
      const recipientsDefault = reportRecipients();
      assert.deepEqual(recipientsDefault, ['admin@propmv.com']);
    });

    test('caps detailed email rows to max limit and escapes HTML', () => {
      const mockHoas = Array.from({ length: 50 }, (_, i) => ({
        name: `<script>alert("xss")</script> Community ${i}`,
        createdAt: new Date().toISOString(),
        createdByName: 'John & Jane',
        createdByEmail: 'test@example.com',
        ownerCount: 5,
        propertyCount: 10,
        unitCount: 10,
        status: 'active',
      }));

      const rows = formatHoaRowsForEmail(mockHoas, 25);
      assert.equal(rows.length, 25);
      assert.ok(!rows[0].name.includes('<script>'));
      assert.ok(rows[0].name.includes('&lt;script&gt;'));
      assert.ok(rows[0].createdByName.includes('John &amp; Jane'));
    });

    test('resolves internal dashboard URL link correctly', () => {
      process.env.FRONTEND_URL = 'https://app.propmv.com/';
      const url = resolveDashboardUrl();
      assert.equal(url, 'https://app.propmv.com/admin/hoa-onboarding');

      delete process.env.FRONTEND_URL;
      delete process.env.APP_URL;
      delete process.env.CLIENT_URL;
      const emptyUrl = resolveDashboardUrl();
      assert.equal(emptyUrl, '');
    });

    test('buildTemplateData formats summary counts and rows cleanly', () => {
      const report = {
        reportDate: '2026-06-15',
        timeZone: 'America/New_York',
        summary: { daily: 3, weekly: 12, monthly: 45 },
        periods: {
          daily: { hoas: [{ name: 'Oakridge HOA', propertyCount: 8, ownerCount: 8, status: 'active' }] },
          weekly: { hoas: [] },
          monthly: { hoas: [] },
        },
      };

      const data = buildTemplateData(report);
      assert.equal(data.dailyCount, 3);
      assert.equal(data.weeklyCount, 12);
      assert.equal(data.monthlyCount, 45);
      assert.equal(data.hasDailyHoas, true);
      assert.equal(data.hasWeeklyHoas, false);
      assert.equal(data.dailyHoas[0].name, 'Oakridge HOA');
    });
  });

  // -------------------------------------------------------------
  // 4. CRITICAL SECURITY: INTERNAL STAFF AUTHORIZATION
  // -------------------------------------------------------------
  describe('Security Boundary: requireInternalStaff', () => {
    const PROPMV_COMPANY_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
    const CUSTOMER_COMPANY_ID = new mongoose.Types.ObjectId('607f1f77bcf86cd799439022');
    const ADMIN_ROLE_ID = new mongoose.Types.ObjectId('707f1f77bcf86cd799439033');

    let originalFindById;
    let originalGetPropMvCompany;
    let originalResolveUserRole;

    beforeEach(() => {
      originalFindById = User.findById;
      originalGetPropMvCompany = companyRoleHelper.getPropMvCompany;
      originalResolveUserRole = companyRoleHelper.resolveUserRole;

      // Mock canonical PropMv company
      companyRoleHelper.getPropMvCompany = async () => ({
        _id: PROPMV_COMPANY_ID,
        name: 'PropMv',
        roles: [
          {
            _id: ADMIN_ROLE_ID,
            name: 'Administrator',
            isActive: true,
            privileges: ['VIEW_INTERNAL_REPORTS'],
          },
        ],
      });
    });

    afterEach(() => {
      User.findById = originalFindById;
      companyRoleHelper.getPropMvCompany = originalGetPropMvCompany;
      companyRoleHelper.resolveUserRole = originalResolveUserRole;
    });

    test('401: rejects unauthenticated requests (missing userId)', async () => {
      const req = {};
      let statusCode = null;
      let jsonPayload = null;
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(payload) {
          jsonPayload = payload;
          return this;
        },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 401);
      assert.match(jsonPayload.message, /Authentication is required/);
    });

    test('403: CRITICAL VULNERABILITY CHECK - Customer Property Manager with role "Administrator" MUST BE REJECTED', async () => {
      const customerUserId = new mongoose.Types.ObjectId();

      // Customer Property Manager belongs to their own company, NOT PropMv
      User.findById = () => ({
        lean: async () => ({
          _id: customerUserId,
          companyId: CUSTOMER_COMPANY_ID, // Customer Company!
          companyRoleId: ADMIN_ROLE_ID,
          role: 'Property Manager',
          email: 'customer.admin@propertymanagercorp.com',
          isAdministrator: true, // Even if req.user has isAdministrator: true!
        }),
      });

      const req = {
        userId: customerUserId,
        user: { id: customerUserId, isAdministrator: true, role: 'Administrator' },
      };

      let statusCode = null;
      let jsonPayload = null;
      let nextCalled = false;

      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(payload) {
          jsonPayload = payload;
          return this;
        },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'Customer administrator MUST NOT pass internal staff check');
      assert.equal(statusCode, 403);
      assert.match(jsonPayload.message, /PropMv internal staff access required/);
    });

    test('403: rejects Landlord user', async () => {
      const landlordId = new mongoose.Types.ObjectId();
      User.findById = () => ({
        lean: async () => ({
          _id: landlordId,
          companyId: null,
          role: 'Landlord',
          email: 'landlord@example.com',
        }),
      });

      const req = { userId: landlordId };
      let statusCode = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 403);
    });

    test('403: rejects Tenant user', async () => {
      const tenantId = new mongoose.Types.ObjectId();
      User.findById = () => ({
        lean: async () => ({
          _id: tenantId,
          companyId: null,
          role: 'Tenant',
          email: 'tenant@example.com',
        }),
      });

      const req = { userId: tenantId };
      let statusCode = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 403);
    });

    test('403: rejects HOA Board Member user', async () => {
      const boardMemberId = new mongoose.Types.ObjectId();
      User.findById = () => ({
        lean: async () => ({
          _id: boardMemberId,
          companyId: null,
          role: 'HOA Board Member',
          email: 'board@community.org',
        }),
      });

      const req = { userId: boardMemberId };
      let statusCode = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 403);
    });

    test('403: rejects HOA Owner user', async () => {
      const ownerId = new mongoose.Types.ObjectId();
      User.findById = () => ({
        lean: async () => ({
          _id: ownerId,
          companyId: null,
          role: 'HOA Owner',
          email: 'owner@gmail.com',
        }),
      });

      const req = { userId: ownerId };
      let statusCode = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 403);
    });

    test('403: rejects deactivated/soft-deleted internal user', async () => {
      const deletedStaffId = new mongoose.Types.ObjectId();
      User.findById = () => ({
        lean: async () => ({
          _id: deletedStaffId,
          companyId: PROPMV_COMPANY_ID,
          role: 'Administrator',
          isDeleted: true, // Soft-deleted
          email: 'former.staff@propmv.com',
        }),
      });

      const req = { userId: deletedStaffId };
      let statusCode = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {});
      assert.equal(statusCode, 403);
    });

    test('ALLOW: passes authenticated PropMv internal staff with admin role', async () => {
      const internalStaffId = new mongoose.Types.ObjectId();
      const staffUserDoc = {
        _id: internalStaffId,
        companyId: PROPMV_COMPANY_ID,
        companyRoleId: ADMIN_ROLE_ID,
        role: 'Administrator',
        email: 'admin@propmv.com',
        isDeleted: false,
      };

      User.findById = () => ({
        lean: async () => staffUserDoc,
      });

      companyRoleHelper.resolveUserRole = async () => ({
        _id: ADMIN_ROLE_ID,
        name: 'Administrator',
        privileges: ['VIEW_INTERNAL_REPORTS'],
      });

      const req = { userId: internalStaffId };
      let nextCalled = false;
      const res = {
        status() { return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true, 'PropMv internal staff must be allowed');
      assert.ok(req.internalStaff);
      assert.equal(req.internalStaff.userId, String(internalStaffId));
      assert.equal(req.internalStaff.companyId, String(PROPMV_COMPANY_ID));
    });

    test('403: CRITICAL REGRESSION - support@propmv.com as HOA Board Member in canonical PropMv company MUST BE DENIED', async () => {
      const supportUserId = new mongoose.Types.ObjectId();
      const boardRoleId = new mongoose.Types.ObjectId();

      const supportUserDoc = {
        _id: supportUserId,
        email: 'support@propmv.com',
        companyId: PROPMV_COMPANY_ID, // Belongs to canonical PropMv company!
        companyRoleId: boardRoleId,
        isDeleted: false,
      };

      User.findById = () => ({
        lean: async () => supportUserDoc,
      });

      // Role is HOA Board Member, NOT Administrator; privileges do NOT include VIEW_INTERNAL_REPORTS
      companyRoleHelper.resolveUserRole = async () => ({
        _id: boardRoleId,
        name: 'HOA Board Member',
        privileges: ['VIEW_DASHBOARD', 'VIEW_PROPERTY', 'EXPORT_REPORTS'],
      });

      // Even if HOA_ONBOARDING_REPORT_EMAIL and SUPPORT_EMAIL are set to support@propmv.com
      process.env.HOA_ONBOARDING_REPORT_EMAIL = 'support@propmv.com';
      process.env.SUPPORT_EMAIL = 'support@propmv.com';

      const req = { userId: supportUserId };
      let statusCode = null;
      let jsonPayload = null;
      let nextCalled = false;
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json(data) {
          jsonPayload = data;
          return this;
        },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'support@propmv.com as HOA Board Member MUST NOT be granted internal report access');
      assert.equal(statusCode, 403);
      assert.match(jsonPayload.message, /Insufficient internal staff privileges/);
    });

    test('403: qa.board@propmv.com as HOA Board Member MUST BE DENIED', async () => {
      const qaBoardId = new mongoose.Types.ObjectId();
      const boardRoleId = new mongoose.Types.ObjectId();

      User.findById = () => ({
        lean: async () => ({
          _id: qaBoardId,
          email: 'qa.board@propmv.com',
          companyId: PROPMV_COMPANY_ID,
          companyRoleId: boardRoleId,
          isDeleted: false,
        }),
      });

      companyRoleHelper.resolveUserRole = async () => ({
        _id: boardRoleId,
        name: 'HOA Board Member',
        privileges: ['VIEW_DASHBOARD', 'VIEW_PROPERTY'],
      });

      const req = { userId: qaBoardId };
      let statusCode = null;
      let nextCalled = false;
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'qa.board@propmv.com must be denied');
      assert.equal(statusCode, 403);
    });

    test('ALLOW: Canonical Internal Admin (admin@propmv.com) with canonical PropMv Administrator role and VIEW_INTERNAL_REPORTS', async () => {
      const adminId = new mongoose.Types.ObjectId();
      const adminDoc = {
        _id: adminId,
        email: 'admin@propmv.com',
        companyId: PROPMV_COMPANY_ID,
        companyRoleId: ADMIN_ROLE_ID,
        role: 'Administrator',
        isDeleted: false,
      };

      User.findById = () => ({
        lean: async () => adminDoc,
      });

      companyRoleHelper.resolveUserRole = async () => ({
        _id: ADMIN_ROLE_ID,
        name: 'Administrator',
        privileges: ['VIEW_INTERNAL_REPORTS'],
      });

      const req = { userId: adminId };
      let nextCalled = false;
      const res = {
        status() { return this; },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true, 'Canonical internal admin must be allowed');
      assert.ok(req.internalStaff);
      assert.equal(req.internalStaff.userId, String(adminId));
      assert.equal(req.internalStaff.email, 'admin@propmv.com');
      assert.equal(req.internalStaff.companyId, String(PROPMV_COMPANY_ID));
    });

    test('403: Previous internal admin (privacy@propmv.com) deprovisioned from PropMv company MUST BE DENIED', async () => {
      const oldAdminId = new mongoose.Types.ObjectId();
      const oldAdminDoc = {
        _id: oldAdminId,
        email: 'privacy@propmv.com',
        companyId: undefined,
        companyRoleId: undefined,
        role: undefined,
        isDeleted: true,
      };

      User.findById = () => ({
        lean: async () => oldAdminDoc,
      });

      const req = { userId: oldAdminId };
      let nextCalled = false;
      let statusCode = null;
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'Deprovisioned former admin privacy@propmv.com must be denied');
      assert.equal(statusCode, 403);
    });

    test('403: Old QA admin (jadeyash2812@gmail.com) deprovisioned from PropMv company MUST BE DENIED', async () => {
      const oldQaId = new mongoose.Types.ObjectId();
      const oldQaDoc = {
        _id: oldQaId,
        email: 'jadeyash2812@gmail.com',
        companyId: undefined,
        companyRoleId: undefined,
        role: undefined,
        isDeleted: true,
      };

      User.findById = () => ({
        lean: async () => oldQaDoc,
      });

      const req = { userId: oldQaId };
      let nextCalled = false;
      let statusCode = null;
      const res = {
        status(code) {
          statusCode = code;
          return this;
        },
        json() { return this; },
      };

      await requireInternalStaff(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, 'Deprovisioned QA admin must be denied');
      assert.equal(statusCode, 403);
    });
  });

  // -------------------------------------------------------------
  // 5. SECURITY REGRESSION: OLD MARKETING ENDPOINT REMOVAL
  // -------------------------------------------------------------
  describe('Marketing Route Bypass Regression', () => {
    test('marketing router does NOT expose /hoa-onboarding-report', () => {
      const marketingRouter = require('../shared/modules/marketing/routes/marketing.routes');
      const registeredPaths = [];

      marketingRouter.stack.forEach((layer) => {
        if (layer.route) {
          registeredPaths.push(layer.route.path);
        }
      });

      assert.ok(
        !registeredPaths.includes('/hoa-onboarding-report'),
        'Old marketing route /hoa-onboarding-report must be removed to prevent bypass'
      );
      assert.ok(
        !registeredPaths.includes('/hoa-onboarding-report/send'),
        'Old marketing route /hoa-onboarding-report/send must be removed to prevent bypass'
      );
    });
  });

  // -------------------------------------------------------------
  // 6. SCHEDULER SAFETY & IDEMPOTENCY CONTRACT
  // -------------------------------------------------------------
  describe('Scheduler Error Containment', () => {
    test('scheduler start and stop do not throw or crash process', () => {
      const {
        startHoaOnboardingReportScheduler,
        stopHoaOnboardingReportScheduler,
      } = require('../common/schedulers/hoaOnboardingReportScheduler.service');

      // Disabled run
      process.env.HOA_ONBOARDING_REPORT_ENABLED = 'false';
      startHoaOnboardingReportScheduler();
      stopHoaOnboardingReportScheduler();

      // Enabled run (mocked daily runner)
      process.env.HOA_ONBOARDING_REPORT_ENABLED = 'true';
      startHoaOnboardingReportScheduler();
      stopHoaOnboardingReportScheduler();
      assert.ok(true, 'Scheduler lifecycle started and stopped cleanly');
    });
  });

  // -------------------------------------------------------------
  // 7. BATCH ENRICHMENT: CREATOR, PROPERTY, OWNER & STATUS
  // -------------------------------------------------------------
  describe('Batch Enrichment & Calculations (enrichHoaBatch)', () => {
    const { enrichHoaBatch } = require('../shared/modules/system/reports/service/hoaOnboardingReport.service');
    const HOAProperty = require('../portals/hoa-board/modules/property/model/property.model');
    const HOASettings = require('../portals/hoa-board/modules/hoa-settings/model/hoaSettings.model');
    const hoaStatusHelper = require('../portals/hoa-board/modules/hoa/helpers/hoaOnboardingStatus.helper');
    const hoaOwnerRoleHelper = require('../common/helpers/hoaOwnerRole');

    let originalUserFind;
    let originalPropertyFind;
    let originalSettingsFind;
    let originalBankSummary;
    let originalOwnerRoleRefs;

    beforeEach(() => {
      originalUserFind = User.find;
      originalPropertyFind = HOAProperty.find;
      originalSettingsFind = HOASettings.find;
      originalBankSummary = hoaStatusHelper.summarizeCommunityLinkedBanks;
      originalOwnerRoleRefs = hoaOwnerRoleHelper.getHOAOwnerRoleRefs;

      hoaOwnerRoleHelper.getHOAOwnerRoleRefs = async () => ({ roleId: new mongoose.Types.ObjectId() });
      hoaStatusHelper.summarizeCommunityLinkedBanks = async () => ({ hasLinkedBank: false, hasActiveLinkedBank: false });
    });

    afterEach(() => {
      User.find = originalUserFind;
      HOAProperty.find = originalPropertyFind;
      HOASettings.find = originalSettingsFind;
      hoaStatusHelper.summarizeCommunityLinkedBanks = originalBankSummary;
      hoaOwnerRoleHelper.getHOAOwnerRoleRefs = originalOwnerRoleRefs;
    });

    test('creator resolution: firstName+lastName, email fallback, soft-deleted, and missing', async () => {
      const hoa1Id = new mongoose.Types.ObjectId();
      const creator1Id = new mongoose.Types.ObjectId();
      const creator2Id = new mongoose.Types.ObjectId();
      const creator3Id = new mongoose.Types.ObjectId();

      const hoas = [
        { _id: hoa1Id, name: 'Meadowlands', createdBy: creator1Id, numberOfUnits: 100 },
        { _id: new mongoose.Types.ObjectId(), name: 'Parkview', createdBy: creator2Id },
        { _id: new mongoose.Types.ObjectId(), name: 'Lakeview', createdBy: creator3Id },
        { _id: new mongoose.Types.ObjectId(), name: 'Orphan HOA', createdBy: null },
      ];

      User.find = () => ({
        select: () => ({
          lean: async () => [
            { _id: creator1Id, firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com', isDeleted: false },
            { _id: creator2Id, firstName: '', lastName: '', email: 'creator2@example.com', isDeleted: false }, // email fallback
            { _id: creator3Id, firstName: 'Bob', lastName: 'Jones', email: 'bob@example.com', isDeleted: true }, // soft-deleted
          ],
        }),
      });

      HOAProperty.find = () => ({ select: () => ({ lean: async () => [] }) });
      HOASettings.find = () => ({ lean: async () => [] });
      hoaStatusHelper.summarizeCommunityLinkedBanks = async () => ({ hasLinkedBank: false, hasActiveLinkedBank: false });
      hoaOwnerRoleHelper.getHOAOwnerRoleRefs = async () => ({ roleId: new mongoose.Types.ObjectId() });

      const enriched = await enrichHoaBatch(hoas);
      assert.equal(enriched.length, 4);

      // Alice Smith
      assert.equal(enriched[0].createdBy.name, 'Alice Smith');
      assert.equal(enriched[0].createdBy.email, 'alice@example.com');
      assert.equal(enriched[0].createdBy.isDeleted, false);

      // Email fallback
      assert.equal(enriched[1].createdBy.name, 'creator2@example.com');

      // Soft-deleted creator
      assert.equal(enriched[2].createdBy.name, 'Bob Jones');
      assert.equal(enriched[2].createdBy.isDeleted, true);

      // Missing creator
      assert.equal(enriched[3].createdBy.name, 'Unknown User');
    });

    test('property/unit counting: uses persisted properties, excludes deleted/archived, ignores signup numberOfUnits', async () => {
      const hoaId = new mongoose.Types.ObjectId();
      const hoas = [{ _id: hoaId, name: 'Pinecrest', numberOfUnits: 999 }]; // 999 is signup target!

      // 3 actual persisted properties
      HOAProperty.find = () => ({
        select: () => ({
          lean: async () => [
            { _id: new mongoose.Types.ObjectId(), hoaId, associatedOwnerIds: [] },
            { _id: new mongoose.Types.ObjectId(), hoaId, associatedOwnerIds: [] },
            { _id: new mongoose.Types.ObjectId(), hoaId, associatedOwnerIds: [] },
          ],
        }),
      });

      User.find = () => ({ select: () => ({ lean: async () => [] }) });
      HOASettings.find = () => ({ lean: async () => [] });
      hoaStatusHelper.summarizeCommunityLinkedBanks = async () => ({ hasLinkedBank: false });

      const enriched = await enrichHoaBatch(hoas);
      assert.equal(enriched[0].propertyCount, 3);
      assert.equal(enriched[0].unitCount, 3);
      assert.notEqual(enriched[0].unitCount, 999, 'Signup numberOfUnits must not be used as unit count');
    });

    test('owner counting: counts verified HOA Owners, deduplicates across units, excludes board members', async () => {
      const hoaId = new mongoose.Types.ObjectId();
      const hoas = [{ _id: hoaId, name: 'Sunridge' }];

      const owner1Id = new mongoose.Types.ObjectId();
      const owner2Id = new mongoose.Types.ObjectId();
      const boardMemberId = new mongoose.Types.ObjectId();

      // Properties reference owner1 on two units, owner2 on one unit
      HOAProperty.find = () => ({
        select: () => ({
          lean: async () => [
            { _id: new mongoose.Types.ObjectId(), hoaId, associatedOwnerIds: [owner1Id] },
            { _id: new mongoose.Types.ObjectId(), hoaId, associatedOwnerIds: [owner1Id, owner2Id] },
          ],
        }),
      });

      const OWNER_ROLE_ID = new mongoose.Types.ObjectId();
      hoaOwnerRoleHelper.getHOAOwnerRoleRefs = async () => ({ roleId: OWNER_ROLE_ID });

      User.find = (filter) => ({
        select: () => ({
          lean: async () => {
            // If querying creators
            if (filter?._id?.$in && !filter?.isDeleted) {
              return [];
            }
            // If querying candidate owners: return owner1 (roleId match), owner2 (role string match), and board member (non-owner)
            return [
              { _id: owner1Id, companyRoleId: OWNER_ROLE_ID, role: 'HOA Owner', hoaInfo: { hoaId } },
              { _id: owner2Id, role: 'HOA Owner' },
              { _id: boardMemberId, role: 'HOA Board Member' }, // Board Member must not be counted as owner!
            ];
          },
        }),
      });

      HOASettings.find = () => ({ lean: async () => [] });
      hoaStatusHelper.summarizeCommunityLinkedBanks = async () => ({ hasLinkedBank: false });

      const enriched = await enrichHoaBatch(hoas);
      // owner1 (linked to 2 units) and owner2 (linked to 1 unit) = 2 distinct owners. boardMember excluded.
      assert.equal(enriched[0].ownerCount, 2, 'Must count 2 distinct owners, deduplicating owner1 and excluding board member');
    });

    test('onboarding status: derives active, in_progress, pending_setup, deleted accurately', async () => {
      const hoaActive = { _id: new mongoose.Types.ObjectId(), name: 'Active HOA', isDeleted: false };
      const hoaProgress = { _id: new mongoose.Types.ObjectId(), name: 'In Progress HOA', isDeleted: false };
      const hoaPending = { _id: new mongoose.Types.ObjectId(), name: 'Pending HOA', isDeleted: false };
      const hoaDeleted = { _id: new mongoose.Types.ObjectId(), name: 'Deleted HOA', isDeleted: true };

      const hoas = [hoaActive, hoaProgress, hoaPending, hoaDeleted];

      // Active has properties, progress has properties, pending has none
      HOAProperty.find = () => ({
        select: () => ({
          lean: async () => [
            { _id: new mongoose.Types.ObjectId(), hoaId: hoaActive._id, associatedOwnerIds: [] },
            { _id: new mongoose.Types.ObjectId(), hoaId: hoaProgress._id, associatedOwnerIds: [] },
          ],
        }),
      });

      // Active has complete settings
      HOASettings.find = () => ({
        lean: async () => [
          {
            hoaId: hoaActive._id,
            recurringFee: { enabled: true, amount: 250, frequency: 'monthly', tenure: 12 },
            paymentTerm: { dueDay: 1, gracePeriodDays: 10 },
            lateFee: { enabled: false },
          },
        ],
      });

      // Active has active linked bank; others do not
      hoaStatusHelper.summarizeCommunityLinkedBanks = async (id) => {
        if (String(id) === String(hoaActive._id)) {
          return { hasLinkedBank: true, hasActiveLinkedBank: true };
        }
        return { hasLinkedBank: false, hasActiveLinkedBank: false };
      };

      User.find = () => ({ select: () => ({ lean: async () => [] }) });
      hoaOwnerRoleHelper.getHOAOwnerRoleRefs = async () => ({ roleId: new mongoose.Types.ObjectId() });

      const enriched = await enrichHoaBatch(hoas);

      assert.equal(enriched[0].status, 'active', 'Complete settings + properties + bank = active');
      assert.equal(enriched[1].status, 'in_progress', 'Properties only without settings/bank = in_progress');
      assert.equal(enriched[2].status, 'pending_setup', 'No setup = pending_setup');
      assert.equal(enriched[3].status, 'deleted', 'isDeleted: true = deleted');
    });
  });

  // -------------------------------------------------------------
  // 8. CONTROLLER ENDPOINTS
  // -------------------------------------------------------------
  describe('HOA Onboarding Report Controller', () => {
    const controller = require('../shared/modules/system/reports/controllers/hoaOnboardingReport.controller');
    const reportingService = require('../shared/modules/system/reports/service/hoaOnboardingReport.service');
    const notifyService = require('../shared/modules/system/reports/service/hoaOnboardingReportNotify.service');

    let originalGetSummary;
    let originalListHoas;
    let originalSendEmail;

    beforeEach(() => {
      originalGetSummary = reportingService.getHoaOnboardingSummary;
      originalListHoas = reportingService.listHoaOnboarding;
      originalSendEmail = notifyService.sendHoaOnboardingReportEmail;
    });

    afterEach(() => {
      reportingService.getHoaOnboardingSummary = originalGetSummary;
      reportingService.listHoaOnboarding = originalListHoas;
      notifyService.sendHoaOnboardingReportEmail = originalSendEmail;
    });

    test('getSummary returns standardized 200 JSON with KPI metrics', async () => {
      reportingService.getHoaOnboardingSummary = async () => ({
        reportDate: '2026-06-15',
        timezone: 'America/New_York',
        today: 4,
        thisWeek: 15,
        thisMonth: 42,
      });

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.getSummary({}, res);
      assert.equal(resStatus, 200);
      assert.equal(resJson.statuscode, 200);
      assert.equal(resJson.data.today, 4);
      assert.equal(resJson.data.thisWeek, 15);
      assert.equal(resJson.data.thisMonth, 42);
    });

    test('getHoas returns paginated list records', async () => {
      reportingService.listHoaOnboarding = async (query) => ({
        items: [{ id: 'hoa1', name: 'Test HOA', status: 'active' }],
        pagination: { page: query.page || 1, limit: 10, totalItems: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false },
      });

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.getHoas({ query: { page: 1, limit: 10 } }, res);
      assert.equal(resStatus, 200);
      assert.equal(resJson.data.items.length, 1);
      assert.equal(resJson.data.items[0].name, 'Test HOA');
    });

    test('sendEmailNow returns success message when report is sent', async () => {
      notifyService.sendHoaOnboardingReportEmail = async () => ({
        sent: true,
        alreadySent: false,
        reportDate: '2026-06-15',
        recipients: ['admin@propmv.com'],
        summary: { dailyCount: 4, weeklyCount: 15, monthlyCount: 42 },
      });

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.sendEmailNow({ body: {} }, res);
      assert.equal(resStatus, 200);
      assert.equal(resJson.data.sent, true);
      assert.equal(resJson.data.alreadySent, false);
      assert.match(resJson.message, /sent successfully/i);
    });

    test('sendEmailNow returns 503 when email sending is skipped due to configuration', async () => {
      notifyService.sendHoaOnboardingReportEmail = async () => ({
        sent: false,
        skipped: true,
        alreadySent: false,
        reason: 'disabled_by_config',
        reportDate: '2026-06-15',
        recipients: ['admin@propmv.com'],
        summary: { dailyCount: 4, weeklyCount: 15, monthlyCount: 42 },
      });

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.sendEmailNow({ body: {} }, res);
      assert.equal(resStatus, 503);
      assert.equal(resJson.statuscode, 503);
      assert.equal(resJson.data.sent, false);
      assert.equal(resJson.data.skipped, true);
      assert.match(resJson.message, /skipped/i);
    });

    test('sendEmailNow returns success message and dispatches email even when report was already sent today', async () => {
      notifyService.sendHoaOnboardingReportEmail = async ({ triggerSource }) => {
        assert.equal(triggerSource, 'manual');
        return {
          sent: true,
          alreadySent: false,
          reportDate: '2026-06-15',
          recipients: ['admin@propmv.com'],
          summary: { dailyCount: 4, weeklyCount: 15, monthlyCount: 42 },
        };
      };

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.sendEmailNow({ body: {} }, res);
      assert.equal(resStatus, 200);
      assert.equal(resJson.data.sent, true);
      assert.equal(resJson.data.alreadySent, false);
      assert.match(resJson.message, /sent successfully/i);
    });

    test('sendEmailNow returns 409 Conflict when another manual send is already in progress', async () => {
      notifyService.sendHoaOnboardingReportEmail = async () => {
        const err = new Error('A manual report email send is already in progress. Please wait.');
        err.code = 'CONCURRENT_MANUAL_SEND';
        err.statusCode = 409;
        throw err;
      };

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; },
      };

      await controller.sendEmailNow({ body: {} }, res);
      assert.equal(resStatus, 409);
      assert.match(resJson.message, /already in progress/i);
    });
  });

  // -------------------------------------------------------------
  // 9. SNAPSHOT IDEMPOTENCY & MANUAL TRIGGER SEPARATION
  // -------------------------------------------------------------
  describe('Snapshot Idempotency & Manual Trigger Separation (sendHoaOnboardingReportEmail)', () => {
    const notifyService = require('../shared/modules/system/reports/service/hoaOnboardingReportNotify.service');
    const reportingService = require('../shared/modules/system/reports/service/hoaOnboardingReport.service');
    const HoaOnboardingReportSnapshot = require('../shared/modules/system/reports/model/hoaOnboardingReportSnapshot.model');
    const emailHelper = require('../common/helpers/emailHelper');

    let originalFindOne;
    let originalFindOneAndUpdate;
    let originalUpdateOne;
    let originalSendEmail;
    let originalBuildReport;
    let originalGetSummary;

    beforeEach(() => {
      originalFindOne = HoaOnboardingReportSnapshot.findOne;
      originalFindOneAndUpdate = HoaOnboardingReportSnapshot.findOneAndUpdate;
      originalUpdateOne = HoaOnboardingReportSnapshot.updateOne;
      originalSendEmail = emailHelper.sendEmail;
      originalBuildReport = reportingService.buildHoaOnboardingReport;
      originalGetSummary = reportingService.getHoaOnboardingSummary;

      reportingService.getHoaOnboardingSummary = async () => ({
        reportDate: '2026-06-15',
        timezone: 'America/New_York',
        today: 2,
        thisWeek: 8,
        thisMonth: 20,
        periodStarts: { daily: new Date(), weekly: new Date(), monthly: new Date() },
        periodEnd: new Date(),
      });

      reportingService.buildHoaOnboardingReport = async () => ({
        reportDate: '2026-06-15',
        timeZone: 'America/New_York',
        summary: { daily: 2, weekly: 8, monthly: 20 },
        periods: { daily: { hoas: [] }, weekly: { hoas: [] }, monthly: { hoas: [] } },
      });
    });

    afterEach(() => {
      HoaOnboardingReportSnapshot.findOne = originalFindOne;
      HoaOnboardingReportSnapshot.findOneAndUpdate = originalFindOneAndUpdate;
      HoaOnboardingReportSnapshot.updateOne = originalUpdateOne;
      emailHelper.sendEmail = originalSendEmail;
      reportingService.buildHoaOnboardingReport = originalBuildReport;
      reportingService.getHoaOnboardingSummary = originalGetSummary;
    });

    test('scheduler sends once for a report date and marks snapshot emailSent=true', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls++;
      };

      // No existing snapshot
      HoaOnboardingReportSnapshot.findOne = async () => null;

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      let updatedFields = null;
      HoaOnboardingReportSnapshot.updateOne = async (query, update) => {
        updatedFields = update.$set;
      };

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T13:00:00.000Z'),
        triggerSource: 'cron',
      });

      assert.equal(result.sent, true);
      assert.equal(result.alreadySent, false);
      assert.equal(emailCalls, 1);
      assert.equal(updatedFields?.emailSent, true);
      assert.equal(updatedFields?.triggerSource, 'cron');
    });

    test('second scheduler run skips when daily report was already sent (idempotent)', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls++;
      };

      // Mock existing successful daily snapshot from first scheduler run
      HoaOnboardingReportSnapshot.findOne = async () => ({
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
        emailSentAt: new Date('2026-06-15T13:00:00.000Z'),
        summary: { dailyCount: 2, weeklyCount: 8, monthlyCount: 20 },
        recipients: ['admin@propmv.com'],
        triggerSource: 'cron',
      });

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T14:00:00.000Z'),
        triggerSource: 'cron',
        force: false,
      });

      assert.equal(result.sent, false);
      assert.equal(result.alreadySent, true);
      assert.equal(emailCalls, 0, 'Scheduler must not send duplicate email on second run');
    });

    test('manual send works when today\'s report was already sent without corrupting existing snapshot', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls++;
      };

      // Existing snapshot already has emailSent=true from automated cron
      const snapshotId = new mongoose.Types.ObjectId();
      const existingScheduledSnapshot = {
        _id: snapshotId,
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
        emailSentAt: new Date('2026-06-15T13:00:00.000Z'),
        triggerSource: 'cron',
        summary: { dailyCount: 2, weeklyCount: 8, monthlyCount: 20 },
        recipients: ['admin@propmv.com'],
      };

      HoaOnboardingReportSnapshot.findOne = async () => existingScheduledSnapshot;
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => existingScheduledSnapshot;

      let updateApplied = null;
      HoaOnboardingReportSnapshot.updateOne = async (query, update) => {
        updateApplied = update;
      };

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:30:00.000Z'),
        triggerSource: 'manual',
      });

      assert.equal(result.sent, true, 'Manual send must send email even when report was already sent today');
      assert.equal(result.alreadySent, false);
      assert.equal(emailCalls, 1);
      // Verify existing daily automated snapshot is not overwritten or corrupted
      assert.equal(updateApplied?.$set?.triggerSource, undefined, 'Must not overwrite cron triggerSource');
      assert.ok(updateApplied?.$set?.lastManualSentAt instanceof Date, 'Must record lastManualSentAt');
      assert.equal(updateApplied?.$inc?.manualSendCount, 1, 'Must increment manualSendCount');
    });

    test('two separate manual clicks result in two separate intentional emails', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls++;
      };

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOne = async () => ({
        _id: snapshotId,
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
      });
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: true,
      });
      HoaOnboardingReportSnapshot.updateOne = async () => {};

      // Click 1
      const result1 = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:30:00.000Z'),
        triggerSource: 'manual',
      });

      // Click 2
      const result2 = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:35:00.000Z'),
        triggerSource: 'manual',
      });

      assert.equal(result1.sent, true);
      assert.equal(result2.sent, true);
      assert.equal(emailCalls, 2, 'Two intentional manual clicks must produce two separate emails');
    });

    test('prevents accidental duplicate sends while a manual request is already in progress', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls++;
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOne = async () => null;
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });
      HoaOnboardingReportSnapshot.updateOne = async () => {};

      // Trigger two concurrent calls simulating rapid double-click
      const [call1, call2] = await Promise.allSettled([
        notifyService.sendHoaOnboardingReportEmail({
          referenceDate: new Date('2026-06-15T15:30:00.000Z'),
          triggerSource: 'manual',
        }),
        notifyService.sendHoaOnboardingReportEmail({
          referenceDate: new Date('2026-06-15T15:30:00.000Z'),
          triggerSource: 'manual',
        }),
      ]);

      const fulfilled = [call1, call2].filter((c) => c.status === 'fulfilled');
      const rejected = [call1, call2].filter((c) => c.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one concurrent call should succeed');
      assert.equal(rejected.length, 1, 'Duplicate concurrent call must be rejected');
      assert.match(rejected[0].reason.message, /already in progress/i);
      assert.equal(emailCalls, 1, 'Exactly one email should be sent for concurrent double-clicks');
    });

    test('force=true bypasses already-sent skip to allow intentional re-send for scheduler', async () => {
      let emailCalled = false;
      emailHelper.sendEmail = async () => {
        emailCalled = true;
      };

      HoaOnboardingReportSnapshot.findOne = async () => ({
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
      });

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      let updatedFields = null;
      HoaOnboardingReportSnapshot.updateOne = async (query, update) => {
        updatedFields = update.$set;
      };

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T14:00:00.000Z'),
        triggerSource: 'cron',
        force: true,
      });

      assert.equal(result.sent, true);
      assert.equal(emailCalled, true);
      assert.equal(updatedFields?.emailSent, true);
    });

    test('records errorMessage and keeps emailSent=false on email delivery failure (retryable)', async () => {
      emailHelper.sendEmail = async () => {
        throw new Error('SMTP connection timeout: host unreachable');
      };

      HoaOnboardingReportSnapshot.findOne = async () => null;

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      let recordedError = null;
      HoaOnboardingReportSnapshot.updateOne = async (query, update) => {
        recordedError = update.$set?.errorMessage;
      };

      await assert.rejects(
        async () => {
          await notifyService.sendHoaOnboardingReportEmail({
            referenceDate: new Date('2026-06-15T14:00:00.000Z'),
          });
        },
        /SMTP connection timeout/
      );

      assert.match(recordedError, /SMTP connection timeout/);
    });

    test('manual send: sends email even if daily cron snapshot with emailSent=true already exists', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls += 1;
      };

      HoaOnboardingReportSnapshot.findOne = async () => ({
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
        summary: { dailyCount: 3, weeklyCount: 15, monthlyCount: 45 },
        recipients: ['admin@propmv.com'],
      });

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      HoaOnboardingReportSnapshot.updateOne = async () => {};

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:00:00.000Z'),
        triggerSource: 'manual',
      });

      assert.equal(result.sent, true);
      assert.equal(emailCalls, 1, 'Manual send must send email despite existing snapshot');
    });

    test('manual send: second intentional click after first completes dispatches another email', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls += 1;
      };

      HoaOnboardingReportSnapshot.findOne = async () => ({
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
      });

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      HoaOnboardingReportSnapshot.updateOne = async () => {};

      // First intentional manual send
      const first = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:00:00.000Z'),
        triggerSource: 'manual',
      });
      assert.equal(first.sent, true);
      assert.equal(emailCalls, 1);

      // Second intentional manual send after first completes
      const second = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:05:00.000Z'),
        triggerSource: 'manual',
      });
      assert.equal(second.sent, true);
      assert.equal(emailCalls, 2, 'Second intentional manual click must send second email');
    });

    test('scheduler idempotency: subsequent cron run skips duplicate send when emailSent=true', async () => {
      let emailCalls = 0;
      emailHelper.sendEmail = async () => {
        emailCalls += 1;
      };

      HoaOnboardingReportSnapshot.findOne = async () => ({
        reportDate: '2026-06-15',
        period: 'daily',
        emailSent: true,
        summary: { dailyCount: 3, weeklyCount: 15, monthlyCount: 45 },
        recipients: ['admin@propmv.com'],
      });

      const result = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T15:00:00.000Z'),
        triggerSource: 'cron',
        force: false,
      });

      assert.equal(result.sent, false);
      assert.equal(result.alreadySent, true);
      assert.equal(emailCalls, 0, 'Automated cron run must skip send when already sent for today');
    });

    test('emailHelper returning false marks send as skipped and does not update successful snapshot fields', async () => {
      emailHelper.sendEmail = async () => false;

      const snapshotId = new mongoose.Types.ObjectId();
      HoaOnboardingReportSnapshot.findOne = async () => null;
      HoaOnboardingReportSnapshot.findOneAndUpdate = async () => ({
        _id: snapshotId,
        emailSent: false,
      });

      let updateApplied = false;
      HoaOnboardingReportSnapshot.updateOne = async () => {
        updateApplied = true;
      };

      // Test cron trigger
      const cronResult = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T13:00:00.000Z'),
        triggerSource: 'cron',
      });

      assert.equal(cronResult.sent, false);
      assert.equal(cronResult.skipped, true);
      assert.equal(cronResult.reason, 'disabled_by_config');
      assert.deepEqual(cronResult.recipients, ['admin@propmv.com']);
      assert.equal(updateApplied, false, 'Cron snapshot must not be updated on skipped send');

      // Test manual trigger
      const manualResult = await notifyService.sendHoaOnboardingReportEmail({
        referenceDate: new Date('2026-06-15T13:00:00.000Z'),
        triggerSource: 'manual',
      });

      assert.equal(manualResult.sent, false);
      assert.equal(manualResult.skipped, true);
      assert.equal(manualResult.reason, 'disabled_by_config');
      assert.deepEqual(manualResult.recipients, ['admin@propmv.com']);
      assert.equal(updateApplied, false, 'Manual snapshot must not be updated on skipped send');
    });
  });
});


