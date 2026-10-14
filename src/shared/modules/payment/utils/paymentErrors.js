/**
 * ------------------------------------------------------------------
 * File: paymentErrors.js
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for paymentErrors.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * PaymentError
 *
 * Represents the Payment Error controller/model class.
 */
export class PaymentError extends Error {
  constructor(message, status = 500, provider = null, details = null) {
    super(message);
    this.name = "PaymentError";
    this.status = status;
    this.provider = provider;
    this.details = details;
  }
}

export const handlePaymentError = (error, provider = "unknown") => {
  if (error.response) {
    throw new PaymentError(
      error.response.data?.message || "Payment provider error",
      error.response.status,
      provider,
      error.response.data
    );
  }

  if (error.request) {
    throw new PaymentError(
      "Payment provider did not respond",
      502,
      provider
    );
  }

  throw new PaymentError(error.message || "Unknown payment error", 500, provider);
};