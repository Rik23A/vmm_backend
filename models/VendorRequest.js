const mongoose = require('mongoose');

// ── Counter for generating sequential temp vendor numbers ────────────
const CounterSchema = new mongoose.Schema({
  _id: String, // e.g., "VMM-2026"
  seq: { type: Number, default: 0 },
});
const Counter = mongoose.model('Counter', CounterSchema);

// ── Generate temp vendor number: VMM-YYYY-NNNNN ──────────────────────
async function generateTempVendorNumber() {
  const year = new Date().getFullYear();
  const counterId = `VMM-${year}`;
  const counter = await Counter.findByIdAndUpdate(
    counterId,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const seq = String(counter.seq).padStart(5, '0');
  return `VMM-${year}-${seq}`;
}

// ── Approval Entry Sub-Schema ─────────────────────────────────────────
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
  performedByName: { type: String }, // denormalized for audit display
  comments: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
});

// ── Document Sub-Schema ───────────────────────────────────────────────
const DocumentSchema = new mongoose.Schema({
  docType: {
    type: String,
    enum: ['PAN_CARD', 'GST_CERTIFICATE', 'CANCELLED_CHEQUE', 'MSME_CERTIFICATE', 'BANK_LETTER', 'BALANCE_SHEET_3YR', 'OTHER'],
    required: true,
  },
  fileName: { type: String, required: true },   // original file name
  storedName: { type: String, required: true },  // UUID-based stored name in /uploads
  filePath: { type: String, required: true },    // relative path: uploads/tenantId/filename
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
  }
});

// ── Main VendorRequest Schema ─────────────────────────────────────────
const VendorRequestSchema = new mongoose.Schema({

  // ── Identification ─────────────────────────────────────────────────
  // TEMP number assigned on first submit. Real SAP number assigned after SAP push.
  tempVendorNumber: {
    type: String,
    unique: true,
    sparse: true,  // only set when first submitted (not on draft)
    index: true,
  },
  sapVendorNumber: {
    type: String,
    default: null, // null until SAP push succeeds
    index: true,
  },

  // Multi-tenancy
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

  requestType: {
    type: String,
    enum: ['CREATE', 'MODIFY'],
    required: true,
    default: 'CREATE',
  },

  // For MODIFY requests — which existing vendor is being changed
  existingVendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VendorRequest',
    default: null,
  },

  // ── Status Machine ─────────────────────────────────────────────────
  // DRAFT → PENDING_L1 → PENDING_L2 → PENDING_MDT → SAP_PENDING → SAP_PUSHED / SAP_FAILED
  // REJECTED / SENT_BACK can occur at any approval stage
  status: {
    type: String,
    enum: [
      'DRAFT',
      'PENDING_APPROVAL',
      'PENDING_L1',
      'PENDING_L2',
      'PENDING_MDT',
      'SAP_PENDING',
      'SAP_PUSHED',
      'SAP_FAILED',
      'REJECTED',
      'SENT_BACK',
      'CANCELLED',
    ],
    default: 'DRAFT',
    index: true,
  },

  generalData: {
    vendorName: { type: String, trim: true, maxlength: 35 },
    searchTerm: { type: String, trim: true, uppercase: true, maxlength: 20 },
    vendorType: { type: String, enum: ['DOMESTIC', 'INTERNATIONAL'], default: 'DOMESTIC' },
    title: { type: String, trim: true, default: null }, // Title / Form of Address code (e.g. 0003)
    language: { type: String, default: 'EN', maxlength: 2 },
    email: { type: String, trim: true, lowercase: true },
    mobile: { type: String, trim: true },
    phone: { type: String, trim: true },
    bpGrouping: { type: String, default: null },
    legalForm: { type: String, default: null },
    // Address
    street: { type: String, trim: true, maxlength: 35 },
    city: { type: String, trim: true, maxlength: 35 },
    district: { type: String, trim: true, maxlength: 35, default: '' },
    state: { type: String, trim: true, maxlength: 3 },  // SAP region code
    postalCode: { type: String, trim: true, maxlength: 10 },
    country: { type: String, trim: true, maxlength: 3, default: 'IN' }, // ISO country code
  },

  // ── Company Code Data (LFB1) ───────────────────────────────────────
  companyCodeData: {
    companyCode: { type: String, trim: true, maxlength: 4, uppercase: true },
    reconciliationAccount: { type: String, trim: true, maxlength: 10 },
    paymentTerms: { type: String, trim: true, maxlength: 4, uppercase: true },
    toleranceGroup: { type: String, trim: true },
    withholdingTaxType: { type: String, trim: true },
    withholdingTaxCode: { type: String, trim: true },
    withholdingTax: [
      {
        taxType: { type: String },
        taxCode: { type: String, default: '' },
        subject: { type: Boolean, default: true },
        recipientType: { type: String, default: 'OT' },
        exemptionNumber: { type: String, default: '' },
        exemptionPercent: { type: Number, default: 0 },
        exemptFrom: { type: String, default: null },
        exemptTo: { type: String, default: null }
      }
    ],
  },

  // ── Purchasing Data (LFM1) ─────────────────────────────────────────
  purchasingData: {
    purchasingOrg: { type: String, trim: true, maxlength: 4, uppercase: true },
    orderCurrency: { type: String, trim: true, maxlength: 5, uppercase: true, default: 'INR' },
    incoterms: { type: String, trim: true },
    incotermsLocation: { type: String, trim: true },
    grBasedInvoice: { type: Boolean, default: true },
  },

  // ── Bank Details (LFBK) — multiple banks allowed ───────────────────
  bankDetails: [{
    bankCountry: { type: String, trim: true, default: 'IN' },
    bankKey: { type: String, trim: true },    // SAP Bank Key (separate configuration)
    ifsc: { type: String, trim: true, uppercase: true }, // Bank IFSC (for checking/validation)
    accountNumber: { type: String, trim: true },
    accountHolder: { type: String, trim: true },
    bankName: { type: String, trim: true },
    isPrimary: { type: Boolean, default: false },
    controlKey: { type: String, default: 'EN' },
  }],

  // ── Tax Details (India-specific) ──────────────────────────────────
  taxDetails: {
    pan: {
      type: String,
      trim: true,
      uppercase: true,
    },
    gstin: {
      type: String,
      trim: true,
      uppercase: true,
    },
    msmeStatus: {
      type: String,
      enum: ['NONE', 'MICRO', 'SMALL', 'MEDIUM'],
      default: 'NONE',
    },
    msmeNumber: { type: String, trim: true },
    msmeRegDate: { type: Date, default: null },
    tin: { type: String, trim: true },
  },

  // ── Documents ─────────────────────────────────────────────────────
  documents: [DocumentSchema],

  // ── Duplicate Detection Result ────────────────────────────────────
  duplicateCheck: {
    checked: { type: Boolean, default: false },
    isDuplicate: { type: Boolean, default: false },
    matchType: { type: String, enum: ['EXACT', 'FUZZY', 'NONE'], default: 'NONE' },
    matchedRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'VendorRequest', default: null },
    checkedAt: { type: Date },
    sapMatches: [{
      businessPartner: { type: String },
      fullName: { type: String },
      houseNumber: { type: String },
      streetName: { type: String },
      city: { type: String },
      country: { type: String },
      matchRuleName: { type: String },
      matchScore: { type: Number },
    }],
  },

  // ── Approval Chain (immutable log of all approval actions) ────────
  approvalChain: [ApprovalEntrySchema],

  // ── Current Approver Info ─────────────────────────────────────────
  currentLevel: {
    type: String,
    default: null,
  },
  currentStepIndex: {
    type: Number,
    default: 0,
  },

  // ── SAP Integration Result ────────────────────────────────────────
  sapResult: {
    vendorNumber: { type: String, default: null },   // Real SAP vendor number (0000012345)
    pushedAt: { type: Date, default: null },
    pushedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sapVersion: { type: String },                     // Which SAP version was used: ECC | S4HANA | STUB
    requestPayload: { type: Object, default: null },  // What was sent to SAP (for debugging)
    responsePayload: { type: Object, default: null }, // What SAP returned
    errorMessage: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
  },

  // ── Delta tracking for MODIFY requests ───────────────────────────
  changedFields: [{ fieldPath: String, oldValue: String, newValue: String }],

  // ── Version for optimistic concurrency ───────────────────────────
  __v: { type: Number, select: false },

  // ── Requestor ────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByName: { type: String },  // denormalized
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },

}, {
  timestamps: true,
  // Custom toJSON to expose vendorNumber as a unified field
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// ── Virtual: displayVendorNumber ──────────────────────────────────────
// Returns SAP number if pushed, otherwise temp number
VendorRequestSchema.virtual('displayVendorNumber').get(function () {
  return this.sapVendorNumber || this.tempVendorNumber || null;
});

// ── Compound indexes for fast tenant-scoped queries ───────────────────
VendorRequestSchema.index({ tenantId: 1, status: 1 });
VendorRequestSchema.index({ tenantId: 1, 'taxDetails.pan': 1 });
VendorRequestSchema.index({ tenantId: 1, 'taxDetails.gstin': 1 });
VendorRequestSchema.index({ tenantId: 1, createdAt: -1 });

// ── Pre-save: assign tempVendorNumber on first submit ─────────────────
VendorRequestSchema.pre('save', async function (next) {
  // Only assign temp number when moving from DRAFT/SENT_BACK to PENDING_APPROVAL/PENDING_L1 for the first time
  if (this.isModified('status') && ['PENDING_L1', 'PENDING_APPROVAL'].includes(this.status) && !this.tempVendorNumber) {
    this.tempVendorNumber = await generateTempVendorNumber();
    this.submittedAt = new Date();
  }
  // Set completedAt when fully done
  if (this.isModified('status') && ['SAP_PUSHED', 'REJECTED', 'CANCELLED'].includes(this.status)) {
    this.completedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('VendorRequest', VendorRequestSchema);
module.exports.generateTempVendorNumber = generateTempVendorNumber;
