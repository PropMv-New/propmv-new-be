'use strict';

function detectMultiMerchantPayinIssues(merchantContexts = []) {
  const merchantIds = [...new Set(
    merchantContexts
      .map((ctx) => ctx?.merchantId)
      .filter(Boolean)
      .map(String),
  )];

  if (merchantIds.length <= 1) {
    return [];
  }

  return [{
    code: 'MULTI_MERCHANT_ALLOCATION',
    message:
      'These invoices route to different HOA business accounts. Pay each group separately or contact your HOA board.',
    merchantIds,
    allocations: merchantContexts,
  }];
}

module.exports = {
  detectMultiMerchantPayinIssues,
};
