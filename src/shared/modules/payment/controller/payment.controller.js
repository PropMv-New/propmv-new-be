/**
 * ------------------------------------------------------------------
 * File: payment.controller.js
 * Module: Payment Module
 *
 * Purpose:
 * Controller class/module handling HTTP requests, parameters validation, and returning JSON responses.
 *
 * Used By:
 * payments.route
 * ------------------------------------------------------------------
 */

const { StraddleService } = require('../service/straddle.service');
const { resolveEmbeddedAccount } = require('../service/resolveEmbeddedAccount');
const { resolveVendorPlatformAccount } = require('../service/resolveVendorPlatformAccount');
const PaymentCustomer = require('../model/paymentCustomer.model');
const PaymentBankAccount = require('../model/paymentBankAccount.model');
const StraddleTransaction = require('../model/straddleTransaction.model');
const User = require('../../users/models/user.model');
const logger = require('../../../../common/logger');
const { initiateInvoiceProcessingPayment } = require('../../../../portals/hoa-board/modules/invoice/helpers/invoiceProcessingPayment.helper');
const ledgerService = require('../../../../portals/hoa-board/modules/owners/services/ledger.service');
const Invoice = require('../../../../portals/hoa-board/modules/invoice/model/invoice.model');
const { ClockService, DateUtil } = require('../../../../common/date');
const paymentVerifyService = require('../service/paymentVerify.service');
const { logControllerStep, handleControllerError } = require('../../../../common/helpers/controllerLogger');
const { OtpResendLimitedError } = require('../../../../services/otpResendLimiter.service');

const straddle = new StraddleService();

async function tryGateway(fn) {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: err?.message || err?.data?.error?.detail || 'Gateway error'
    };
  }
}

/**
 * Parse a Straddle API error into a user-friendly message + HTTP status.
 * Straddle error envelope: { data: { error: { message, code, details } } }
 */
function parseStraddleError(err) {
  const status = err?.response?.status ?? err?.status ?? 500;
  const body = err?.response?.data ?? err?.data ?? {};
  const straddleErr = body?.data?.error ?? body?.error ?? {};
  const detail = straddleErr?.message || straddleErr?.detail || body?.message;

  const statusMessages = {
    400: detail || 'The request contained invalid data. Please check your inputs.',
    401: 'Authentication failed. Please log out and log back in.',
    403: detail || 'You do not have permission to perform this action.',
    404: 'The requested resource was not found.',
    409: detail || 'A customer with this information already exists.',
    422: detail || 'The provided data failed validation. Please review your inputs.',
    429: 'Too many requests. Please wait a moment and try again.',
    500: 'Straddle service is temporarily unavailable. Please try again later.',
    503: 'Straddle service is temporarily unavailable. Please try again later.'
  };

  return {
    status,
    message: statusMessages[status] || detail || 'An unexpected error occurred. Please try again.'
  };
}

/** Normalize phone to E.164 for Straddle customer create. */
function normalizePhoneE164(phone) {
  if (!phone) return undefined;
  const trimmed = String(phone).trim();
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return undefined;
}

function applyStraddleCustomerFields(customer, straddleData) {
  if (!straddleData) return;
  customer.status = straddleData.status || customer.status;
  customer.statusDetail = straddleData.status_details || straddleData.status_detail || customer.statusDetail;
  if (straddleData.verification_status) {
    customer.verificationStatus = straddleData.verification_status;
  }
  customer.straddle = {
    success: true,
    gatewayId: straddleData.id || customer.straddle?.gatewayId,
    status: straddleData.status,
    raw: straddleData,
  };
  const st = String(straddleData.status || '').toLowerCase();
  customer.straddleReady = ['verified', 'active'].includes(st) || !!customer.straddleReady;
}

async function resolveScopeFromBody(req) {
  const { hoaId, entityId, entityType, straddleAccountId } = req.body || {};
  return resolveEmbeddedAccount({
    hoaId: hoaId || req.query?.hoaId || null,
    entityId: entityId || null,
    entityType: entityType || (hoaId ? 'hoa' : null),
    straddleAccountId: straddleAccountId || null,
    companyId: req.user?.companyId || null,
  });
}

async function resolveScopeFromCustomer(customer, req) {
  if (customer.straddleAccountId) {
    return { straddleAccountId: customer.straddleAccountId, account: null };
  }
  return resolveEmbeddedAccount({
    hoaId: req.body?.hoaId || req.query?.hoaId || null,
    entityId: customer.entityId || req.body?.entityId || null,
    entityType: customer.entityType || req.body?.entityType || null,
    companyId: req.user?.companyId || null,
  });
}

async function applyCustomerStatusFromWebhook(straddleCustomerId, data) {
  if (!straddleCustomerId && !data?.id) return null;
  const id = straddleCustomerId || data.id;
  const customer = await PaymentCustomer.findOne({
    'straddle.gatewayId': id,
    isDeleted: { $ne: true },
  });
  if (!customer) {
    logger.warn('[Payment] webhook: no local customer for', { straddleCustomerId: id });
    return null;
  }
  applyStraddleCustomerFields(customer, data || {});
  customer.lastWebhookAt = ClockService.now();
  await customer.save();
  return customer;
}


// ── Customers ─────────────────────────────────────────────────────────────────

const createCustomer = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createCustomer' });
  try {
    const {
      name, email, phone, type = 'individual', metadata = {},
      dob, ssn, address, ipAddress,
      ein, legalBusinessName, website,
      hoaId, entityId, entityType,
    } = req.body;

    const resolvedIp = ipAddress
      || req.ip
      || req.headers['x-forwarded-for']?.split(',')[0].trim()
      || '127.0.0.1';

    let scope;
    try {
      scope = await resolveScopeFromBody(req);
    } catch (scopeErr) {
      return res.status(scopeErr.statusCode || 400).json({
        success: false,
        message: scopeErr.message,
      });
    }

    const { account, straddleAccountId } = scope;
    const externalId = `${req.user._id}:${straddleAccountId}`;

    const existing = await PaymentCustomer.findOne({
      createdBy: req.user._id,
      straddleAccountId,
      isDeleted: { $ne: true },
      'straddle.success': true,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'A payment profile already exists for this account. Edit or sync the existing customer.',
        data: existing,
      });
    }

    logger.info('[Payment] createCustomer started', {
      userId: req.user._id, type, externalId, straddleAccountId,
      hoaId: hoaId || entityId || null,
    });

    let straddleResult;
    try {
      const straddleData = await straddle.createCustomer({
        name, email, phone, type, ipAddress: resolvedIp, externalId, metadata,
        dob, ssn, address, ein, legalBusinessName, website,
      }, straddleAccountId);
      straddleResult = { success: true, data: straddleData };
    } catch (straddleErr) {
      const parsed = parseStraddleError(straddleErr);
      logger.error('[Payment] createCustomer Straddle error', {
        userId: req.user._id, status: parsed.status, message: parsed.message,
        raw: straddleErr?.response?.data,
      });
      if (parsed.status === 409) {
        return res.status(409).json({
          success: false,
          message: 'A payment profile already exists for this Straddle account.',
        });
      }
      if (parsed.status >= 400 && parsed.status < 500) {
        return res.status(parsed.status).json({ success: false, message: parsed.message });
      }
      return res.status(502).json({ success: false, message: parsed.message });
    }

    if (!straddleResult.data?.id) {
      return res.status(502).json({ success: false, message: 'Straddle did not return a customer id.' });
    }

    const customerDoc = {
      name, email, phone, type,
      externalId,
      ipAddress: resolvedIp,
      metadata,
      straddleAccountId,
      straddleAccountRef: account._id,
      entityType: account.entityType || entityType || (hoaId ? 'hoa' : null),
      entityId: account.entityId || entityId || hoaId || null,
      status: straddleResult.data.status || null,
      straddle: {
        success: true,
        gatewayId: straddleResult.data.id,
        status: straddleResult.data.status,
        raw: straddleResult.data,
      },
      straddleReady: ['verified', 'active'].includes(String(straddleResult.data.status || '').toLowerCase()),
      createdBy: req.user._id,
    };
    if (dob) customerDoc.dob = dob;
    if (ssn) customerDoc.ssn = ssn;
    if (address) customerDoc.address = address;
    if (ein) customerDoc.ein = ein;
    if (legalBusinessName) customerDoc.legalBusinessName = legalBusinessName;
    if (website) customerDoc.website = website;

    const customer = await PaymentCustomer.create(customerDoc);
    logger.info('[Payment] createCustomer completed', {
      userId: req.user._id, customerId: customer._id, straddleAccountId,
    });
    res.status(201).json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
};

const updateCustomer = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'updateCustomer' });
  try {
    const customer = await PaymentCustomer.findOne({
      _id: req.params.id, createdBy: req.user._id, isDeleted: { $ne: true },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const {
      name, email, phone, dob, ssn, address,
      ein, legalBusinessName, website, metadata,
    } = req.body;

    let straddleAccountId;
    try {
      ({ straddleAccountId } = await resolveScopeFromCustomer(customer, req));
    } catch (scopeErr) {
      return res.status(scopeErr.statusCode || 400).json({ success: false, message: scopeErr.message });
    }

    if (customer.straddle?.gatewayId) {
      try {
        const straddleData = await straddle.updateCustomer(
          customer.straddle.gatewayId, req.body, straddleAccountId
        );
        applyStraddleCustomerFields(customer, straddleData);
        customer.lastSyncedAt = ClockService.now();
      } catch (straddleErr) {
        const parsed = parseStraddleError(straddleErr);
        const responseStatus = parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502;
        return res.status(responseStatus).json({ success: false, message: parsed.message });
      }
    }

    if (name) customer.name = name;
    if (email) customer.email = email;
    if (phone) customer.phone = phone;
    if (dob) customer.dob = dob;
    if (ssn) customer.ssn = ssn;
    if (address) customer.address = address;
    if (ein) customer.ein = ein;
    if (legalBusinessName) customer.legalBusinessName = legalBusinessName;
    if (website) customer.website = website;
    if (metadata) customer.metadata = { ...customer.metadata, ...metadata };
    customer.updatedBy = req.user._id;
    await customer.save();
    res.json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
};

const syncCustomer = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'syncCustomer' });
  try {
    const customer = await PaymentCustomer.findOne({
      _id: req.params.id, createdBy: req.user._id, isDeleted: { $ne: true },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    if (!customer.straddle?.gatewayId) {
      return res.status(400).json({ success: false, message: 'Customer is not registered with Straddle' });
    }
    const { straddleAccountId } = await resolveScopeFromCustomer(customer, req);
    const straddleData = await straddle.getCustomer(customer.straddle.gatewayId, straddleAccountId);
    applyStraddleCustomerFields(customer, straddleData);
    customer.lastSyncedAt = ClockService.now();
    customer.updatedBy = req.user._id;
    await customer.save();
    res.json({ success: true, data: customer, message: 'Customer synced' });
  } catch (err) {
    const parsed = parseStraddleError(err);
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    if (parsed.status >= 400) {
      return res.status(parsed.status >= 500 ? 502 : parsed.status).json({ success: false, message: parsed.message });
    }
    next(err);
  }
};

const deleteCustomer = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteCustomer' });
  try {
    const customer = await PaymentCustomer.findOne({
      _id: req.params.id, createdBy: req.user._id, isDeleted: { $ne: true },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    if (customer.straddle?.gatewayId) {
      try {
        const { straddleAccountId } = await resolveScopeFromCustomer(customer, req);
        await straddle.deleteCustomer(customer.straddle.gatewayId, straddleAccountId);
      } catch (straddleErr) {
        const parsed = parseStraddleError(straddleErr);
        if (parsed.status !== 404 && parsed.status >= 400 && parsed.status < 500) {
          return res.status(parsed.status).json({ success: false, message: parsed.message });
        }
      }
    }

    customer.isDeleted = true;
    customer.deletedAt = ClockService.now();
    customer.updatedBy = req.user._id;
    await customer.save();
    res.json({ success: true, data: null, message: 'Customer deleted' });
  } catch (err) {
    next(err);
  }
};

const getCustomers = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getCustomers' });
  try {
    const filter = { isDeleted: { $ne: true } };
    if (req.query.hoaId) {
      filter.entityId = req.query.hoaId;
      filter.entityType = 'hoa';
    } else {
      filter.createdBy = req.user._id;
    }
    if (req.query.straddleAccountId) filter.straddleAccountId = req.query.straddleAccountId;

    const customers = await PaymentCustomer.find(filter).sort({ createdAt: -1 }).lean();

    const bankQuery = {
      paymentCustomerId: { $in: customers.map(c => c._id) },
      isDeleted: { $ne: true },
    };
    if (!req.query.hoaId) {
      bankQuery.createdBy = req.user._id;
    }

    const bankAccounts = await PaymentBankAccount.find(bankQuery)
      .select('_id paymentCustomerId holderName accountType last4 straddle straddleReady verificationStatus routingNumber')
      .lean();

    const banksByCustomer = {};
    for (const b of bankAccounts) {
      const cid = String(b.paymentCustomerId);
      if (!banksByCustomer[cid]) banksByCustomer[cid] = [];
      banksByCustomer[cid].push(b);
    }

    const data = customers.map((c) => ({
      ...c,
      status: c.status || c.straddle?.status || null,
      straddleReady: c.straddleReady ?? !!c.straddle?.success,
      banks: (banksByCustomer[String(c._id)] || []).map((b) => ({
        _id: b._id,
        holderName: b.holderName,
        accountType: b.accountType,
        last4: b.last4,
        status: b.straddle?.status || b.verificationStatus || null,
      })),
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

const getCustomerById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getCustomerById' });
  try {
    const customer = await PaymentCustomer.findOne({
      _id: req.params.id, createdBy: req.user._id, isDeleted: { $ne: true },
    });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    res.json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
};

// ── Bank Accounts ─────────────────────────────────────────────────────────────

const linkBankAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'linkBankAccount' });
  try {
    logger.info('[Payment] linkBankAccount started', {
      userId: req.user._id,
      paymentCustomerId: req.body.paymentCustomerId,
    });
    const {
      paymentCustomerId, holderName, accountNumber,
      routingNumber, accountType = 'checking',
    } = req.body;

    const customer = await PaymentCustomer.findById(paymentCustomerId);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const straddleCustomerId = customer.straddle?.gatewayId;
    let straddleAccountId = customer.straddleAccountId;
    if (!straddleAccountId) {
      try {
        ({ straddleAccountId } = await resolveScopeFromCustomer(customer, req));
      } catch (scopeErr) {
        return res.status(scopeErr.statusCode || 400).json({ success: false, message: scopeErr.message });
      }
    }

    const straddleResult = await (
      straddleCustomerId
        ? tryGateway(() => straddle.createPaykey(
          { customerId: straddleCustomerId, holderName, accountNumber, routingNumber, accountType },
          straddleAccountId
        ))
        : Promise.resolve({ success: false, error: 'No Straddle customer ID on record' })
    );

    // straddleResult.data.id  = bridge record UUID (for managing the bank account)
    // straddleResult.data.paykey = the paykey TOKEN required for charges
    const bankAccount = await PaymentBankAccount.create({
      paymentCustomerId: customer._id,
      straddleAccountId: customer.straddleAccountRef || null,
      holderName,
      accountType,
      routingNumber,
      last4: String(accountNumber).slice(-4),
      straddle: straddleResult.success
        ? {
          success: true,
          gatewayId: straddleResult.data.id,               // bridge record UUID
          paykeyToken: straddleResult.data.paykey ?? null,   // paykey token for charges
          status: straddleResult.data.status,
          raw: straddleResult.data
        }
        : { success: false, error: straddleResult.error },
      straddleReady: straddleResult.success,
      verificationStatus: 'pending',
      createdBy: req.user._id
    });

    logger.info('[Payment] linkBankAccount completed', {
      userId: req.user._id,
      bankAccountId: bankAccount._id,
      paymentCustomerId: customer._id,
    });
    res.status(201).json({ success: true, data: bankAccount });
  } catch (err) {
    logger.error('[Payment] linkBankAccount failed', { userId: req.user?._id, error: err.message });
    next(err);
  }
};

const getBankAccounts = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getBankAccounts' });
  try {
    logger.info('[Payment] getBankAccounts started', {
      userId: req.user._id,
      customerId: req.query.customerId || null,
    });
    const filter = { createdBy: req.user._id };
    if (req.query.customerId) filter.paymentCustomerId = req.query.customerId;
    const accounts = await PaymentBankAccount.find(filter).sort({ createdAt: -1 });
    logger.info('[Payment] getBankAccounts completed', {
      userId: req.user._id,
      count: accounts.length,
    });
    res.json({ success: true, data: accounts });
  } catch (err) {
    logger.error('[Payment] getBankAccounts failed', { userId: req.user?._id, error: err.message });
    next(err);
  }
};

const getBankAccountById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getBankAccountById' });
  try {
    const account = await PaymentBankAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ success: false, message: 'Bank account not found' });
    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
};

const updateBankAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'updateBankAccount' });
  try {
    const account = await PaymentBankAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ success: false, message: 'Bank account not found' });

    const { holderName, accountType } = req.body;
    const updates = {};
    if (holderName) updates.holderName = holderName;
    if (accountType) updates.accountType = accountType;

    const customer = await PaymentCustomer.findById(account.paymentCustomerId);
    let straddleAccountId = customer?.straddleAccountId || null;
    if (!straddleAccountId && customer) {
      try {
        ({ straddleAccountId } = await resolveScopeFromCustomer(customer, req));
      } catch (_) { /* continue without if legacy */ }
    }

    const straddleResult = await (
      account.straddle?.gatewayId
        ? tryGateway(() => straddle.updatePaykey(account.straddle.gatewayId, {
          holder_name: holderName ?? account.holderName,
          account_type: accountType ?? account.accountType
        }, straddleAccountId))
        : Promise.resolve({ success: false, error: 'No Straddle paykey on record' })
    );

    Object.assign(account, updates);
    if (straddleResult.success) {
      account.straddle = {
        success: true,
        gatewayId: account.straddle.gatewayId,
        paykeyToken: account.straddle.paykeyToken ?? straddleResult.data.paykey ?? null,
        status: straddleResult.data.status,
        raw: straddleResult.data
      };
      account.straddleReady = true;
    }
    await account.save();

    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
};

// ── Charges ───────────────────────────────────────────────────────────────────

const createCharge = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createCharge' });
  try {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.split(',')[0].trim();

    // Resolve the correct paykey token from the stored bank account.
    // paykeyToken = data.paykey from Straddle bridge response (the charge-ready token)
    // gatewayId   = data.id   (the bridge record UUID - NOT valid as a paykey for charges)
    let { paykeyId } = req.body;
    let straddleAccountId = req.body.straddleAccountId || null;
    if (paykeyId) {
      const bankAccount = await PaymentBankAccount.findOne({
        $or: [
          { 'straddle.gatewayId': paykeyId },
          { 'straddle.paykeyToken': paykeyId },
          { 'straddle.raw.paykey': paykeyId }
        ],
        createdBy: req.user._id
      });
      if (bankAccount) {
        const resolved =
          bankAccount.straddle?.paykeyToken ||
          bankAccount.straddle?.raw?.paykey ||
          paykeyId;
        paykeyId = resolved;
        if (!straddleAccountId && bankAccount.paymentCustomerId) {
          const cust = await PaymentCustomer.findById(bankAccount.paymentCustomerId);
          straddleAccountId = cust?.straddleAccountId || null;
          if (!straddleAccountId && cust) {
            try {
              ({ straddleAccountId } = await resolveScopeFromCustomer(cust, req));
            } catch (_) { }
          }
        }
      }
    }

    if (!straddleAccountId) {
      try {
        const scope = await resolveScopeFromBody(req);
        straddleAccountId = scope.straddleAccountId;
      } catch (_) { }
    }

    // Validate invoice payment rules before charging so a rejected payment
    // cannot leave a successful Straddle charge without an invoice update.
    const invoiceId = req.body.metadata?.invoiceId;
    const invoicePaymentAmountRaw = req.body.metadata?.invoicePaymentAmount;
    const invoiceAmountDollars = invoiceId
      ? (
        invoicePaymentAmountRaw != null && invoicePaymentAmountRaw !== ''
          ? Number(invoicePaymentAmountRaw)
          : Number(req.body.amount || 0) / 100
      )
      : null;

    if (invoiceId) {
      const invoice = await Invoice.findOne({ _id: invoiceId, isDeleted: { $ne: true } });
      if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found.' });
      }
      try {
        await ledgerService.assertOwnerOnlinePaymentAllowed(invoice, invoiceAmountDollars);
      } catch (validationErr) {
        const status = validationErr.status || validationErr.statusCode || 400;
        return res.status(status).json({ success: false, message: validationErr.message });
      }
    }

    const straddleRes = await straddle.createCharge({ ...req.body, paykeyId, ipAddress }, straddleAccountId);

    const transaction = await StraddleTransaction.create({
      straddleId: straddleRes.id,
      type: 'charge',
      amount: straddleRes.amount ?? req.body.amount,
      currency: straddleRes.currency ?? 'usd',
      paykeyId: straddleRes.paykey ?? paykeyId,
      description: straddleRes.description ?? req.body.description,
      status: straddleRes.status,
      metadata: straddleRes.metadata ?? req.body.metadata,
      raw: straddleRes,
      createdBy: req.user._id
    });

    // Record in-flight payment on the invoice so both portals show Processing amount.
    // Prefer net invoice amount from metadata when present (excludes processing fees).
    if (invoiceId) {
      try {
        await initiateInvoiceProcessingPayment({
          invoiceId,
          amount: invoiceAmountDollars,
          method: 'ACH',
          paidBy: req.user._id,
          recordedBy: req.user._id,
          gatewayTransactionId: transaction._id,
          gatewayExternalId: straddleRes.id,
          note: `ACH payment initiated - ${transaction._id}`,
        });
        logger.info('[Payment] Invoice processing payment recorded', { invoiceId, chargeId: straddleRes.id });
      } catch (invoiceErr) {
        if (invoiceErr.statusCode === 409 || invoiceErr.statusCode === 400) {
          return res.status(invoiceErr.statusCode).json({ success: false, message: invoiceErr.message });
        }
        logger.error('[Payment] Failed to record invoice processing payment', { invoiceId, error: invoiceErr.message });
      }
    }

    res.status(201).json({ success: true, data: transaction });
  } catch (err) {
    next(err);
  }
};

const getCharges = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getCharges' });
  try {
    const charges = await StraddleTransaction.find({ type: 'charge', createdBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: charges });
  } catch (err) {
    next(err);
  }
};

const getChargeById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getChargeById' });
  try {
    const charge = await StraddleTransaction.findById(req.params.id);
    if (!charge) return res.status(404).json({ success: false, message: 'Charge not found' });
    res.json({ success: true, data: charge });
  } catch (err) {
    next(err);
  }
};

// ── Payouts ───────────────────────────────────────────────────────────────────

const createPayout = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createPayout' });
  try {
    let payoutAccountId = req.body.straddleAccountId || null;
    if (!payoutAccountId) {
      try {
        const scope = await resolveScopeFromBody(req);
        payoutAccountId = scope.straddleAccountId;
      } catch (_) { }
    }
    const straddleRes = await straddle.createPayout(req.body, payoutAccountId);

    const transaction = await StraddleTransaction.create({
      straddleId: straddleRes.id,
      type: 'payout',
      amount: straddleRes.amount ?? req.body.amount,
      currency: straddleRes.currency ?? 'usd',
      paykeyId: straddleRes.paykey ?? req.body.paykeyId,
      description: straddleRes.description ?? req.body.description,
      status: straddleRes.status,
      raw: straddleRes,
      createdBy: req.user._id
    });

    res.status(201).json({ success: true, data: transaction });
  } catch (err) {
    next(err);
  }
};

const getPayouts = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getPayouts' });
  try {
    const payouts = await StraddleTransaction.find({ type: 'payout', createdBy: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: payouts });
  } catch (err) {
    next(err);
  }
};

const getPayoutById = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'getPayoutById' });
  try {
    const payout = await StraddleTransaction.findById(req.params.id);
    if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });
    res.json({ success: true, data: payout });
  } catch (err) {
    next(err);
  }
};

// ── Bridge Session ───────────────────────────────────────────────────────────

const verifyBankAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'verifyBankAccount' });
  try {
    const account = await PaymentBankAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ success: false, message: 'Bank account not found' });

    account.verificationStatus = 'verified';
    account.straddleReady = true;

    await account.save();
    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
};

const createBridgeSession = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'createBridgeSession' });
  try {
    const { bankAccountId, customerId, hoaId } = req.body;

    let customer = null;
    if (bankAccountId) {
      const bankAccount = await PaymentBankAccount.findById(bankAccountId);
      if (!bankAccount) {
        return res.status(400).json({ message: 'Failed to create bridge session', statuscode: 400, data: { success: false } });
      }
      customer = await PaymentCustomer.findById(bankAccount.paymentCustomerId);
    } else if (customerId) {
      customer = await PaymentCustomer.findOne({
        _id: customerId,
        createdBy: req.user._id,
        isDeleted: { $ne: true },
      });
    }

    if (!customer) {
      return res.status(400).json({ message: 'Customer not found for bridge session', statuscode: 400, data: { success: false } });
    }

    const straddleCustomerId = customer.straddle?.gatewayId;
    if (!straddleCustomerId) {
      return res.status(400).json({ message: 'Customer is not registered with Straddle', statuscode: 400, data: { success: false } });
    }

    let straddleAccountId = customer.straddleAccountId || null;
    if (!straddleAccountId) {
      try {
        ({ straddleAccountId } = await resolveScopeFromCustomer(customer, {
          ...req,
          body: { ...req.body, hoaId: hoaId || req.body.hoaId },
        }));
      } catch (scopeErr) {
        return res.status(scopeErr.statusCode || 400).json({
          message: scopeErr.message,
          statuscode: scopeErr.statusCode || 400,
          data: { success: false },
        });
      }
    }

    let session;
    try {
      session = await straddle.createBridgeSession(straddleCustomerId, straddleAccountId, {
        externalId: `bridge_${customer._id}_${ClockService.nowEpoch()}`,
      });
    } catch (err) {
      const parsed = parseStraddleError(err);
      logger.error('[Payment] createBridgeSession failed', { error: parsed.message, raw: err?.response?.data });
      return res.status(parsed.status >= 400 && parsed.status < 500 ? parsed.status : 400).json({
        message: parsed.message || 'Failed to create bridge session',
        statuscode: 400,
        data: { success: false },
      });
    }

    const sessionKey = session.bridge_token || session.session_key;
    res.json({
      message: 'Success',
      statuscode: 200,
      data: {
        success: true,
        sessionKey,
        bridge_token: sessionKey,
        customerId: customer._id,
        straddleCustomerId,
        straddleAccountId,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * HOA Owner Add Bank entrypoint.
 * 1) Ensure lightweight individual customer (name/email/phone/ip) under HOA Straddle Account
 * 2) Create Bridge initialize session with Straddle-Account-Id
 * Does NOT expose customer KYC form to the owner.
 */
const startOwnerBankLink = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'startOwnerBankLink' });
  try {
    const { hoaId } = req.body;
    const userId = req.userId || req.user?._id || req.user?.id;

    // Auth JWT only carries sub + role - load profile fields from DB
    const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select('email phone firstName lastName name')
      .lean();

    if (!userDoc) {
      return res.status(401).json({
        success: false,
        message: 'User not found. Please log in again.',
      });
    }

    const email = (userDoc.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Your profile needs an email before linking a bank account.',
      });
    }

    const name = [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim()
      || userDoc.name
      || email
      || 'HOA Owner';
    const phone = normalizePhoneE164(userDoc.phone) || '+10000000000';

    let scope;
    try {
      scope = await resolveEmbeddedAccount({
        hoaId,
        entityType: 'hoa',
        entityId: hoaId,
      });
    } catch (scopeErr) {
      return res.status(scopeErr.statusCode || 400).json({
        success: false,
        message: scopeErr.message,
      });
    }

    const { account, straddleAccountId } = scope;
    const resolvedIp = req.ip
      || req.headers['x-forwarded-for']?.split(',')[0].trim()
      || '127.0.0.1';
    const externalId = `${userId}:${straddleAccountId}`;

    let customer = await PaymentCustomer.findOne({
      createdBy: userId,
      straddleAccountId,
      isDeleted: { $ne: true },
      'straddle.success': true,
    });

    if (!customer) {
      logger.info('[Payment] startOwnerBankLink creating customer', {
        userId,
        straddleAccountId,
        hoaId,
        email,
      });

      let straddleData = null;
      try {
        // type forced to individual server-side; no KYC form for owner
        straddleData = await straddle.createCustomer({
          name,
          email,
          phone,
          type: 'individual',
          ipAddress: resolvedIp,
          externalId,
          metadata: { userId: String(userId), hoaId: String(hoaId), source: 'owner_bank_link' },
        }, straddleAccountId);
      } catch (straddleErr) {
        const parsed = parseStraddleError(straddleErr);
        if (parsed.status === 409) {
          customer = await PaymentCustomer.findOne({
            createdBy: userId,
            straddleAccountId,
            isDeleted: { $ne: true },
          });
        }
        if (!customer) {
          return res.status(parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502).json({
            success: false,
            message: parsed.message,
          });
        }
      }

      if (!customer) {
        if (!straddleData?.id) {
          return res.status(502).json({ success: false, message: 'Straddle did not return a customer id.' });
        }
        customer = await PaymentCustomer.create({
          name,
          email,
          phone,
          type: 'individual',
          externalId,
          ipAddress: resolvedIp,
          straddleAccountId,
          straddleAccountRef: account._id,
          entityType: 'hoa',
          entityId: hoaId,
          status: straddleData.status || null,
          straddle: {
            success: true,
            gatewayId: straddleData.id,
            status: straddleData.status,
            raw: straddleData,
          },
          straddleReady: ['verified', 'active'].includes(String(straddleData.status || '').toLowerCase()),
          metadata: { source: 'owner_bank_link' },
          createdBy: userId,
        });
      }
    }

    const straddleCustomerId = customer.straddle?.gatewayId;
    if (!straddleCustomerId) {
      return res.status(400).json({ success: false, message: 'Payment profile is incomplete. Please try again.' });
    }

    let session;
    try {
      const isSandbox = String(process.env.STRADDLE_BASE_URL || '').includes('sandbox');
      session = await straddle.createBridgeSession(straddleCustomerId, straddleAccountId, {
        externalId: `owner_bank_${customer._id}_${ClockService.nowEpoch()}`,
        // Sandbox: force an active paykey even when MX holder name doesn't match customer name
        ...(isSandbox ? { config: { sandbox_outcome: 'active' } } : {}),
      });
    } catch (err) {
      const parsed = parseStraddleError(err);
      return res.status(parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502).json({
        success: false,
        message: parsed.message || 'Failed to start bank linking session.',
      });
    }

    const sessionKey = session.bridge_token || session.session_key;
    if (!sessionKey) {
      return res.status(502).json({ success: false, message: 'Straddle did not return a bridge token.' });
    }

    res.status(200).json({
      success: true,
      data: {
        customerId: customer._id,
        straddleCustomerId,
        straddleAccountId,
        sessionKey,
        bridge_token: sessionKey,
        holderName: customer.name || name,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * After Bridge widget success - persist linked bank for the owner customer.
 * Idempotent: Bridge (esp. manual entry) can fire onSuccess twice; concurrent
 * complete-bank-link calls must upsert a single PaymentBankAccount row.
 */
const completeOwnerBankLink = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'completeOwnerBankLink' });
  try {
    const {
      customerId,
      straddlePaykeyId,
      paykey,
      status,
      holderName,
      accountType,
      routingNumber,
      last4,
      raw,
    } = req.body;

    const userId = req.userId || req.user._id;
    const customer = await PaymentCustomer.findOne({
      _id: customerId,
      createdBy: userId,
      isDeleted: { $ne: true },
    });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const straddleAccountId = customer.straddleAccountId;
    // Bridge widget may send { data: { id, paykey, bank_data } } or flat paykey object
    const rawRoot = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
    let remote = rawRoot || null;
    const remoteId = straddlePaykeyId || rawRoot?.id || raw?.id || null;

    if (remoteId && straddleAccountId) {
      try {
        remote = await straddle.getPaykey(remoteId, straddleAccountId);
      } catch (err) {
        logger.warn('[Payment] completeOwnerBankLink getPaykey failed - using callback payload', {
          error: err.message,
        });
      }
    }

    const bankData = remote?.bank_data || remote?.bank_account || rawRoot?.bank_data || {};
    const gatewayId = remote?.id || remoteId || null;
    const paykeyToken = paykey || remote?.paykey || remote?.token || rawRoot?.paykey || null;
    const bankStatus = status || remote?.status || rawRoot?.status || 'pending';

    if (!gatewayId && !paykeyToken) {
      return res.status(400).json({
        success: false,
        message: 'Bridge did not return a paykey id. Please try linking your bank again.',
      });
    }

    const maskedAccount = String(
      bankData.account_number || remote?.account_number || rawRoot?.account_number || ''
    );
    const bankLast4 = String(
      last4
      || maskedAccount.replace(/\D/g, '').slice(-4)
      || remote?.last4
      || ''
    ).slice(-4) || null;
    const bankRouting = String(
      routingNumber || bankData.routing_number || remote?.routing_number || ''
    ).replace(/\D/g, '').slice(0, 9) || null;
    const bankHolder = holderName
      || bankData.account_holder
      || remote?.holder_name
      || customer.name;
    const rawType = String(
      accountType || bankData.account_type || remote?.account_type || 'checking'
    ).toLowerCase();
    const bankType = ['checking', 'savings'].includes(rawType) ? rawType : 'checking';
    const isReady = ['active', 'verified'].includes(String(bankStatus).toLowerCase());

    const orConditions = [];
    if (gatewayId) orConditions.push({ 'straddle.gatewayId': gatewayId });
    if (paykeyToken) orConditions.push({ 'straddle.paykeyToken': paykeyToken });
    if (bankLast4 && bankLast4 !== '****' && bankRouting && bankRouting !== '000000000') {
      orConditions.push({
        paymentCustomerId: customer._id,
        last4: bankLast4,
        routingNumber: bankRouting,
      });
    }

    const findExisting = () => PaymentBankAccount.findOne({
      createdBy: userId,
      paymentCustomerId: customer._id,
      $or: orConditions,
    });

    let bankAccount = await findExisting();

    const nextFields = {
      holderName: bankHolder,
      accountType: bankType,
      routingNumber: bankRouting || '000000000',
      last4: bankLast4 || '****',
      verificationStatus: isReady ? 'verified' : 'pending',
      straddle: {
        success: true,
        gatewayId: gatewayId || bankAccount?.straddle?.gatewayId || null,
        paykeyToken: paykeyToken || bankAccount?.straddle?.paykeyToken || null,
        status: bankStatus,
        raw: remote || rawRoot || { id: gatewayId, paykey: paykeyToken, status: bankStatus },
      },
      straddleReady: isReady,
    };

    if (bankAccount) {
      Object.assign(bankAccount, nextFields);
      await bankAccount.save();
    } else {
      try {
        bankAccount = await PaymentBankAccount.create({
          paymentCustomerId: customer._id,
          straddleAccountId: customer.straddleAccountRef || null,
          ...nextFields,
          createdBy: userId,
        });
      } catch (createErr) {
        // Concurrent duplicate (unique index) - treat as idempotent update
        if (createErr?.code === 11000) {
          bankAccount = await findExisting();
          if (bankAccount) {
            Object.assign(bankAccount, nextFields);
            await bankAccount.save();
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }
    }

    res.status(200).json({ success: true, data: bankAccount });
  } catch (err) {
    next(err);
  }
};

/** Sync bank/paykey status from Straddle GET /v1/paykeys/{id}. */
const syncBankAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'syncBankAccount' });
  try {
    const userId = req.userId || req.user?._id;
    const account = await PaymentBankAccount.findOne({
      _id: req.params.id,
      createdBy: userId,
    });
    if (!account) {
      return res.status(404).json({ success: false, message: 'Bank account not found' });
    }

    const customer = await PaymentCustomer.findById(account.paymentCustomerId);
    let straddleAccountId = customer?.straddleAccountId || null;
    if (!straddleAccountId && customer) {
      try {
        ({ straddleAccountId } = await resolveScopeFromCustomer(customer, req));
      } catch (_) { /* legacy records */ }
    }

    const paykeyId = account.straddle?.gatewayId || account.straddle?.raw?.id || null;
    if (!paykeyId) {
      return res.status(400).json({
        success: false,
        message: 'Bank is not linked to a Straddle paykey yet. Re-link the bank to sync status.',
      });
    }
    if (!straddleAccountId) {
      return res.status(400).json({
        success: false,
        message: 'Missing Straddle Account scope for this bank. Relink under your HOA to fix.',
      });
    }

    let remote;
    try {
      remote = await straddle.getPaykey(paykeyId, straddleAccountId);
    } catch (err) {
      const parsed = parseStraddleError(err);
      return res.status(parsed.status >= 500 ? 502 : (parsed.status || 502)).json({
        success: false,
        message: parsed.message || 'Failed to sync bank status from Straddle.',
      });
    }

    const bankData = remote?.bank_data || remote?.bank_account || {};
    const maskedAccount = String(bankData.account_number || remote?.account_number || '');
    const last4 = maskedAccount.replace(/\D/g, '').slice(-4) || account.last4;
    const routing = String(bankData.routing_number || remote?.routing_number || account.routingNumber || '')
      .replace(/\D/g, '')
      .slice(0, 9) || account.routingNumber;
    const rawType = String(bankData.account_type || remote?.account_type || account.accountType || 'checking').toLowerCase();
    const accountType = ['checking', 'savings'].includes(rawType) ? rawType : account.accountType;
    const status = remote?.status || account.straddle?.status;
    const isReady = ['active', 'verified'].includes(String(status || '').toLowerCase());

    account.straddle = {
      success: true,
      gatewayId: remote?.id || paykeyId,
      paykeyToken: account.straddle?.paykeyToken || remote?.paykey || null,
      status,
      raw: remote,
    };
    account.straddleReady = isReady;
    if (isReady) account.verificationStatus = 'verified';
    else if (['rejected', 'inactive', 'canceled', 'cancelled'].includes(String(status || '').toLowerCase())) {
      account.verificationStatus = 'pending';
    }
    if (last4) account.last4 = last4;
    if (routing) account.routingNumber = routing;
    if (accountType) account.accountType = accountType;
    if (remote?.label || remote?.institution_name) {
      // keep holderName; optionally enrich from institution
    }
    await account.save();

    res.json({
      success: true,
      data: account,
      message: `Bank status synced: ${status || 'unknown'}`,
    });
  } catch (err) {
    next(err);
  }
};

const deleteBankAccount = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'deleteBankAccount' });
  try {
    const userId = req.userId || req.user?._id;
    const account = await PaymentBankAccount.findOne({
      _id: req.params.id,
      createdBy: userId,
    });
    if (!account) return res.status(404).json({ success: false, message: 'Bank account not found' });

    await PaymentBankAccount.deleteOne({ _id: account._id });
    res.json({ success: true, data: null, message: 'Bank account removed' });
  } catch (err) {
    next(err);
  }
};

/**
 * Vendor portal: link bank without HOA community.
 * Creates a lightweight PaymentCustomer under the platform/vendor Straddle scope,
 * then starts a Bridge session. Reuses completeOwnerBankLink to persist the bank.
 */
const startVendorBankLink = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'startVendorBankLink' });
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    const userDoc = await User.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select('email phone firstName lastName name associatedHoaIds associatedLandlordIds hoaInfo')
      .lean();

    if (!userDoc) {
      return res.status(401).json({
        success: false,
        message: 'User not found. Please log in again.',
      });
    }

    const email = (userDoc.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Your profile needs an email before linking a bank account.',
      });
    }

    const name = [userDoc.firstName, userDoc.lastName].filter(Boolean).join(' ').trim()
      || userDoc.name
      || email
      || 'Vendor';
    const phone = normalizePhoneE164(userDoc.phone) || '+10000000000';

    const associatedHoaIds = [
      ...(Array.isArray(userDoc.associatedHoaIds) ? userDoc.associatedHoaIds : []),
      ...(userDoc.hoaInfo?.hoaId ? [userDoc.hoaInfo.hoaId] : []),
    ];
    const associatedLandlordIds = Array.isArray(userDoc.associatedLandlordIds)
      ? userDoc.associatedLandlordIds
      : [];

    let scope;
    try {
      scope = await resolveVendorPlatformAccount({ associatedHoaIds, associatedLandlordIds });
    } catch (scopeErr) {
      return res.status(scopeErr.statusCode || 400).json({
        success: false,
        message: scopeErr.message,
      });
    }

    const { account, straddleAccountId } = scope;
    if (!straddleAccountId) {
      return res.status(400).json({
        success: false,
        message: 'Vendor payment platform is not configured. Ask an administrator to set STRADDLE_VENDOR_ACCOUNT_ID.',
      });
    }

    const resolvedIp = req.ip
      || req.headers['x-forwarded-for']?.split(',')[0].trim()
      || '127.0.0.1';
    const externalId = `${userId}:vendor:${straddleAccountId}`;

    const customerFilter = {
      createdBy: userId,
      isDeleted: { $ne: true },
      'metadata.source': 'vendor_bank_link',
      'straddle.success': true,
      straddleAccountId,
    };

    let customer = await PaymentCustomer.findOne(customerFilter);

    if (!customer) {
      logger.info('[Payment] startVendorBankLink creating customer', {
        userId,
        straddleAccountId,
        source: scope.source,
        email,
      });

      let straddleData = null;
      try {
        straddleData = await straddle.createCustomer({
          name,
          email,
          phone,
          type: 'individual',
          ipAddress: resolvedIp,
          externalId,
          metadata: { userId: String(userId), source: 'vendor_bank_link' },
        }, straddleAccountId);
      } catch (straddleErr) {
        const parsed = parseStraddleError(straddleErr);
        if (parsed.status === 409) {
          customer = await PaymentCustomer.findOne({
            createdBy: userId,
            'metadata.source': 'vendor_bank_link',
            isDeleted: { $ne: true },
            straddleAccountId,
          });
        }
        if (!customer) {
          return res.status(parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502).json({
            success: false,
            message: parsed.message,
          });
        }
      }

      if (!customer) {
        if (!straddleData?.id) {
          return res.status(502).json({ success: false, message: 'Straddle did not return a customer id.' });
        }
        customer = await PaymentCustomer.create({
          name,
          email,
          phone,
          type: 'individual',
          externalId,
          ipAddress: resolvedIp,
          straddleAccountId,
          straddleAccountRef: account?._id || null,
          entityType: 'vendor',
          entityId: userId,
          status: straddleData.status || null,
          straddle: {
            success: true,
            gatewayId: straddleData.id,
            status: straddleData.status,
            raw: straddleData,
          },
          straddleReady: ['verified', 'active'].includes(String(straddleData.status || '').toLowerCase()),
          metadata: { source: 'vendor_bank_link', accountSource: scope.source || null },
          createdBy: userId,
        });
      }
    }

    const straddleCustomerId = customer.straddle?.gatewayId;
    if (!straddleCustomerId) {
      return res.status(400).json({ success: false, message: 'Payment profile is incomplete. Please try again.' });
    }

    let session;
    try {
      const isSandbox = String(process.env.STRADDLE_BASE_URL || '').includes('sandbox');
      session = await straddle.createBridgeSession(straddleCustomerId, straddleAccountId, {
        externalId: `vendor_bank_${customer._id}_${ClockService.nowEpoch()}`,
        ...(isSandbox ? { config: { sandbox_outcome: 'active' } } : {}),
      });
    } catch (err) {
      const parsed = parseStraddleError(err);
      return res.status(parsed.status >= 400 && parsed.status < 500 ? parsed.status : 502).json({
        success: false,
        message: parsed.message || 'Failed to start bank linking session.',
      });
    }

    const sessionKey = session.bridge_token || session.session_key;
    if (!sessionKey) {
      return res.status(502).json({ success: false, message: 'Straddle did not return a bridge token.' });
    }

    res.status(200).json({
      success: true,
      data: {
        customerId: customer._id,
        straddleCustomerId,
        straddleAccountId,
        sessionKey,
        bridge_token: sessionKey,
        holderName: customer.name || name,
      },
    });
  } catch (err) {
    next(err);
  }
};

function otpResendMetaPayload(meta) {
  if (!meta) return {};
  return {
    retryAfterSeconds: meta.retryAfterSeconds,
    resendAvailableAt: meta.resendAvailableAt,
    resendCount: meta.resendCount,
  };
}

const sendPaymentVerifyOtp = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'sendPaymentVerifyOtp' });
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const { phone, resend = false } = req.body;
    const result = await paymentVerifyService.sendPaymentVerifyOtp({
      userId,
      phone,
      resend,
    });
    res.json({
      success: true,
      message: result.emailDeliveryFailed
        ? "We're having trouble sending your verification email right now. Please try again shortly."
        : 'Verification code sent to your email.',
      data: {
        email: result.email,
        emailDeliveryFailed: result.emailDeliveryFailed,
        ...otpResendMetaPayload(result.otpResendMeta),
        ...(result.devOtp ? { devOtp: result.devOtp } : {}),
      },
    });
  } catch (err) {
    if (err instanceof OtpResendLimitedError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: err.message,
        data: {
          retryAfterSeconds: err.retryAfterSeconds,
          resendAvailableAt: err.resendAvailableAt,
          resendCount: err.resendCount,
        },
      });
    }
    if (err.message === 'Phone number format is invalid') {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

const verifyPaymentVerifyOtp = async (req, res, next) => {
  logControllerStep(req, 'START', { action: 'verifyPaymentVerifyOtp' });
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const { phone, otp } = req.body;
    await paymentVerifyService.verifyPaymentVerifyOtp({ userId, phone, otp });
    res.json({ success: true, message: 'Account verified successfully', data: { verified: true } });
  } catch (err) {
    if (
      err.message === 'Invalid verification code' ||
      err.message === 'Verification code has expired. Please request a new one.' ||
      err.message === 'No active payment verification code. Please request a new code.'
    ) {
      return res.status(401).json({ success: false, message: err.message });
    }
    if (err.message === 'Phone number format is invalid' || err.message === 'Verification code is required') {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

module.exports = {
  createCustomer, updateCustomer, syncCustomer, deleteCustomer,
  getCustomers, getCustomerById,
  linkBankAccount, getBankAccounts, getBankAccountById, updateBankAccount, verifyBankAccount,
  syncBankAccount, deleteBankAccount,
  createCharge, getCharges, getChargeById,
  createPayout, getPayouts, getPayoutById,
  createBridgeSession,
  startOwnerBankLink,
  completeOwnerBankLink,
  startVendorBankLink,
  sendPaymentVerifyOtp,
  verifyPaymentVerifyOtp,
  applyCustomerStatusFromWebhook,
};
