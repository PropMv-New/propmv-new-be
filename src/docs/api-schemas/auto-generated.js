/**
 * ------------------------------------------------------------------
 * File: auto-generated.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Backend utility/module providing helper functions for auto-generated.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Auto-generated schemas from Joi validators
// These schemas are generated based on actual validator definitions

const schemas = {
  // Property APIs
  "POST /api/v1/property/properties": {
    schema: {
      type: "object",
      required: ["name", "propertyType", "ownershipType", "address", "ownerName", "ownerEmail", "ownerPhone", "ownerType", "unitDetails"],
      properties: {
        name: { type: "string" },
        propertyType: { type: "string" },
        description: { type: "string" },
        ownershipType: { type: "string" },
        propertyManager: { type: "string" },
        address: {
          type: "object",
          required: ["street", "city", "state", "zip", "country"],
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" },
            country: { type: "string" }
          }
        },
        ownerName: { type: "string" },
        ownerEmail: { type: "string", format: "email" },
        ownerPhone: { type: "string" },
        ownerType: { type: "string" },
        amenities: { type: "array", items: { type: "string" } },
        unitDetails: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["unitName", "unitType", "squareFeet"],
            properties: {
              unitName: { type: "string" },
              unitType: { type: "string" },
              rentIncludes: { type: "array", items: { type: "string" } },
              bedRooms: { type: "integer", minimum: 0 },
              bathRoom: { type: "integer", minimum: 0 },
              amenities: { type: "array", items: { type: "string" } },
              squareFeet: { type: "number" }
            }
          }
        },
        propertySettings: {
          type: "object",
          properties: {
            bankAccount: {
              type: "object",
              properties: {
                firstName: { type: "string" },
                lastName: { type: "string" },
                email: { type: "string", format: "email" },
                phone: { type: "string" },
                dob: { type: "string", format: "date" },
                ssn: { type: "string" },
                address: {
                  type: "object",
                  required: ["street", "city", "state", "zip"],
                  properties: {
                    street: { type: "string" },
                    city: { type: "string" },
                    state: { type: "string" },
                    zip: { type: "string" }
                  }
                }
              }
            },
            lateFees: {
              type: "array",
              items: {
                type: "object",
                required: ["lateFeeType", "feeAmount", "gracePeriod", "isRepeat", "applicableUnits", "chargeEachUnpaidTenat"],
                properties: {
                  lateFeeType: { type: "string" },
                  feeAmount: { type: "number", minimum: 0 },
                  gracePeriod: { type: "number", minimum: 0 },
                  isRepeat: { type: "boolean" },
                  applyTo: { type: "string" },
                  repeatEvery: { type: "integer", minimum: 1 },
                  repeatEndAfter: { type: "integer", minimum: 1 },
                  applicableUnits: { type: "array", minItems: 1, items: { type: "string" } },
                  chargeEachUnpaidTenat: { type: "boolean" }
                }
              }
            }
          }
        },
        status: { type: "string" }
      }
    },
    example: {
      name: "Sunset Apartments",
      propertyType: "residential",
      description: "Beautiful apartment complex",
      ownershipType: "owned",
      address: {
        street: "123 Main Street",
        city: "New York",
        state: "NY",
        zip: "10001",
        country: "USA"
      },
      ownerName: "John Doe",
      ownerEmail: "owner@example.com",
      ownerPhone: "+1-555-123-4567",
      ownerType: "individual",
      amenities: ["parking", "gym", "pool"],
      unitDetails: [{
        unitName: "Unit 1A",
        unitType: "residential",
        squareFeet: 1200,
        bedRooms: 2,
        bathRoom: 1,
        amenities: ["balcony", "dishwasher"],
        rentIncludes: ["water", "trash"]
      }]
    }
  },

  // Tenant Setup API
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
            }
          }
        },
        lease: {
          type: "object",
          required: ["property_id", "unitName", "leaseTerm", "lease_type", "start_date", "rentDetails", "rentAndDepositDestribution"],
          properties: {
            property_id: { type: "string" },
            unitName: { type: "string" },
            leaseTerm: { type: "string" },
            lease_type: { type: "string", enum: ["fixed_term", "month_to_month"] },
            start_date: { type: "string", format: "date" },
            end_date: { type: "string", format: "date" },
            switchMonthToMonth: { type: "boolean" },
            auto_renew: { type: "boolean" },
            rentDetails: {
              type: "object",
              required: ["frequency", "amount", "firstRentalInvoiceDue"],
              properties: {
                frequency: { type: "string" },
                amount: { type: "number", minimum: 0 },
                dueOne: { type: "string" },
                firstRentalInvoiceDue: { type: "string", format: "date" }
              }
            },
            depositDetails: {
              type: "object",
              properties: {
                amount: { type: "number", minimum: 0 },
                due: { type: "string", format: "date" }
              }
            },
            additionalFees: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "description", "quantity", "rate", "amount"],
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      quantity: { type: "number", minimum: 0 },
                      rate: { type: "number", minimum: 0 },
                      amount: { type: "number", minimum: 0 }
                    }
                  }
                },
                notes: { type: "string" },
                totalAmount: { type: "number", minimum: 0 },
                alreadyPaid: { type: "number", minimum: 0 },
                balanceAmount: { type: "number", minimum: 0 },
                isRecurringInvoice: { type: "boolean" },
                lineItemOnRentalInvoice: { type: "boolean" },
                dueDate: { type: "string", format: "date" },
                frequency: { type: "string" },
                startDate: { type: "string", format: "date" },
                endDate: { type: "string", format: "date" }
              }
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
                    }
                  }
                }
              }
            },
            documents: {
              type: "array",
              items: {
                type: "object",
                required: ["metadataId"],
                properties: {
                  metadataId: { type: "string" }
                }
              }
            },
            status: { type: "string" }
          }
        }
      }
    },
    example: {
      tenants: [{
        key: "tenant1",
        email: "tenant@example.com",
        phone: "+1-555-987-6543",
        firstName: "Jane",
        lastName: "Smith",
        address: "456 Oak Avenue",
        state: "NY",
        zipCode: "10001"
      }],
      lease: {
        property_id: "60f7a0b8c2a3f2b1c0d4e5f6",
        unitName: "Unit 1A",
        leaseTerm: "12 months",
        lease_type: "fixed_term",
        start_date: "2024-01-01",
        end_date: "2024-12-31",
        switchMonthToMonth: false,
        rentDetails: {
          frequency: "monthly",
          amount: 1500,
          dueOne: "1st of month",
          firstRentalInvoiceDue: "2024-01-01"
        },
        depositDetails: {
          amount: 1500,
          due: "2024-01-01"
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

  // Tenant Create API
  "POST /api/v1/tenants": {
    schema: {
      type: "object",
      required: ["email", "password", "phone", "firstName", "lastName", "address", "state", "zipCode", "landlordId"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" },
        phone: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        address: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        landlordId: { type: "string" }
      }
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

  // Maintenance Request API
  "POST /api/v1/maintenance/request": {
    schema: {
      type: "object",
      required: ["property_id", "title", "description", "category", "priority"],
      properties: {
        property_id: { type: "string" },
        units: { type: "string" },
        title: { type: "string", maxLength: 150 },
        description: { type: "string" },
        category: { type: "string", enum: ["Plumbing", "Electrical", "HVAC", "Appliance", "Structural", "Pest Control", "Landscaping", "Other"] },
        priority: { type: "string", enum: ["Low", "Medium", "High", "Emergency"] },
        request_date: { type: "string", format: "date" },
        isUrgent: { type: "boolean" },
        allowMaintenancePersonnelToEnterPremises: { type: "boolean" }
      }
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

  // Expense Create API
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
        propertyId: { type: "string" },
        unit: { type: "string", maxLength: 100 },
        address: { type: "string", maxLength: 500 },
        amount: { type: "number", minimum: 0 },
        tax: { type: "number", minimum: 0 },
        totalAmount: { type: "number", minimum: 0 },
        status: { type: "string", enum: ["pending", "paid", "unpaid", "overdue"] },
        expenseDate: { type: "string", format: "date" },
        paymentDate: { type: "string", format: "date" },
        paymentMethod: { type: "string", maxLength: 100 },
        referenceNumber: { type: "string", maxLength: 200 },
        memo: { type: "string", maxLength: 2000 },
        isRecurring: { type: "boolean" },
        recurringInterval: { type: "string", maxLength: 100 },
        linkedMaintenance: { type: "string" }
      }
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

module.exports = schemas;