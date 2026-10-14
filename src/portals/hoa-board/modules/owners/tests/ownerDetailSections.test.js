const { describe, test, mock, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const OWNER_ID = '507f1f77bcf86cd799439011';
const PROPERTY_ID = '507f1f77bcf86cd799439021';

const User = require('../../../../../shared/modules/users/models/user.model');
const Message = require('../../../../../shared/messaging/model/message.model');
const hoaServicePath = require.resolve('../../../../../shared/modules/documents/service/hoa.service');
const invoiceModelPath = require.resolve('../../invoice/model/invoice.model');
const messageModelPath = require.resolve('../../../../../shared/messaging/model/message.model');
const ownerServicePath = require.resolve('../service/owner.service');

function buildOwner(overrides = {}) {
  return {
    _id: OWNER_ID,
    isDeleted: false,
    firstName: 'Jane',
    lastName: 'Owner',
    email: 'jane@example.com',
    phone: '555-0100',
    status: 'Active',
    notes: [],
    propertyIds: [
      {
        _id: PROPERTY_ID,
        name: 'Sunset Unit',
        unitDetails: [{ unitName: 'A1' }],
        address: { street: '1 Main', city: 'Austin', state: 'TX', zip: '78701' },
        monthlyRecurringFee: 250,
        balanceAsOf: new Date('2026-01-01'),
        paymentTerm: 12,
      },
    ],
    createdAt: new Date('2025-06-01'),
    updatedAt: new Date('2026-03-01'),
    ...overrides,
  };
}

describe('parseOwnerDetailInclude', () => {
  let parseOwnerDetailInclude;
  let OWNER_DETAIL_SECTIONS;

  before(() => {
    ({ parseOwnerDetailInclude, OWNER_DETAIL_SECTIONS } = require(ownerServicePath));
  });

  test('returns all sections when include is omitted', () => {
    const include = parseOwnerDetailInclude(undefined);
    assert.deepEqual([...include].sort(), [...OWNER_DETAIL_SECTIONS].sort());
  });

  test('returns only requested sections', () => {
    const include = parseOwnerDetailInclude('profile,financials');
    assert.deepEqual([...include].sort(), ['financials', 'profile']);
  });

  test('falls back to all sections for unknown values', () => {
    const include = parseOwnerDetailInclude('unknown-section');
    assert.deepEqual([...include].sort(), [...OWNER_DETAIL_SECTIONS].sort());
  });
});

describe('getOwnerById section loading', () => {
  let ownerService;
  let ownerRecord;
  let invoiceFindMock;
  let invoiceAggregateMock;
  let documentsFetchMock;
  let messagesFindRecentMock;
  let messagesFormatHistoryMock;
  let originalFindById;
  let originalFindRecentForUser;
  let originalFormatHistoryForOwner;
  let originalGetHOADocumentsForOwner;

  before(() => {
    invoiceFindMock = mock.fn(() => ({
      sort: () => ({
        lean: async () => [],
      }),
    }));
    invoiceAggregateMock = mock.fn(async () => ([{
      current: [],
      pastDue: [],
      paymentTotals: [],
    }]));

    require.cache[invoiceModelPath] = {
      id: invoiceModelPath,
      filename: invoiceModelPath,
      loaded: true,
      exports: {
        find: invoiceFindMock,
        aggregate: invoiceAggregateMock,
      },
    };

    messagesFindRecentMock = mock.fn(async () => []);
    messagesFormatHistoryMock = mock.fn((messages) => (messages || []).map((msg) => ({
      to: 'Jane Owner',
      from: 'Admin',
      subject: msg.content || '',
      date: msg.createdAt,
    })));

    require.cache[messageModelPath] = {
      id: messageModelPath,
      filename: messageModelPath,
      loaded: true,
      exports: {
        findRecentForUser: messagesFindRecentMock,
        formatHistoryForOwner: messagesFormatHistoryMock,
      },
    };

    const hoaService = require(hoaServicePath);
    originalGetHOADocumentsForOwner = hoaService.getHOADocumentsForOwner;
    documentsFetchMock = mock.fn(async () => ({ data: [{ id: 'doc-1', name: 'HOA Policy' }] }));
    hoaService.getHOADocumentsForOwner = documentsFetchMock;

    delete require.cache[ownerServicePath];
    ownerService = require(ownerServicePath);
  });

  after(() => {
    const hoaService = require(hoaServicePath);
    hoaService.getHOADocumentsForOwner = originalGetHOADocumentsForOwner;
    delete require.cache[invoiceModelPath];
    delete require.cache[messageModelPath];
    delete require.cache[ownerServicePath];
  });

  beforeEach(() => {
    ownerRecord = buildOwner();
    invoiceFindMock.mock.resetCalls();
    invoiceAggregateMock.mock.resetCalls();
    documentsFetchMock.mock.resetCalls();
    messagesFindRecentMock.mock.resetCalls();
    messagesFormatHistoryMock.mock.resetCalls();

    require.cache[invoiceModelPath] = {
      id: invoiceModelPath,
      filename: invoiceModelPath,
      loaded: true,
      exports: {
        find: invoiceFindMock,
        aggregate: invoiceAggregateMock,
      },
    };

    require.cache[messageModelPath] = {
      id: messageModelPath,
      filename: messageModelPath,
      loaded: true,
      exports: {
        findRecentForUser: messagesFindRecentMock,
        formatHistoryForOwner: messagesFormatHistoryMock,
      },
    };

    delete require.cache[ownerServicePath];
    ownerService = require(ownerServicePath);

    originalFindById = User.findById;
    User.findById = mock.fn(() => ({
      select: () => ({
        populate: () => ({
          lean: async () => ({ ...ownerRecord }),
        }),
      }),
    }));
  });

  afterEach(() => {
    User.findById = originalFindById;
  });

  test('include=profile returns profile fields without heavy section fetches', async () => {
    const result = await ownerService.getOwnerById(OWNER_ID, { include: 'profile' });

    assert.equal(result.firstName, 'Jane');
    assert.equal(result.properties.length, 1);
    assert.equal(result.properties[0].unitName, 'A1');
    assert.equal(invoiceFindMock.mock.callCount(), 0);
    assert.equal(documentsFetchMock.mock.callCount(), 0);
    assert.equal(messagesFindRecentMock.mock.callCount(), 0);
    assert.equal(result.invoices, undefined);
    assert.equal(result.documents, undefined);
    assert.equal(result.messageHistory, undefined);
  });

  test('include=financials loads invoices without profile fields', async () => {
    const result = await ownerService.getOwnerById(OWNER_ID, { include: 'financials' });

    assert.equal(result._id, OWNER_ID);
    assert.equal(result.firstName, undefined);
    assert.ok(result.invoices);
    assert.ok(result.paymentSummary);
    assert.ok(result.ownerRecord);
    assert.equal(invoiceAggregateMock.mock.callCount(), 1);
    assert.equal(documentsFetchMock.mock.callCount(), 0);
    assert.equal(messagesFindRecentMock.mock.callCount(), 0);
  });

  test('include=documents loads linked documents only', async () => {
    const result = await ownerService.getOwnerById(OWNER_ID, { include: 'documents' });

    assert.deepEqual(result.documents, [{ id: 'doc-1', name: 'HOA Policy' }]);
    assert.equal(documentsFetchMock.mock.callCount(), 1);
    assert.equal(invoiceFindMock.mock.callCount(), 0);
    assert.equal(messagesFindRecentMock.mock.callCount(), 0);
  });

  test('include=documents uses homeowner role and viewer from hoaContext', async () => {
    await ownerService.getOwnerById(OWNER_ID, {
      include: 'documents',
      hoaContext: {
        hoaId: '507f1f77bcf86cd799439099',
        userId: OWNER_ID,
        isHOAOwner: true,
      },
    });

    assert.equal(documentsFetchMock.mock.callCount(), 1);
    const [, opts] = documentsFetchMock.mock.calls[0].arguments;
    assert.equal(opts.role, 'HOA Owner');
    assert.equal(String(opts.viewer.userId), OWNER_ID);
  });

  test('include=documents uses board role and viewer from hoaContext', async () => {
    const boardId = '507f1f77bcf86cd799439088';
    await ownerService.getOwnerById(OWNER_ID, {
      include: 'documents',
      hoaContext: {
        hoaId: '507f1f77bcf86cd799439099',
        userId: boardId,
        isHOABoardMember: true,
      },
    });

    assert.equal(documentsFetchMock.mock.callCount(), 1);
    const [, opts] = documentsFetchMock.mock.calls[0].arguments;
    assert.equal(opts.role, 'HOA Board Member');
    assert.equal(String(opts.viewer.userId), boardId);
  });

  test('include=messages loads message history only', async () => {
    messagesFindRecentMock.mock.mockImplementation(async () => ([
      {
        senderId: 'admin-id',
        receiverId: OWNER_ID,
        content: 'Welcome',
        createdAt: new Date('2026-02-01'),
      },
    ]));

    const result = await ownerService.getOwnerById(OWNER_ID, { include: 'messages' });

    assert.equal(result.messageHistory.length, 1);
    assert.equal(result.messageHistory[0].subject, 'Welcome');
    assert.equal(messagesFindRecentMock.mock.callCount(), 1);
    assert.equal(messagesFormatHistoryMock.mock.callCount(), 1);
    assert.equal(invoiceFindMock.mock.callCount(), 0);
    assert.equal(documentsFetchMock.mock.callCount(), 0);
  });

  test('default include loads all sections', async () => {
    messagesFindRecentMock.mock.mockImplementation(async () => []);

    const result = await ownerService.getOwnerById(OWNER_ID);

    assert.equal(result.firstName, 'Jane');
    assert.ok(result.invoices);
    assert.ok(result.documents);
    assert.ok(result.messageHistory);
    assert.equal(invoiceAggregateMock.mock.callCount(), 1);
    assert.equal(documentsFetchMock.mock.callCount(), 1);
    assert.equal(messagesFindRecentMock.mock.callCount(), 1);
  });
});
