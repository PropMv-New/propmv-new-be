'use strict';

const LINKED_BANK_STATUS = {
  CREATED:    'created',
  ONBOARDING: 'onboarding',
  ACTIVE:     'active',
  REJECTED:   'rejected',
  INACTIVE:   'inactive',
  CANCELED:   'canceled',
};

const LINKED_BANK_PURPOSE = {
  CHARGES: 'charges',
  PAYOUTS: 'payouts',
  BILLING: 'billing',
};

const LINKED_BANK_WEBHOOK_EVENTS = [
  'linked_bank_account.created.v1',
  'linked_bank_account.event.v1',
  'linked_bank_account.updated.v1',
];

const LINKED_BANK_AUDIT_EVENTS = {
  LINKED_BANK_CREATED:   'LINKED_BANK_CREATED',
  LINKED_BANK_UPDATED:   'LINKED_BANK_UPDATED',
  LINKED_BANK_CANCELED:  'LINKED_BANK_CANCELED',
  LINKED_BANK_DELETED:   'LINKED_BANK_DELETED',
  LINKED_BANK_SYNCED:    'LINKED_BANK_SYNCED',
  LINKED_BANK_WEBHOOK:   'LINKED_BANK_WEBHOOK',
};

module.exports = {
  LINKED_BANK_STATUS,
  LINKED_BANK_PURPOSE,
  LINKED_BANK_WEBHOOK_EVENTS,
  LINKED_BANK_AUDIT_EVENTS,
};
