/**
 * ------------------------------------------------------------------
 * File: payment.service.js
 * Module: Payment Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

import { PaymentProvider } from "../../../payments/payment.provider.js";

const paymentProvider = new PaymentProvider();

/**
 * PaymentsService
 *
 * Represents the Payments Service controller/model class.
 */
export class PaymentsService {

  /**
   * Create tenant or landlord customer
   */
  async createCustomer({ provider, name, email, phone }) {
    return paymentProvider.createCustomer(provider, {
      name,
      email,
      phone
    });
  }

  /**
   * Rent Payment
   */
  async payRent({
    provider,
    amount,
    customerId,
    paykeyId,
    paymentMethodId,
    propertyId,
    tenantId
  }) {

    if (provider === "straddle") {
      return paymentProvider.charge("straddle", {
        amount,
        paykeyId,
        description: `Rent payment for property ${propertyId}`,
        metadata: {
          tenantId,
          propertyId
        }
      });
    }

    if (provider === "stripe") {
      return paymentProvider.charge("stripe", {
        amount,
        customerId,
        paymentMethodId,
        description: `Rent payment for property ${propertyId}`,
        metadata: {
          tenantId,
          propertyId
        }
      });
    }

    throw new Error("Unsupported provider");
  }

  /**
   * Landlord payout
   */
  async payoutLandlord({
    provider,
    amount,
    paykeyId,
    accountId
  }) {

    if (provider === "straddle") {
      return paymentProvider.payout("straddle", {
        amount,
        paykeyId
      });
    }

    if (provider === "stripe") {
      return paymentProvider.payout("stripe", {
        amount,
        accountId
      });
    }

    throw new Error("Unsupported provider");
  }

}