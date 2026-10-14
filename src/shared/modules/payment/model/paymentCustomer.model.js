'use strict';

/**
 * ------------------------------------------------------------------
 * File: paymentCustomer.model.js
 * Module: Payment Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * expense.controller, payment.controller
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');

const gatewayResultSchema = new mongoose.Schema({
  success:   { type: Boolean, required: true },
  gatewayId: { type: String },
  status:    { type: String },
  raw:       { type: mongoose.Schema.Types.Mixed },
  error:     { type: String },
}, { _id: false });

const addressSchema = new mongoose.Schema({
  line1: { type: String },
  city:  { type: String },
  state: { type: String },
  zip:   { type: String },
}, { _id: false });

/**
 * Local mirror of a Straddle Customer (payer).
 * SaaS scope: always tied to an embedded Straddle Account (landlord / HOA).
 */
const paymentCustomerSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, required: true },
  phone:      { type: String },
  type:       { type: String, enum: ['individual', 'business'], default: 'individual' },
  externalId: { type: String, index: true },

  // SaaS scoping - merchant account that owns this customer
  straddleAccountId:  { type: String, default: null, index: true }, // Straddle UUID for Straddle-Account-Id header
  straddleAccountRef: { type: mongoose.Schema.Types.ObjectId, ref: 'StraddleAccount', default: null, index: true },
  entityType:         { type: String, default: null, index: true }, // landlord | hoa | …
  entityId:           { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

  // Individual
  dob:       { type: String },
  ssn:       { type: String },
  address:   { type: addressSchema },
  ipAddress: { type: String },

  // Business
  ein:               { type: String },
  legalBusinessName: { type: String },
  website:           { type: String },

  // Status from Straddle (pending | review | verified | rejected | …)
  status:            { type: String, default: null, index: true },
  statusDetail:      { type: mongoose.Schema.Types.Mixed, default: null },
  verificationStatus:{ type: String, default: null },

  straddle:      { type: gatewayResultSchema, default: null },
  straddleReady: { type: Boolean, default: false },

  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
  lastSyncedAt:  { type: Date, default: null },
  lastWebhookAt: { type: Date, default: null },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

paymentCustomerSchema.index({ createdBy: 1, straddleAccountId: 1, isDeleted: 1 });
paymentCustomerSchema.index({ 'straddle.gatewayId': 1 }, { sparse: true });

module.exports = mongoose.models.PaymentCustomer ||
  mongoose.model('PaymentCustomer', paymentCustomerSchema);
