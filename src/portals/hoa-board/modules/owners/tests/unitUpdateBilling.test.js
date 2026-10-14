jest.mock('mongoose', () => ({
  startSession: jest.fn(),
  Types: {
    ObjectId: {
      isValid: jest.fn(() => true)
    }
  }
}));

jest.mock('../../property/model/property.model', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOne: jest.fn()
}));

jest.mock('../../../../../shared/modules/users/models/user.model', () => ({
  updateMany: jest.fn(),
  findById: jest.fn()
}));

jest.mock('../../invoice/model/invoice.model', () => ({
  countDocuments: jest.fn(),
  updateMany: jest.fn()
}));

jest.mock('../../dashboard/service/activity.service', () => ({
  logActivity: jest.fn()
}));

jest.mock('../services/unitInvoice.service', () => ({
  generateUnitInvoices: jest.fn()
}));

jest.mock('../../../../../common/helpers/unitAssignmentEmailHelper', () => ({
  sendUnitAssignmentEmail: jest.fn()
}));

jest.mock('../../../../../integrations/s3', () => ({
  upload: jest.fn()
}));

jest.mock('../../../../../config/default', () => ({}));
jest.mock('../../../../../shared/modules/documents/model/documentMetadata.model', () => ({
  create: jest.fn()
}));

const mongoose = require('mongoose');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const Invoice = require('../../invoice/model/invoice.model');
const { logActivity } = require('../../dashboard/service/activity.service');
const { generateUnitInvoices } = require('../services/unitInvoice.service');
const { updateUnit } = require('../services/unit.service');

describe('Unit billing regeneration on update', () => {
  let mockSession;
  let existingUnit;
  let updatedUnit;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSession = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      abortTransaction: jest.fn(),
      endSession: jest.fn()
    };

    mongoose.startSession.mockResolvedValue(mockSession);
    User.updateMany.mockResolvedValue({ modifiedCount: 0 });
    logActivity.mockResolvedValue(undefined);

    existingUnit = {
      _id: 'unit-1',
      landlord_id: 'board-1',
      name: 'Old Unit Name',
      description: 'Old description',
      address: {
        street: '123 Main St',
        city: 'Austin',
        state: 'TX',
        zip: '78701'
      },
      associatedOwnerIds: ['owner-1'],
      startingBalance: 500,
      balanceAsOf: '2026-02-01T00:00:00.000Z',
      monthlyRecurringFee: 200,
      paymentTerm: 12,
      depositBankAccountId: 'bank-1'
    };

    updatedUnit = {
      ...existingUnit,
      name: 'Updated Unit Name',
      startingBalance: -1500
    };

    Property.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(existingUnit)
    });

    Property.findByIdAndUpdate.mockResolvedValue(updatedUnit);
    Property.findOne.mockReturnValue({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null)
    });
    Invoice.updateMany.mockResolvedValue({ modifiedCount: 3 });
    Invoice.countDocuments.mockImplementation(() => {
      const query = Promise.resolve(2);
      query.session = jest.fn().mockResolvedValue(2);
      return query;
    });
    generateUnitInvoices.mockResolvedValue([]);
  });

  it('keeps paid history and regenerates only open invoices when billing config changes', async () => {
    await updateUnit('unit-1', {
      propertyName: 'Updated Unit Name',
      ownerIds: ['owner-1'],
      startingBalance: -1500,
      balanceAsOf: '2026-02-01T00:00:00.000Z',
      monthlyRecurringFee: 200,
      paymentTerm: 12,
      boardMemberId: 'board-1'
    });

    expect(Invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: 'unit-1',
        status: { $in: ['Pending', 'Partially Paid', 'Overdue'] },
        isDeleted: { $ne: true }
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          isDeleted: true,
          deletedBy: 'board-1'
        })
      }),
      { session: mockSession }
    );

    expect(generateUnitInvoices).toHaveBeenCalledWith(
      expect.objectContaining({
        startingBalance: -1500,
        balanceAsOf: '2026-02-01T00:00:00.000Z',
        monthlyRecurringFee: 200,
        paymentTerm: 12,
        associatedOwnerIds: ['owner-1']
      }),
      'unit-1',
      updatedUnit.name,
      mockSession,
      { includeOpeningBalanceInvoice: false }
    );
  });

  it('does not regenerate invoices when billing config is unchanged', async () => {
    await updateUnit('unit-1', {
      propertyName: 'Updated Unit Name',
      ownerIds: ['owner-1'],
      startingBalance: 500,
      balanceAsOf: '2026-02-01T00:00:00.000Z',
      monthlyRecurringFee: 200,
      paymentTerm: 12,
      boardMemberId: 'board-1'
    });

    expect(Invoice.updateMany).toHaveBeenCalledWith(
      { propertyId: 'unit-1' },
      { $set: { propertyName: 'Updated Unit Name' } },
      { session: mockSession }
    );
    expect(Invoice.updateMany.mock.calls.some((call) => call[1]?.$set?.isDeleted)).toBe(false);
    expect(generateUnitInvoices).not.toHaveBeenCalled();
  });

  it('syncs associated invoice unit labels when the unit number changes', async () => {
    existingUnit.unitDetails = [{ unitName: '101' }];
    existingUnit.associatedOwnerIds = [];
    updatedUnit = {
      ...existingUnit,
      unitDetails: [{ unitName: '202' }]
    };
    Property.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(existingUnit)
    });
    Property.findByIdAndUpdate.mockResolvedValue(updatedUnit);

    await updateUnit('unit-1', {
      title: '202',
      boardMemberId: 'board-1'
    });

    expect(Invoice.updateMany).toHaveBeenCalledWith(
      { propertyId: 'unit-1' },
      { $set: { unit: '202' } },
      { session: mockSession }
    );
    expect(Invoice.updateMany.mock.calls.some((call) => call[1]?.$set?.isDeleted)).toBe(false);
    expect(generateUnitInvoices).not.toHaveBeenCalled();
  });
});
