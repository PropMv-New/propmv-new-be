/**
 * ------------------------------------------------------------------
 * File: payment.provider.js
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for payment.provider.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

import { StraddleService } from "../services/straddle.service.js";
import { StripeService } from "./stripe.client.js";

/**
 * PaymentProvider
 *
 * Represents the Payment Provider controller/model class.
 */
export class PaymentProvider {
  constructor() {
    this.straddle = new StraddleService();
    this.stripe = new StripeService();
  }

  /**
   * Create Customer
   * @param {string} provider - "straddle" | "stripe"
   */
  async createCustomer(provider, payload) {
    if (provider === "straddle") {
      return this.straddle.createCustomer(payload);
    }
    if (provider === "stripe") {
      return this.stripe.createCustomer(payload);
    }
    throw new Error("Unsupported payment provider");
  }

  
//Charge (Rent / Deposit / Fees)
  async charge(provider, payload) {
    if (provider === "straddle") {
      return this.straddle.charge(payload); // ACH
    }
    if (provider === "stripe") {
      return this.stripe.charge(payload); // Card
    }
    throw new Error("Unsupported payment provider");
  }

  //payout (Landlord / Manager)
  async payout(provider, payload) {
    if (provider === "straddle") {
      return this.straddle.payout(payload);
    }
    if (provider === "stripe") {
      return this.stripe.payout(payload);
    }
    throw new Error("Unsupported payment provider");
  }
}