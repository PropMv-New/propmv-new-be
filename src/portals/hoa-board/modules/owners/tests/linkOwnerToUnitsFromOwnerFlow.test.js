jest.mock('mongoose', () => ({
  startSession: jest.fn(),
  Types: {
    ObjectId: jest.fn((id) => id),
  },
}));

jest.mock('../../property/model/property.model', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../../invoice/model/invoice.model', () => ({
  updateMany: jest.fn(),
  countDocuments: jest.fn(),
}));

jest.mock('../../../../../shared/modules/users/models/user.model', () => ({
  updateMany: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../dashboard/service/activity.service', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../services/unitInvoice.service', () => ({
  generateUnitInvoices: jest.fn(),
}));

jest.mock('../../../../../common/helpers/unitAssignmentEmailHelper', () => ({
  sendUnitAssignmentEmail: jest.fn(),
}));

jest.mock('../../../../../integrations/s3', () => ({}));
jest.mock('../../../../../config/default', () => ({}));
jest.mock('../../../../../shared/modules/documents/model/documentMetadata.model', () => ({
  create: jest.fn(),
}));
jest.mock('../../expense/model/expense.model', () => ({}));
jest.mock('../models/ledgerEntry.model', () => ({}));
jest.mock('../services/ledger.service', () => ({}));
jest.mock('../services/unitScheduleRecalc.service', () => ({
  recalculateFutureScheduleInvoicesForUnit: jest.fn(),
}));
jest.mock('../../invoice/service/invoice.service', () => ({}));
jest.mock('../../hoa-settings/model/hoaSettings.model', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../../../../common/helpers/addressHelper', () => ({
  updateOwnersMailingAddress: jest.fn(),
}));
jest.mock('../../../../../common/helpers/ownerRemovalNoticeEmailHelper', () => ({
  sendOwnerRemovalNoticeEmail: jest.fn(),
}));
jest.mock('../../../../../common/helpers/hoaOwnerRole', () => ({
  buildHOAOwnerUserFilter: jest.fn(),
}));

const Property = require('../../property/model/property.model');
const Invoice = require('../../invoice/model/invoice.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { buildHOAOwnerUserFilter } = require('../../../../../common/helpers/hoaOwnerRole');
const { linkOwnerToUnitsFromOwnerFlow } = require('../services/unit.service');

const eligibleOwnerDoc = {
  _id: '507f1f77bcf86cd799439013',
  portalOnboardingStatus: 'active',
  status: 'Active',
  isArchived: false,
  isDeleted: false,
};

describe('linkOwnerToUnitsFromOwnerFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Invoice.updateMany.mockResolvedValue({ modifiedCount: 2 });
    buildHOAOwnerUserFilter.mockResolvedValue({ role: 'HOA Owner' });
    User.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(eligibleOwnerDoc),
        }),
        lean: jest.fn().mockResolvedValue(eligibleOwnerDoc),
      }),
    });
  });

  it('adds owner to unit ownership timeline and future invoice payers', async () => {
    const unit = {
      _id: '507f1f77bcf86cd799439011',
      createdAt: new Date('2025-01-01T12:00:00.000Z'),
      associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      ownershipRecords: [],
    };

    Property.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(unit),
    });
    Property.findByIdAndUpdate.mockResolvedValue(unit);

    await linkOwnerToUnitsFromOwnerFlow(
      ['507f1f77bcf86cd799439011'],
      '507f1f77bcf86cd799439013',
      { userId: 'board-1', source: 'create-owner' },
    );

    expect(Property.findByIdAndUpdate).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      expect.objectContaining({
        $set: expect.objectContaining({
          associatedOwnerIds: expect.arrayContaining([
            '507f1f77bcf86cd799439012',
            '507f1f77bcf86cd799439013',
          ]),
        }),
        $push: expect.objectContaining({
          ownershipLogs: expect.objectContaining({ action: 'ADD' }),
        }),
      }),
      {},
    );

    expect(Invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: '507f1f77bcf86cd799439011',
        isDeleted: { $ne: true },
        tenants: { $ne: '507f1f77bcf86cd799439013' },
        dueDate: expect.any(Date),
      }),
      { $addToSet: { tenants: '507f1f77bcf86cd799439013' } },
      { session: null },
    );
  });

  it('skips units where the owner is already linked', async () => {
    const unit = {
      _id: '507f1f77bcf86cd799439011',
      createdAt: new Date('2025-01-01T12:00:00.000Z'),
      associatedOwnerIds: ['507f1f77bcf86cd799439013'],
      ownershipRecords: [],
    };

    Property.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(unit),
    });

    await linkOwnerToUnitsFromOwnerFlow(
      ['507f1f77bcf86cd799439011'],
      '507f1f77bcf86cd799439013',
      { userId: 'board-1' },
    );

    expect(Property.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Invoice.updateMany).not.toHaveBeenCalled();
  });

  it('INV-SC-029: links invitation_sent owners without adding them as invoice payers', async () => {
    User.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            ...eligibleOwnerDoc,
            portalOnboardingStatus: 'invitation_sent',
          }),
        }),
        lean: jest.fn().mockResolvedValue({
          ...eligibleOwnerDoc,
          portalOnboardingStatus: 'invitation_sent',
        }),
      }),
    });

    const unit = {
      _id: '507f1f77bcf86cd799439011',
      createdAt: new Date('2025-01-01T12:00:00.000Z'),
      associatedOwnerIds: ['507f1f77bcf86cd799439012'],
      ownershipRecords: [],
    };

    Property.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(unit),
    });
    Property.findByIdAndUpdate.mockResolvedValue(unit);

    await linkOwnerToUnitsFromOwnerFlow(
      ['507f1f77bcf86cd799439011'],
      '507f1f77bcf86cd799439013',
      { userId: 'board-1', source: 'create-owner' },
    );

    expect(Property.findByIdAndUpdate).toHaveBeenCalled();
    expect(Invoice.updateMany).not.toHaveBeenCalled();
  });
});
