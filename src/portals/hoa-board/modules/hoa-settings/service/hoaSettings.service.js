/**
 * ------------------------------------------------------------------
 * File: hoaSettings.service.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * hoaSettings.controller
 * ------------------------------------------------------------------
 */

const HOASettings = require('../model/hoaSettings.model');
const HOAMembership = require('../../hoa/model/hoaMembership.model');
const HOA = require('../../hoa/model/hoa.model');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const logger = require('../../../../../common/logger');
const { recalculateFutureScheduleInvoicesForHoa } = require('../../owners/services/unitScheduleRecalc.service');
const { logActivity } = require('../../dashboard/service/activity.service');
const { notifyHoaFeeUpdatedInAppInBackground } = require('../../../../../common/helpers/hoaCommunityNotify.helper');

/** HOA Owners have no HOAMembership; allow read-only settings access for their community. */
async function ownerCanAccessHoa(userId, hoaIdParam) {
  const { fetchUserWithResolvedRole } = require('../../../../../common/helpers/companyRoleHelper');
  const { user, role } = await fetchUserWithResolvedRole(userId, 'hoaInfo propertyIds role companyId companyRoleId');
  const roleName = role?.name ? String(role.name) : '';
  if (!/^hoa owner$/i.test(roleName)) return false;

  const target = String(hoaIdParam);
  if (user?.hoaInfo?.hoaId && String(user.hoaInfo.hoaId) === target) return true;

  const propertyIds = Array.isArray(user?.propertyIds) ? user.propertyIds.filter(Boolean) : [];
  if (propertyIds.length === 0) return false;

  const props = await Property.find({ _id: { $in: propertyIds } }).select('hoaId').lean();
  return props.some((p) => p.hoaId && String(p.hoaId) === target);
}

/**
 * Resolve the active hoaId for a user.
 * Priority:
 *  1. Explicit hoaId param (validated against membership or owner linkage)
 *  2. req.hoaContext.hoaId set by hoaDataIsolation middleware
 *  3. First active membership
 *  4. HOA matched by user.hoaInfo.communityName (auto-created on signup)
 */
async function resolveHoaId(userId, hoaIdParam, hoaContext) {
  // 1. Explicit param - board membership or linked HOA owner
  if (hoaIdParam) {
    const membership = await HOAMembership.findOne({
      hoaId: hoaIdParam,
      userId,
      status: 'active',
    }).lean();
    if (membership) return { hoaId: String(hoaIdParam), role: membership.role };
    if (await ownerCanAccessHoa(userId, hoaIdParam)) {
      return { hoaId: String(hoaIdParam), role: 'member' };
    }
    throw new Error('You are not an active member of this HOA');
  }

  // 2. From middleware context
  if (hoaContext?.hoaId) {
    const membership = await HOAMembership.findOne({
      hoaId: hoaContext.hoaId,
      userId,
      status: 'active',
    }).lean();
    return { hoaId: String(hoaContext.hoaId), role: membership?.role || 'member' };
  }

  // 3. First active membership
  const firstMembership = await HOAMembership.findOne({ userId, status: 'active' }).lean();
  if (firstMembership) {
    return { hoaId: String(firstMembership.hoaId), role: firstMembership.role };
  }

  // 4. Match by user.hoaInfo.hoaId (stable ID stored at signup)
  const user = await User.findById(userId).lean();
  if (user?.hoaInfo?.hoaId) {
    const membership = await HOAMembership.findOne({
      hoaId: user.hoaInfo.hoaId,
      userId,
      status: 'active',
    }).lean();
    if (membership) return { hoaId: String(user.hoaInfo.hoaId), role: membership.role };
    // HOA exists but membership not yet created - treat as admin (signup flow)
    const hoa = await HOA.findById(user.hoaInfo.hoaId).lean();
    if (hoa) return { hoaId: String(hoa._id), role: 'admin' };
  }

  // 5. Fallback: match by user.hoaInfo.communityName (legacy users without hoaId)
  const userFallback = await User.findById(userId).lean();
  const communityName = userFallback?.hoaInfo?.communityName;
  if (communityName) {
    const hoa = await HOA.findOne({
      name: communityName,
      isDeleted: { $ne: true },
    }).lean();
    if (hoa) {
      return { hoaId: String(hoa._id), role: 'admin' };
    }
  }

  throw new Error('No active HOA found for this user');
}

async function getPaymentPolicy(userId, hoaIdParam, hoaContext) {
  const { hoaId } = await resolveHoaId(userId, hoaIdParam, hoaContext);
  const { loadAcceptPartialPaymentsForHoa } = require('../helpers/hoaPartialPaymentPolicy.helper');
  const acceptPartialPayments = await loadAcceptPartialPaymentsForHoa(hoaId);
  return { hoaId, acceptPartialPayments };
}

async function getSettings(userId, hoaIdParam, hoaContext) {
  const { hoaId } = await resolveHoaId(userId, hoaIdParam, hoaContext);
  const settings = await HOASettings.findOne({ hoaId }).lean();

  // Return settings merged with HOA metadata so the frontend knows which HOA it's for
  const hoa = await HOA.findById(hoaId).lean();
  return {
    hoaId,
    hoaName: hoa?.name,
    numberOfUnits: hoa?.numberOfUnits,
    associationType: hoa?.associationType,
    propertyAddress: hoa?.propertyAddress,
    ...(settings || {}),
  };
}

async function upsertSettings(userId, hoaIdParam, hoaContext, payload) {
  const { hoaId, role } = await resolveHoaId(userId, hoaIdParam, hoaContext);

  if (role !== 'admin') throw new Error('Only HOA admins can manage these settings');

  const prev = await HOASettings.findOne({ hoaId }).lean();

  const { recurringFee, paymentTerm, lateFee, lateFees, paymentReminders } = payload;
  const update = { updatedBy: userId };

  if (recurringFee !== undefined) {
    if (recurringFee.enabled !== undefined) update['recurringFee.enabled'] = recurringFee.enabled;
    if (recurringFee.amount !== undefined) update['recurringFee.amount'] = Number(recurringFee.amount);
    if (recurringFee.frequency !== undefined) update['recurringFee.frequency'] = recurringFee.frequency;
    if (recurringFee.tenure !== undefined) update['recurringFee.tenure'] = Number(recurringFee.tenure);
  }

  if (paymentTerm !== undefined) {
    if (paymentTerm.dueDay !== undefined) update['paymentTerm.dueDay'] = Number(paymentTerm.dueDay);
    if (paymentTerm.gracePeriodDays !== undefined) update['paymentTerm.gracePeriodDays'] = Number(paymentTerm.gracePeriodDays);
    if (paymentTerm.acceptPartialPayments !== undefined) update['paymentTerm.acceptPartialPayments'] = paymentTerm.acceptPartialPayments;
  }

  if (lateFees !== undefined) {
    update.lateFees = Array.isArray(lateFees) ? lateFees : [];
  }

  if (lateFee !== undefined) {
    if (lateFee.enabled !== undefined) update['lateFee.enabled'] = lateFee.enabled;
    if (lateFee.applyAfterDays !== undefined) update['lateFee.applyAfterDays'] = Number(lateFee.applyAfterDays);
    if (lateFee.initialType !== undefined) update['lateFee.initialType'] = lateFee.initialType;
    if (lateFee.initialAmount !== undefined) update['lateFee.initialAmount'] = Number(lateFee.initialAmount);
    if (lateFee.initialPercentage !== undefined) update['lateFee.initialPercentage'] = Number(lateFee.initialPercentage);
    if (lateFee.dailyEnabled !== undefined) update['lateFee.dailyEnabled'] = lateFee.dailyEnabled;
    if (lateFee.dailyType !== undefined) update['lateFee.dailyType'] = lateFee.dailyType;
    if (lateFee.dailyAmount !== undefined) update['lateFee.dailyAmount'] = Number(lateFee.dailyAmount);
    if (lateFee.dailyPercentage !== undefined) update['lateFee.dailyPercentage'] = Number(lateFee.dailyPercentage);
    if (lateFee.maxAmount !== undefined) update['lateFee.maxAmount'] = lateFee.maxAmount ? Number(lateFee.maxAmount) : null;
  }

  if (paymentReminders !== undefined) {
    if (paymentReminders.enabled !== undefined) update['paymentReminders.enabled'] = paymentReminders.enabled;
    if (paymentReminders.timezone !== undefined) {
      update['paymentReminders.timezone'] = paymentReminders.timezone || null;
    }
    if (paymentReminders.onDueDate !== undefined) update['paymentReminders.onDueDate'] = paymentReminders.onDueDate;
    if (paymentReminders.respectGracePeriod !== undefined) {
      update['paymentReminders.respectGracePeriod'] = paymentReminders.respectGracePeriod;
    }
    if (paymentReminders.channels !== undefined) {
      if (paymentReminders.channels.email !== undefined) {
        update['paymentReminders.channels.email'] = paymentReminders.channels.email;
      }
      if (paymentReminders.channels.inApp !== undefined) {
        update['paymentReminders.channels.inApp'] = paymentReminders.channels.inApp;
      }
      if (paymentReminders.channels.push !== undefined) {
        update['paymentReminders.channels.push'] = paymentReminders.channels.push;
      }
    }
    if (paymentReminders.beforeDueDate !== undefined) {
      if (paymentReminders.beforeDueDate.enabled !== undefined) {
        update['paymentReminders.beforeDueDate.enabled'] = paymentReminders.beforeDueDate.enabled;
      }
      if (paymentReminders.beforeDueDate.intervals !== undefined) {
        update['paymentReminders.beforeDueDate.intervals'] = paymentReminders.beforeDueDate.intervals;
      }
    }
    if (paymentReminders.afterDueDate !== undefined) {
      const after = paymentReminders.afterDueDate;
      if (after.enabled !== undefined) update['paymentReminders.afterDueDate.enabled'] = after.enabled;
      if (after.intervals !== undefined) update['paymentReminders.afterDueDate.intervals'] = after.intervals;
      if (after.continueOverdueReminders !== undefined) {
        update['paymentReminders.afterDueDate.continueOverdueReminders'] = after.continueOverdueReminders;
      }
      if (after.overdueFrequencyDays !== undefined) {
        update['paymentReminders.afterDueDate.overdueFrequencyDays'] = Number(after.overdueFrequencyDays);
      }
      if (after.maxOverdueReminders !== undefined) {
        update['paymentReminders.afterDueDate.maxOverdueReminders'] = Number(after.maxOverdueReminders);
      }
    }
    if (paymentReminders.templates !== undefined) {
      for (const key of ['beforeDue', 'onDueDate', 'overdue']) {
        const tpl = paymentReminders.templates[key];
        if (!tpl) continue;
        if (tpl.subject !== undefined) update[`paymentReminders.templates.${key}.subject`] = tpl.subject;
        if (tpl.body !== undefined) update[`paymentReminders.templates.${key}.body`] = tpl.body;
      }
    }
  }

  const settings = await HOASettings.findOneAndUpdate(
    { hoaId },
    { $set: update },
    { upsert: true, new: true, runValidators: true }
  );

  const nextPlain = typeof settings?.toObject === 'function'
    ? settings.toObject()
    : settings && typeof settings === 'object'
      ? { ...settings }
      : {};

  const prevAmt = prev && prev.recurringFee ? Number(prev.recurringFee.amount) : NaN;
  const nextAmt = Number(nextPlain.recurringFee && nextPlain.recurringFee.amount);
  const prevDay = prev && prev.paymentTerm ? Number(prev.paymentTerm.dueDay) : NaN;
  const nextDay = Number(nextPlain.paymentTerm && nextPlain.paymentTerm.dueDay);
  const prevTen = prev && prev.recurringFee ? Number(prev.recurringFee.tenure) : NaN;
  const nextTen = Number(nextPlain.recurringFee && nextPlain.recurringFee.tenure);

  const billingChanged =
    !prev ||
    prevAmt !== nextAmt ||
    prevDay !== nextDay ||
    prevTen !== nextTen;

  const snapshotBilling = (doc) => ({
    recurringEnabled: !!(doc && doc.recurringFee && doc.recurringFee.enabled),
    recurringAmount: Number(doc && doc.recurringFee && doc.recurringFee.amount),
    recurringFrequency: doc && doc.recurringFee ? doc.recurringFee.frequency : null,
    recurringTenure: Number(doc && doc.recurringFee && doc.recurringFee.tenure),
    dueDay: Number(doc && doc.paymentTerm && doc.paymentTerm.dueDay),
    gracePeriodDays: Number(doc && doc.paymentTerm && doc.paymentTerm.gracePeriodDays),
    acceptPartialPayments: !!(doc && doc.paymentTerm && doc.paymentTerm.acceptPartialPayments),
    lateFeeEnabled: !!(doc && doc.lateFee && doc.lateFee.enabled),
    lateApplyAfterDays: Number(doc && doc.lateFee && doc.lateFee.applyAfterDays),
    lateInitialType: doc && doc.lateFee ? doc.lateFee.initialType : null,
    lateInitialAmount: Number(doc && doc.lateFee && doc.lateFee.initialAmount),
    lateInitialPercentage: Number(doc && doc.lateFee && doc.lateFee.initialPercentage),
    lateDailyEnabled: !!(doc && doc.lateFee && doc.lateFee.dailyEnabled),
    lateDailyType: doc && doc.lateFee ? doc.lateFee.dailyType : null,
    lateDailyAmount: Number(doc && doc.lateFee && doc.lateFee.dailyAmount),
    lateDailyPercentage: Number(doc && doc.lateFee && doc.lateFee.dailyPercentage),
    lateMaxAmount: doc && doc.lateFee && doc.lateFee.maxAmount != null
      ? Number(doc.lateFee.maxAmount)
      : null,
  });

  const prevBilling = snapshotBilling(prev);
  const nextBilling = snapshotBilling(nextPlain);

  if (billingChanged && Number.isFinite(nextAmt) && nextAmt > 0) {
    try {
      await recalculateFutureScheduleInvoicesForHoa(String(hoaId), nextPlain);
    } catch (e) {
      logger.error('[upsertSettings] recalculateFutureScheduleInvoicesForHoa:', e && e.message);
    }
  }

  const hoa = await HOA.findById(hoaId).select('name').lean();
  const activityMessages = [];

  if (!prev) {
    activityMessages.push('HOA billing settings configured.');
  } else {
    if (prevBilling.gracePeriodDays !== nextBilling.gracePeriodDays) {
      activityMessages.push('Grace period updated.');
    }

    if (prevBilling.acceptPartialPayments !== nextBilling.acceptPartialPayments) {
      activityMessages.push(
        nextBilling.acceptPartialPayments
          ? 'Partial payments enabled.'
          : 'Partial payments disabled.'
      );
    }

    if (
      prevBilling.recurringEnabled !== nextBilling.recurringEnabled
      || prevBilling.recurringFrequency !== nextBilling.recurringFrequency
    ) {
      activityMessages.push('Recurring fee schedule updated.');
    }

    const lateChanged =
      prevBilling.lateFeeEnabled !== nextBilling.lateFeeEnabled
      || prevBilling.lateApplyAfterDays !== nextBilling.lateApplyAfterDays
      || prevBilling.lateInitialType !== nextBilling.lateInitialType
      || prevBilling.lateInitialAmount !== nextBilling.lateInitialAmount
      || prevBilling.lateInitialPercentage !== nextBilling.lateInitialPercentage
      || prevBilling.lateDailyEnabled !== nextBilling.lateDailyEnabled
      || prevBilling.lateDailyType !== nextBilling.lateDailyType
      || prevBilling.lateDailyAmount !== nextBilling.lateDailyAmount
      || prevBilling.lateDailyPercentage !== nextBilling.lateDailyPercentage
      || prevBilling.lateMaxAmount !== nextBilling.lateMaxAmount;
    if (lateChanged) {
      activityMessages.push('Late fee settings updated.');
    }

    const prevReminders = prev.paymentReminders || {};
    const nextReminders = nextPlain.paymentReminders || {};
    const remindersChanged =
      prevReminders.enabled !== nextReminders.enabled
      || JSON.stringify(prevReminders.beforeDueDate || {}) !== JSON.stringify(nextReminders.beforeDueDate || {})
      || JSON.stringify(prevReminders.afterDueDate || {}) !== JSON.stringify(nextReminders.afterDueDate || {})
      || JSON.stringify(prevReminders.channels || {}) !== JSON.stringify(nextReminders.channels || {});
    if (remindersChanged) {
      activityMessages.push('Payment reminder settings updated.');
    }

    if (billingChanged) {
      activityMessages.push('HOA billing settings updated.');
    }
  }

  for (const description of activityMessages) {
    await logActivity({
      userId,
      action: 'UPDATE',
      module: 'Settings',
      entityId: hoaId,
      entityName: hoa?.name || 'HOA Settings',
      description,
    });
  }

  if (activityMessages.length > 0) {
    const feeAmount = Number.isFinite(nextAmt) ? nextAmt.toFixed(2) : null;
    const feeChanged = !prev || prevAmt !== nextAmt || prevBilling.recurringEnabled !== nextBilling.recurringEnabled;
    const customMessage = feeChanged && feeAmount
      ? `HOA fee settings have been updated${hoa?.name ? ` for ${hoa.name}` : ''}${nextBilling.recurringEnabled ? ` ($${feeAmount})` : ' (disabled)'}.`
      : `HOA fee settings have been updated${hoa?.name ? ` for ${hoa.name}` : ''}.`;
    notifyHoaFeeUpdatedInAppInBackground({
      hoaId,
      hoaName: hoa?.name || '',
      customMessage,
      actorUserId: userId,
    });
  }

  return settings;
}

module.exports = { getSettings, getPaymentPolicy, upsertSettings };
