const mongoose = require('mongoose');
const HOASettings = require('../../hoa-settings/model/hoaSettings.model');
const HOAMembership = require('../model/hoaMembership.model');
const Property = require('../../property/model/property.model');
const User = require('../../../../../shared/modules/users/models/user.model');
const StraddleAccount = require('../../../../../shared/modules/payment/account/model/straddleAccount.model');
const LinkedBankAccount = require('../../../../../shared/modules/payment/account/model/linkedBankAccount.model');
const PaymentCustomer = require('../../../../../shared/modules/payment/model/paymentCustomer.model');
const PaymentBankAccount = require('../../../../../shared/modules/payment/model/paymentBankAccount.model');
const { ENTITY_TYPE } = require('../../../../../shared/modules/payment/account/constants/account.constants');
const RainforestAccount = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestAccount.model');
const {
  RainforestDepositMethod,
} = require('../../../../../shared/modules/payment/providers/rainforest/model/rainforestDepositMethod.model');
const {
  buildHoaBillableMerchantQuery,
} = require('../../../../../shared/modules/payment/providers/rainforest/utils/rainforestBillableMerchant.util');
const PayloadAccount = require('../../../../../shared/modules/payment/providers/payload/model/payloadAccount.model');
const {
  PayloadDepositMethod,
} = require('../../../../../shared/modules/payment/providers/payload/model/payloadDepositMethod.model');
const {
  buildHoaBillableMerchantQuery: buildPayloadHoaBillableMerchantQuery,
} = require('../../../../../shared/modules/payment/providers/payload/utils/payloadBillableMerchant.util');
const { ENTITY_TYPE: PAYLOAD_ENTITY_TYPE } = require('../../../../../shared/modules/payment/providers/payload/constants/payload.constants');

function isHoaSettingsComplete(settings) {
  if (!settings) return false;
  const rf = settings.recurringFee || {};
  const pt = settings.paymentTerm || {};
  const lf = settings.lateFee || {};
  const lateFeesArr = Array.isArray(settings.lateFees) ? settings.lateFees : [];

  const recurringOk =
    rf.enabled === true &&
    Number(rf.amount || 0) > 0 &&
    Boolean(rf.frequency) &&
    Number(rf.tenure || 0) > 0;

  const paymentTermOk =
    Number(pt.dueDay || 0) >= 1 &&
    Number(pt.gracePeriodDays ?? 0) >= 0;

  const initialAmt =
    lf.initialType === 'percentage'
      ? Number(lf.initialPercentage || 0)
      : Number(lf.initialAmount || 0);
  const dailyAmt =
    lf.dailyType === 'percentage'
      ? Number(lf.dailyPercentage || 0)
      : Number(lf.dailyAmount || 0);

  const lateFeeOk =
    !lf.enabled ||
    lateFeesArr.length > 0 ||
    (Number(lf.applyAfterDays ?? 0) >= 0 &&
      initialAmt > 0 &&
      (!lf.dailyEnabled || dailyAmt > 0));

  return recurringOk && paymentTermOk && lateFeeOk;
}

function isLinkedBankSelectable(bank) {
  const status = String(bank?.status || '').toLowerCase();
  if (['rejected', 'canceled', 'inactive'].includes(status)) return false;
  const ver = String(bank?.verificationStatus || '').toLowerCase();
  if (ver === 'failed' || ver === 'canceled') return false;
  return Boolean(bank?.last4 || bank?._id);
}

function isLinkedBankActiveForDeposit(bank) {
  const status = String(bank?.status || '').toLowerCase();
  const ver = String(bank?.verificationStatus || '').toLowerCase();
  if (status === 'active') return true;
  if (ver === 'verified') return true;
  if (bank?.straddleReady) return true;
  return false;
}

function isRainforestDepositSelectable(deposit) {
  const status = String(deposit?.status || '').toUpperCase();
  if (status === 'REPLACED') return false;
  return Boolean(deposit?.last4 || deposit?.depositMethodId || deposit?._id);
}

function isRainforestDepositActiveForPayout(deposit) {
  return String(deposit?.status || '').toUpperCase() === 'ACTIVE';
}

/** Payload deposit methods use the same status model as Rainforest. */
const isPayloadDepositSelectable = isRainforestDepositSelectable;
const isPayloadDepositActiveForPayout = isRainforestDepositActiveForPayout;

/** Board onboarding: bank captured on processing account before Payload marks payout ACTIVE. */
function isPayloadDepositActiveForOnboarding(deposit) {
  if (!isPayloadDepositSelectable(deposit)) return false;
  const status = String(deposit?.status || '').toUpperCase();
  if (status === 'ACTIVE') return true;
  if (status === 'CREATED') return true;
  return false;
}

function accumulateSelectableDeposits(deposits, seenIds) {
  let bankCount = 0;
  let activeBankCount = 0;

  for (const deposit of deposits) {
    const id = deposit?.depositMethodId
      ? String(deposit.depositMethodId)
      : deposit?._id
        ? String(deposit._id)
        : '';
    if (!id || seenIds.has(id) || !isRainforestDepositSelectable(deposit)) continue;
    seenIds.add(id);
    bankCount += 1;
    if (isRainforestDepositActiveForPayout(deposit)) activeBankCount += 1;
  }

  return { bankCount, activeBankCount };
}

async function findHoaMerchantAccounts(AccountModel, billableQuery, hoaIdStr, entityType) {
  if (billableQuery) {
    const billableAccounts = await AccountModel.find(billableQuery).select('_id').lean();
    if (billableAccounts.length > 0) return billableAccounts;
  }

  return AccountModel.find({
    isDeleted: { $ne: true },
    entityType,
    'metadata.hoaId': hoaIdStr,
  })
    .select('_id')
    .lean();
}

async function resolveActiveHoaId(userId, hoaIdParam, hoaContext) {
  const targetHoaId = hoaIdParam || hoaContext?.hoaId;
  if (!targetHoaId) {
    const err = new Error('Active HOA context is required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.Types.ObjectId.isValid(String(targetHoaId))) {
    const err = new Error('Invalid HOA id');
    err.status = 400;
    throw err;
  }

  const membership = await HOAMembership.findOne({
    userId,
    hoaId: targetHoaId,
    status: 'active',
  }).lean();
  if (!membership) {
    const err = new Error('You are not an active member of this HOA');
    err.status = 403;
    err.statusCode = 403;
    throw err;
  }

  return String(targetHoaId);
}

/**
 * Board members (HOAMembership) and HOA owners (hoaInfo / linked properties) may use
 * community-scoped owner payment flows. Owners typically have no HOAMembership row.
 */
async function assertUserCanAccessHoaCommunity(userId, hoaIdParam) {
  const targetHoaId = String(hoaIdParam);
  if (!mongoose.Types.ObjectId.isValid(targetHoaId)) {
    const err = new Error('Invalid HOA id');
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }

  const membership = await HOAMembership.findOne({
    userId,
    hoaId: targetHoaId,
    status: 'active',
  }).lean();
  if (membership) {
    return targetHoaId;
  }

  const user = await User.findById(userId).select('hoaInfo propertyIds').lean();
  if (user?.hoaInfo?.hoaId && String(user.hoaInfo.hoaId) === targetHoaId) {
    return targetHoaId;
  }

  const propertyIds = (user?.propertyIds || [])
    .map((entry) => (entry && entry._id ? entry._id : entry))
    .filter(Boolean);
  if (propertyIds.length > 0) {
    const linkedToHoa = await Property.exists({
      _id: { $in: propertyIds },
      hoaId: targetHoaId,
      isDeleted: { $ne: true },
      isArchieved: { $ne: true },
    });
    if (linkedToHoa) {
      return targetHoaId;
    }
  }

  const err = new Error('You are not an active member of this HOA');
  err.status = 403;
  err.statusCode = 403;
  throw err;
}

async function summarizeCommunityLinkedBanks(hoaId) {
  const hoaIdStr = String(hoaId);
  const seenIds = new Set();
  let bankCount = 0;
  let activeBankCount = 0;

  const accounts = await StraddleAccount.find({
    entityType: ENTITY_TYPE.HOA,
    isDeleted: { $ne: true },
    $or: [{ 'metadata.hoaId': hoaIdStr }, { entityId: hoaIdStr }],
  })
    .select('_id')
    .lean();

  if (accounts.length > 0) {
    const accountIds = accounts.map((a) => a._id);
    const banks = await LinkedBankAccount.find({
      straddleAccountRef: { $in: accountIds },
      isDeleted: { $ne: true },
    }).lean();

    for (const bank of banks) {
      const id = bank?._id ? String(bank._id) : '';
      if (!id || seenIds.has(id) || !isLinkedBankSelectable(bank)) continue;
      seenIds.add(id);
      bankCount += 1;
      if (isLinkedBankActiveForDeposit(bank)) activeBankCount += 1;
    }
  }

  const customers = await PaymentCustomer.find({
    entityType: 'hoa',
    entityId: hoaIdStr,
    isDeleted: { $ne: true },
  })
    .select('_id')
    .lean();

  if (customers.length > 0) {
    const customerIds = customers.map((c) => c._id);
    const legacyBanks = await PaymentBankAccount.find({
      paymentCustomerId: { $in: customerIds },
      isDeleted: { $ne: true },
    }).lean();

    for (const bank of legacyBanks) {
      const id = bank?._id ? String(bank._id) : '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      bankCount += 1;
      if (bank.straddleReady || String(bank.verificationStatus || '').toLowerCase() === 'verified') {
        activeBankCount += 1;
      }
    }
  }

  const rainforestQuery = buildHoaBillableMerchantQuery(hoaIdStr);
  const rainforestAccounts = await findHoaMerchantAccounts(
    RainforestAccount,
    rainforestQuery,
    hoaIdStr,
    ENTITY_TYPE.HOA
  );
  if (rainforestAccounts.length > 0) {
    const rainforestDeposits = await RainforestDepositMethod.find({
      rainforestAccountRef: { $in: rainforestAccounts.map((account) => account._id) },
      isDeleted: { $ne: true },
    }).lean();
    const rainforestCounts = accumulateSelectableDeposits(rainforestDeposits, seenIds);
    bankCount += rainforestCounts.bankCount;
    activeBankCount += rainforestCounts.activeBankCount;
  }

  const payloadQuery = buildPayloadHoaBillableMerchantQuery(hoaIdStr);
  const payloadAccounts = await findHoaMerchantAccounts(
    PayloadAccount,
    payloadQuery,
    hoaIdStr,
    PAYLOAD_ENTITY_TYPE.HOA
  );
  if (payloadAccounts.length > 0) {
    const payloadDeposits = await PayloadDepositMethod.find({
      payloadAccountRef: { $in: payloadAccounts.map((account) => account._id) },
      isDeleted: { $ne: true },
    }).lean();
    for (const deposit of payloadDeposits) {
      const id = deposit?.depositMethodId
        ? String(deposit.depositMethodId)
        : deposit?._id
          ? String(deposit._id)
          : '';
      if (!id || seenIds.has(id) || !isPayloadDepositSelectable(deposit)) continue;
      seenIds.add(id);
      bankCount += 1;
      if (isPayloadDepositActiveForOnboarding(deposit)) activeBankCount += 1;
    }
  }

  return {
    bankCount,
    activeBankCount,
    hasLinkedBank: bankCount > 0,
    hasActiveLinkedBank: activeBankCount > 0,
  };
}

function formatCommunityDepositLabel(deposit) {
  const last4 = deposit?.last4 ? `••••${String(deposit.last4).slice(-4)}` : '';
  const primary = String(deposit?.bankName || deposit?.holderName || '').trim();
  return [primary, last4].filter(Boolean).join(' ').trim();
}

/**
 * First active HOA payout bank (Payload, then Rainforest, then Straddle).
 * Used when a unit invoice has no depositBankAccountId of its own.
 */
async function resolveHoaActiveDepositBank(hoaId) {
  const hoaIdStr = String(hoaId || '').trim();
  if (!hoaIdStr) return null;

  const payloadAccounts = await findHoaMerchantAccounts(
    PayloadAccount,
    buildPayloadHoaBillableMerchantQuery(hoaIdStr),
    hoaIdStr,
    PAYLOAD_ENTITY_TYPE.HOA
  );
  if (payloadAccounts.length > 0) {
    const payloadDeposits = await PayloadDepositMethod.find({
      payloadAccountRef: { $in: payloadAccounts.map((account) => account._id) },
      isDeleted: { $ne: true },
    }).lean();
    const active = payloadDeposits.find(
      (deposit) => isPayloadDepositSelectable(deposit) && isPayloadDepositActiveForPayout(deposit)
    );
    if (active) {
      return {
        id: active._id || active.depositMethodId,
        name: formatCommunityDepositLabel(active) || 'HOA Bank Account',
      };
    }
  }

  const rainforestAccounts = await findHoaMerchantAccounts(
    RainforestAccount,
    buildHoaBillableMerchantQuery(hoaIdStr),
    hoaIdStr,
    ENTITY_TYPE.HOA
  );
  if (rainforestAccounts.length > 0) {
    const rainforestDeposits = await RainforestDepositMethod.find({
      rainforestAccountRef: { $in: rainforestAccounts.map((account) => account._id) },
      isDeleted: { $ne: true },
    }).lean();
    const active = rainforestDeposits.find(
      (deposit) => isRainforestDepositSelectable(deposit) && isRainforestDepositActiveForPayout(deposit)
    );
    if (active) {
      return {
        id: active._id || active.depositMethodId,
        name: formatCommunityDepositLabel(active) || 'HOA Bank Account',
      };
    }
  }

  const straddleAccounts = await StraddleAccount.find({
    entityType: ENTITY_TYPE.HOA,
    isDeleted: { $ne: true },
    $or: [{ 'metadata.hoaId': hoaIdStr }, { entityId: hoaIdStr }],
  })
    .select('_id')
    .lean();
  if (straddleAccounts.length > 0) {
    const banks = await LinkedBankAccount.find({
      straddleAccountRef: { $in: straddleAccounts.map((account) => account._id) },
      isDeleted: { $ne: true },
    }).lean();
    const active = banks.find(
      (bank) => isLinkedBankSelectable(bank) && isLinkedBankActiveForDeposit(bank)
    );
    if (active) {
      return {
        id: active._id,
        name: formatCommunityDepositLabel(active) || 'HOA Bank Account',
      };
    }
  }

  return null;
}

async function getCommunityOnboardingStatus(userId, hoaIdParam, hoaContext) {
  const hoaId = await resolveActiveHoaId(userId, hoaIdParam, hoaContext);

  const [settings, hasProperties, linkedBanks] = await Promise.all([
    HOASettings.findOne({ hoaId }).lean(),
    Property.exists({
      hoaId,
      isDeleted: { $ne: true },
      isArchieved: { $ne: true },
    }).then(Boolean),
    summarizeCommunityLinkedBanks(hoaId),
  ]);

  return {
    hoaId,
    hoaSettingsConfigured: isHoaSettingsComplete(settings),
    hasProperties,
    linkedBanks,
  };
}

module.exports = {
  resolveActiveHoaId,
  assertUserCanAccessHoaCommunity,
  getCommunityOnboardingStatus,
  isHoaSettingsComplete,
  isLinkedBankActiveForDeposit,
  isLinkedBankSelectable,
  isRainforestDepositSelectable,
  isRainforestDepositActiveForPayout,
  isPayloadDepositSelectable,
  isPayloadDepositActiveForPayout,
  isPayloadDepositActiveForOnboarding,
  summarizeCommunityLinkedBanks,
  resolveHoaActiveDepositBank,
  formatCommunityDepositLabel,
};
