'use strict';

const ENTITY_TYPE = {
  LANDLORD:    'landlord',
  HOA:         'hoa',
  PROPERTY_MGR:'property_manager',
};

const ACCOUNT_STATUS = {
  CREATED:    'created',
  ONBOARDING: 'onboarding',
  ACTIVE:     'active',
  SUSPENDED:  'suspended',
  REJECTED:   'rejected',
  CLOSED:     'closed',
};

const ONBOARDING_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  SUBMITTED:   'submitted',
  COMPLETED:   'completed',
  FAILED:      'failed',
};

const VERIFICATION_STATUS = {
  UNVERIFIED: 'unverified',
  PENDING:    'pending',
  VERIFIED:   'verified',
  FAILED:     'failed',
};

const CAPABILITY_STATUS = {
  INACTIVE: 'inactive',
  PENDING:  'pending',
  ACTIVE:   'active',
  DISABLED: 'disabled',
};

const SETTLEMENT_STATUS = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  SETTLED:    'settled',
  FAILED:     'failed',
};

// Straddle account-related webhook event types
const ACCOUNT_WEBHOOK_EVENTS = [
  'account.created.v1',
  'account.event.v1',
  'capability_request.created.v1',
  'capability_request.event.v1',
  'representative.created.v1',
  'representative.event.v1',
];

const AUDIT_EVENTS = {
  ACCOUNT_CREATED:          'ACCOUNT_CREATED',
  ACCOUNT_UPDATED:          'ACCOUNT_UPDATED',
  ACCOUNT_RETRIEVED:        'ACCOUNT_RETRIEVED',
  ONBOARDING_STARTED:       'ONBOARDING_STARTED',
  ONBOARDING_SUBMITTED:     'ONBOARDING_SUBMITTED',
  VERIFICATION_STARTED:     'VERIFICATION_STARTED',
  VERIFICATION_COMPLETED:   'VERIFICATION_COMPLETED',
  STATUS_CHANGED:           'STATUS_CHANGED',
  CAPABILITIES_CHANGED:     'CAPABILITIES_CHANGED',
  ACCOUNT_ACTIVATED:        'ACCOUNT_ACTIVATED',
  ACCOUNT_DISABLED:         'ACCOUNT_DISABLED',
  WEBHOOK_RECEIVED:         'WEBHOOK_RECEIVED',
  WEBHOOK_PROCESSED:        'WEBHOOK_PROCESSED',
  WEBHOOK_FAILED:           'WEBHOOK_FAILED',
};

module.exports = {
  ENTITY_TYPE,
  ACCOUNT_STATUS,
  ONBOARDING_STATUS,
  VERIFICATION_STATUS,
  CAPABILITY_STATUS,
  SETTLEMENT_STATUS,
  ACCOUNT_WEBHOOK_EVENTS,
  AUDIT_EVENTS,
};
