'use strict';

function toUserFriendlyPayloadMessage(status, detail) {
  const message = String(detail || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('merchant name') && lower.includes('unique')) {
    return 'This business name is already registered in Payload. Please enter a different business name and try again.';
  }
  if (lower.includes('invalid merchant name')) {
    return 'Please enter a valid business name using letters, numbers, and common punctuation.';
  }
  if (status === 401) {
    return 'Payload rejected the server API key. Ask your platform admin to verify PAYLOAD_SECRET_KEY (sandbox keys start with test_secret_key_) in the PropMv server environment.';
  }
  if (lower.includes('payload authentication') || lower.includes('payload auth')) {
    return 'Payload rejected the server API key. Verify PAYLOAD_SECRET_KEY on the PropMv server.';
  }
  if (status === 403) {
    if (lower.includes('processing account') || lower.includes('processing_accounts')) {
      return 'Your Payload API key cannot create processing accounts via the server API. Complete onboarding using the embedded Payload form, or ask Payload to enable processing account API access for your platform key.';
    }
    return 'You do not have permission to perform this Payload action.';
  }
  if (status === 404) {
    return 'The requested Payload record could not be found.';
  }
  if (status === 409) {
    return 'This Payload business account already exists.';
  }
  if (status === 422 || status === 400) {
    if (lower.includes('billing address')) {
      return 'Billing address on this payment method is invalid. Update your saved card billing address in Settings and try again.';
    }
    // Check21 / check-image InvalidAttributes often lists "receiver" or "check_images" —
    // never map those to Card/ACH "saved payment method" copy.
    if (
      lower.includes('check_images')
      || lower.includes('check_front')
      || lower.includes('check_back')
      || lower.includes('unreadable check')
    ) {
      return message && !message.startsWith('Invalid Payload')
        ? message
        : 'Check21 submission was rejected by Payload. Verify both check images and try again.';
    }
    if (
      (lower.includes('sender') || lower.includes('receiver'))
      && (lower.includes('payment_method') || lower.includes('method_id') || lower.includes('method'))
    ) {
      return 'Payload could not process this payment with the saved payment method. Try again or re-add the payment method in Settings.';
    }
    if (lower.includes('payment_method_id') && lower.includes('conv_fee')) {
      return 'Payload rejected the payment request. Try again or re-add your payment method in Settings.';
    }
    if (lower.includes('payment_method_id')) {
      return 'Payload could not use this saved payment method. Re-add it in Settings or choose another method.';
    }
    if (message && !message.startsWith('Invalid Payload')) return message;
    return 'Some business details are invalid. Please review the form and try again.';
  }
  if (status === 429) {
    return 'Payload is busy right now. Please wait a moment and try again.';
  }
  if (lower.includes('not configured') || lower.includes('platform id')) {
    return message || 'Payload platform is not configured. Contact support.';
  }
  if (lower.includes('billable merchant is required') || lower.includes('no active payload merchant')) {
    return message || 'An active Payload business merchant is required before owners or tenants can save cards or bank accounts.';
  }
  if (status === 503 || lower.includes('unreachable') || lower.includes('etimedout') || lower.includes('econnaborted')) {
    return message && !message.startsWith('Invalid Payload')
      ? message
      : 'Payload is taking too long to respond. Please try again - bank payments can take up to a minute.';
  }
  if (status >= 500) {
    if (message && !message.startsWith('Invalid Payload') && message.length < 220) {
      return message;
    }
    return 'Payload is temporarily unavailable. Please try again in a few minutes.';
  }

  return message || 'Something went wrong while connecting to Payload. Please try again.';
}

module.exports = {
  toUserFriendlyPayloadMessage,
};
