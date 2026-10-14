/**
 * ------------------------------------------------------------------
 * File: extended-schemas.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Extended API Schemas for all modules
// This file contains hardcoded request body schemas for all remaining module APIs

const tenantSchemas = {
  "POST /api/v1/tenants": {
    schema: {
      type: "object",
      required: ["email", "password", "phone", "firstName", "lastName", "address", "state", "zipCode", "landlordId"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" },
        phone: { type: "string", pattern: "^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        address: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string", pattern: "^\\d{5}(-\\d{4})?$" },
        landlordId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
      },
      additionalProperties: false
    },
    example: {
      email: "user@domain.com",
      password: "ExamplePass123!",
      phone: "+1-555-987-6543",
      firstName: "Jane",
      lastName: "Smith",
      address: "456 Oak Avenue",
      state: "NY",
      zipCode: "10001",
      landlordId: "60f7a0b8c2a3f2b1c0d4e5f6"
    }
  },
  "POST /api/v1/tenants/setup": {
    schema: {
      type: "object",
      required: ["tenants", "lease"],
      properties: {
        tenants: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["key", "email", "phone", "firstName", "lastName"],
            properties: {
              key: { type: "string" },
              email: { type: "string", format: "email" },
              phone: { type: "string" },
              password: { type: "string" },
              firstName: { type: "string" },
              lastName: { type: "string" },
              address: { type: "string" },
              state: { type: "string" },
              zipCode: { type: "string" }
            },
            additionalProperties: false
          }
        },
        lease: {
          type: "object",
          required: ["property_id", "unitName", "leaseTerm", "lease_type", "start_date", "rentDetails", "rentAndDepositDestribution"],
          properties: {
            property_id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
            unitName: { type: "string" },
            leaseTerm: { type: "string" },
            lease_type: { type: "string", enum: ["fixed_term", "month_to_month"] },
            start_date: { type: "string", format: "date" },
            end_date: { type: "string", format: "date" },
            rentDetails: {
              type: "object",
              required: ["frequency", "amount", "firstRentalInvoiceDue"],
              properties: {
                frequency: { type: "string" },
                amount: { type: "number", minimum: 0 },
                dueOne: { type: "string" },
                firstRentalInvoiceDue: { type: "string", format: "date" }
              },
              additionalProperties: false
            },
            rentAndDepositDestribution: {
              type: "object",
              required: ["isAllTenantsEquallyResponsible", "isPartialPaymentAllowed", "rentDistributionType", "securityDepositDestributionType", "split"],
              properties: {
                isAllTenantsEquallyResponsible: { type: "boolean" },
                isPartialPaymentAllowed: { type: "boolean" },
                rentDistributionType: { type: "string" },
                securityDepositDestributionType: { type: "string" },
                split: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["key", "rentAmount", "rentPercentage", "depositAmount", "depositPercentage"],
                    properties: {
                      key: { type: "string" },
                      rentAmount: { type: "number", minimum: 0 },
                      rentPercentage: { type: "number", minimum: 0, maximum: 100 },
                      depositAmount: { type: "number", minimum: 0 },
                      depositPercentage: { type: "number", minimum: 0, maximum: 100 }
                    },
                    additionalProperties: false
                  }
                }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    example: {
      tenants: [{
        key: "tenant1",
        email: "tenant@example.com",
        phone: "+1-555-987-6543",
        firstName: "Jane",
        lastName: "Smith"
      }],
      lease: {
        property_id: "60f7a0b8c2a3f2b1c0d4e5f6",
        unitName: "Unit 1A",
        leaseTerm: "12 months",
        lease_type: "fixed_term",
        start_date: "2024-01-01",
        end_date: "2024-12-31",
        rentDetails: {
          frequency: "monthly",
          amount: 1500,
          firstRentalInvoiceDue: "2024-01-01"
        },
        rentAndDepositDestribution: {
          isAllTenantsEquallyResponsible: true,
          isPartialPaymentAllowed: false,
          rentDistributionType: "equal",
          securityDepositDestributionType: "equal",
          split: [{
            key: "tenant1",
            rentAmount: 1500,
            rentPercentage: 100,
            depositAmount: 1500,
            depositPercentage: 100
          }]
        }
      }
    }
  },
  "POST /api/v1/tenants/resend-invite": {
    schema: {
      type: "object",
      required: ["propertyId", "tenantId"],
      properties: {
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        tenantId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
      },
      additionalProperties: false
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      tenantId: "60f7a0b8c2a3f2b1c0d4e5f7"
    }
  }
};

const maintenanceSchemas = {
  "POST /api/v1/maintenance/request": {
    schema: {
      type: "object",
      required: ["property_id", "title", "description", "category", "priority"],
      properties: {
        property_id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        units: { type: "string" },
        title: { type: "string", maxLength: 150 },
        description: { type: "string" },
        category: { type: "string", enum: ["Plumbing", "Electrical", "HVAC", "Appliance", "Structural", "Pest Control", "Landscaping", "Other"] },
        priority: { type: "string", enum: ["Low", "Medium", "High", "Emergency"] },
        request_date: { type: "string", format: "date" },
        isUrgent: { type: "boolean", default: false },
        allowMaintenancePersonnelToEnterPremises: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    example: {
      property_id: "60f7a0b8c2a3f2b1c0d4e5f6",
      units: "Unit 1A",
      title: "Leaky faucet repair",
      description: "Kitchen faucet is leaking and needs immediate attention",
      category: "Plumbing",
      priority: "Medium",
      request_date: "2024-01-15",
      isUrgent: false,
      allowMaintenancePersonnelToEnterPremises: true
    }
  },
  "PUT /api/v1/maintenance/request/{id}": {
    schema: {
      type: "object",
      properties: {
        units: { type: "string" },
        title: { type: "string", maxLength: 150 },
        description: { type: "string" },
        category: { type: "string", enum: ["Plumbing", "Electrical", "HVAC", "Appliance", "Structural", "Pest Control", "Landscaping", "Other"] },
        priority: { type: "string", enum: ["Low", "Medium", "High", "Emergency"] },
        status: { type: "string" },
        isUrgent: { type: "boolean" },
        allowMaintenancePersonnelToEnterPremises: { type: "boolean" },
        assignedTo: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        completedDate: { type: "string", format: "date" },
        estimatedCost: { type: "number", minimum: 0 },
        actualCost: { type: "number", minimum: 0 }
      },
      additionalProperties: false
    },
    example: {
      status: "in_progress",
      assignedTo: "60f7a0b8c2a3f2b1c0d4e5f8",
      estimatedCost: 150
    }
  }
};

const expenseSchemas = {
  "POST /api/v1/expense": {
    schema: {
      type: "object",
      required: ["category", "vendor", "amount", "totalAmount"],
      properties: {
        category: { type: "string", maxLength: 100 },
        subCategory: { type: "string", maxLength: 100 },
        vendor: { type: "string", maxLength: 200 },
        vendorContact: { type: "string", maxLength: 200 },
        vendorPhone: { type: "string", maxLength: 50 },
        vendorEmail: { type: "string", format: "email" },
        vendorWebsite: { type: "string", format: "uri" },
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        unit: { type: "string", maxLength: 100 },
        address: { type: "string", maxLength: 500 },
        amount: { type: "number", minimum: 0 },
        tax: { type: "number", minimum: 0, default: 0 },
        totalAmount: { type: "number", minimum: 0 },
        status: { type: "string", enum: ["pending", "paid", "unpaid", "overdue"], default: "pending" },
        expenseDate: { type: "string", format: "date" },
        paymentDate: { type: "string", format: "date" },
        paymentMethod: { type: "string", maxLength: 100 },
        referenceNumber: { type: "string", maxLength: 200 },
        memo: { type: "string", maxLength: 2000 },
        isRecurring: { type: "boolean", default: false },
        recurringInterval: { type: "string", maxLength: 100 },
        linkedMaintenance: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
      },
      additionalProperties: false
    },
    example: {
      category: "maintenance",
      vendor: "ABC Plumbing Services",
      vendorEmail: "john@abcplumbing.com",
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      amount: 250,
      tax: 25,
      totalAmount: 275,
      status: "pending",
      expenseDate: "2024-01-15",
      memo: "Fixed leaky faucet in kitchen"
    }
  }
};

const invoiceSchemas = {
  "POST /api/v1/invoice": {
    schema: {
      type: "object",
      required: ["tenantId", "propertyId", "amount", "dueDate", "description"],
      properties: {
        tenantId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        amount: { type: "number", minimum: 0 },
        dueDate: { type: "string", format: "date" },
        description: { type: "string" },
        invoiceType: { type: "string" },
        status: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      tenantId: "60f7a0b8c2a3f2b1c0d4e5f7",
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      amount: 1500,
      dueDate: "2024-02-01",
      description: "Monthly rent for January 2024",
      invoiceType: "rent",
      status: "pending"
    }
  }
};

const leasingSchemas = {
  "POST /api/v1/leasing/lease": {
    schema: {
      type: "object",
      required: ["propertyId", "tenantId", "startDate", "endDate", "rentAmount"],
      properties: {
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        tenantId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        rentAmount: { type: "number", minimum: 0 },
        securityDeposit: { type: "number", minimum: 0 },
        terms: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      tenantId: "60f7a0b8c2a3f2b1c0d4e5f7",
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      rentAmount: 1500,
      securityDeposit: 1500,
      terms: "Standard lease terms and conditions"
    }
  },
  "POST /api/v1/leasing/template": {
    schema: {
      type: "object",
      required: ["name", "content"],
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        description: { type: "string" },
        category: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      name: "Standard Lease Agreement",
      content: "This lease agreement is entered into...",
      description: "Standard residential lease template",
      category: "lease"
    }
  }
};

const eventsSchemas = {
  "POST /api/v1/events/events": {
    schema: {
      type: "object",
      required: ["title", "description", "startDate", "endDate"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        startDate: { type: "string", format: "date-time" },
        endDate: { type: "string", format: "date-time" },
        propertyId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        tenantId: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        eventType: { type: "string" },
        location: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      title: "Property Inspection",
      description: "Annual property inspection",
      startDate: "2024-02-15T10:00:00Z",
      endDate: "2024-02-15T12:00:00Z",
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      eventType: "inspection",
      location: "Unit 1A"
    }
  }
};

const masterSchemas = {
  "POST /api/v1/master/masterData": {
    schema: {
      type: "object",
      required: ["type", "value"],
      properties: {
        type: { type: "string" },
        value: { type: "string" },
        description: { type: "string" },
        category: { type: "string" },
        isActive: { type: "boolean" }
      },
      additionalProperties: false
    },
    example: {
      type: "property_type",
      value: "apartment",
      description: "Multi-unit residential building",
      category: "property",
      isActive: true
    }
  }
};

const userSchemas = {
  "PUT /api/v1/users/userProfile": {
    schema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        phone: { type: "string" },
        address: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        bio: { type: "string" }
      },
      additionalProperties: false
    },
    example: {
      firstName: "John",
      lastName: "Doe",
      phone: "+1-555-123-4567",
      address: "123 Main Street",
      state: "NY",
      zipCode: "10001",
      bio: "Experienced property manager"
    }
  }
};

module.exports = {
  ...tenantSchemas,
  ...maintenanceSchemas,
  ...expenseSchemas,
  ...invoiceSchemas,
  ...leasingSchemas,
  ...eventsSchemas,
  ...masterSchemas,
  ...userSchemas
};