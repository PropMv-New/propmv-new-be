const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');
const { USER_STATUSES } = require('../../../../../common/constants/user');

const hoaOwnerRole = require('../../../../../common/helpers/hoaOwnerRole');
hoaOwnerRole.buildHOAOwnerUserFilter = async () => ({ role: 'HOA Owner' });

const unitInvoiceService = require('../services/unitInvoice.service');
const invoiceGeneration = { calls: 0 };
unitInvoiceService.generateUnitInvoices = async () => {
  invoiceGeneration.calls += 1;
  return { invoices: [{ invoiceId: 'INV-TEST' }], remainingCredit: 0 };
};

const User = require('../../../../../shared/modules/users/models/user.model');
const Property = require('../../property/model/property.model');
const Invoice = require('../../invoice/model/invoice.model');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const LedgerEntry = require('../models/ledgerEntry.model');
const ledgerService = require('../services/ledger.service');
const {
  ensureInvoicesWhenOwnerLinkedToUnits,
  ensureInvoicesWhenOwnerVerified,
} = require('../services/unit.service');

const OWNER_ID = '507f1f77bcf86cd799439013';
const UNIT_ID = '507f1f77bcf86cd799439011';
const HOA_ID = '507f1f77bcf86cd799439022';

function chainable(result) {
  const chain = {
    select() { return chain; },
    session() { return chain; },
    lean: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return chain;
}

function makeOwner(overrides = {}) {
  return {
    _id: OWNER_ID,
    portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.ACTIVE,
    status: USER_STATUSES.ACTIVE,
    isArchived: false,
    isDeleted: false,
    propertyIds: [UNIT_ID],
    ...overrides,
  };
}

function makeUnit(overrides = {}) {
  return {
    _id: UNIT_ID,
    name: 'Unit 101',
    hoaId: HOA_ID,
    associatedOwnerIds: [OWNER_ID],
    ownershipRecords: [{
      ownerId: OWNER_ID,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
      financialHandling: 'FRESH',
    }],
    monthlyRecurringFee: 150,
    paymentTerm: 12,
    startingBalance: 0,
    balanceAsOf: new Date('2026-01-01T12:00:00.000Z'),
    requestPayload: { paymentDueDay: 1 },
    unitDetails: [{ unitName: '101' }],
    ...overrides,
  };
}

describe('INV-SC-029 owner verification invoice gate', () => {
  let originals;

  beforeEach(() => {
    originals = {
      userFind: User.find,
      userFindById: User.findById,
      userFindOne: User.findOne,
      propertyFindById: Property.findById,
      propertyFind: Property.find,
      propertyFindByIdAndUpdate: Property.findByIdAndUpdate,
      invoiceCount: Invoice.countDocuments,
      invoiceUpdateMany: Invoice.updateMany,
      hoaSettingsFindOne: HOASettings.findOne,
      ledgerCount: LedgerEntry.countDocuments,
      createOpeningBalance: ledgerService.createOpeningBalance,
      remainingCredit: ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration,
    };

    invoiceGeneration.calls = 0;
    ledgerService.createOpeningBalance = async () => ({});
    ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration = async () => 0;
    Invoice.updateMany = async () => ({ modifiedCount: 0 });
    Property.findByIdAndUpdate = async () => makeUnit();
    LedgerEntry.countDocuments = () => chainable(0);
    HOASettings.findOne = () => chainable({
      recurringFee: { enabled: true, amount: 150, tenure: 1 },
    });
  });

  afterEach(() => {
    User.find = originals.userFind;
    User.findById = originals.userFindById;
    User.findOne = originals.userFindOne;
    Property.findById = originals.propertyFindById;
    Property.find = originals.propertyFind;
    Property.findByIdAndUpdate = originals.propertyFindByIdAndUpdate;
    Invoice.countDocuments = originals.invoiceCount;
    Invoice.updateMany = originals.invoiceUpdateMany;
    HOASettings.findOne = originals.hoaSettingsFindOne;
    LedgerEntry.countDocuments = originals.ledgerCount;
    ledgerService.createOpeningBalance = originals.createOpeningBalance;
    ledgerService.resolvePropertyRemainingCreditAfterInvoiceGeneration = originals.remainingCredit;
  });

  function mockOwnerLookup(owner) {
    User.find = () => chainable(owner ? [owner] : []);
    User.findById = () => chainable(owner || null);
  }

  it('does not generate invoices when linking an invitation_sent owner', async () => {
    let unitLookedUp = false;
    mockOwnerLookup(makeOwner({ portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT }));
    Property.findById = () => {
      unitLookedUp = true;
      return chainable(makeUnit());
    };

    await ensureInvoicesWhenOwnerLinkedToUnits([UNIT_ID], OWNER_ID, { userId: 'board-1' });
    assert.equal(unitLookedUp, false);
  });

  it('does not generate invoices when linking a pending_verification owner', async () => {
    let unitLookedUp = false;
    mockOwnerLookup(makeOwner({ portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION }));
    Property.findById = () => {
      unitLookedUp = true;
      return chainable(makeUnit());
    };

    await ensureInvoicesWhenOwnerLinkedToUnits([UNIT_ID], OWNER_ID, { userId: 'board-1' });
    assert.equal(unitLookedUp, false);
  });

  it('does not generate invoices when linking an inactive owner', async () => {
    let unitLookedUp = false;
    mockOwnerLookup(makeOwner({ status: USER_STATUSES.INACTIVE }));
    Property.findById = () => {
      unitLookedUp = true;
      return chainable(makeUnit());
    };

    await ensureInvoicesWhenOwnerLinkedToUnits([UNIT_ID], OWNER_ID, { userId: 'board-1' });
    assert.equal(unitLookedUp, false);
  });

  it('skips generation when the unit already has invoices', async () => {
    mockOwnerLookup(makeOwner());
    Property.findById = () => chainable(makeUnit());
    Invoice.countDocuments = () => chainable(4);

    await ensureInvoicesWhenOwnerLinkedToUnits([UNIT_ID], OWNER_ID, { userId: 'board-1' });
    assert.equal(invoiceGeneration.calls, 0);
  });

  it('generates invoices when a verified owner is linked and the unit has none', async () => {
    mockOwnerLookup(makeOwner());
    Property.findById = () => chainable(makeUnit());
    Invoice.countDocuments = () => chainable(0);

    await ensureInvoicesWhenOwnerLinkedToUnits([UNIT_ID], OWNER_ID, { userId: 'board-1', hoaId: HOA_ID });
    assert.equal(invoiceGeneration.calls, 1);
  });

  it('ensureInvoicesWhenOwnerVerified no-ops for unverified owners', async () => {
    let unitsLookedUp = false;
    mockOwnerLookup(makeOwner({ portalOnboardingStatus: PORTAL_ONBOARDING_STATUS.INVITATION_SENT }));
    Property.find = () => {
      unitsLookedUp = true;
      return chainable([]);
    };

    await ensureInvoicesWhenOwnerVerified(OWNER_ID, { source: 'owner-verified' });
    assert.equal(unitsLookedUp, false);
  });

  it('ensureInvoicesWhenOwnerVerified no-ops without an owner id', async () => {
    let ownerLookedUp = false;
    User.find = () => {
      ownerLookedUp = true;
      return chainable([]);
    };

    await ensureInvoicesWhenOwnerVerified(null);
    await ensureInvoicesWhenOwnerVerified('');
    assert.equal(ownerLookedUp, false);
  });

  it('ensureInvoicesWhenOwnerVerified generates invoices for a newly verified owner', async () => {
    mockOwnerLookup(makeOwner());
    Property.find = () => chainable([makeUnit()]);
    Property.findById = () => chainable(makeUnit());
    Invoice.countDocuments = () => chainable(0);

    await ensureInvoicesWhenOwnerVerified(OWNER_ID, { source: 'owner-verified' });
    assert.equal(invoiceGeneration.calls, 1);
  });

  it('ensureInvoicesWhenOwnerVerified does not create duplicates when invoices already exist', async () => {
    mockOwnerLookup(makeOwner());
    Property.find = () => chainable([makeUnit()]);
    Property.findById = () => chainable(makeUnit());
    Invoice.countDocuments = () => chainable(12);

    await ensureInvoicesWhenOwnerVerified(OWNER_ID, { source: 'owner-verified' });
    assert.equal(invoiceGeneration.calls, 0);
  });
});
