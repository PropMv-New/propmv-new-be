/**
 * ------------------------------------------------------------------
 * File: swagger-schemas.js
 * Module: Src Docs
 *
 * Purpose:
 * Database schema definition representing database collections/tables and indexing.
 *
 * Used By:
 * swagger.config
 * ------------------------------------------------------------------
 */

// Swagger request body schemas for all API endpoints - corrected paths
const swaggerSchemas = {
    // Auth endpoints
    'POST /api/v1/auth/login': {
        schema: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string' }
            },
            additionalProperties: false
        },
        example: { email: 'user@domain.com', passphrase: '<password>' }
    },
    'POST /api/v1/auth/signup': {
        schema: {
            type: 'object',
            required: ['email', 'password', 'firstName', 'lastName'],
            properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                phone: { type: 'string' },
                address: { type: 'string' },
                state: { type: 'string' },
                zipCode: { type: 'string' },
                role: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            email: 'user@domain.com',
            passphrase: '<password>',
            firstName: 'John',
            lastName: 'Doe',
            phone: '+1-555-123-4567',
            address: '123 Main Street',
            state: 'NY',
            zipCode: '10001',
            role: 'landlord'
        }
    },
    'POST /api/v1/auth/forgot-password': {
        schema: {
            type: 'object',
            required: ['email'],
            properties: {
                email: { type: 'string', format: 'email' }
            },
            additionalProperties: false
        },
        example: { email: 'user@example.com' }
    },
    'PUT /api/v1/auth/verify-otp-reset-password': {
        schema: {
            type: 'object',
            required: ['email', 'otp', 'newPassword', 'confirmPassword'],
            properties: {
                email: { type: 'string', format: 'email' },
                otp: { type: 'string' },
                newPassword: { type: 'string' },
                confirmPassword: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            email: 'user@domain.com',
            otp: '123456',
            newPassphrase: '<new-password>',
            confirmPassphrase: '<new-password>'
        }
    },
    'PUT /api/v1/auth/reset-password': {
        schema: {
            type: 'object',
            required: ['currentPassword', 'newPassword', 'confirmPassword'],
            properties: {
                currentPassword: { type: 'string' },
                newPassword: { type: 'string' },
                confirmPassword: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            currentPassphrase: '<current-password>',
            newPassphrase: '<new-password>',
            confirmPassphrase: '<new-password>'
        }
    },
    'PUT /api/v1/auth/lock-account': {
        schema: {
            type: 'object',
            required: ['userId'],
            properties: {
                userId: { type: 'string' }
            },
            additionalProperties: false
        },
        example: { userId: '60f7a0b8c2a3f2b1c0d4e5f6' }
    },
    'PUT /api/v1/auth/unlock-account': {
        schema: {
            type: 'object',
            required: ['userId'],
            properties: {
                userId: { type: 'string' }
            },
            additionalProperties: false
        },
        example: { userId: '60f7a0b8c2a3f2b1c0d4e5f6' }
    },
    'POST /api/v1/auth/refresh': {
        schema: {
            type: 'object',
            required: ['refreshToken'],
            properties: {
                refreshToken: { type: 'string' }
            },
            additionalProperties: false
        },
        example: { refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }
    },

    // Roles endpoints
    'POST /api/v1/auth/roles': {
        schema: {
            type: 'object',
            required: ['name', 'functions'],
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                functions: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        },
        example: {
            name: 'Property Manager',
            description: 'Manages properties and tenants',
            functions: ['60f7a0b8c2a3f2b1c0d4e5f6', '60f7a0b8c2a3f2b1c0d4e5f7']
        }
    },
    'PUT /api/v1/auth/roles/{id}': {
        schema: {
            type: 'object',
            required: ['functions'],
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                functions: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        },
        example: {
            name: 'Updated Role Name',
            description: 'Updated description',
            functions: ['60f7a0b8c2a3f2b1c0d4e5f6']
        }
    },

    // Functions endpoints
    'POST /api/v1/auth/functions': {
        schema: {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string' },
                description: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            name: 'Create Property',
            description: 'Allows creating new properties'
        }
    },
    'PUT /api/v1/auth/functions/{id}': {
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                description: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            name: 'Updated Function Name',
            description: 'Updated description'
        }
    },

    // Property endpoints
    'POST /api/v1/property/properties': {
        schema: {
            type: 'object',
            required: ['name', 'propertyType', 'ownershipType', 'address', 'ownerName', 'ownerEmail', 'ownerPhone', 'ownerType', 'unitDetails'],
            properties: {
                name: { type: 'string' },
                propertyType: { type: 'string' },
                description: { type: 'string' },
                ownershipType: { type: 'string' },
                propertyManager: { type: 'string' },
                address: {
                    type: 'object',
                    required: ['street', 'city', 'state', 'zip', 'country'],
                    properties: {
                        street: { type: 'string' },
                        city: { type: 'string' },
                        state: { type: 'string' },
                        zip: { type: 'string' },
                        country: { type: 'string' }
                    }
                },
                ownerName: { type: 'string' },
                ownerEmail: { type: 'string', format: 'email' },
                ownerPhone: { type: 'string' },
                ownerType: { type: 'string' },
                amenities: { type: 'array', items: { type: 'string' } },
                unitDetails: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['unitName', 'unitType', 'squareFeet'],
                        properties: {
                            unitName: { type: 'string' },
                            unitType: { type: 'string' },
                            rentIncludes: { type: 'array', items: { type: 'string' } },
                            bedRooms: { type: 'number' },
                            bathRoom: { type: 'number' },
                            amenities: { type: 'array', items: { type: 'string' } },
                            squareFeet: { type: 'number' }
                        }
                    }
                }
            },
            additionalProperties: false
        },
        example: {
            name: 'Sunset Apartments',
            propertyType: 'residential',
            description: 'Beautiful apartment complex',
            ownershipType: 'owned',
            address: {
                street: '123 Main Street',
                city: 'New York',
                state: 'NY',
                zip: '10001',
                country: 'USA'
            },
            ownerName: 'John Doe',
            ownerEmail: 'owner@example.com',
            ownerPhone: '+1-555-123-4567',
            ownerType: 'individual',
            amenities: ['parking', 'gym', 'pool'],
            unitDetails: [{
                unitName: 'Unit 1A',
                unitType: 'residential',
                squareFeet: 1200,
                bedRooms: 2,
                bathRoom: 1,
                amenities: ['balcony', 'dishwasher']
            }]
        }
    },
    'PUT /api/v1/property/properties': {
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                propertyType: { type: 'string' },
                description: { type: 'string' },
                ownershipType: { type: 'string' },
                address: {
                    type: 'object',
                    properties: {
                        street: { type: 'string' },
                        city: { type: 'string' },
                        state: { type: 'string' },
                        zip: { type: 'string' },
                        country: { type: 'string' }
                    }
                },
                ownerName: { type: 'string' },
                ownerEmail: { type: 'string', format: 'email' },
                ownerPhone: { type: 'string' },
                ownerType: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            name: 'Updated Property Name',
            description: 'Updated description',
            status: 'active'
        }
    },
    'POST /api/v1/property/properties/{id}/notes': {
        schema: {
            type: 'object',
            required: ['note'],
            properties: {
                note: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            note: 'Property inspection completed successfully'
        }
    },

    // Application endpoints
    'POST /api/v1/application': {
        schema: {
            type: 'object',
            required: ['propertyId', 'personalInformation', 'addressInformation', 'references', 'emergencyContact'],
            properties: {
                propertyId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
                personalInformation: {
                    type: 'object',
                    required: ['firstName', 'lastName', 'mobileNumber', 'email', 'birthDate'],
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' },
                        birthDate: { type: 'string', format: 'date' }
                    },
                    additionalProperties: false
                },
                addressInformation: {
                    type: 'object',
                    required: ['addressLine1', 'city', 'state', 'zip'],
                    properties: {
                        addressLine1: { type: 'string' },
                        city: { type: 'string' },
                        state: { type: 'string' },
                        zip: { type: 'string' }
                    },
                    additionalProperties: false
                },
                employmentHistory: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['employer', 'titleOrPosition', 'startDate', 'contact'],
                        properties: {
                            employer: { type: 'string' },
                            titleOrPosition: { type: 'string' },
                            startDate: { type: 'string', format: 'date' },
                            endDate: { oneOf: [{ type: 'string', format: 'date' }, { type: 'string', enum: ['Present'] }, { type: 'null' }] },
                            contact: {
                                type: 'object',
                                required: ['firstName', 'lastName', 'email', 'phone'],
                                properties: {
                                    firstName: { type: 'string' },
                                    lastName: { type: 'string' },
                                    email: { type: 'string', format: 'email' },
                                    phone: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' }
                                },
                                additionalProperties: false
                            }
                        },
                        additionalProperties: false
                    }
                },
                rentalHistory: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['streetAddress', 'city', 'state', 'zip', 'moveInDate', 'moveOutDate', 'monthlyRent', 'landlordOrManager'],
                        properties: {
                            streetAddress: { type: 'string' },
                            city: { type: 'string' },
                            state: { type: 'string' },
                            zip: { type: 'string' },
                            moveInDate: { type: 'string', format: 'date' },
                            moveOutDate: { type: 'string', format: 'date' },
                            monthlyRent: { type: 'number' },
                            landlordOrManager: {
                                type: 'object',
                                required: ['name', 'email', 'phone'],
                                properties: {
                                    name: { type: 'string' },
                                    email: { type: 'string', format: 'email' },
                                    phone: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' }
                                },
                                additionalProperties: false
                            }
                        },
                        additionalProperties: false
                    }
                },
                references: {
                    type: 'object',
                    required: ['firstName', 'lastName', 'mobileNumber', 'email', 'relation'],
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' },
                        relation: { type: 'string' }
                    },
                    additionalProperties: false
                },
                emergencyContact: {
                    type: 'object',
                    required: ['firstName', 'lastName', 'mobileNumber', 'email'],
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' }
                    },
                    additionalProperties: false
                }
            },
            additionalProperties: false
        },
        example: {
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            personalInformation: {
                firstName: 'Alice',
                lastName: 'Johnson',
                mobileNumber: '+1-555-444-3333',
                email: 'alice.johnson@example.com',
                birthDate: '1990-05-15'
            },
            addressInformation: {
                addressLine1: '456 Oak Avenue',
                city: 'Boston',
                state: 'MA',
                zip: '02101'
            },
            employmentHistory: [{
                employer: 'Tech Corp Inc',
                titleOrPosition: 'Software Engineer',
                startDate: '2020-01-15',
                endDate: 'Present',
                contact: {
                    firstName: 'John',
                    lastName: 'Manager',
                    email: 'john.manager@techcorp.com',
                    phone: '+1-555-123-9999'
                }
            }],
            rentalHistory: [{
                streetAddress: '123 Previous St',
                city: 'Cambridge',
                state: 'MA',
                zip: '02139',
                moveInDate: '2018-06-01',
                moveOutDate: '2023-05-31',
                monthlyRent: 2200,
                landlordOrManager: {
                    name: 'Previous Landlord',
                    email: 'landlord@example.com',
                    phone: '+1-555-777-8888'
                }
            }],
            references: {
                firstName: 'Bob',
                lastName: 'Smith',
                mobileNumber: '+1-555-111-2222',
                email: 'bob.smith@example.com',
                relation: 'friend'
            },
            emergencyContact: {
                firstName: 'Carol',
                lastName: 'Johnson',
                mobileNumber: '+1-555-333-4444',
                email: 'carol.johnson@example.com'
            }
        }
    },
    'PUT /api/v1/application/{id}': {
        schema: {
            type: 'object',
            properties: {
                propertyId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
                personalInformation: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' },
                        birthDate: { type: 'string', format: 'date' }
                    },
                    additionalProperties: false
                },
                addressInformation: {
                    type: 'object',
                    properties: {
                        addressLine1: { type: 'string' },
                        city: { type: 'string' },
                        state: { type: 'string' },
                        zip: { type: 'string' }
                    },
                    additionalProperties: false
                },
                employmentHistory: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['employer', 'titleOrPosition', 'startDate', 'contact'],
                        properties: {
                            employer: { type: 'string' },
                            titleOrPosition: { type: 'string' },
                            startDate: { type: 'string', format: 'date' },
                            endDate: { oneOf: [{ type: 'string', format: 'date' }, { type: 'string', enum: ['Present'] }, { type: 'null' }] },
                            contact: {
                                type: 'object',
                                required: ['firstName', 'lastName', 'email', 'phone'],
                                properties: {
                                    firstName: { type: 'string' },
                                    lastName: { type: 'string' },
                                    email: { type: 'string', format: 'email' },
                                    phone: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' }
                                },
                                additionalProperties: false
                            }
                        },
                        additionalProperties: false
                    }
                },
                references: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' },
                        relation: { type: 'string' }
                    },
                    additionalProperties: false
                },
                emergencyContact: {
                    type: 'object',
                    properties: {
                        firstName: { type: 'string' },
                        lastName: { type: 'string' },
                        mobileNumber: { type: 'string', pattern: '^(?:\\+?1[-\\s]?)?\\(?\\d{3}\\)?[-\\s.]?\\d{3}[-\\s.]?\\d{4}$' },
                        email: { type: 'string', format: 'email' }
                    },
                    additionalProperties: false
                }
            },
            additionalProperties: false
        },
        example: {
            personalInformation: {
                firstName: 'Updated First Name',
                email: 'updated.email@example.com',
                mobileNumber: '+1-555-999-8888'
            },
            addressInformation: {
                addressLine1: '789 New Address St',
                city: 'Updated City',
                state: 'NY',
                zip: '10001'
            }
        }
    },
    'PATCH /api/v1/application/{id}/screening': {
        schema: {
            type: 'object',
            properties: {
                creditScore: { type: 'number', minimum: 300, maximum: 850 },
                backgroundCheckStatus: { type: 'string', enum: ['pending', 'passed', 'failed', 'in_progress'] },
                incomeVerified: { type: 'boolean' },
                employmentVerified: { type: 'boolean' },
                referencesVerified: { type: 'boolean' },
                screeningNotes: { type: 'string' },
                screeningDate: { type: 'string', format: 'date' },
                approvalStatus: { type: 'string', enum: ['pending', 'approved', 'rejected', 'conditional'] },
                conditions: { type: 'array', items: { type: 'string' } }
            },
            additionalProperties: false
        },
        example: {
            creditScore: 750,
            backgroundCheckStatus: 'passed',
            incomeVerified: true,
            employmentVerified: true,
            referencesVerified: true,
            screeningNotes: 'Excellent candidate with strong credit and employment history',
            screeningDate: '2024-01-20',
            approvalStatus: 'approved',
            conditions: []
        }
    },

    // Tenant endpoints
    'POST /api/v1/tenants': {
        schema: {
            type: 'object',
            required: ['firstName', 'lastName', 'email', 'phone'],
            properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                email: { type: 'string', format: 'email' },
                phone: { type: 'string' },
                address: { type: 'string' },
                dateOfBirth: { type: 'string', format: 'date' },
                emergencyContact: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        phone: { type: 'string' },
                        relationship: { type: 'string' }
                    }
                },
                notes: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            firstName: 'Jane',
            lastName: 'Smith',
            email: 'jane.smith@example.com',
            phone: '+1-555-987-6543',
            address: '456 Oak Avenue',
            dateOfBirth: '1985-03-20',
            emergencyContact: {
                name: 'John Smith',
                phone: '+1-555-111-2222',
                relationship: 'spouse'
            },
            notes: 'Excellent tenant'
        }
    },
    'PUT /api/v1/tenants/{id}': {
        schema: {
            type: 'object',
            properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                email: { type: 'string', format: 'email' },
                phone: { type: 'string' },
                address: { type: 'string' },
                notes: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            phone: '+1-555-999-8888',
            address: '789 New Street',
            notes: 'Updated contact information'
        }
    },
    'POST /api/v1/tenants/setup': {
        schema: {
            type: 'object',
            required: ['tenantId', 'password'],
            properties: {
                tenantId: { type: 'string' },
                password: { type: 'string' },
                confirmPassword: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            tenantId: '60f7a0b8c2a3f2b1c0d4e5f6',
            passphrase: '<password>',
            confirmPassphrase: '<password>'
        }
    },
    'POST /api/v1/tenants/resend-invite': {
        schema: {
            type: 'object',
            required: ['tenantId'],
            properties: {
                tenantId: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            tenantId: '60f7a0b8c2a3f2b1c0d4e5f6'
        }
    },

    // Maintenance endpoints
    'POST /api/v1/maintenance/request': {
        schema: {
            type: 'object',
            required: ['propertyId', 'tenantId', 'description', 'priority'],
            properties: {
                propertyId: { type: 'string' },
                tenantId: { type: 'string' },
                description: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
                category: { type: 'string' },
                location: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            tenantId: '60f7a0b8c2a3f2b1c0d4e5f7',
            description: 'Leaky faucet in kitchen',
            priority: 'medium',
            category: 'plumbing',
            location: 'kitchen',
            status: 'open'
        }
    },
    'PUT /api/v1/maintenance/request/{id}': {
        schema: {
            type: 'object',
            properties: {
                description: { type: 'string' },
                priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
                status: { type: 'string' },
                assignedTo: { type: 'string' },
                estimatedCost: { type: 'number' }
            },
            additionalProperties: false
        },
        example: {
            status: 'in_progress',
            assignedTo: 'John Maintenance',
            estimatedCost: 150
        }
    },

    // Expense endpoints
    'POST /api/v1/expense': {
        schema: {
            type: 'object',
            required: ['category', 'vendor', 'amount', 'totalAmount'],
            properties: {
                category: { type: 'string' },
                subCategory: { type: 'string' },
                vendor: { type: 'string' },
                vendorContact: { type: 'string' },
                vendorPhone: { type: 'string' },
                vendorEmail: { type: 'string', format: 'email' },
                propertyId: { type: 'string' },
                unit: { type: 'string' },
                amount: { type: 'number', minimum: 0 },
                tax: { type: 'number', minimum: 0 },
                totalAmount: { type: 'number', minimum: 0 },
                status: { type: 'string', enum: ['pending', 'paid', 'unpaid', 'overdue'] },
                expenseDate: { type: 'string', format: 'date' },
                memo: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            category: 'maintenance',
            subCategory: 'plumbing',
            vendor: 'ABC Plumbing Services',
            vendorContact: 'John Smith',
            vendorPhone: '+1-555-777-8888',
            vendorEmail: 'john@abcplumbing.com',
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            unit: 'Unit 1A',
            amount: 250,
            tax: 25,
            totalAmount: 275,
            status: 'pending',
            expenseDate: '2024-01-15',
            memo: 'Fixed leaky faucet in kitchen'
        }
    },
    'PUT /api/v1/expense/{id}': {
        schema: {
            type: 'object',
            properties: {
                category: { type: 'string' },
                vendor: { type: 'string' },
                amount: { type: 'number', minimum: 0 },
                status: { type: 'string', enum: ['pending', 'paid', 'unpaid', 'overdue'] },
                memo: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            status: 'paid',
            memo: 'Payment completed'
        }
    },

    // Invoice endpoints
    'POST /api/v1/invoice': {
        schema: {
            type: 'object',
            required: ['tenantId', 'propertyId', 'amount', 'dueDate', 'description'],
            properties: {
                tenantId: { type: 'string' },
                propertyId: { type: 'string' },
                amount: { type: 'number', minimum: 0 },
                dueDate: { type: 'string', format: 'date' },
                description: { type: 'string' },
                invoiceType: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            tenantId: '60f7a0b8c2a3f2b1c0d4e5f7',
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            amount: 1500,
            dueDate: '2024-02-01',
            description: 'Monthly rent for January 2024',
            invoiceType: 'rent',
            status: 'pending'
        }
    },
    'PUT /api/v1/invoice/{id}': {
        schema: {
            type: 'object',
            properties: {
                amount: { type: 'number', minimum: 0 },
                dueDate: { type: 'string', format: 'date' },
                description: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            amount: 1600,
            description: 'Updated rent amount',
            status: 'sent'
        }
    },

    // Lease endpoints
    'POST /api/v1/leasing/lease': {
        schema: {
            type: 'object',
            required: ['propertyId', 'tenantId', 'startDate', 'endDate', 'rentAmount'],
            properties: {
                propertyId: { type: 'string' },
                tenantId: { type: 'string' },
                startDate: { type: 'string', format: 'date' },
                endDate: { type: 'string', format: 'date' },
                rentAmount: { type: 'number', minimum: 0 },
                securityDeposit: { type: 'number', minimum: 0 },
                terms: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            tenantId: '60f7a0b8c2a3f2b1c0d4e5f7',
            startDate: '2024-01-01',
            endDate: '2024-12-31',
            rentAmount: 1500,
            securityDeposit: 1500,
            terms: 'Standard lease terms and conditions',
            status: 'active'
        }
    },
    'PUT /api/v1/leasing/lease/{id}': {
        schema: {
            type: 'object',
            properties: {
                rentAmount: { type: 'number', minimum: 0 },
                endDate: { type: 'string', format: 'date' },
                terms: { type: 'string' },
                status: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            rentAmount: 1600,
            status: 'active'
        }
    },

    // Template endpoints
    'POST /api/v1/leasing/template': {
        schema: {
            type: 'object',
            required: ['name', 'content'],
            properties: {
                name: { type: 'string' },
                content: { type: 'string' },
                description: { type: 'string' },
                category: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            name: 'Standard Lease Agreement',
            content: 'This lease agreement is entered into...',
            description: 'Standard residential lease template',
            category: 'lease'
        }
    },
    'PUT /api/v1/leasing/template/{id}': {
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                content: { type: 'string' },
                description: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            name: 'Updated Template Name',
            content: 'Updated template content'
        }
    },

    // Event endpoints
    'POST /api/v1/events/events': {
        schema: {
            type: 'object',
            required: ['title', 'description', 'startDate', 'endDate'],
            properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' },
                propertyId: { type: 'string' },
                tenantId: { type: 'string' },
                eventType: { type: 'string' },
                location: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            title: 'Property Inspection',
            description: 'Annual property inspection',
            startDate: '2024-02-15T10:00:00Z',
            endDate: '2024-02-15T12:00:00Z',
            propertyId: '60f7a0b8c2a3f2b1c0d4e5f6',
            eventType: 'inspection',
            location: 'Unit 1A'
        }
    },
    'PUT /api/v1/events/events/{id}': {
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' },
                eventType: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            title: 'Updated Event Title',
            startDate: '2024-02-16T10:00:00Z',
            endDate: '2024-02-16T12:00:00Z'
        }
    },

    // Master Data endpoints
    'POST /api/v1/master/masterData': {
        schema: {
            type: 'object',
            required: ['type', 'value'],
            properties: {
                type: { type: 'string' },
                value: { type: 'string' },
                description: { type: 'string' },
                category: { type: 'string' },
                isActive: { type: 'boolean' }
            },
            additionalProperties: false
        },
        example: {
            type: 'property_type',
            value: 'apartment',
            description: 'Multi-unit residential building',
            category: 'property',
            isActive: true
        }
    },
    'PUT /api/v1/master/masterData/{id}': {
        schema: {
            type: 'object',
            properties: {
                value: { type: 'string' },
                description: { type: 'string' },
                isActive: { type: 'boolean' }
            },
            additionalProperties: false
        },
        example: {
            value: 'updated_value',
            description: 'Updated description',
            isActive: false
        }
    },

    // User Profile endpoints
    'PUT /api/v1/users/userProfile': {
        schema: {
            type: 'object',
            properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                phone: { type: 'string' },
                address: { type: 'string' },
                state: { type: 'string' },
                zipCode: { type: 'string' },
                bio: { type: 'string' }
            },
            additionalProperties: false
        },
        example: {
            firstName: 'John',
            lastName: 'Doe',
            phone: '+1-555-123-4567',
            address: '123 Main Street',
            state: 'NY',
            zipCode: '10001',
            bio: 'Experienced property manager'
        }
    }
};

module.exports = swaggerSchemas;