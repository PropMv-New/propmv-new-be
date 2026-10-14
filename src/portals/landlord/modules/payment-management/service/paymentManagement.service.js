/**
 * ------------------------------------------------------------------
 * File: paymentManagement.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * paymentManagement.controller
 * ------------------------------------------------------------------
 */

const Property = require('../../property/model/property.model');
const Invoice = require('../../invoice/model/invoice.model');
const Lease = require('../../leasing/model/lease.model');
const { LandlordPayment, PropertyPaymentSettings } = require('../model/paymentManagement.model');
const { resolveCreatorScope, buildPropertyOwnerFilterWithScope } = require('../../../../../shared/utils/creatorScope.util');
const { ClockService, DateUtil } = require('../../../../../common/date');

/**
 * Get payment management data for all properties
 * @param {Object} query - Query parameters
 * @returns {Object} Payment management data with pagination
 */
const getPaymentManagementService = async (query) => {
  const {
    pageNumber = 1,
    pagesize = 10,
    search,
    createdBy,
    isAdministrator = false,
    companyId = null,
  } = query;

  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const page = parseInt(pageNumber, 10);
  const limit = parseInt(pagesize, 10);
  const skip = (page - 1) * limit;

  // Resolve creator scope - get all company user IDs if Administrator
  const creatorCandidates = await resolveCreatorScope(createdBy, isAdministrator, companyId);

  // Build search filter with Administrator support
  const ownerFilter = buildPropertyOwnerFilterWithScope(creatorCandidates);
  const filter = { ...ownerFilter };
  
  if (search) {
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { 'address.street': { $regex: search, $options: 'i' } },
        { ownerName: { $regex: search, $options: 'i' } },
      ],
    });
  }

  // Get total count
  const total = await Property.countDocuments(filter);

  // Get properties with populated data
  const properties = await Property.find(filter)
    .select('name ownerName ownerEmail ownerPhone unitDetails address createdBy')
    .skip(skip)
    .limit(limit)
    .lean();

  // Process each property to calculate payment details
  const paymentData = await Promise.all(
    properties.map(async (property) => {
      const propertyId = property._id.toString();

      // Calculate monthly rent from all units
      const units = property.unitDetails || [];
      const monthlyRent = units.reduce((sum, unit) => {
        const rent = parseFloat(unit.rent) || 0;
        return sum + rent;
      }, 0);

      // Get active leases for this property
      const activeLeases = await Lease.find({
        property: propertyId,
        status: { $in: ['active', 'Active', 'ACTIVE'] },
      })
        .select('_id')
        .lean();

      const leaseIds = activeLeases.map((lease) => lease._id);

      // Calculate invoice-based data
      let additionalFees = 0;
      let rentCollected = 0;

      // Build invoice query to get both lease-based and property-based invoices
      const invoiceQuery = {
        $or: [
          { propertyId: propertyId },
        ],
        isDeleted: { $ne: true }
      };

      // Add lease-based invoices to query if leases exist
      if (leaseIds.length > 0) {
        invoiceQuery.$or.push({ lease_id: { $in: leaseIds } });
      }

      // Get all invoices for this property (not limited to current month)
      const invoices = await Invoice.find(invoiceQuery)
        .select('invoiceItemDetails alreadyPaid balanceDue subAmount type')
        .lean();

      invoices.forEach((invoice) => {
        // Calculate additional fees and rent from invoice items
        const items = invoice.invoiceItemDetails || [];
        items.forEach((item) => {
          const itemName = (item.invoiceItem || '').toLowerCase();
          const amount = parseFloat(item.amount) || 0;
          
          if (itemName.includes('rent')) {
            // This is rent
          } else {
            // This is additional fee
            additionalFees += amount;
          }
        });

        // Calculate rent collected (already paid amount)
        rentCollected += parseFloat(invoice.alreadyPaid) || 0;
      });

      // Calculate total payment expected
      const totalPayment = monthlyRent + additionalFees;

      // Fetch payment settings for this property (latest) to compute deductions
      // We don't restrict by createdBy here so Administrator scope can pick up settings
      // Try to find a payment setting created by one of the resolved creators
      const paymentSetting = await PropertyPaymentSettings.findOne({ propertyId, createdBy: { $in: creatorCandidates }, isDeleted: { $ne: true } })
        .sort({ updatedAt: -1 })
        .lean();
      const percentageCut = parseFloat(paymentSetting?.percentageCut) || 0;

  // Compute totals: apply percentage cut on the Total Payment Collected (rentCollected)
  // NOTE: Per product requirement, deductions should be computed from the amount actually
  // collected (rentCollected) rather than the expected totalPayment. If rentCollected is
  // zero or missing, fall back to totalPayment as a defensive measure.
  const deductionBase = parseFloat(rentCollected?.toFixed?.(2) || 0) || parseFloat((totalPayment || 0).toFixed(2));
  const totalDeductions = parseFloat(((percentageCut / 100) * deductionBase).toFixed(2));
  const totalPaymentAfterDeduction = parseFloat((deductionBase - totalDeductions).toFixed(2));

      // Get total paid to landlord from landlord_payments collection
      // For Administrator, query across all company users
      const paymentQuery = {
        propertyId: propertyId,
        createdBy: { $in: creatorCandidates },
        isDeleted: { $ne: true }
      };

      const landlordPayments = await LandlordPayment.find(paymentQuery)
        .select('amount')
        .lean();

      const paidToLandlord = landlordPayments.reduce((sum, payment) => {
        return sum + (parseFloat(payment.amount) || 0);
      }, 0);

      // Calculate pending = rent collected - paid to landlord
      const pendingToPayLandlord = rentCollected - paidToLandlord;

      return {
        propertyId: propertyId,
        propertyName: property.name || 'Unnamed Property',
        landlordName: property.ownerName || null,
        landlordEmail: property.ownerEmail || null,
        landlordPhone: property.ownerPhone || null,
        monthlyRent: parseFloat(monthlyRent.toFixed(2)),
        additionalFees: parseFloat(additionalFees.toFixed(2)),
        totalPayment: parseFloat(totalPayment.toFixed(2)),
        // New fields: deductions applied to collected amount and net after deduction
        totalDeductions: parseFloat(totalDeductions.toFixed(2)),
        totalPaymentAfterDeduction: parseFloat(totalPaymentAfterDeduction.toFixed(2)),
        rentCollected: parseFloat(rentCollected.toFixed(2)),
        paidToLandlord: parseFloat(paidToLandlord.toFixed(2)),
        pendingToPayLandlord: parseFloat(pendingToPayLandlord.toFixed(2)),
        address: property.address || {},
      };
    })
  );

  return {
    statuscode: 200,
    message: 'Payment management data retrieved successfully',
    data: {
      paymentData,
      total,
      pageNumber: page,
      pagesize: limit,
      totalPages: Math.ceil(total / limit),
    },
  };
};

/**
 * Get payment summary/overview
 * @param {String} createdBy - User ID
 * @returns {Object} Payment summary
 */
const getPaymentSummaryService = async (createdBy) => {
  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const properties = await Property.find({ createdBy })
    .select('unitDetails')
    .lean();

  let totalMonthlyRent = 0;
  let totalProperties = properties.length;

  properties.forEach((property) => {
    const units = property.unitDetails || [];
    units.forEach((unit) => {
      totalMonthlyRent += parseFloat(unit.rent) || 0;
    });
  });

  // Get all active leases
  const propertyIds = properties.map((p) => p._id);
  const activeLeases = await Lease.find({
    property: { $in: propertyIds },
    status: { $in: ['active', 'Active', 'ACTIVE'] },
  })
    .select('_id')
    .lean();

  const leaseIds = activeLeases.map((lease) => lease._id);

  let totalRentCollected = 0;
  let totalPending = 0;

  // Build invoice query
  const invoiceQuery = {
    $or: [
      { propertyId: { $in: propertyIds } },
    ],
    isDeleted: { $ne: true }
  };

  if (leaseIds.length > 0) {
    invoiceQuery.$or.push({ lease_id: { $in: leaseIds } });
  }

  const invoices = await Invoice.find(invoiceQuery)
    .select('alreadyPaid subAmount')
    .lean();

  invoices.forEach((invoice) => {
    totalRentCollected += parseFloat(invoice.alreadyPaid) || 0;
    const due = parseFloat(invoice.subAmount) || 0;
    const paid = parseFloat(invoice.alreadyPaid) || 0;
    totalPending += Math.max(0, due - paid);
  });

  return {
    statuscode: 200,
    message: 'Payment summary retrieved successfully',
    data: {
      totalProperties,
      totalMonthlyRent: parseFloat(totalMonthlyRent.toFixed(2)),
      totalRentCollected: parseFloat(totalRentCollected.toFixed(2)),
      totalPending: parseFloat(totalPending.toFixed(2)),
      collectionRate: totalMonthlyRent > 0 
        ? parseFloat(((totalRentCollected / totalMonthlyRent) * 100).toFixed(2))
        : 0,
    },
  };
};

/**
 * Assign or update landlord for a property
 * @param {String} propertyId - Property ID
 * @param {Object} landlordData - Landlord information
 * @param {String} createdBy - User ID
 * @returns {Object} Updated property
 */
const assignLandlordService = async (propertyId, landlordData, createdBy) => {
  if (!propertyId) {
    throw new Error('propertyId is required');
  }
  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const { landlordName, landlordEmail, landlordPhone } = landlordData;

  if (!landlordName) {
    throw new Error('landlordName is required');
  }

  const property = await Property.findOne({ _id: propertyId, createdBy });
  if (!property) {
    throw new Error('Property not found or access denied');
  }

  // Update landlord information
  property.ownerName = landlordName;
  if (landlordEmail) property.ownerEmail = landlordEmail;
  if (landlordPhone) property.ownerPhone = landlordPhone;

  await property.save();

  return {
    statuscode: 200,
    message: 'Landlord assigned successfully',
    data: {
      propertyId: property._id,
      propertyName: property.name,
      landlordName: property.ownerName,
      landlordEmail: property.ownerEmail,
      landlordPhone: property.ownerPhone,
    },
  };
};

/**
 * Get payment management detail for a specific property
 * @param {String} propertyId - Property ID
 * @param {String} createdBy - User ID
 * @returns {Object} Payment management detail
 */
const getPaymentManagementDetailService = async (propertyId, createdBy) => {
  if (!propertyId) {
    throw new Error('propertyId is required');
  }
  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const property = await Property.findOne({ _id: propertyId, createdBy })
    .select('name ownerName ownerEmail ownerPhone unitDetails address createdBy')
    .lean();

  if (!property) {
    throw new Error('Property not found or access denied');
  }

  // Calculate monthly rent from all units
  const units = property.unitDetails || [];
  const monthlyRent = units.reduce((sum, unit) => {
    const rent = parseFloat(unit.rent) || 0;
    return sum + rent;
  }, 0);

  // Get active leases for this property
  const activeLeases = await Lease.find({
    property: propertyId,
    status: { $in: ['active', 'Active', 'ACTIVE'] },
  })
    .select('_id')
    .lean();

  const leaseIds = activeLeases.map((lease) => lease._id);

  // Calculate invoice-based data
  let additionalFees = 0;
  let rentCollected = 0;

  // Build invoice query
  const invoiceQuery = {
    $or: [
      { propertyId: propertyId },
    ],
    isDeleted: { $ne: true }
  };

  if (leaseIds.length > 0) {
    invoiceQuery.$or.push({ lease_id: { $in: leaseIds } });
  }

  // Get all invoices for this property
  const invoices = await Invoice.find(invoiceQuery)
    .select('invoiceItemDetails alreadyPaid balanceDue subAmount type')
    .lean();

  invoices.forEach((invoice) => {
    // Calculate additional fees from invoice items
    const items = invoice.invoiceItemDetails || [];
    items.forEach((item) => {
      const itemName = (item.invoiceItem || '').toLowerCase();
      const amount = parseFloat(item.amount) || 0;
      
      if (!itemName.includes('rent')) {
        additionalFees += amount;
      }
    });

    // Calculate rent collected (already paid amount)
    rentCollected += parseFloat(invoice.alreadyPaid) || 0;
  });

  // Calculate total payment expected
  const totalPayment = monthlyRent + additionalFees;

  // Get total paid to landlord from landlord_payments collection
  const landlordPayments = await LandlordPayment.find({
    propertyId: propertyId,
    createdBy: createdBy,
    isDeleted: { $ne: true }
  })
    .select('amount')
    .lean();

  const paidToLandlord = landlordPayments.reduce((sum, payment) => {
    return sum + (parseFloat(payment.amount) || 0);
  }, 0);

  // Calculate pending = rent collected - paid to landlord
  const pendingToPayLandlord = rentCollected - paidToLandlord;

  // Fetch payment settings for this property (latest) to compute deductions
  const paymentSetting = await PropertyPaymentSettings.findOne({ propertyId, isDeleted: { $ne: true } })
    .sort({ updatedAt: -1 })
    .lean();
  const percentageCut = parseFloat(paymentSetting?.percentageCut) || 0;

  // Compute totals: apply percentage cut on the Total Payment Collected (rentCollected)
  // NOTE: Per product requirement, deductions should be computed from the amount actually
  // collected (rentCollected) rather than the expected totalPayment. If rentCollected is
  // zero or missing, fall back to totalPayment as a defensive measure.
  const deductionBase = parseFloat(rentCollected?.toFixed?.(2) || 0) || parseFloat((totalPayment || 0).toFixed(2));
  const totalDeductions = parseFloat(((percentageCut / 100) * deductionBase).toFixed(2));
  const totalPaymentAfterDeduction = parseFloat((deductionBase - totalDeductions).toFixed(2));

  return {
    statuscode: 200,
    message: 'Payment management detail retrieved successfully',
    data: {
      propertyId: property._id.toString(),
      propertyName: property.name || 'Unnamed Property',
      landlordName: property.ownerName || null,
      landlordEmail: property.ownerEmail || null,
      landlordPhone: property.ownerPhone || null,
      monthlyRent: parseFloat(monthlyRent.toFixed(2)),
      additionalFees: parseFloat(additionalFees.toFixed(2)),
      totalPayment: parseFloat(totalPayment.toFixed(2)),
      // New fields
      totalDeductions: parseFloat(totalDeductions.toFixed(2)),
      totalPaymentAfterDeduction: parseFloat(totalPaymentAfterDeduction.toFixed(2)),
      rentCollected: parseFloat(rentCollected.toFixed(2)),
      paidToLandlord: parseFloat(paidToLandlord.toFixed(2)),
      pendingToPayLandlord: parseFloat(pendingToPayLandlord.toFixed(2)),
      address: property.address || {},
      units: units.length,
      occupancyRate: units.length > 0 ? 100 : 0,
    },
  };
};

/**
 * Record payment made to landlord
 * @param {String} propertyId - Property ID
 * @param {Object} paymentData - Payment details
 * @param {String} createdBy - User ID
 * @returns {Object} Created payment record
 */
const recordPaymentToLandlordService = async (propertyId, paymentData, createdBy) => {
  if (!propertyId) {
    throw new Error('propertyId is required');
  }
  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  const { amount, paymentDate, paymentType, referenceNumber, remark } = paymentData;

  if (!amount || amount <= 0) {
    throw new Error('Valid payment amount is required');
  }

  // Verify property exists and belongs to user
  const property = await Property.findOne({ _id: propertyId, createdBy });
  if (!property) {
    throw new Error('Property not found or access denied');
  }

  // Create payment record
  const payment = new LandlordPayment({
    propertyId,
    amount: parseFloat(amount),
    paymentDate: paymentDate ? (DateUtil.toUTC(paymentDate) || ClockService.now()) : ClockService.now(),
    paymentType: paymentType || 'Bank Transfer',
    referenceNumber: referenceNumber || '',
    remark: remark || '',
    createdBy,
  });

  await payment.save();

  return {
    statuscode: 201,
    message: 'Payment recorded successfully',
    data: {
      paymentId: payment._id,
      propertyId: payment.propertyId,
      amount: payment.amount,
      paymentDate: payment.paymentDate,
      paymentType: payment.paymentType,
      referenceNumber: payment.referenceNumber,
      remark: payment.remark,
    },
  };
};

/**
 * Get payment history for a property
 * @param {String} propertyId - Property ID
 * @param {String} createdBy - User ID
 * @returns {Object} Payment history
 */
const getPaymentHistoryForPropertyService = async (propertyId, createdBy) => {
  if (!propertyId) {
    throw new Error('propertyId is required');
  }
  if (!createdBy) {
    throw new Error('createdBy is required');
  }

  // Verify property exists and belongs to user
  const property = await Property.findOne({ _id: propertyId, createdBy })
    .select('name ownerName')
    .lean();

  if (!property) {
    throw new Error('Property not found or access denied');
  }

  // Get all payments for this property
  const payments = await LandlordPayment.find({
    propertyId,
    createdBy,
    isDeleted: { $ne: true },
  })
    .sort({ paymentDate: -1 })
    .lean();

  const totalPaid = payments.reduce((sum, payment) => {
    return sum + (parseFloat(payment.amount) || 0);
  }, 0);

  return {
    statuscode: 200,
    message: 'Payment history retrieved successfully',
    data: {
      propertyId: property._id.toString(),
      propertyName: property.name,
      landlordName: property.ownerName,
      totalPaid: parseFloat(totalPaid.toFixed(2)),
      paymentCount: payments.length,
      payments: payments.map((p) => ({
        paymentId: p._id,
        amount: p.amount,
        paymentDate: p.paymentDate,
        paymentType: p.paymentType,
        referenceNumber: p.referenceNumber,
        remark: p.remark,
        createdAt: p.createdAt,
      })),
    },
  };
};

/**
 * Get payment settings for all properties
 */
const getPaymentSettingsService = async (createdBy) => {
  if (!createdBy) throw new Error('createdBy is required');

  const settings = await PropertyPaymentSettings.find({ createdBy, isDeleted: { $ne: true } })
    .populate('propertyId', 'name address')
    .lean();

  return {
    statuscode: 200,
    message: 'Payment settings retrieved successfully',
    data: settings.map((s) => ({
      _id: s._id,
      propertyId: s.propertyId?._id || s.propertyId,
      propertyName: s.propertyId?.name || '',
      percentageCut: s.percentageCut,
      updatedAt: s.updatedAt,
    })),
  };
};

/**
 * Upsert payment settings for a property
 */
const upsertPaymentSettingsService = async (propertyId, percentageCut, createdBy) => {
  if (!propertyId) throw new Error('propertyId is required');
  if (percentageCut === undefined || percentageCut === null) throw new Error('percentageCut is required');
  if (!createdBy) throw new Error('createdBy is required');

  const property = await Property.findOne({ _id: propertyId, createdBy }).select('name').lean();
  if (!property) throw new Error('Property not found or access denied');

  const settings = await PropertyPaymentSettings.findOneAndUpdate(
    { propertyId, createdBy, isDeleted: { $ne: true } },
    { propertyId, percentageCut, createdBy, isDeleted: false },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    statuscode: 200,
    message: 'Payment settings saved successfully',
    data: {
      _id: settings._id,
      propertyId: settings.propertyId,
      propertyName: property.name,
      percentageCut: settings.percentageCut,
    },
  };
};

module.exports = {
  getPaymentManagementService,
  getPaymentSummaryService,
  assignLandlordService,
  getPaymentManagementDetailService,
  recordPaymentToLandlordService,
  getPaymentHistoryForPropertyService,
  getPaymentSettingsService,
  upsertPaymentSettingsService,
};
