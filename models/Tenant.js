const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: [true, 'Tenant ID is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-z0-9_-]+$/, 'Tenant ID can only contain lowercase letters, numbers, hyphens, underscores'],
  },

  companyName: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
  },

  regdOfficeAddress: {
    type: String,
    default: '',
  },

  cin: {
    type: String,
    default: '',
  },

  phone: {
    type: String,
    default: '',
  },

  fax: {
    type: String,
    default: '',
  },

  website: {
    type: String,
    default: '',
  },

  // ── Multi-Entity / Company Codes Configuration ──────────────────────
  // Allows supporting multiple legal company entities under one tenant
  companyEntities: {
    type: [{
      companyCode: { type: String, required: true },
      legalName: { type: String, required: true },
      cin: { type: String, default: '' },
      gstin: { type: String, default: '' },
      pan: { type: String, default: '' },
      regdOfficeAddress: { type: String, default: '' },
      phone: { type: String, default: '' },
      fax: { type: String, default: '' },
      website: { type: String, default: '' },
      logoUrl: { type: String, default: '' },
    }],
    default: [],
  },

  subdomain: {
    type: String,
    unique: true,
    sparse: true, // allows null for non-subdomain setups
    trim: true,
    lowercase: true,
  },

  // ── SAP Configuration (per tenant — admin configures via Settings UI)
  sapConfig: {
    // STUB = demo mode, ECC = SAP ECC via BAPI, S4HANA = OData API, S4HANA_BAPI = S/4HANA BP via BAPI (VMD_EI_API)
    sapVersion: {
      type: String,
      enum: ['STUB', 'ECC', 'S4HANA', 'S4HANA_BAPI'],
      default: 'STUB',
    },
    sapHost: { type: String, default: '' },
    sapClient: { type: String, default: '' },
    sapSystemId: { type: String, default: '' },
    sapUser: { type: String, default: '' },
    sapPassword: { type: String, default: '', select: false }, // never returned in queries
    sapOdataUrl: { type: String, default: '' }, // for S4HANA API_BUSINESS_PARTNER
    sapIndiaTaxOdataUrl: { type: String, default: '' }, // for ZBP_INDIA_SP_SRV
    companyCodes: [{ type: String }],
    purchasingOrgs: [{ type: String }],
    sapBpGrouping: { type: String, default: 'Z001' },
    bpGroupings: {
      type: [{
        code: { type: String, required: true },
        name: { type: String, required: true }
      }],
      default: []
    },
    legalForms: {
      type: [{
        code: { type: String, required: true },
        name: { type: String, required: true }
      }],
      default: []
    },
    vendorRoleFI: { type: String, default: 'FLVN00' },
    vendorRolePurchasing: { type: String, default: 'FLVN01' },
    taxTypePan: { type: String, default: 'IN3' },
    taxTypeGst: { type: String, default: 'IN03' },
    cviRetryCount: { type: Number, default: 10 },
    cviRetryDelay: { type: Number, default: 3000 },
    grBasedIVField: { type: String, default: 'InvoiceIsGoodsReceiptBased' },
    sapProtocol: { type: String, default: 'http' },
    sapPort: { type: String, default: '8000' },
  },

  // ── Email config override (if client has their own SMTP)
  emailConfig: {
    useDefault: { type: Boolean, default: true }, // true = use system .env email
    emailHost: { type: String, default: '' },
    emailPort: { type: Number, default: 587 },
    emailUser: { type: String, default: '' },
    emailPass: { type: String, default: '', select: false },
    emailFrom: { type: String, default: '' },
  },

  // ── Subscription / plan
  subscription: {
    plan: {
      type: String,
      enum: ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'],
      default: 'TRIAL',
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'SUSPENDED', 'EXPIRED'],
      default: 'ACTIVE',
    },
    trialEndsAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, // 30 days
    paidUntil: { type: Date, default: null },
  },

  // ── Modular Entitlements (Add-on modules enabled per company)
  modules: {
    vendorMaster: { type: Boolean, default: true },
    balanceConfirmation: { type: Boolean, default: false },
    customerMaster: { type: Boolean, default: false },
  },

  // ── Vendor Balance Confirmation (SA 505) Configuration
  balanceConfirmationConfig: {
    defaultAuditorGroupEmail: { type: String, default: '' },
    defaultClientApEmail: { type: String, default: '' },
    defaultResponseDeadlineDays: { type: Number, default: 10 },
    disclaimerClause: {
      type: String,
      default: 'This balance confirmation is requested in accordance with Standard on Auditing (SA) 505 issued by the Institute of Chartered Accountants of India (ICAI).'
    },
    auditorFirmName: { type: String, default: '' },
    auditorAddress: { type: String, default: '' },
    auditorEmails: [{ type: String }],
    auditors: [{
      auditorFirmName: { type: String, required: true },
      address: { type: String, default: '' },
      emails: [{ type: String }],
      activeForFiscalYears: [{ type: String }],
    }],
  },

  // ── Workflow configuration
  workflowConfig: {
    requireL2Approval: { type: Boolean, default: true },   // can skip L2 for some tenants
    autoNotifyEmail: { type: Boolean, default: true },     // email notifications on/off
    sapAutoSync: { type: Boolean, default: false },        // auto push to SAP on MDT approval
  },

  // ── Gemini OCR Configuration (per tenant)
  geminiConfig: {
    enableOcrValidation: { type: Boolean, default: false },
    geminiApiKey: { type: String, default: '', select: false }, // never returned in normal queries
    geminiModel: { type: String, default: 'gemma-4-31b-it' },
    primaryModel: { type: String, default: 'gemma-4-31b-it' },
    fallbackModel: { type: String, default: 'gemini-3.5-flash-lite' },
    primaryDailyLimit: { type: Number, default: 5000 },
    fallbackDailyLimit: { type: Number, default: 400 },
  },

  plants: {
    type: [{
      code: { type: String, required: true },
      name: { type: String, required: true },
      companyCode: { type: String, default: '' },
      division: { type: String, default: '' },
      address: { type: String, default: '' },
      apEmail: { type: String, default: '' },
      signatoryTitle: { type: String, default: 'Authorized Signatory' },
    }],
    default: []
  },

  isActive: { type: Boolean, default: true },

  // Created by the platform ADMIN
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

}, {
  timestamps: true,
});

module.exports = mongoose.model('Tenant', TenantSchema);
