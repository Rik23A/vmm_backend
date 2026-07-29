const mongoose = require('mongoose');

// Immutable audit log — never updated or deleted
const AuditLogSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorRequest', index: true },
  tempVendorNumber: { type: String },
  sapVendorNumber: { type: String },

  action: {
    type: String,
    enum: [
      'CREATED', 'DRAFT_SAVED', 'DRAFT_DELETED', 'SUBMITTED',
      'L1_APPROVED', 'L1_REJECTED', 'L1_SENT_BACK',
      'L2_APPROVED', 'L2_REJECTED', 'L2_SENT_BACK',
      'MDT_APPROVED', 'MDT_REJECTED', 'MDT_SENT_BACK',
      'SAP_PUSH_TRIGGERED', 'SAP_PUSH_SUCCESS', 'SAP_PUSH_FAILED', 'SAP_PUSH_RETRY',
      'SAP_PATCH_SUCCESS', 'SAP_PATCH_FAILED',
      'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED',
      'USER_CREATED', 'USER_DEACTIVATED', 'USER_ROLE_CHANGED', 'USER_DELETED', 'USER_UPDATED',
      'TENANT_SETTINGS_CHANGED', 'LOGIN', 'LOGOUT',
      'MODIFY_INITIATED', 'PASSWORD_CHANGED', 'WORKFLOW_SETTINGS_CHANGED',
      'CR_DRAFT_SAVED', 'CR_SUBMITTED', 'CR_SAP_UPDATED', 'CR_SAP_FAILED',
      'CR_L1_APPROVED', 'CR_L1_REJECTED', 'CR_L2_APPROVED', 'CR_L2_REJECTED',
      'CR_MDT_APPROVED', 'CR_MDT_REJECTED', 'CR_SENT_BACK',
    ],
    required: true,
  },

  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  performedByName: { type: String },
  performedByRole: { type: String },

  // What changed — for MODIFY requests and settings changes
  changes: [{
    field: String,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
  }],

  comments: { type: String, default: '' },
  ipAddress: { type: String },
  userAgent: { type: String },

  // SAP-specific metadata
  sapPayload: { type: Object, default: null },
  sapResponse: { type: Object, default: null },

  timestamp: { type: Date, default: Date.now, index: true },
}, {
  // Prevent any updates to audit logs
  strict: true,
  // No timestamps: true — we use our own timestamp field
});

// Compound index for efficient tenant-scoped audit queries
AuditLogSchema.index({ tenantId: 1, timestamp: -1 });
AuditLogSchema.index({ tenantId: 1, action: 1, timestamp: -1 });

// ── Static helper: create an audit entry easily ────────────────────
AuditLogSchema.statics.log = async function (data) {
  try {
    return await this.create(data);
  } catch (err) {
    // Audit log failure should NEVER crash the main operation
    console.error('[AUDIT LOG ERROR]', err.message);
  }
};

module.exports = mongoose.model('AuditLog', AuditLogSchema);
