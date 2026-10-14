/**
 * ------------------------------------------------------------------
 * File: company.model.js
 * Module: Company Module
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * check-company-roles, check-user-company, create-default-propmv-company, create-propmv-company-with-roles
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');

// Embedded Role Schema (same structure as Role model)
const embeddedRoleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    privileges: [{ type: String }], // Direct privilege assignment (e.g., "VIEW_PROPERTY", "CREATE_PROPERTY")
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Company Schema
const companySchema = new mongoose.Schema(
  {
    name: { 
      type: String, 
      required: true, 
      trim: true,
      index: true 
    },
    description: { type: String },
    
    // Embedded roles array
    roles: [embeddedRoleSchema],
    
    // Company metadata
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    
    // Additional company information
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      zipCode: { type: String },
      country: { type: String, default: 'USA' },
    },
    
    contactInfo: {
      email: { type: String },
      phone: { type: String },
      website: { type: String },
    },
    
    settings: {
      timezone: { type: String, default: 'America/New_York' },
      currency: { type: String, default: 'USD' },
      dateFormat: { type: String, default: 'MM/DD/YYYY' },
    },
    
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    subscription: {
      plan: { type: String, enum: ['free', 'basic', 'premium', 'enterprise'], default: 'free' },
      status: { type: String, enum: ['active', 'inactive', 'suspended', 'trial'], default: 'active' },
      startDate: { type: Date },
      endDate: { type: Date },
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

companySchema.index({ name: 1 });
companySchema.index({ isDeleted: 1, isActive: 1 });
companySchema.index({ ownerId: 1 });

companySchema.virtual('activeRolesCount').get(function() {
  return this.roles ? this.roles.filter(role => role.isActive).length : 0;
});

companySchema.methods.getActiveRoles = function() {
  return this.roles.filter(role => role.isActive);
};

companySchema.methods.findRoleByName = function(roleName) {
  return this.roles.find(role => role.name === roleName && role.isActive);
};

companySchema.methods.findRoleById = function(roleId) {
  return this.roles.id(roleId);
};

companySchema.methods.addRole = function(roleData) {
  this.roles.push(roleData);
  return this.save();
};

companySchema.methods.updateRole = function(roleId, updateData) {
  const role = this.roles.id(roleId);
  if (!role) throw new Error('Role not found in company');
  Object.assign(role, updateData);
  return this.save();
};

companySchema.methods.removeRole = function(roleId) {
  const role = this.roles.id(roleId);
  if (!role) throw new Error('Role not found in company');
  role.isActive = false;
  return this.save();
};

companySchema.statics.findByName = function(name) {
  return this.findOne({ name, isDeleted: { $ne: true } });
};

companySchema.statics.findActive = function() {
  return this.find({ isActive: true, isDeleted: { $ne: true } });
};

const Company = mongoose.models.Company || mongoose.model('Company', companySchema);

module.exports = Company;
