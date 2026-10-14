/**
 * ------------------------------------------------------------------
 * File: serviceTicket.js
 * Module: Src Common Constants
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Service Ticket Request Types and Sub-Types by Role

const PRIMARY_REQUEST_TYPES = {
  MAINTENANCE: 'Maintenance',
  ARCHITECTURAL: 'Architectural',
  VIOLATIONS: 'Violations'
};

const HOA_BOARD_MEMBER_SUB_TYPES = {
  [PRIMARY_REQUEST_TYPES.MAINTENANCE]: [
    'Common Area',
    'Pool Area', 
    'Gym Area',
    'ClubHouse',
    'Landscaping',
    'Pest Control',
    'Other Maintenance'
  ],
  [PRIMARY_REQUEST_TYPES.ARCHITECTURAL]: [
    'Fence',
    'Roof',
    'Siding',
    'Windows / Doors',
    'Driveway / Walkway',
    'Other Architectural'
  ],
  [PRIMARY_REQUEST_TYPES.VIOLATIONS]: [
    'Noise Complaint',
    'Parking Violation',
    'Pet Violation',
    'Other Violation'
  ]
};

const LANDLORD_SUB_TYPES = {
  [PRIMARY_REQUEST_TYPES.MAINTENANCE]: [
    'Plumbing',
    'Electrical',
    'Heating / Cooling',
    'Appliances',
    'AC',
    'Kitchen',
    'Bathroom',
    'Other Maintenance'
  ]
};

const ROLE_PERMISSIONS = {
  hoa_board_member: {
    allowedRequestTypes: [
      PRIMARY_REQUEST_TYPES.MAINTENANCE,
      PRIMARY_REQUEST_TYPES.ARCHITECTURAL,
      PRIMARY_REQUEST_TYPES.VIOLATIONS
    ],
    subTypes: HOA_BOARD_MEMBER_SUB_TYPES
  },
  owner: {
    allowedRequestTypes: [
      PRIMARY_REQUEST_TYPES.MAINTENANCE,
      PRIMARY_REQUEST_TYPES.ARCHITECTURAL,
      PRIMARY_REQUEST_TYPES.VIOLATIONS
    ],
    subTypes: HOA_BOARD_MEMBER_SUB_TYPES
  },
  landlord: {
    allowedRequestTypes: [PRIMARY_REQUEST_TYPES.MAINTENANCE],
    subTypes: LANDLORD_SUB_TYPES
  }
};

module.exports = {
  PRIMARY_REQUEST_TYPES,
  HOA_BOARD_MEMBER_SUB_TYPES,
  LANDLORD_SUB_TYPES,
  ROLE_PERMISSIONS
};
