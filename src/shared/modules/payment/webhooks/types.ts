/**
 * ------------------------------------------------------------------
 * File: types.ts
 * Module: Payment Module
 *
 * Purpose:
 * Backend utility/module providing helper functions for types.ts.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Straddle Payment Status Webhook Types
 * Based on official Straddle API documentation
 */

export interface StraddleWebhookPayload {
  account_id: string;
  data: PayoutEventData;
  event_id: string;
  event_type: 'payout.event.v1';
}

export interface PayoutEventData {
  id: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  description?: string;
  paykey?: string;
  paykey_details?: PaykeyDetails;
  customer_details?: CustomerDetails;
  status_details?: StatusDetails;
  status_history?: StatusHistoryItem[];
  payment_rail?: string;
  consent_type?: string;
  effective_at?: string;
  payment_date?: string;
  processed_at?: string;
  created_at?: string;
  updated_at?: string;
  external_id?: string;
  funding_ids?: string[];
  related_payments?: RelatedPayment[];
  is_refund?: boolean;
  is_resubmit?: boolean;
  has_resubmit?: boolean;
  metadata?: Record<string, any>;
  config?: Record<string, any>;
  device?: DeviceInfo;
}

export interface PaykeyDetails {
  id: string;
  customer_id: string;
  label?: string;
  balance?: number;
}

export interface CustomerDetails {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  customer_type?: string;
}

export interface StatusDetails {
  changed_at?: string;
  code?: string;
  message?: string;
  reason?: string;
  source?: string;
}

export interface StatusHistoryItem {
  status: string;
  changed_at?: string;
  code?: string;
  message?: string;
  reason?: string;
  source?: string;
}

export interface RelatedPayment {
  id: string;
  payment_type?: string;
  relationship?: string;
}

export interface DeviceInfo {
  ip_address?: string;
}

export type PaymentStatus = 
  | 'created'
  | 'scheduled'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'on_hold'
  | 'reversed';

export interface WebhookProcessResult {
  duplicate: boolean;
  event: any;
}
