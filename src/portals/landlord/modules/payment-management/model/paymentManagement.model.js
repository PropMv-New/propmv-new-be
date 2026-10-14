/**
 * ------------------------------------------------------------------
 * File: paymentManagement.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * paymentManagement.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// LandlordPayment Schema
const LandlordPaymentSchema = new Schema({
  propertyId: {
    type: Schema.Types.ObjectId,
    ref: 'Property',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  paymentType: {
    type: String,
    required: true,
    enum: ['Cash', 'Check', 'Bank Transfer', 'Wire Transfer', 'ACH', 'Other'],
    default: 'Bank Transfer'
  },
  referenceNumber: {
    type: String,
    trim: true
  },
  remark: {
    type: String,
    trim: true
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

LandlordPaymentSchema.index({ propertyId: 1, createdBy: 1, isDeleted: 1 });
LandlordPaymentSchema.index({ createdBy: 1, paymentDate: -1 });

const LandlordPayment = mongoose.model('LandlordPayment', LandlordPaymentSchema, 'landlord_payments');

// PropertyPaymentSettings Schema
const PropertyPaymentSettingsSchema = new Schema({
  propertyId: {
    type: Schema.Types.ObjectId,
    ref: 'Property',
    required: true,
    index: true,
  },
  percentageCut: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true,
  },
}, {
  timestamps: true,
});

PropertyPaymentSettingsSchema.index({ propertyId: 1, createdBy: 1, isDeleted: 1 }, { unique: false });

const PropertyPaymentSettings = mongoose.model(
  'PropertyPaymentSettings',
  PropertyPaymentSettingsSchema,
  'property_payment_settings'
);

module.exports = {
  LandlordPayment,
  PropertyPaymentSettings,
};
