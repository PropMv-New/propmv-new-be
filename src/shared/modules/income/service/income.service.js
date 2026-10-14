/**
 * ------------------------------------------------------------------
 * File: income.service.js
 * Module: Income Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * income.controller
 * ------------------------------------------------------------------
 */

const Income = require('../model/income.model');
const Invoice = require('../../../../portals/landlord/modules/invoice/model/invoice.model');
const Property = require('../../../../portals/landlord/modules/property/model/property.model');
const User = require('../../users/models/user.model');
const Lease = require('../../../../portals/landlord/modules/leasing/model/lease.model');
const mongoose = require('mongoose');
const emailHelper = require('../../../../common/helpers/emailHelper');
const logger = require('../../../../common/logger');
const { getPagination } = require('../../../../common/helpers/paginationHelper');
const {
  findPropertyIdsByCreatedBy,
  requireCreatedBy,
  resolveCreatedBy,
} = require('../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../common/date');
const { formatMonthYearInAppTimezone, formatDateInAppTimezone } = require('../../../../common/helpers/hoaBillingDates');
const { buildInvoiceEmailPreheader } = require('../../../../common/helpers/emailDisplayHelper');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function toObjectIds(arr) {
  return (Array.isArray(arr) ? arr : []).map(toObjectId).filter(Boolean);
}

/**
 * NotFoundError
 *
 * Represents the Not Found Error controller/model class.
 */
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * Send invoice email to all tenants for a given invoice document
 * Uses the `invoice-template.html` template
 * @param {Object} invoice - saved invoice document
 */
const sendInvoiceEmails = async (invoice) => {
  try {
    if (!invoice) return;

    // fetch related data for template
    const safePropId = toObjectId(invoice.propertyId);
    const safeLeaseId = toObjectId(invoice.lease_id);
    const safeTenantIds = toObjectIds(invoice.tenants);

    const property = safePropId ? await Property.findOne({ _id: safePropId, isDeleted: { $ne: true } }).lean() : null;
    const lease = safeLeaseId ? await Lease.findOne({ _id: safeLeaseId, isDeleted: { $ne: true } }) : null;

    // fetch tenant user records
    const tenants = safeTenantIds.length > 0
      ? await User.find({ _id: { $in: safeTenantIds }, isDeleted: { $ne: true } }).select('email firstName lastName').lean()
      : [];

    const landlordName = property ? String(resolveCreatedBy(property) || '') : '';

    // Build invoice line items for template
    const invoiceLines = (invoice.invoiceItemDetails || []).map(item => ({
      description: item.description || item.invoiceItem || '',
      period: item.period || (invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : ''),
      amount: typeof item.amount === 'number' ? `$${item.amount.toFixed(2)}` : String(item.amount || '')
    }));

    // Basic formatted values
    const amountDue = typeof invoice.balanceDue === 'number' ? `$${invoice.balanceDue.toFixed(2)}` : String(invoice.balanceDue || '');
    const subTotal = typeof invoice.subAmount === 'number' ? `$${invoice.subAmount.toFixed(2)}` : String(invoice.subAmount || '');
    const adjustments = typeof (invoice.subAmount - invoice.balanceDue) === 'number' ? `$${(invoice.subAmount - invoice.balanceDue).toFixed(2)}` : '';
    const dueDate = invoice.dueDate ? formatDateInAppTimezone(invoice.dueDate) : '';

    // Build invoice URL - fallback to FRONTEND_BASE_URL if not provided
    const invoiceBase = process.env.INVOICE_BASE_URL || process.env.FRONTEND_BASE_URL || 'https://app.example.com';
    const invoiceUrl = `${String(invoiceBase).replace(/\/\/$/, '')}/invoices/${invoice._id}`;

    for (const t of tenants) {
      const payerName = `${t.firstName || ''} ${t.lastName || ''}`.trim() || 'Member';
      const data = {
        invoiceNumber: String(invoice._id),
        billingPeriod: invoice.dueDate ? formatMonthYearInAppTimezone(invoice.dueDate) : '',
        amountDue,
        dueDate,
        invoiceUrl,
        payerName,
        tenantName: payerName,
        tenantEmail: t.email,
        propertyAddress: property ? (property.address || property.name || '') : '',
        leaseId: invoice.lease_id ? String(invoice.lease_id) : '',
        leaseStart: lease ? (lease.start_date ? formatDateInAppTimezone(lease.start_date) : '') : '',
        leaseEnd: lease ? (lease.end_date ? formatDateInAppTimezone(lease.end_date) : '') : '',
        billedByName: landlordName,
        landlordName: landlordName,
        invoiceLines,
        subTotal,
        adjustments
      };

      try {
        await emailHelper.sendEmail('invoice', t.email, data, {
          template: 'invoice-template',
          subject: `Invoice #${invoice.invoiceId || 'pending'}`,
          preheaderText: buildInvoiceEmailPreheader({
            invoiceNumber: invoice.invoiceId || 'Pending Invoice',
            outstandingBalance: amountDue,
            dueDate,
          }),
        });
        console.log(`Invoice email sent successfully to ${t.email} for invoice ${invoice._id}`);
        logger.info(`Invoice email sent successfully to ${t.email} for invoice ${invoice._id}`);
      } catch (mailErr) {
        logger.error(`Failed to send invoice email to ${t.email} for invoice ${invoice._id}:`, mailErr.message);
      }
    }
  } catch (err) {
    logger.error('Failed to prepare/send invoice emails:', err);
  }
};

/**
 * Create a new income record and automatically generate invoice with email
 * @param {Object} data - Income data
 * @param {String} userId - User ID creating the income
 * @returns {Object} - Created income with invoice
 */
const createIncome = async (data, userId) => {
  if (userId) data.createdBy = userId;

  // Validate property exists
  if (data.propertyId) {
    const safePropId = toObjectId(data.propertyId);
    if (!safePropId) throw new Error('Invalid property ID');
    const property = await Property.findOne({ _id: safePropId, isDeleted: { $ne: true } }).lean();
    if (!property) throw new Error('Property not found');
    data.propertyId = safePropId;
  }

  // Validate tenants exist
  if (data.tenants && data.tenants.length > 0) {
    const safeTenantIds = toObjectIds(data.tenants);
    if (safeTenantIds.length !== data.tenants.length) throw new Error('One or more tenant IDs are invalid');
    const tenants = await User.find({ _id: { $in: safeTenantIds }, isDeleted: { $ne: true } }).lean();
    if (tenants.length !== safeTenantIds.length) throw new Error('One or more tenants not found');
    data.tenants = safeTenantIds;
  }

  // Try to find active lease for this property/unit and tenants
  let leaseId = null;
  try {
    const activeLease = await Lease.findOne({
      property_id: data.propertyId,
      unitName: data.unit,
      status: { $in: ['Active', 'active'] },
      isDeleted: { $ne: true }
    }).select('_id').lean();
    if (activeLease) {
      leaseId = activeLease._id;
    }
  } catch (leaseErr) {
    logger.info('Could not find active lease for income, continuing without lease link:', leaseErr.message);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Create income record
    const income = new Income(data);
    await income.validate();
    const savedIncome = await income.save({ session });

    // Create corresponding invoice
    const invoiceData = {
      type: data.type,
      propertyId: data.propertyId,
      unit: data.unit,
      term: 'N/A',
      tenants: data.tenants,
      lease_id: leaseId, // Link to lease if found
      invoiceItemDetails: [{
        invoiceItem: data.type,
        description: data.description,
        quantity: 1,
        rate: data.amount,
        amount: data.amount
      }],
      subAmount: data.amount,
      alreadyPaid: 0,
      balanceDue: data.amount,
      isPartialPaymentAllowed: true,
      dueDate: data.dueDate,
      createdBy: userId
    };

    const invoice = new Invoice(invoiceData);
    await invoice.validate();
    const savedInvoice = await invoice.save({ session });

    // Link invoice to income
    savedIncome.invoiceId = savedInvoice._id;
    await savedIncome.save({ session });

    await session.commitTransaction();
    session.endSession();

    logger.info(`Income created successfully: ${savedIncome.incomeId}, Invoice: ${savedInvoice.invoiceId}`);

    // Send invoice emails after successful transaction
    // This runs asynchronously and won't block the response
    sendInvoiceEmails(savedInvoice).catch(emailErr => {
      logger.error(`Failed to send invoice emails for invoice ${savedInvoice.invoiceId}:`, emailErr.message);
    });

    return { income: savedIncome, invoice: savedInvoice };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
};

/**
 * Get income records with filters and pagination
 * @param {Object} query - Query parameters
 * @returns {Object} - { data: [], meta: { total, page, pageSize } }
 */
const getIncomes = async (query) => {
  const { propertyId, unit, tenantId, type, status, startDate, endDate, pageNumber, pageSize, minAmount, maxAmount } = query;
  const createdBy = resolveCreatedBy(query);
  
  const filter = { isDeleted: { $ne: true } };
  
  let scopedPropertyIds = [];
  if (createdBy) {
    const ownerId = requireCreatedBy({ createdBy });
    scopedPropertyIds = await findPropertyIdsByCreatedBy(Property, ownerId);
    if (!scopedPropertyIds.length) {
      const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
      const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
      return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize } };
    }
  }

  // Property and owner filtering
  if (propertyId) {
    if (scopedPropertyIds.length > 0 && !scopedPropertyIds.some((id) => String(id) === String(propertyId))) {
        const respPage = pageNumber ? parseInt(pageNumber, 10) : 1;
        const respPageSize = pageSize ? parseInt(pageSize, 10) : 0;
        return { data: [], meta: { total: 0, page: respPage, pageSize: respPageSize } };
    }
    filter.propertyId = propertyId;
  } else if (scopedPropertyIds.length > 0) {
    filter.propertyId = { $in: scopedPropertyIds };
  }
  
  // Additional filters
  if (unit) filter.unit = unit;
  if (tenantId) filter.tenants = tenantId;
  if (type) filter.type = type;
  if (status) filter.status = status;
  
  // Amount range filter
  if (minAmount !== undefined || maxAmount !== undefined) {
    filter.amount = {};
    if (minAmount !== undefined) filter.amount.$gte = minAmount;
    if (maxAmount !== undefined) filter.amount.$lte = maxAmount;
  }
  
  // Date range filter
  if (startDate && endDate) {
    const start = DateUtil.startOfDayEST(startDate) || DateUtil.toUTC(startDate);
    const end = DateUtil.endOfDayEST(endDate) || DateUtil.toUTC(endDate);
    if (!start || !end) {
      throw new Error('Invalid date format for startDate or endDate');
    }
    filter.dueDate = { $gte: start, $lte: end };
  }

  const { offset, limit, page } = getPagination({ page: pageNumber, pageSize });

  const [incomes, total] = await Promise.all([
    Income.find(filter)
      .populate('propertyId', 'name address')
      .populate('tenants', 'firstName lastName email')
      .populate('invoiceId')
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit || 0),
    Income.countDocuments(filter)
  ]);

  return { data: incomes, meta: { total, page, pageSize: limit } };
};

/**
 * Get income by ID
 * @param {String} id - Income ID
 * @returns {Object} - Income document
 */
const getIncomeById = async (id) => {
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Income not found');
  const income = await Income.findOne({ _id: safeId, isDeleted: { $ne: true } })
    .populate('propertyId')
    .populate('tenants', 'firstName lastName email phone address')
    .populate('invoiceId');
  if (!income) throw new NotFoundError('Income not found');
  return income;
};

/**
 * Update an existing income record
 * @param {String} id - Income ID
 * @param {Object} updates - Fields to update
 * @param {String} userId - User ID performing the update
 * @returns {Object} - Updated income
 */
const updateIncome = async (id, updates, userId) => {
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Income not found');
  const income = await Income.findOne({ _id: safeId, isDeleted: { $ne: true } });
  if (!income) throw new NotFoundError('Income not found');

  if (userId) updates.updatedBy = userId;

  Object.assign(income, updates);
  await income.validate();
  const saved = await income.save();
  return saved;
};

/**
 * Soft delete an income record
 * @param {String} id - Income ID
 * @returns {Object} - Soft deleted income
 */
const deleteIncome = async (id) => {
  const safeId = toObjectId(id);
  if (!safeId) throw new NotFoundError('Income not found');
  const income = await Income.findOneAndUpdate(
    { _id: safeId, isDeleted: { $ne: true } },
    { isDeleted: true },
    { new: true }
  );
  if (!income) throw new NotFoundError('Income not found');
  return income;
};

module.exports = {
  createIncome,
  getIncomes,
  getIncomeById,
  updateIncome,
  deleteIncome
};
