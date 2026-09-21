const mongoose = require('mongoose');

// ── Approval Entry Schema ─────────────────────────────────────────
const ApprovalEntrySchema = new mongoose.Schema({
  level: {
    type: String,
    required: true,
  },
  action: {
    type: String,
    enum: ['APPROVED', 'REJECTED', 'SENT_BACK', 'SAP_PUSHED', 'SAP_FAILED'],
    required: true,
  },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  performedByName: { type: String },
  comments: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
});

// ── Document Schema ───────────────────────────────────────────────
const DocumentSchema = new mongoose.Schema({
  docType: {
    type: String,
    enum: ['PAN_CARD', 'GST_CERTIFICATE', 'CANCELLED_CHEQUE', 'MSME_CERTIFICATE', 'BANK_LETTER', 'ADDRESS_PROOF', 'BALANCE_SHEET_3YR', 'OTHER'],
    required: true,
  },
  fileName: { type: String, required: true },
  storedName: { type: String, required: true },
  filePath: { type: String, required: true },
  fileSize: { type: Number },
  mimeType: { type: String },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now },
  ocrResult: {
    extracted: { type: Object, default: null },
    mismatches: [{
      field: { type: String },
      expected: { type: String },
      found: { type: String }
    }],
    confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW', 'FAILED'], default: null },
    ocrEngine: { type: String, default: null },
    error: { type: String, default: null },
    processedAt: { type: Date, default: null }
  },
  sapAttachmentId: { type: String, default: null },
  sapUploaded: { type: Boolean, default: false },
  sapUploadedAt: { type: Date, default: null },
  sapUploadStatus: { type: String, enum: ['NOT_UPLOADED', 'UPLOADED', 'FAILED', 'SKIPPED'], default: 'NOT_UPLOADED' },
  sapUploadError: { type: String, default: null }
});

// ── Main VendorChangeRequest Schema ──────────────────────────────────
const VendorChangeRequestSchema = new mongoose.Schema({
  sapVendorNumber: {
    type: String,
    required: true,
    index: true,
  },
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  plant: {
    type: String,
    default: null,
    index: true,
  },
  status: {
    type: String,
    enum: [
      'DRAFT',
      'PENDING_APPROVAL',
      'PENDING_L1',
      'PENDING_L2',
      'PENDING_MDT',
      'SAP_PENDING',
      'SAP_UPDATED',
      'SAP_FAILED',
      'REJECTED',
      'SENT_BACK',
      'CANCELLED'
    ],
    default: 'DRAFT',
    index: true,
  },

  // Proposed updates
  proposedChanges: {
    bankDetails: [{
      bankCountry: { type: String, trim: true, default: 'IN' },
      bankKey: { type: String, trim: true },
      ifsc: { type: String, trim: true, uppercase: true },
      accountNumber: { type: String, trim: true },
      accountHolder: { type: String, trim: true },
      bankName: { type: String, trim: true },
      isPrimary: { type: Boolean, default: false },
      controlKey: { type: String, default: 'EN' },
      bankIdentification: { type: String, trim: true },
    }],
    taxDetails: {
      gstin: { type: String, trim: true, uppercase: true },
      pan: { type: String, trim: true, uppercase: true },
      msmeStatus: { type: String, enum: ['NONE', 'MICRO', 'SMALL', 'MEDIUM', 'CANCELLED'], default: 'NONE' },
      msmeNumber: { type: String, trim: true },
      msmeRegDate: { type: Date, default: null },
      msmeValTo: { type: Date, default: null },
      msmeEntryDate: { type: Date, default: null },
      msmeRegion: { type: String, trim: true }
    },
    addressDetails: {
      careOfName: { type: String, trim: true, maxlength: 40 },
      tradeName: { type: String, trim: true, maxlength: 40 },
      street: { type: String, trim: true },
      houseNumber: { type: String, trim: true },
      city: { type: String, trim: true },
      district: { type: String, trim: true },
      state: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      country: { type: String, trim: true, default: 'IN' }
    }
  },

  documents: [DocumentSchema],
  approvalChain: [ApprovalEntrySchema],

  currentLevel: {
    type: String,
    default: null,
  },
  currentStepIndex: {
    type: Number,
    default: 0,
  },

  sapResult: {
    pushedAt: { type: Date, default: null },
    pushedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    requestPayload: { type: Object, default: null },
    responsePayload: { type: Object, default: null },
    errorMessage: { type: String, default: null }
  },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String },
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

VendorChangeRequestSchema.index({ tenantId: 1, status: 1 });
VendorChangeRequestSchema.index({ tenantId: 1, sapVendorNumber: 1 });

module.exports = mongoose.model('VendorChangeRequest', VendorChangeRequestSchema);
