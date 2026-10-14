/**
 * ------------------------------------------------------------------
 * File: complete-schemas.js
 * Module: Src Docs Api-schemas
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Complete API Schemas - Generated from actual validators
const completeSchemas = {
  // AUTH APIs
  "POST /api/v1/auth/signup": {
    schema: {
      type: "object",
      required: ["email", "password", "firstName", "lastName"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" },
        phone: { type: "string" },
        firstName: { type: "string", minLength: 1 },
        lastName: { type: "string", minLength: 1 },
        address: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        role: { type: "string" },
        profilePic: {},
        dob: {},
        gender: {}
      }
    },
    example: {
      email: "user@domain.com",
      password: "ExamplePass123!",
      firstName: "John",
      lastName: "Doe",
      phone: "+1-555-123-4567",
      address: "123 Main Street",
      state: "NY",
      zipCode: "10001",
      role: "landlord"
    }
  },

  "POST /api/v1/auth/login": {
    schema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string" }
      }
    },
    example: {
      email: "user@domain.com",
      password: "ExamplePass123!"
    }
  },

  "POST /api/v1/auth/forgot-password": {
    schema: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email" }
      }
    },
    example: {
      email: "landlord@gmail.com"
    }
  },

  "PUT /api/v1/auth/verify-otp-reset-password": {
    schema: {
      type: "object",
      required: ["email", "otp", "newPassword", "confirmPassword"],
      properties: {
        email: { type: "string", format: "email" },
        otp: { type: "string" },
        newPassword: { type: "string" },
        confirmPassword: { type: "string" }
      }
    },
    example: {
      email: "user@domain.com",
      otp: "123456",
      newPassword: "<password>",
      confirmPassword: "<password>"
    }
  },

  "POST /api/v1/auth/refresh": {
    schema: {
      type: "object",
      required: ["refreshToken"],
      properties: {
        refreshToken: { type: "string" }
      }
    },
    example: {
      refreshToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  },

  "PUT /api/v1/auth/reset-password": {
    schema: {
      type: "object",
      required: ["currentPassword", "newPassword", "confirmPassword"],
      properties: {
        currentPassword: { type: "string" },
        newPassword: { type: "string" },
        confirmPassword: { type: "string" }
      }
    },
    example: {
      currentPassword: "<password>",
      newPassword: "<password>",
      confirmPassword: "<password>"
    }
  },

  "PUT /api/v1/auth/lock-account": {
    schema: {
      type: "object",
      required: ["userId"],
      properties: {
        userId: { type: "string" }
      }
    },
    example: {
      userId: "60f7a0b8c2a3f2b1c0d4e5f6"
    }
  },

  "PUT /api/v1/auth/unlock-account": {
    schema: {
      type: "object",
      required: ["userId"],
      properties: {
        userId: { type: "string" }
      }
    },
    example: {
      userId: "60f7a0b8c2a3f2b1c0d4e5f6"
    }
  },

  "POST /api/v1/auth/role": {
    schema: {
      type: "object",
      required: ["name", "functions"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        functions: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
        }
      }
    },
    example: {
      name: "Property Manager",
      description: "Manages properties and tenants",
      functions: ["60f7a0b8c2a3f2b1c0d4e5f6", "60f7a0b8c2a3f2b1c0d4e5f7"]
    }
  },

  "PUT /api/v1/auth/role/{id}": {
    schema: {
      type: "object",
      required: ["functions"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        functions: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[0-9a-fA-F]{24}$" }
        }
      }
    },
    example: {
      name: "Updated Property Manager",
      functions: ["60f7a0b8c2a3f2b1c0d4e5f6"]
    }
  },

  "POST /api/v1/auth/function": {
    schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" }
      }
    },
    example: {
      name: "Create Property",
      description: "Allows creating new properties"
    }
  },

  "PUT /api/v1/auth/function/{id}": {
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" }
      }
    },
    example: {
      name: "Updated Function Name",
      description: "Updated description"
    }
  },

  // PROPERTY APIs
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

  "POST /api/v1/property/properties/{id}/notes": {
    schema: {
      type: "object",
      properties: {
        note: { type: "string" },
        category: { type: "string" },
        isPrivate: { type: "boolean" }
      }
    },
    example: {
      note: "Property needs new roof within next 2 years",
      category: "maintenance",
      isPrivate: false
    }
  },

  // TENANT APIs
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
        propertyId: { type: "string" },
        tenantId: { type: "string" }
      }
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      tenantId: "60f7a0b8c2a3f2b1c0d4e5f7"
    }
  },

  // APPLICATION APIs
  "POST /api/v1/application": {
    schema: {
      type: "object",
      required: ["propertyId", "personalInformation", "addressInformation", "references", "emergencyContact"],
      properties: {
        propertyId: { type: "string" },
        personalInformation: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email", "birthDate"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" },
            birthDate: { type: "string", format: "date" }
          }
        },
        addressInformation: {
          type: "object",
          required: ["addressLine1", "city", "state", "zip"],
          properties: {
            addressLine1: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            zip: { type: "string" }
          }
        },
        employmentHistory: {
          type: "array",
          items: {
            type: "object",
            required: ["employer", "titleOrPosition", "startDate", "contact"],
            properties: {
              employer: { type: "string" },
              titleOrPosition: { type: "string" },
              startDate: { type: "string", format: "date" },
              endDate: { type: "string" },
              contact: {
                type: "object",
                required: ["firstName", "lastName", "email", "phone"],
                properties: {
                  firstName: { type: "string" },
                  lastName: { type: "string" },
                  email: { type: "string", format: "email" },
                  phone: { type: "string" }
                }
              }
            }
          }
        },
        rentalHistory: {
          type: "array",
          items: {
            type: "object",
            required: ["streetAddress", "city", "state", "zip", "moveInDate", "moveOutDate", "monthlyRent", "landlordOrManager"],
            properties: {
              streetAddress: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              zip: { type: "string" },
              moveInDate: { type: "string", format: "date" },
              moveOutDate: { type: "string", format: "date" },
              monthlyRent: { type: "number" },
              landlordOrManager: {
                type: "object",
                required: ["name", "email", "phone"],
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                  phone: { type: "string" }
                }
              }
            }
          }
        },
        references: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email", "relation"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" },
            relation: { type: "string" }
          }
        },
        emergencyContact: {
          type: "object",
          required: ["firstName", "lastName", "mobileNumber", "email"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            mobileNumber: { type: "string" },
            email: { type: "string", format: "email" }
          }
        }
      }
    },
    example: {
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      personalInformation: {
        firstName: "Alice",
        lastName: "Johnson",
        mobileNumber: "+1-555-444-3333",
        email: "alice.johnson@example.com",
        birthDate: "1990-05-15"
      },
      addressInformation: {
        addressLine1: "456 Oak Avenue",
        city: "Boston",
        state: "MA",
        zip: "02101"
      },
      references: {
        firstName: "Bob",
        lastName: "Smith",
        mobileNumber: "+1-555-111-2222",
        email: "bob.smith@example.com",
        relation: "friend"
      },
      emergencyContact: {
        firstName: "Carol",
        lastName: "Johnson",
        mobileNumber: "+1-555-333-4444",
        email: "carol.johnson@example.com"
      }
    }
  },

  // MAINTENANCE APIs
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

  // EXPENSE APIs
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
  },

  // INVOICE APIs
  "POST /api/v1/invoice": {
    schema: {
      type: "object",
      required: ["type", "isPartialPaymentAllowed", "propertyId", "unit", "term", "tenants", "isAllTenantSelected", "invoiceItemDetails", "subAmount", "alreadyPaid", "balanceDue", "isRecurringInvoice", "dueDate"],
      properties: {
        type: { type: "string" },
        isPartialPaymentAllowed: { type: "boolean" },
        propertyId: { type: "string" },
        unit: { type: "string" },
        term: { type: "string" },
        tenants: { type: "array", minItems: 1, items: { type: "string" } },
        isAllTenantSelected: { type: "boolean" },
        invoiceItemDetails: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["invoiceItem", "description", "quantity", "rate", "amount"],
            properties: {
              invoiceItem: { type: "string" },
              description: { type: "string" },
              quantity: { type: "number", minimum: 0 },
              rate: { type: "number", minimum: 0 },
              amount: { type: "number", minimum: 0 },
              notes: { type: "string" }
            }
          }
        },
        subAmount: { type: "number", minimum: 0 },
        alreadyPaid: { type: "number", minimum: 0 },
        balanceDue: { type: "number", minimum: 0 },
        isRecurringInvoice: { type: "boolean" },
        isLineItemOnRentalInvoice: { type: "boolean" },
        dueDate: { type: "string", format: "date" },
        frequency: { type: "string" },
        dueOnDate: { type: "integer", minimum: 1, maximum: 31 },
        startDate: { type: "string", format: "date" },
        endDate: { type: "string", format: "date" },
        documents: { type: "array", items: { type: "string" } }
      }
    },
    example: {
      type: "rent",
      isPartialPaymentAllowed: false,
      propertyId: "60f7a0b8c2a3f2b1c0d4e5f6",
      unit: "Unit 1A",
      term: "January 2024",
      tenants: ["60f7a0b8c2a3f2b1c0d4e5f7"],
      isAllTenantSelected: true,
      invoiceItemDetails: [{
        invoiceItem: "Monthly Rent",
        description: "Rent for January 2024",
        quantity: 1,
        rate: 1500,
        amount: 1500
      }],
      subAmount: 1500,
      alreadyPaid: 0,
      balanceDue: 1500,
      isRecurringInvoice: true,
      dueDate: "2024-01-01"
    }
  },

  // LEASING APIs
  "POST /api/v1/leasing/lease": {
    schema: {
      type: "object",
      required: ["property_id", "unitName", "leaseTerm", "lease_type", "start_date", "rentDetails"],
      properties: {
        property_id: { type: "string" },
        unitName: { type: "string" },
        leaseTerm: { type: "string" },
        lease_type: { type: "string" },
        start_date: { type: "string", format: "date" },
        end_date: { type: "string", format: "date" },
        switchMonthToMonth: { type: "boolean" },
        auto_renew: { type: "boolean" },
        rentDetails: {
          type: "object",
          required: ["amount", "firstRentalInvoiceDue"],
          properties: {
            amount: { type: "number" },
            firstRentalInvoiceDue: { type: "string", format: "date" },
            frequency: { type: "string" },
            dueOne: { type: "string" }
          }
        },
        depositDetails: {
          type: "object",
          properties: {
            amount: { type: "number" },
            due: { type: "string", format: "date" },
            isDepositAlreadyCollected: { type: "boolean" }
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
                  quantity: { type: "number" },
                  rate: { type: "number" },
                  amount: { type: "number" }
                }
              }
            },
            totalAmount: { type: "number" },
            alreadyPaid: { type: "number" },
            balanceAmount: { type: "number" },
            isRecurringInvoice: { type: "boolean" },
            lineItemOnRentalInvoice: { type: "boolean" },
            dueDate: { type: "string", format: "date" },
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
            frequency: { type: "string" },
            notes: { type: "string" }
          }
        },
        rentAndDepositDestribution: {
          type: "object",
          properties: {
            isAllTenantsEquallyResponsible: { type: "boolean" },
            isPartialPaymentAllowed: { type: "boolean" },
            rentDistributionType: { type: "string" },
            securityDepositDestributionType: { type: "string" },
            split: {
              type: "array",
              items: {
                type: "object",
                required: ["tenantId", "rentAmount", "rentPercentage", "depositAmount", "depositPercentage"],
                properties: {
                  tenantId: { type: "string" },
                  rentAmount: { type: "number" },
                  rentPercentage: { type: "number" },
                  depositAmount: { type: "number" },
                  depositPercentage: { type: "number" }
                }
              }
            }
          }
        },
        status: { type: "string" }
      }
    },
    example: {
      property_id: "60f7a0b8c2a3f2b1c0d4e5f6",
      unitName: "Unit 1A",
      leaseTerm: "12 months",
      lease_type: "FixedTerm",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      rentDetails: {
        amount: 1500,
        firstRentalInvoiceDue: "2024-01-01",
        frequency: "monthly"
      },
      depositDetails: {
        amount: 1500,
        due: "2024-01-01",
        isDepositAlreadyCollected: false
      }
    }
  },

  "POST /api/v1/leasing/landlord/{landlordId}/templates": {
    schema: {
      type: "object",
      required: ["templateName"],
      properties: {
        templateName: { type: "string" },
        description: { type: "string" },
        templateType: { type: "string" }
      }
    },
    example: {
      templateName: "Standard Lease Agreement",
      description: "Standard residential lease template",
      templateType: "lease"
    }
  },

  // EVENTS APIs
  "POST /api/v1/events/events": {
    schema: {
      type: "object",
      required: ["title", "description", "startDate", "endDate"],
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        startDate: { type: "string", format: "date-time" },
        endDate: { type: "string", format: "date-time" },
        propertyId: { type: "string" },
        tenantId: { type: "string" },
        eventType: { type: "string" },
        location: { type: "string" }
      }
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
  },

  // MASTER DATA APIs
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
      }
    },
    example: {
      type: "property_type",
      value: "apartment",
      description: "Multi-unit residential building",
      category: "property",
      isActive: true
    }
  },

  // USER APIs
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
      }
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

module.exports = completeSchemas;