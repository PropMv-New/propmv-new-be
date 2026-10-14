'use strict';

const {
  MERCHANT_ONBOARDING_STATUS,
  MERCHANT_STATUS,
} = require('../constants/payload.constants');

function mapPayloadProcessingStatus(processingStatus) {
  const s = String(processingStatus || '').toLowerCase();
  const map = {
    incomplete: 'NOT_STARTED',
    pending: 'PROCESSING',
    active: 'ACTIVE',
    in_review: 'IN_REVIEW',
    action_needed: 'NEEDS_INFORMATION',
    resubmit: 'NEEDS_INFORMATION',
    inactive: 'DEACTIVATED',
  };
  return map[s] || 'PROCESSING';
}

function mapPayloadMerchantStatus(merchantStatus, applicationStatus) {
  const merchant = String(merchantStatus || '').toUpperCase();
  const application = String(applicationStatus || '').toUpperCase();

  if (application === 'NEEDS_INFORMATION') return MERCHANT_ONBOARDING_STATUS.NEEDS_INFORMATION;
  if (application === 'IN_REVIEW') return MERCHANT_ONBOARDING_STATUS.IN_REVIEW;
  if (application === 'PROCESSING') return MERCHANT_ONBOARDING_STATUS.PROCESSING;
  if (application === 'IN_PROGRESS') return MERCHANT_ONBOARDING_STATUS.ONBOARDING;
  if (application === 'CREATED') return MERCHANT_ONBOARDING_STATUS.CREATED;
  if (application === 'COMPLETED') return MERCHANT_ONBOARDING_STATUS.ACTIVE;
  if (application === 'DECLINED') return MERCHANT_ONBOARDING_STATUS.DECLINED;

  if (merchant === MERCHANT_STATUS.ACTIVE) return MERCHANT_ONBOARDING_STATUS.ACTIVE;
  if (merchant === MERCHANT_STATUS.SUSPENDED) return MERCHANT_ONBOARDING_STATUS.SUSPENDED;
  if (merchant === MERCHANT_STATUS.DEACTIVATED) return MERCHANT_ONBOARDING_STATUS.DEACTIVATED;
  if (merchant === MERCHANT_STATUS.CANCELED) return MERCHANT_ONBOARDING_STATUS.CANCELED;
  if (merchant === MERCHANT_STATUS.ONBOARDING) return MERCHANT_ONBOARDING_STATUS.ONBOARDING;
  if (merchant === MERCHANT_STATUS.PENDING) return MERCHANT_ONBOARDING_STATUS.CREATED;

  return MERCHANT_ONBOARDING_STATUS.NOT_STARTED;
}

const DEPOSIT_BANK_EDITABLE_ONBOARDING_STATUSES = new Set([
  MERCHANT_ONBOARDING_STATUS.CREATED,
  MERCHANT_ONBOARDING_STATUS.ONBOARDING,
  MERCHANT_ONBOARDING_STATUS.NEEDS_INFORMATION,
]);

function resolveDepositBankSetupFlow(onboardingStatus) {
  const status = String(onboardingStatus || '').toUpperCase();
  if (status === MERCHANT_ONBOARDING_STATUS.ACTIVE) return 'hub';
  if (DEPOSIT_BANK_EDITABLE_ONBOARDING_STATUSES.has(status)) return 'onboarding';
  return 'blocked';
}

function depositBankBlockedReason(onboardingStatus) {
  const status = String(onboardingStatus || '').toUpperCase();
  if (
    status === MERCHANT_ONBOARDING_STATUS.PROCESSING
    || status === MERCHANT_ONBOARDING_STATUS.IN_REVIEW
  ) {
    return 'Your merchant application is under Payload review. Deposit banks cannot be added or edited until Payload approves the application or requests more information.';
  }
  if (status === MERCHANT_ONBOARDING_STATUS.NOT_STARTED) {
    return 'Complete merchant onboarding before adding a deposit bank.';
  }
  return 'Deposit banks cannot be added or edited for this merchant in its current status.';
}

function merchantStatusLabel(status) {
  switch (String(status || '').toUpperCase()) {
    case MERCHANT_ONBOARDING_STATUS.NOT_STARTED:
      return 'Not started';
    case MERCHANT_ONBOARDING_STATUS.CREATED:
      return 'Created';
    case MERCHANT_ONBOARDING_STATUS.ONBOARDING:
      return 'Onboarding in progress';
    case MERCHANT_ONBOARDING_STATUS.PROCESSING:
      return 'Under review';
    case MERCHANT_ONBOARDING_STATUS.NEEDS_INFORMATION:
      return 'Action required';
    case MERCHANT_ONBOARDING_STATUS.IN_REVIEW:
      return 'In review';
    case MERCHANT_ONBOARDING_STATUS.ACTIVE:
      return 'Active';
    case MERCHANT_ONBOARDING_STATUS.DECLINED:
      return 'Declined';
    case MERCHANT_ONBOARDING_STATUS.SUSPENDED:
      return 'Suspended';
    case MERCHANT_ONBOARDING_STATUS.DEACTIVATED:
      return 'Deactivated';
    case MERCHANT_ONBOARDING_STATUS.CANCELED:
      return 'Canceled';
    default:
      return 'Unknown';
  }
}

module.exports = {
  mapPayloadProcessingStatus,
  mapPayloadMerchantStatus,
  merchantStatusLabel,
  resolveDepositBankSetupFlow,
  depositBankBlockedReason,
  DEPOSIT_BANK_EDITABLE_ONBOARDING_STATUSES,
};
