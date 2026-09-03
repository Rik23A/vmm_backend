const Tenant = require('../models/Tenant');

// ── injectTenant ─────────────────────────────────────────────────────
// After requireLogin has run, this middleware loads the full Tenant document
// and attaches it to req.tenant. Used in routes that need SAP config etc.
// Must be used AFTER requireLogin.
const injectTenant = async (req, res, next) => {
  try {
    if (!req.tenantId) {
      return res.status(400).json({ message: 'Tenant context missing.' });
    }
    const tenant = await Tenant.findOne({ tenantId: req.tenantId, isActive: true })
      .select('+sapConfig.sapPassword +emailConfig.emailPass +geminiConfig.geminiApiKey');

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found or inactive.' });
    }
    if (process.env.TENANT_MODE !== 'SINGLE') {
      const now = new Date();
      const isTrialExpired = tenant.subscription.plan === 'TRIAL' && tenant.subscription.trialEndsAt && tenant.subscription.trialEndsAt < now;
      const isPaidExpired = tenant.subscription.paidUntil && tenant.subscription.paidUntil < now;

      if (tenant.subscription.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Your account is suspended. Contact support.' });
      }
      if (tenant.subscription.status === 'EXPIRED' || isTrialExpired || isPaidExpired) {
        return res.status(403).json({ message: 'Your organization subscription has expired. Contact support.' });
      }
    }

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
};

// ── getSapConfig ──────────────────────────────────────────────────────
// Returns the effective SAP config for a tenant.
// Falls back to system .env values if tenant hasn't configured their own.
const getSapConfig = (tenant) => {
  const tc = tenant?.sapConfig || {};
  return {
    sapVersion: tc.sapVersion || process.env.SAP_VERSION || 'STUB',
    sapHost: tc.sapHost || process.env.SAP_HOST || '',
    sapClient: tc.sapClient || process.env.SAP_CLIENT || '',
    sapSystemId: tc.sapSystemId || process.env.SAP_SYSTEM_ID || '',
    sapUser: tc.sapUser || process.env.SAP_USER || '',
    sapPassword: tc.sapPassword || process.env.SAP_PASSWORD || '',
    sapOdataUrl: tc.sapOdataUrl || process.env.SAP_ODATA_URL || '',
    sapIndiaTaxOdataUrl: tc.sapIndiaTaxOdataUrl || process.env.SAP_INDIA_TAX_ODATA_URL || '',
    companyCodes: tc.companyCodes || [],
    purchasingOrgs: tc.purchasingOrgs || [],
    sapBpGrouping: tc.sapBpGrouping || process.env.SAP_BP_GROUPING || 'ZV01',
    vendorRoleFI: tc.vendorRoleFI || process.env.SAP_VENDOR_ROLE_FI || 'FLVN00',
    vendorRolePurchasing: tc.vendorRolePurchasing || process.env.SAP_VENDOR_ROLE_PURCHASING || 'FLVN01',
    taxTypePan: tc.taxTypePan || process.env.SAP_TAX_TYPE_PAN || 'IN3',
    taxTypeGst: tc.taxTypeGst || process.env.SAP_TAX_TYPE_GST || 'IN03',
    cviRetryCount: tc.cviRetryCount !== undefined ? tc.cviRetryCount : (process.env.SAP_CVI_RETRY_COUNT ? parseInt(process.env.SAP_CVI_RETRY_COUNT) : 10),
    cviRetryDelay: tc.cviRetryDelay !== undefined ? tc.cviRetryDelay : (process.env.SAP_CVI_RETRY_DELAY ? parseInt(process.env.SAP_CVI_RETRY_DELAY) : 3000),
    grBasedIVField: tc.grBasedIVField || process.env.SAP_GR_BASED_IV_FIELD || 'InvoiceIsGoodsReceiptBased',
    sapProtocol: tc.sapProtocol || process.env.SAP_PROTOCOL || 'http',
    sapPort: tc.sapPort || process.env.SAP_PORT || '8000',
  };
};

// ── getGeminiConfig ───────────────────────────────────────────────────
const getGeminiConfig = (tenant) => {
  const gc = tenant?.geminiConfig || {};
  const primaryModel = gc.primaryModel || gc.geminiModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const fallbackModel = gc.fallbackModel !== undefined ? gc.fallbackModel : 'gemma-4-31b-it';

  return {
    enableOcrValidation: gc.enableOcrValidation !== undefined ? gc.enableOcrValidation : false,
    geminiApiKey: gc.geminiApiKey || process.env.GEMINI_API_KEY || '',
    geminiModel: primaryModel,
    primaryModel,
    fallbackModel,
  };
};

module.exports = { injectTenant, getSapConfig, getGeminiConfig };
