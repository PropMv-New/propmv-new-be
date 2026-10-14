/**
 * ------------------------------------------------------------------
 * File: leaseInvoiceSync.service.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * lease.service
 * ------------------------------------------------------------------
 */

/**
 * Synchronizes existing landlord invoices when a lease is edited.
 * Handles deposit/fee adjustments, tenant roster changes, end-date cleanup,
 * overpayment credits, and lease activity comments for auditability.
 */
const Invoice = require('../../invoice/model/invoice.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const { INVOICE_TYPES, INVOICE_STATUS } = require('../../../../../common/constants/invoice');
const logger = require('../../../../../common/logger');
const { ClockService } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  dateOnlyKeyFromStoredInstant,
} = require('../../../../../common/helpers/hoaBillingDates');
const { startOfDay } = require('../../../../../common/helpers/landlordInvoiceStatus.helper');

/**
 * round Money
 *
 * Performs logic operations for roundMoney.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/** YYYY-MM-DD in business timezone for stable date comparisons. */
function dateKey(value) {
  return dateOnlyKeyFromStoredInstant(value) || getDateKeyInTimeZone(value) || '';
}

/**
 * is Unpaid Invoice
 *
 * Performs logic operations for isUnpaidInvoice.
 *
 * @param inv - Request/input argument
 * @returns Operations result
 */
function isUnpaidInvoice(inv) {
  const status = String(inv?.status || '').toLowerCase();
  if (status === String(INVOICE_STATUS.PAID).toLowerCase()) return false;
  return roundMoney(inv?.balanceDue || 0) > 0;
}

/**
 * apply Session
 *
 * Performs logic operations for applySession.
 *
 * @param query - Request/input argument
 * @param session - Request/input argument
 * @returns Operations result
 */
function applySession(query, session) {
  if (session && query && typeof query.session === 'function') {
    return query.session(session);
  }
  return query;
}

async function loadTenantNameMap(split, session) {
  const tenantIds = (Array.isArray(split) ? split : [])
    .map((entry) => entry?.tenantId)
    .filter(Boolean);
  if (!tenantIds.length) return {};

  const users = await applySession(
    User.find({ _id: { $in: tenantIds }, isDeleted: { $ne: true } }).select('firstName lastName'),
    session
  ).lean();

  return users.reduce((acc, user) => {
    acc[String(user._id)] = `${user.firstName || ''} ${user.lastName || ''}`.trim() || `Tenant ${String(user._id)}`;
    return acc;
  }, {});
}

/** Build rent invoice line items from the lease tenant split. */
function buildRentLineItemsFromSplit(split, totalAmount, tenantNameById) {
  const rows = Array.isArray(split) ? split : [];
  if (!rows.length) {
    const amount = roundMoney(totalAmount);
    return [{
      invoiceItem: INVOICE_TYPES.RENT,
      description: INVOICE_TYPES.RENT,
      quantity: 1,
      rate: amount,
      amount,
    }];
  }

  const lineItems = rows.map((entry, idx) => {
    const pct = Number(entry?.rentPercentage || 0);
    const baseAmount = pct > 0 ? (Number(totalAmount) * pct) / 100 : Number(totalAmount) / rows.length;
    const amount = roundMoney(baseAmount);
    const tenantName = tenantNameById[String(entry?.tenantId || '')] || `Tenant ${idx + 1}`;
    const label = `${INVOICE_TYPES.RENT} - ${tenantName}`;
    return {
      invoiceItem: label,
      description: label,
      quantity: 1,
      rate: amount,
      amount,
    };
  });

  const sum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
  const drift = roundMoney(Number(totalAmount) - sum);
  if (Math.abs(drift) >= 0.01 && lineItems.length > 0) {
    const last = lineItems[lineItems.length - 1];
    const patched = roundMoney(Number(last.amount || 0) + drift);
    lineItems[lineItems.length - 1] = { ...last, amount: patched, rate: patched };
  }
  return lineItems;
}

/**
 * Apply a credit (overpayment) to the next unpaid invoice on the lease.
 * Adds invoice comments so the landlord can trace the adjustment.
 */
async function applyCreditToNextUnpaidInvoice(leaseId, creditAmount, sourceLabel, session, actorId) {
  const credit = roundMoney(creditAmount);
  if (!leaseId || credit <= 0) {
    logger.info('[leaseInvoiceSync] Skipping credit application - no credit amount', { leaseId, credit });
    return { applied: 0, targetInvoiceId: null };
  }

  logger.info('[leaseInvoiceSync] Applying credit to next unpaid invoice', { leaseId, credit, sourceLabel });

  const candidates = await applySession(
    Invoice.find({
      lease_id: leaseId,
      isDeleted: { $ne: true },
      balanceDue: { $gt: 0 },
      status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
    }).sort({ dueDate: 1 }),
    session
  );

  let remaining = credit;
  let totalApplied = 0;
  let firstTargetId = null;

  for (const target of candidates) {
    if (remaining <= 0) break;
    const balance = roundMoney(target.balanceDue || 0);
    if (balance <= 0) continue;

    const applied = roundMoney(Math.min(remaining, balance));
    target.alreadyPaid = roundMoney(Number(target.alreadyPaid || 0) + applied);
    target.balanceDue = roundMoney(Math.max(0, balance - applied));
    target.comments = Array.isArray(target.comments) ? target.comments : [];
    target.comments.push({
      text: `Credit of $${applied.toFixed(2)} applied from lease edit (${sourceLabel}).`,
      createdBy: actorId || undefined,
      createdAt: ClockService.now(),
    });

    await target.save(session ? { session } : undefined);
    remaining = roundMoney(remaining - applied);
    totalApplied = roundMoney(totalApplied + applied);
    if (!firstTargetId) firstTargetId = String(target._id);

    logger.info('[leaseInvoiceSync] Credit applied to invoice', {
      leaseId,
      targetInvoiceId: String(target._id),
      applied,
      remainingCredit: remaining,
    });
  }

  return { applied: totalApplied, targetInvoiceId: firstTargetId, remainingCredit: remaining };
}

/**
 * Remove pending invoices whose due date falls after the lease end date.
 */
async function removePendingInvoicesBeyondLeaseEnd(leaseId, endDate, session) {
  if (!leaseId || !endDate) {
    return { deletedCount: 0 };
  }

  const end = startOfDay(endDate);
  logger.info('[leaseInvoiceSync] Removing pending invoices beyond lease end', { leaseId, endDate: dateKey(end) });

  const filter = {
    lease_id: leaseId,
    status: INVOICE_STATUS.PENDING,
    dueDate: { $gt: end },
    isDeleted: { $ne: true },
  };

  // Find matching invoices first so we can return the exact IDs removed (safer audit trail)
  const matching = session
    ? await Invoice.find(filter).session(session).select('_id').lean()
    : await Invoice.find(filter).select('_id').lean();
  const idsToDelete = Array.isArray(matching) ? matching.map((m) => String(m._id)) : [];

  const deleteResult = idsToDelete.length
    ? (session ? await Invoice.deleteMany({ _id: { $in: idsToDelete } }).session(session) : await Invoice.deleteMany({ _id: { $in: idsToDelete } }))
    : { deletedCount: 0 };

  logger.info('[leaseInvoiceSync] Pending invoices beyond lease end removed', {
    leaseId,
    deletedCount: deleteResult?.deletedCount || 0,
    deletedIds: idsToDelete,
  });

  return { deletedCount: deleteResult?.deletedCount || 0, deletedIds: idsToDelete };
}

/**
 * Adjust deposit / one-time fee invoices when lease amounts decrease or increase.
 * Credits from overpaid deposits/fees roll forward to the next unpaid invoice.
 */
async function adjustDepositAndFeeInvoices(existingLease, savedLease, session, actorId, activityLines) {
  const leaseId = savedLease._id;
  const oldDeposit = roundMoney(existingLease?.depositDetails?.amount || 0);
  const newDeposit = roundMoney(savedLease?.depositDetails?.amount || 0);

  if (oldDeposit !== newDeposit) {
    logger.info('[leaseInvoiceSync] Deposit amount changed - adjusting deposit invoice', {
      leaseId: String(leaseId),
      oldDeposit,
      newDeposit,
    });

    const depositInvoice = await applySession(
      Invoice.findOne({
        lease_id: leaseId,
        type: INVOICE_TYPES.DEPOSIT,
        isDeleted: { $ne: true },
      }).sort({ dueDate: 1 }),
      session
    );

    if (depositInvoice) {
      const previousSub = roundMoney(depositInvoice.subAmount || 0);
      const alreadyPaid = roundMoney(depositInvoice.alreadyPaid || 0);
      depositInvoice.subAmount = newDeposit;
      depositInvoice.balanceDue = roundMoney(Math.max(0, newDeposit - alreadyPaid));

      if (Array.isArray(depositInvoice.invoiceItemDetails) && depositInvoice.invoiceItemDetails.length > 0) {
        depositInvoice.invoiceItemDetails[0].rate = newDeposit;
        depositInvoice.invoiceItemDetails[0].amount = newDeposit;
      }

      depositInvoice.comments = Array.isArray(depositInvoice.comments) ? depositInvoice.comments : [];
      depositInvoice.comments.push({
        text: `Security deposit updated from $${previousSub.toFixed(2)} to $${newDeposit.toFixed(2)} due to lease edit.`,
        createdBy: actorId || undefined,
        createdAt: ClockService.now(),
      });

      await depositInvoice.save(session ? { session } : undefined);

      if (alreadyPaid > newDeposit) {
        const credit = roundMoney(alreadyPaid - newDeposit);
        const creditResult = await applyCreditToNextUnpaidInvoice(
          leaseId,
          credit,
          'security deposit reduction',
          session,
          actorId
        );
        activityLines.push(
          `Security deposit reduced to $${newDeposit.toFixed(2)}; $${credit.toFixed(2)} credit applied to next unpaid invoice${creditResult.targetInvoiceId ? ` (${creditResult.targetInvoiceId})` : ''}.`
        );
      } else {
        activityLines.push(`Security deposit amount updated from $${previousSub.toFixed(2)} to $${newDeposit.toFixed(2)}.`);
      }
    }
  }

  const oldFeesJson = JSON.stringify(existingLease?.additionalFees || []);
  const newFeesJson = JSON.stringify(savedLease?.additionalFees || []);
  if (oldFeesJson === newFeesJson) {
    return;
  }

  const newFees = Array.isArray(savedLease?.additionalFees) ? savedLease.additionalFees : [];
  for (const feeGroup of newFees) {
    if (feeGroup?.isRecurringInvoice) continue;
    const feeItems = Array.isArray(feeGroup?.items) ? feeGroup.items : [];
    const newAmount = roundMoney(
      feeGroup?.totalAmount != null
        ? feeGroup.totalAmount
        : feeItems.reduce((sum, item) => sum + Number(item?.amount || 0), 0)
    );
    if (newAmount <= 0) continue;

    const feeNames = feeItems.map((item) => String(item?.name || '').trim()).filter(Boolean);
    const feeInvoiceQuery = {
      lease_id: leaseId,
      type: INVOICE_TYPES.OTHER,
      isDeleted: { $ne: true },
    };
    if (feeNames.length === 1) {
      feeInvoiceQuery['invoiceItemDetails.invoiceItem'] = feeNames[0];
    }

    const feeInvoice = await applySession(
      Invoice.findOne(feeInvoiceQuery).sort({ dueDate: 1 }),
      session
    );
    if (!feeInvoice) continue;

    const previousSub = roundMoney(feeInvoice.subAmount || 0);
    if (previousSub === newAmount) continue;

    const alreadyPaid = roundMoney(feeInvoice.alreadyPaid || 0);
    feeInvoice.subAmount = newAmount;
    feeInvoice.balanceDue = roundMoney(Math.max(0, newAmount - alreadyPaid));

    if (Array.isArray(feeInvoice.invoiceItemDetails) && feeInvoice.invoiceItemDetails.length > 0) {
      feeInvoice.invoiceItemDetails = feeInvoice.invoiceItemDetails.map((line, idx) => {
        if (idx === 0) {
          return { ...line, rate: newAmount, amount: newAmount };
        }
        return line;
      });
    }

    feeInvoice.comments = Array.isArray(feeInvoice.comments) ? feeInvoice.comments : [];
    feeInvoice.comments.push({
      text: `Additional fee updated from $${previousSub.toFixed(2)} to $${newAmount.toFixed(2)} due to lease edit.`,
      createdBy: actorId || undefined,
      createdAt: ClockService.now(),
    });

    await feeInvoice.save(session ? { session } : undefined);

    if (alreadyPaid > newAmount) {
      const credit = roundMoney(alreadyPaid - newAmount);
      const label = feeNames[0] || 'additional fee';
      const creditResult = await applyCreditToNextUnpaidInvoice(leaseId, credit, `${label} reduction`, session, actorId);
      activityLines.push(
        `${label} reduced to $${newAmount.toFixed(2)}; $${credit.toFixed(2)} credit applied to next unpaid invoice${creditResult.targetInvoiceId ? ` (${creditResult.targetInvoiceId})` : ''}.`
      );
    } else {
      activityLines.push(`${feeNames[0] || 'Additional fee'} amount updated from $${previousSub.toFixed(2)} to $${newAmount.toFixed(2)}.`);
    }
  }
}

/**
 * Update unpaid rent invoices so tenant names / line items match the current lease split.
 */
async function syncTenantRosterOnUnpaidInvoices(savedLease, tenantDelta, session, actorId, activityLines) {
  const leaseId = savedLease._id;
  const split = savedLease?.rentAndDepositDestribution?.split || [];
  const tenantIds = split.map((entry) => entry?.tenantId).filter(Boolean);
  const tenantNameById = await loadTenantNameMap(split, session);

  logger.info('[leaseInvoiceSync] Syncing tenant roster on unpaid invoices', {
    leaseId: String(leaseId),
    added: tenantDelta?.added || [],
    removed: tenantDelta?.removed || [],
  });

  const unpaidInvoices = await applySession(
    Invoice.find({
      lease_id: leaseId,
      type: INVOICE_TYPES.RENT,
      isDeleted: { $ne: true },
      balanceDue: { $gt: 0 },
      status: { $in: [INVOICE_STATUS.PENDING, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] },
    }),
    session
  );

  let updatedCount = 0;
  for (const inv of unpaidInvoices) {
    inv.tenants = tenantIds;
    inv.invoiceItemDetails = buildRentLineItemsFromSplit(split, inv.subAmount, tenantNameById);
    inv.isPartialPaymentAllowed = !!savedLease?.rentAndDepositDestribution?.isPartialPaymentAllowed;
    await inv.save(session ? { session } : undefined);
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    if (tenantDelta?.removed?.length > 0) {
      activityLines.push(`Removed tenant(s) from ${updatedCount} unpaid rent invoice(s); line items recalculated for remaining tenants.`);
    }
    if (tenantDelta?.added?.length > 0) {
      activityLines.push(`Added tenant(s) to ${updatedCount} unpaid rent invoice(s); rent line items updated.`);
    }
  } else {
    logger.info('[leaseInvoiceSync] No unpaid rent invoices required roster updates', { leaseId: String(leaseId) });
  }
}

/** True when the lease end date value changed between snapshots. */
function leaseEndDateChanged(existingLease, savedLease) {
  return dateKey(existingLease?.end_date) !== dateKey(savedLease?.end_date);
}

/**
 * Sync isPartialPaymentAllowed on all lease invoices when the lease setting changes.
 */
async function syncPartialPaymentOnLeaseInvoices(existingLease, savedLease, session, activityLines) {
  const oldVal = !!existingLease?.rentAndDepositDestribution?.isPartialPaymentAllowed;
  const newVal = !!savedLease?.rentAndDepositDestribution?.isPartialPaymentAllowed;
  if (oldVal === newVal) return;

  const leaseId = savedLease._id;
  logger.info('[leaseInvoiceSync] Syncing partial payment flag on lease invoices', {
    leaseId: String(leaseId),
    oldVal,
    newVal,
  });

  const updateResult = session
    ? await Invoice.updateMany(
        { lease_id: leaseId, isDeleted: { $ne: true } },
        { $set: { isPartialPaymentAllowed: newVal } }
      ).session(session)
    : await Invoice.updateMany(
        { lease_id: leaseId, isDeleted: { $ne: true } },
        { $set: { isPartialPaymentAllowed: newVal } }
      );

  const count = updateResult?.modifiedCount || 0;
  if (count > 0) {
    activityLines.push(
      newVal
        ? `Partial payments enabled on ${count} invoice(s) linked to this lease.`
        : `Partial payments disabled on ${count} invoice(s) linked to this lease; only full-balance payments are allowed.`
    );
  }
}

/**
 * Main entry: run all post-edit invoice sync steps and record a lease activity comment.
 */
async function syncInvoicesAfterLeaseEdit(existingLease, savedLease, context = {}, options = {}) {
  const session = options.session;
  const actorId = context.actorId || options.actorId || null;
  const tenantDelta = context.tenantDelta || { added: [], removed: [] };
  const regenerationResult = context.regenerationResult || null;

  const activityLines = [];
  const leaseId = savedLease._id || savedLease.id;

  logger.info('[leaseInvoiceSync] Starting post-edit invoice sync', { leaseId: String(leaseId) });

  const endDateChanged = leaseEndDateChanged(existingLease, savedLease);

  // Step 1 - remove pending invoices beyond the lease end date (always run; log only when end date changed)
  if (savedLease.end_date) {
    const beyondEnd = await removePendingInvoicesBeyondLeaseEnd(leaseId, savedLease.end_date, session);
    if (endDateChanged && beyondEnd.deletedCount > 0) {
      const previousEnd = dateKey(existingLease?.end_date);
      const newEnd = dateKey(savedLease.end_date);
      activityLines.push(
        previousEnd
          ? `${beyondEnd.deletedCount} pending invoice(s) after ${newEnd} were removed because the lease end date changed from ${previousEnd} to ${newEnd}.`
          : `${beyondEnd.deletedCount} pending invoice(s) after ${newEnd} were removed because the lease end date was set.`
      );
    }
  }

  // Step 2 - adjust deposit and one-time fee invoices when amounts changed
  await adjustDepositAndFeeInvoices(existingLease, savedLease, session, actorId, activityLines);

  // Step 3 - sync partial payment flag on all lease invoices when setting changed
  await syncPartialPaymentOnLeaseInvoices(existingLease, savedLease, session, activityLines);

  // Step 4 - sync tenant names on unpaid rent invoices when roster changed
  const tenantsChanged = (tenantDelta.added?.length || 0) > 0 || (tenantDelta.removed?.length || 0) > 0;
  if (tenantsChanged) {
    await syncTenantRosterOnUnpaidInvoices(savedLease, tenantDelta, session, actorId, activityLines);
  }

  // Step 5 - capture invoice regeneration stats from pending-future refresh
  if (regenerationResult) {
    const { deletedPendingCount = 0, createdCount = 0, skippedProtectedCount = 0 } = regenerationResult;
    if (deletedPendingCount > 0 || createdCount > 0) {
      if (deletedPendingCount > 0 && createdCount > 0) {
        activityLines.push(
          `${deletedPendingCount} future pending invoice(s) were replaced with ${createdCount} invoice(s) to match the updated lease schedule.`
        );
      } else if (createdCount > 0) {
        activityLines.push(`${createdCount} new pending invoice(s) were created from the updated lease schedule.`);
      } else if (deletedPendingCount > 0) {
        activityLines.push(`${deletedPendingCount} future pending invoice(s) were removed from the updated lease schedule.`);
      }
    }
    if (skippedProtectedCount > 0) {
      activityLines.push(`${skippedProtectedCount} existing paid/partial invoice(s) were kept unchanged to avoid duplicates.`);
    }
  }

  // Step 6 - persist a lease activity comment for each action for audit trail
  if (activityLines.length > 0) {
    logger.info('[leaseInvoiceSync] Recording lease edit activity lines', { leaseId: String(leaseId), lineCount: activityLines.length });
    // Lazy require avoids circular dependency with lease.service.js
    const { addCommentToLeaseService } = require('./lease.service');
    for (const line of activityLines) {
      try {
        const commentText = `Lease edited on ${getDateKeyInTimeZone(ClockService.now()) || ClockService.now().toISOString().slice(0, 10)}: ${line}`;
        // create a separate comment per activity line
        await addCommentToLeaseService(leaseId, commentText, 'lease-edit', actorId, { session });
      } catch (err) {
        logger.error('[leaseInvoiceSync] Failed to persist lease activity line', { leaseId: String(leaseId), line, err });
      }
    }
  } else {
    logger.info('[leaseInvoiceSync] No invoice adjustments required for this lease edit', { leaseId: String(leaseId) });
  }

  return { activityLines };
}

module.exports = {
  syncInvoicesAfterLeaseEdit,
  applyCreditToNextUnpaidInvoice,
  removePendingInvoicesBeyondLeaseEnd,
};
