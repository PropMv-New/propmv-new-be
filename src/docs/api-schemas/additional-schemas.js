/**
 * ------------------------------------------------------------------
 * File: additional-schemas.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Additional Schemas for Damage Reports and Lease Management
// This file contains schemas for damage reports and lease-specific APIs

const additionalSchemas = {
  "POST /api/v1/maintenance/damageReport": {
    schema: {
      type: "object",
      required: ["propertyId", "title", "description", "category", "severity"],
      properties: {
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        unitName: { type: "string" },
        title: { type: "string", maxLength: 150 },
        description: { type: "string" },
        category: { type: "string", enum: ["Structural", "Electrical", "Plumbing", "Appliance", "Cosmetic", "Other"] },
        severity: { type: "string", enum: ["Minor", "Moderate", "Major", "Severe"] },
        reportDate: { type: "string", format: "date" },
        estimatedCost: { type: "number", minimum: 0 },
        isPreExisting: { type: "boolean", default: false },
        tenantResponsible: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      unitName: "Unit 1A",
      title: "Damaged kitchen cabinet door",
      description: "Cabinet door is hanging off its hinges and needs repair",
      category: "Structural",
      severity: "Moderate",
      reportDate: "2024-01-15",
      estimatedCost: 200,
      isPreExisting: false,
      tenantResponsible: true
    }
  },
  "PUT /api/v1/maintenance/damageReport/{id}": {
    schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 150 },
        description: { type: "string" },
        category: { type: "string", enum: ["Structural", "Electrical", "Plumbing", "Appliance", "Cosmetic", "Other"] },
        severity: { type: "string", enum: ["Minor", "Moderate", "Major", "Severe"] },
        estimatedCost: { type: "number", minimum: 0 },
        actualCost: { type: "number", minimum: 0 },
        status: { type: "string", enum: ["Open", "In Progress", "Resolved", "Closed"] },
        tenantResponsible: { type: "boolean" },
        repairDate: { type: "string", format: "date" }
      },
      additionalProperties: false
    },
    example: {
      status: "In Progress",
      actualCost: 180,
      repairDate: "2024-01-20"
    }
  },
  "POST /api/v1/leasing/lease/{id}/document": {
    schema: {
      type: "object",
      required: ["documentType", "title"],
      properties: {
        documentType: { type: "string", enum: ["lease_agreement", "addendum", "notice", "other"] },
        title: { type: "string" },
        description: { type: "string" },
        isRequired: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    example: {
      documentType: "lease_agreement",
      title: "Standard Lease Agreement",
      description: "Main lease agreement document",
      isRequired: true
    }
  },
  "POST /api/v1/leasing/lease/{id}/notes": {
    schema: {
      type: "object",
      required: ["note"],
      properties: {
        note: { type: "string", maxLength: 2000 },
        isPrivate: { type: "boolean", default: false },
        category: { type: "string", enum: ["general", "payment", "maintenance", "violation", "other"] }
      },
      additionalProperties: false
    },
    example: {
      note: "Tenant requested early lease termination",
      isPrivate: false,
      category: "general"
    }
  },
  "PATCH /api/v1/leasing/lease/{id}/terminate": {
    schema: {
      type: "object",
      required: ["terminationDate", "reason"],
      properties: {
        terminationDate: { type: "string", format: "date" },
        reason: { type: "string", enum: ["tenant_request", "lease_violation", "non_payment", "property_sale", "other"] },
        notes: { type: "string", maxLength: 1000 },
        refundAmount: { type: "number", minimum: 0 },
        penaltyAmount: { type: "number", minimum: 0 }
      },
      additionalProperties: false
    },
    example: {
      terminationDate: "2024-06-30",
      reason: "tenant_request",
      notes: "Tenant relocating for work",
      refundAmount: 1200,
      penaltyAmount: 0
    }
  },
  "POST /api/v1/property/properties/{id}/notes": {
    schema: {
      type: "object",
      required: ["note"],
      properties: {
        note: { type: "string", maxLength: 2000 },
        category: { type: "string", enum: ["maintenance", "tenant", "financial", "legal", "general"] },
        isPrivate: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    example: {
      note: "Property needs new roof within next 2 years",
      category: "maintenance",
      isPrivate: false
    }
  },
  "PATCH /api/v1/property/properties/{id}/archive": {
    schema: {
      type: "object",
      required: ["archived"],
      properties: {
        archived: { type: "boolean" },
        archiveReason: { type: "string", maxLength: 500 }
      },
      additionalProperties: false
    },
    example: {
      archived: true,
      archiveReason: "Property sold to new owner"
    }
  },
  "PATCH /api/v1/application/{id}/screening": {
    schema: {
      type: "object",
      properties: {
        creditScore: { type: "number", minimum: 300, maximum: 850 },
        backgroundCheckStatus: { type: "string", enum: ["pending", "passed", "failed"] },
        incomeVerified: { type: "boolean" },
        screeningNotes: { type: "string", maxLength: 1000 },
        approvalStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
        monthlyIncome: { type: "number", minimum: 0 },
        employmentVerified: { type: "boolean" }
      },
      additionalProperties: false
    },
    example: {
      creditScore: 750,
      backgroundCheckStatus: "passed",
      incomeVerified: true,
      screeningNotes: "Excellent candidate with stable employment",
      approvalStatus: "approved",
      monthlyIncome: 5000,
      employmentVerified: true
    }
  }
};

module.exports = additionalSchemas;