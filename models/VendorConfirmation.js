'use strict';

const mongoose = require('mongoose');

const ConfirmationLineItemSchema = new mongoose.Schema({
  sapDocumentNumber: { type: String, required: true },
  fiscalYear: { type: String, required: true },
  vendorInvoiceRef: { type: String, default: '' },
  documentDate: { type: Date, default: null },
  netDueDate: { type: Date, default: null },
  amount: { type: Number, required: true },
  debitCreditCode: { type: String, enum: ['H', 'S'], required: true }, // 'H' = Credit (Payable), 'S' = Debit (Advance/Deduction)
  itemText: { type: String, default: '' },
  specialGl: { type: String, default: '' },
}, { _id: false });

const VendorConfirmationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: [true, 'Tenant ID is required'],
    trim: true,
    lowercase: true,
    index: true,
  },

  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ConfirmationCampaign',
    required: false,
    index: true,
  },

  sapVendorNumber: {
    type: String,
    required: [true, 'SAP Vendor Number is required'],
    trim: true,
    index: true,
  },

  vendorName: {
    type: String,
    required: [true, 'Vendor Name is required'],
    trim: true,
  },

  vendorEmail: {
    type: String,
    required: [true, 'Vendor Email is required'],
    trim: true,
    lowercase: true,
  },

  vendorAddress: {
    type: String,
    default: '',
  },

  companyCode: {
    type: String,
    required: true,
    trim: true,
  },

  companyName: {
    type: String,
    default: '',
  },

  companyAddress: {
    type: String,
    default: '',
  },

  unitName: {
    type: String,
    default: '',
  },

  unitAddress: {
    type: String,
    default: '',
  },

  cin: {
    type: String,
    default: '',
  },

  auditorFirmName: {
    type: String,
    default: '',
  },

  auditorAddress: {
    type: String,
    default: '',
  },

  auditorEmails: [{
    type: String,
  }],

  referenceNumber: {
    type: String,
    required: true,
    trim: true,
  },

  keyCutOffDate: {
    type: Date,
    required: true,
  },

  fiscalYear: {
    type: String,
    trim: true,
    default: '',
  },

  // ── Cryptographic Magic Token ──────────────────────────────────────────
  token: {
    type: String,
    required: true,
    index: true,
  },

  tokenHash: {
    type: String,
    required: true,
    index: true,
  },

  tokenExpiresAt: {
    type: Date,
    required: true,
  },

  // ── Initiator Tracking (Reverts back to this user upon completion) ────
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  initiatorEmail: {
    type: String,
    default: '',
  },

  // ── Financial Snapshot (Derived from SAP) ─────────────────────────────
  sapClosingBalance: {
    type: Number,
    required: true,
  },

  openingBalance: {
    type: Number,
    default: 0,
  },

  totalCredit: {
    type: Number,
    default: 0,
  },

  totalDebit: {
    type: Number,
    default: 0,
  },

  balanceSource: {
    type: String,
    default: 'SAP S/4HANA',
  },

  balanceIndicator: {
    type: String,
    enum: ['Credit', 'Debit'],
    default: 'Credit',
  },

  currency: {
    type: String,
    default: 'INR',
  },

  subledgerBreakdown: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  // ── Status & Vendor Response ───────────────────────────────────────────
  // PENDING_VENDOR = Dispatched, awaiting vendor action
  // PENDING_REVIEW = Vendor submitted, reverted to initiator for review
  // CONFIRMED = Agreed by vendor and verified
  // DISPUTED = Disputed by vendor, awaiting / under reconciliation
  // RECONCILED = Initiator reviewed variance and officially closed
  // PRESUMED_CONFIRMED = Auto-confirmed after statutory presumption deadline
  status: {
    type: String,
    enum: ['PENDING_VENDOR', 'PENDING_REVIEW', 'CONFIRMED', 'DISPUTED', 'RECONCILED', 'PRESUMED_CONFIRMED'],
    default: 'PENDING_VENDOR',
    index: true,
  },

  vendorReportedBalance: {
    type: Number,
    default: null,
  },

  differenceAmount: {
    type: Number,
    default: 0,
  },

  disputeReason: {
    type: String,
    default: '',
  },

  vendorStatementFileUrl: {
    type: String,
    default: null,
  },

  vendorStatementFileName: {
    type: String,
    default: null,
  },

  // ── Physical / Uploaded Signed Confirmation Document ─────────────────
  vendorSignedDocumentUrl: {
    type: String,
    default: null,
  },

  vendorSignedDocumentFileName: {
    type: String,
    default: null,
  },

  // ── Archival Copy of the Dispatched Confirmation Notice PDF ──────────
  initialLetterPdfUrl: {
    type: String,
    default: null,
  },

  // ── SA 505 Audit Trail & Digital Sign-Off ──────────────────────────────
  signatoryName: {
    type: String,
    default: '',
  },

  signatoryDesignation: {
    type: String,
    default: '',
  },

  signatoryIp: {
    type: String,
    default: '',
  },

  actionTimestamp: {
    type: Date,
    default: null,
  },

  sealedPdfUrl: {
    type: String,
    default: null,
  },

  // ── Closed-Loop Reconciliation (Initiator Review) ─────────────────────
  reconciliationNotes: {
    type: String,
    default: '',
  },

  reconciledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  reconciledAt: {
    type: Date,
    default: null,
  },

  // ── Cached SAP Line Items Breakdown ───────────────────────────────────
  lineItems: [ConfirmationLineItemSchema],
}, {
  timestamps: true,
});

VendorConfirmationSchema.index({ tenantId: 1, sapVendorNumber: 1, createdAt: -1 });
VendorConfirmationSchema.index({ tenantId: 1, status: 1 });
VendorConfirmationSchema.index({ tenantId: 1, referenceNumber: 1 }, { unique: true });

module.exports = mongoose.model('VendorConfirmation', VendorConfirmationSchema);
