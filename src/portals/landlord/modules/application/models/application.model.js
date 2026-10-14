/**
 * ------------------------------------------------------------------
 * File: application.model.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * diagnostic, ensureLandlordIndexes, dashboard.service, application.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const { 
  APPLICATION_STATUS, 
  BACKGROUND_CHECK_STATUS, 
  INCOME_VERIFICATION_STATUS, 
  EVICTION_REPORT_STATUS 
} = require('../../../../../common/constants/application');

const contactSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
});

const employmentSchema = new mongoose.Schema({
  employer: { type: String, required: true },
  titleOrPosition: { type: String, required: true },
  startDate: { type: Date, required: true },
  // endDate may be null for currently-employed entries
  endDate: { type: Date, required: false },
  contact: { type: contactSchema, required: true },
});

const landlordContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: false },
  phone: { type: String, required: false },
});

const rentalHistorySchema = new mongoose.Schema({
  streetAddress: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  zip: { type: String, required: true },
  moveInDate: { type: Date, required: true },
  moveOutDate: { type: Date, required: false },
  monthlyRent: { type: Number, required: true },
  landlordOrManager: { type: landlordContactSchema, required: true },
});

const personalInformationSchema = new mongoose.Schema({
  firstName: { type: String, required: false },
  lastName: { type: String, required: false },
  mobileNumber: { type: String, required: false },
  email: { type: String, required: true, lowercase: true, index: true },
  birthDate: { type: Date, required: false },
});

const addressInformationSchema = new mongoose.Schema({
  addressLine1: { type: String, required: false },
  city: { type: String, required: false },
  state: { type: String, required: false },
  zip: { type: String, required: false },
});

const referenceSchema = new mongoose.Schema({
  firstName: { type: String, required: false },
  lastName: { type: String, required: false },
  mobileNumber: { type: String, required: false },
  email: { type: String, required: false },
  relation: { type: String, required: false },
});

const emergencyContactSchema = new mongoose.Schema({
  firstName: { type: String, required: false },
  lastName: { type: String, required: false },
  mobileNumber: { type: String, required: false },
  email: { type: String, required: false },
});

const noteSchema = new mongoose.Schema({
  text: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

const commentSchema = new mongoose.Schema({
  text: { type: String, required: true },
  action: { type: String, required: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
  createdAt: { type: Date, default: Date.now },
});

const applicationSchema = new mongoose.Schema(
  {
    property_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: false, index: true, alias: 'propertyId' },
    tenant_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true, alias: 'tenantId' },
    lease_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Lease', required: false, index: true, alias: 'leaseId' },
    landlord_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true, alias: 'landlordId' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true },
    personalInformation: { type: personalInformationSchema, required: true },
    addressInformation: { type: addressInformationSchema, required: true },
    employmentHistory: { type: [employmentSchema], default: [] },
    rentalHistory: { type: [rentalHistorySchema], default: [] },
    references: { type: referenceSchema, required: false },
    emergencyContact: { type: emergencyContactSchema, required: false },
    
    // Notes
    notes: { type: [noteSchema], default: [] },
    comments: { type: [commentSchema], default: [] },
    
    // Application Details
    desiredMoveInDate: { type: Date, required: false },
    annualIncome: { type: Number, required: false },
    screeningPropertyStatus: { type: String, required: false, trim: true },
    
    // Screening Information
    creditScore: { type: Number, min: 300, max: 850, required: false },
    backgroundCheckStatus: {
      type: String,
      enum: Object.values(BACKGROUND_CHECK_STATUS),
      default: BACKGROUND_CHECK_STATUS.PENDING,
    },
    incomeVerificationStatus: {
      type: String,
      enum: Object.values(INCOME_VERIFICATION_STATUS),
      default: INCOME_VERIFICATION_STATUS.PENDING,
    },
    verifiedAnnualIncome: { type: Number, required: false },
    evictionReportStatus: {
      type: String,
      enum: Object.values(EVICTION_REPORT_STATUS),
      default: EVICTION_REPORT_STATUS.PENDING,
    },
    
    // Application Status
    status: {
      type: String,
      enum: Object.values(APPLICATION_STATUS),
      default: APPLICATION_STATUS.SUBMITTED,
    },
    rejectionReason: { type: String, required: false },
    
    // System Fields
    isDeleted: { type: Boolean, default: false },
    version: { type: String, default: '1.0' },
  },
  { timestamps: true }
);

const Application = mongoose.models.Application || mongoose.model('Application', applicationSchema);

module.exports = Application;
