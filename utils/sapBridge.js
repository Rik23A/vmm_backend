'use strict';
/**
 * SAP Integration Bridge — utils/sapBridge.js
 *
 * Correct API_BUSINESS_PARTNER entity flow (multi-step):
 *   Step 1 → POST A_BusinessPartner          (BP + Address + TaxNumber + Bank deep-insert)
 *   Step 2 → POST A_BusinessPartnerRole (FI + Purchasing roles), then poll
 *             A_Supplier / to_Supplier until CVI generates the Supplier record
 *   Step 3 → POST A_SupplierCompany          (company code data)
 *   Step 4 → POST A_SupplierPurchasingOrg    (purchasing org data)
 *
 * CSRF token is fetched and cached before every write (POST/PATCH/DELETE).
 *
 * ── PAN / IN0 / IN3 notes (S/4HANA 2023, confirmed via TFKTAXNUMTYPE + SPRO) ──
 *   IN1 is NOT maintained in this client's tax-number-category customizing
 *   (dead/legacy category — only present on historically migrated BPs).
 *   IN0 is the active category now used for PAN.
 *   IN3 is GSTIN — confirmed correct, unchanged.
 *   PAN is written via to_BusinessPartnerTax (IN0) and the write succeeds,
 *   but does NOT mirror onto the India: Withholding Tax → PAN field on the
 *   Vendor: Country-Spec. Enh. screen — that field is populated by a
 *   country-specific CIN mechanism outside this OData service (confirmed via
 *   controlled test: BP 1013531, PAN field blank post-creation). Same is true
 *   for the India: TAN-Based Exemption grid — populated by a separate CIN
 *   table, not by to_SupplierWithHoldingTax (which correctly populates the
 *   *standard* Vendor: Withholding Tax tab instead — confirmed via BP 1013530).
 *   Both of those two screens are maintained manually by FI/consultant team.
 */

const axios = require('axios');
const https = require('https');
const sapIndiaTaxBridge = require('./sapIndiaTaxBridge');

// ── Constants ──────────────────────────────────────────────────────────────
const CSRF_TTL_MS = 25 * 60 * 1000; // 25 min (SAP token lifetime = 30 min)
const SAP_TIMEOUT = 30_000;

// ── Shared keep-alive HTTPS agent (one per process, not one per call) ─────
// Keeps TCP connections alive across requests so SAP sees the same session.
const _sharedAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ── CSRF + Session Cache (per SAP system, supports multi-tenant) ──────────
// Each entry: { token, cookie, fetchedAt }
//   token  — x-csrf-token header value
//   cookie — SAP session cookie(s) extracted from set-cookie response headers
//            (e.g. SAP_SESSIONID_800_xxx=...).  Empty string when SAP is
//            configured stateless (see below).
const _csrfCache = new Map();

const _cacheKey = (cfg) => `${cfg.sapOdataUrl}::${cfg.sapClient || '100'}::${cfg.sapUser}`;
const _isFresh  = (e)   => e && (Date.now() - e.fetchedAt.getTime()) < CSRF_TTL_MS;

/**
 * Fetch a fresh CSRF token from SAP via GET $metadata with x-csrf-token: Fetch.
 *
 * SAP's CSRF protection is session-scoped: the token is valid only within the
 * session that issued it.  We therefore capture the set-cookie header returned
 * by the Fetch GET and forward it on every subsequent write so that SAP sees
 * the same session — this is the fix for the "fails even after token retry"
 * symptom observed when no cookie was forwarded.
 *
 * If SAP is configured as a stateless ICF service (SICF → stateless client
 * management), no set-cookie header is returned and `cookie` will be an empty
 * string.  In that case the token must be fetched fresh before every write
 * (set CSRF_TTL_MS = 0 in the environment to disable caching for that landscape).
 */
const fetchCsrfToken = async (cfg) => {
  const client = cfg.sapClient || '100';
  const url = `${cfg.sapOdataUrl}/$metadata?sap-client=${client}`;
  console.log(`🔑 [CSRF] Fetching token → ${url}`);

  const res = await axios.get(url, {
    headers: {
      'x-csrf-token': 'Fetch',
      Accept: 'application/xml',
      'sap-client': client,
      'X-Requested-With': 'XMLHttpRequest',
    },
    auth: { username: cfg.sapUser, password: cfg.sapPassword },
    timeout: SAP_TIMEOUT,
    validateStatus: (s) => s < 500,
    httpsAgent: _sharedAgent,   // ← reuse shared keep-alive agent
  });

  const token = res.headers['x-csrf-token'];
  if (!token || token === 'Required') {
    throw new Error('[SAP CSRF] No token returned. Check credentials and OData authorizations.');
  }

  // ── Capture session cookie from Fetch response ──────────────────────────
  // Format: take only the name=value portion of each Set-Cookie directive
  // (strip ;Path=..., ;HttpOnly, etc.) and join with "; ".
  const rawCookies = res.headers['set-cookie'];
  const cookie = Array.isArray(rawCookies)
    ? rawCookies.map(c => c.split(';')[0]).join('; ')
    : (typeof rawCookies === 'string' ? rawCookies.split(';')[0] : '');

  _csrfCache.set(_cacheKey(cfg), { token, cookie, fetchedAt: new Date() });

  if (cookie) {
    console.log(`✅ [CSRF] Token cached (session cookie captured — stateful mode)`);
  } else {
    console.warn(`✅ [CSRF] Token cached (⚠️  no set-cookie returned — SAP may be stateless; consider setting CSRF_TTL_MS=0)`);
  }
  return { token, cookie };
};

const getCsrfToken = async (cfg, force = false) => {
  const entry = _csrfCache.get(_cacheKey(cfg));
  if (!force && _isFresh(entry)) return entry;   // returns { token, cookie, fetchedAt }
  return fetchCsrfToken(cfg);
};

const invalidateCsrfToken = (cfg) => _csrfCache.delete(_cacheKey(cfg));

// ── Axios instance factory ─────────────────────────────────────────────────
// Returns a new configured axios instance.  The httpsAgent is the shared
// keep-alive agent so TCP connections are reused across calls.
const _sapInstance = (cfg) =>
  axios.create({
    baseURL: cfg.sapOdataUrl,
    timeout: SAP_TIMEOUT,
    auth: { username: cfg.sapUser, password: cfg.sapPassword },
    params: {
      'sap-client': cfg.sapClient || '100',
    },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'sap-client': cfg.sapClient || '100',
      'X-Requested-With': 'XMLHttpRequest',
    },
    httpsAgent: _sharedAgent,   // ← shared keep-alive agent
  });

// Helper to mask sensitive information (tax IDs, bank accounts, emails, phones) in diagnostic log printouts
const _maskSensitivePayload = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));

  const maskStr = (str, visibleFromStart = 0, visibleFromEnd = 0) => {
    if (!str || typeof str !== 'string') return str;
    if (str.length <= (visibleFromStart + visibleFromEnd)) return str;
    const start = str.substring(0, visibleFromStart);
    const end = str.substring(str.length - visibleFromEnd);
    return `${start}${'*'.repeat(str.length - visibleFromStart - visibleFromEnd)}${end}`;
  };

  const walk = (node) => {
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        walk(node[key]);
      } else if (typeof node[key] === 'string') {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('taxnumber') || lowerKey.includes('stcd') || lowerKey === 'taxnumxl') {
          node[key] = maskStr(node[key], 3, 2);
        } else if (lowerKey.includes('account') || lowerKey.includes('bankn') || lowerKey.includes('bank_acct')) {
          node[key] = maskStr(node[key], 0, 4);
        } else if (lowerKey.includes('email') || lowerKey.includes('e_mail')) {
          node[key] = maskStr(node[key], 2, 4);
        } else if (lowerKey.includes('phone') || lowerKey.includes('tele')) {
          node[key] = maskStr(node[key], 2, 2);
        } else if (lowerKey.includes('password') || lowerKey.includes('pass')) {
          node[key] = '********';
        }
      }
    }
  };

  walk(clone);
  return clone;
};

// Helper to determine if an OData error is transient (network timeout, connection drop, or server 5xx error)
const _isTransient = (err) => {
  if (!err.response) return true; // network timeout / connectivity issue
  return err.response.status >= 500; // server-side gateway error
};

// ── SAP OData Write (POST / PATCH / DELETE) with CSRF + session cookie ───
const sapODataWrite = async (cfg, method, path, data) => {
  const instance = _sapInstance(cfg);

  const executeCall = async () => {
    // getCsrfToken returns { token, cookie, fetchedAt }
    let { token, cookie } = await getCsrfToken(cfg);

    const call = (t, c) => {
      const hdrs = { 'x-csrf-token': t };
      // Forward the SAP session cookie so the token is validated against the
      // same session that issued it — this is the key fix for the 403 retry loop.
      if (c) hdrs['Cookie'] = c;
      if (method.toUpperCase() === 'PATCH') hdrs['If-Match'] = '*';
      if (method.toUpperCase() === 'POST')  hdrs['Prefer']   = 'return=representation';
      return instance.request({ method, url: path, data, headers: hdrs });
    };

    try {
      console.log(`📤 [SAP] ${method} ${path}`);
      if (data) {
        console.log(`📦 Masked Payload:`, JSON.stringify(_maskSensitivePayload(data), null, 2));
      }
      const res = await call(token, cookie);
      console.log(`✅ [SAP] ${method} ${path} → HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (err.response?.status === 403) {
        console.warn('⚠️  [SAP] 403 — refreshing CSRF token + session cookie and retrying…');
        invalidateCsrfToken(cfg);
        const fresh = await getCsrfToken(cfg, true);
        return call(fresh.token, fresh.cookie);
      }
      throw err;
    }
  };

  const maxWriteRetries = 3;
  for (let i = 1; i <= maxWriteRetries; i++) {
    try {
      return await executeCall();
    } catch (err) {
      if (_isTransient(err) && i < maxWriteRetries) {
        const delay = i * 2000;
        console.warn(`⚠️  [SAP] Transient error on write (${method} ${path}): ${err.message}. Retrying in ${delay}ms (attempt ${i}/${maxWriteRetries})…`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw _normalizeErr(err);
      }
    }
  }
};

// ── SAP OData Read (GET) ───────────────────────────────────────────────────
const sapODataRead = async (cfg, path) => {
  console.log(`📥 [SAP] GET ${path}`);
  const instance = _sapInstance(cfg);

  // Attach session cookie on reads too — keeps the same session alive and
  // avoids unnecessary session churn on the SAP application server.
  const getCookieHeader = () => {
    const entry = _csrfCache.get(_cacheKey(cfg));
    return (entry && entry.cookie) ? { Cookie: entry.cookie } : {};
  };

  const maxReadRetries = 3;
  for (let i = 1; i <= maxReadRetries; i++) {
    try {
      const res = await instance.get(path, { headers: getCookieHeader() });
      console.log(`✅ [SAP] GET ${path} → HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (_isTransient(err) && i < maxReadRetries) {
        const delay = i * 2000;
        console.warn(`⚠️  [SAP] Transient error on read (GET ${path}): ${err.message}. Retrying in ${delay}ms (attempt ${i}/${maxReadRetries})…`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw _normalizeErr(err);
      }
    }
  }
};

// ── Error helpers ──────────────────────────────────────────────────────────
const _normalizeErr = (err) => {
  if (!err.response) return new Error(`[SAP] Network error: ${err.message}`);
  const { status, data } = err.response;

  console.error(`❌ [SAP] HTTP ${status}:`, typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data).substring(0, 500));

  const msg =
    data?.error?.message?.value ||
    data?.error?.message ||
    data?.message ||
    (typeof data === 'string' && data.includes('<html') ? 'SAP Authentication failed (401/403) or ICF node configuration issue' : JSON.stringify(data));

  const newErr = new Error(`[SAP] HTTP ${status}: ${msg}`);
  // Map upstream 401/403 to 502 Bad Gateway so client-side Axios interceptor
  // doesn't log the VMM user out of the application dashboard.
  newErr.status = (status === 401 || status === 403) ? 502 : status;
  return newErr;
};

// Check if an error signifies that a Business Partner role is already assigned
const _isRoleAlreadyAssigned = (err) => {
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('already exists') || msg.includes('409') || msg.includes('422') || msg.includes('conflict') || msg.includes('already assigned')) {
    return true;
  }
  // Check gateway innererror errordetails array
  const details = err.response?.data?.error?.innererror?.errordetails || [];
  return details.some(d => {
    const dMsg = (d.message || '').toLowerCase();
    return dMsg.includes('already assigned') || dMsg.includes('already exists') || dMsg.includes('conflict');
  });
};

// Polls CVI to ensure BP to Supplier synchronization has finished (uses standard BP expand to_Supplier path)
const waitForSupplier = async (bpNumber, cfg, txId) => {
  // Wait 1 second before starting CVI polling (gives S/4 Gateway processing buffer)
  console.log(`⏱️  [TX-${txId}] Sleeping 1000ms before beginning CVI Supplier polling...`);
  await new Promise(r => setTimeout(r, 1000));

  const maxRetries = cfg?.cviRetryCount !== undefined ? cfg.cviRetryCount : 10;
  const retryDelay = cfg?.cviRetryDelay !== undefined ? cfg.cviRetryDelay : 3000;
  console.log(`🔍 [TX-${txId}] Verifying Supplier generation via CVI for BP: ${bpNumber} (Retries: ${maxRetries}, Delay: ${retryDelay}ms)`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let isFatal = false;
    let lastError = null;

    // 1. Try direct read from A_Supplier (covers 1:1 BP-Supplier numbering setups)
    try {
      const getRes = await sapODataRead(cfg, `/A_Supplier('${bpNumber}')?$format=json`);
      const supplierId = getRes.data?.d?.Supplier || getRes.data?.Supplier;
      if (supplierId) {
        console.log(`✅ [TX-${txId}] Supplier confirmed directly: ${supplierId}`);
        return supplierId;
      }
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        isFatal = true;
      }
      console.log(`⚠️  [CVI Verification] [TX-${txId}] Supplier '${bpNumber}' not found directly (attempt ${attempt}/${maxRetries}). Checking for relationship expand...`);
    }

    if (isFatal) {
      throw new Error(`[SAP CVI Error] Authentication/Authorization failed: ${lastError?.message}`);
    }

    // 2. Fall back to standard BP expand to_Supplier path (covers custom number assignment ranges)
    try {
      const getBPRes = await sapODataRead(cfg, `/A_BusinessPartner('${bpNumber}')?$expand=to_Supplier&$format=json`);
      const toSupplierData = getBPRes.data?.d?.to_Supplier || getBPRes.data?.to_Supplier;

      let supplierData = null;
      if (toSupplierData) {
        if (Array.isArray(toSupplierData.results)) {
          supplierData = toSupplierData.results[0];
        } else if (Array.isArray(toSupplierData)) {
          supplierData = toSupplierData[0];
        } else {
          supplierData = toSupplierData;
        }
      }

      if (supplierData && supplierData.Supplier) {
        console.log(`✅ [TX-${txId}] Supplier confirmed via relationship expand: ${supplierData.Supplier}`);
        return supplierData.Supplier;
      }
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        isFatal = true;
      }
      console.warn(`⚠️  [CVI Verification] [TX-${txId}] Failed to read BP expand relationship: ${err.message}`);
    }

    if (isFatal) {
      throw new Error(`[SAP CVI Error] Authentication/Authorization failed: ${lastError?.message}`);
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  throw new Error(`[SAP CVI Error] Supplier was not generated for Business Partner '${bpNumber}' by Customer Vendor Integration (CVI) after maximum retries. Please verify customizing.`);
};

// Retry-aware child posting wrapper to prevent synchronization race conditions (LFB1/LFM1 locks)
const postSupplierChildWithRetry = async (cfg, path, payload, txId, label) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sapODataWrite(cfg, 'POST', path, payload);
      console.log(`✅ [${label}] [TX-${txId}] Created successfully`);
      return;
    } catch (err) {
      const errMsg = (err.message || '').toLowerCase();
      const errDataMsg = (err.response?.data?.error?.message?.value || '').toLowerCase();

      const isSyncLag =
        errMsg.includes('not exist') ||
        errMsg.includes('not assigned') ||
        errMsg.includes('not yet synchronized') ||
        errMsg.includes('not completed') ||
        errDataMsg.includes('does not exist') ||
        errDataMsg.includes('not assigned') ||
        errDataMsg.includes('not yet synchronized') ||
        errDataMsg.includes('not completed');

      if (attempt < 3 && isSyncLag) {
        console.warn(`⚠️  [${label}] [TX-${txId}] Post failed on attempt ${attempt} due to potential CVI database synchronisation lag. Retrying in 2000ms...`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION A — S/4HANA: Multi-step vendor creation
//
//  Correct entity map:
//    A_BusinessPartner          ← Step 1 (deep-insert: Address, TaxNumber, Bank)
//    A_Supplier                 ← Step 2 (create Supplier view)
//    A_SupplierCompany          ← Step 3 (company code data)
//    A_SupplierPurchasingOrg    ← Step 4 (purchasing org data)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Step 1 payload — POST A_BusinessPartner
 * Deep-insert navigation properties supported on this entity:
 *   to_BusinessPartnerAddress    → A_BusinessPartnerAddress
 *   to_BusinessPartnerTax        → A_BusinessPartnerTax
 *   to_BusinessPartnerBank       → A_BusinessPartnerBank       ⚠️ NOT to_BankAccount
 *
 * ❌ to_Supplier is NOT a valid nav property here — must be separate POST.
 *
 * NOTE: PAN is intentionally NOT sent here. It's maintained manually by the
 * FI/consultant team via the Country-Spec. Enh. screen (confirmed — see file
 * header note). Only GSTIN (IN3) is written through this OData service.
 */
const _buildBPPayload = (vendorData, cfg) => {
  const { generalData, companyCodeData, bankDetails, taxDetails } = vendorData;

  const bpGrouping = generalData.bpGrouping || cfg?.sapBpGrouping || 'Z001';
  const taxTypeGst = cfg?.taxTypeGst || 'IN3';

  const payload = {
    // ── General ─────────────────────────────────────────────────────────
    BusinessPartnerCategory: '2',                               // 2 = Organisation
    BusinessPartnerGrouping: bpGrouping,
    OrganizationBPName1:     generalData.vendorName,
    LegalForm:               generalData.legalForm || '09',
    FormOfAddress:           generalData.title     || '0003',   // '0001'=M/s. '0002'=Mr. '0003'=Company
    SearchTerm1: (generalData.searchTerm || generalData.vendorName)
      .trim()
      .toUpperCase()
      .substring(0, 20),

    // ── A_BusinessPartnerAddress (deep-insert) ───────────────────────────
    to_BusinessPartnerAddress: {
      results: [{
        StreetName:  generalData.street     || '',
        CityName:    generalData.city       || '',
        District:    generalData.district   || generalData.city || '', // Maps to CITY2 (District)
        Region:      generalData.state      || '',
        PostalCode:  generalData.postalCode || '',
        Country:     generalData.country    || 'IN',
        Language:    generalData.language   || 'EN',
        // Telephone
        to_PhoneNumber: {
          results: generalData.phone
            ? [{ PhoneNumber: generalData.phone, IsDefaultPhoneNumber: true }]
            : [],
        },
        // Mobile phone — separate nav property on A_BusinessPartnerAddressType
        to_MobilePhoneNumber: {
          results: generalData.mobile
            ? [{ PhoneNumber: generalData.mobile, IsDefaultPhoneNumber: true }]
            : [],
        },
        // Email via sub-navigate
        to_EmailAddress: {
          results: generalData.email
            ? [{ EmailAddress: generalData.email, IsDefaultEmailAddress: true }]
            : [],
        },
      }],
    },

    // ── A_BusinessPartnerTax (deep-insert) — GSTIN & TIN ──
    to_BusinessPartnerTax: {
      results: [
        taxDetails?.gstin ? { BPTaxType: taxTypeGst, BPTaxNumber: taxDetails.gstin } : null,
        taxDetails?.tin ? { BPTaxType: 'IN0', BPTaxNumber: taxDetails.tin } : null,
      ].filter(Boolean),
    },



    // ── A_BusinessPartnerBank (deep-insert) ──────────────────────────────
    // ⚠️  Correct field names: BankNumber (IFSC/routing), BankAccount (account no.)
    to_BusinessPartnerBank: {
      results: (bankDetails || []).map((b, i) => ({
        BankIdentification: b.bankIdentification || String(i + 1).padStart(4, '0'), // '0001', '0002', …
        BankCountryKey:     b.bankCountry   || 'IN',
        BankNumber:             b.bankKey       || '',           // IFSC / routing number
        BankAccount:            b.accountNumber || '',
        BankAccountHolderName:  b.accountHolder || '',
        BankControlKey:         b.controlKey    || 'EN',
        BankAccountReferenceText: b.ifsc         || '',
      })),
    },
  };

  return payload;
};

/**
 * Safely converts an ISO string date (YYYY-MM-DD) into an SAP OData v2 Edm.DateTime string format.
 * Returns null if no valid date string is supplied.
 */
const _toSapODataDate = (dateStr) => {
  if (!dateStr) return null;
  if (typeof dateStr === 'string' && dateStr.startsWith('/Date(')) {
    return dateStr;
  }
  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) return null;
  return `/Date(${timestamp})/`;
};

/**
 * Returns the Indian Fiscal Year date range covering the given reference date.
 * FY runs April 1 → March 31.  Defaults to today.
 */
const _getIndianFYRange = (refDate = new Date()) => {
  const y = refDate.getMonth() >= 3 ? refDate.getFullYear() : refDate.getFullYear() - 1;
  return {
    start: _toSapODataDate(`${y}-04-01`),
    end: _toSapODataDate(`${y + 1}-03-31`)
  };
};

/**
 * Step 3 payload — POST A_SupplierCompany
 * Company code–level data for a supplier.
 */
const _buildSupplierCompanyPayload = (bpNumber, companyCodeData, taxDetails) => {
  const payload = {
    Supplier:                   bpNumber,
    CompanyCode:                companyCodeData.companyCode,
    ReconciliationAccount:      companyCodeData.reconciliationAccount || '',
    PaymentTerms:               companyCodeData.paymentTerms          || '',
    IsToBeCheckedForDuplicates: true,
  };



  const wtList = companyCodeData.withholdingTax || [];
  if (wtList.length === 0 && companyCodeData.withholdingTaxType) {
    // Legacy single-field fallback — warn so this is visible in logs
    console.warn(`⚠️  [sapBridge] withholdingTax array was empty; falling back to auto-generate AP+NP from withholdingTaxType gate. Pass withholdingTax[] explicitly to avoid this.`);
    const taxCode = companyCodeData.withholdingTaxCode || '';
    const types = ['AP', 'NP'];
    types.forEach(t => {
      wtList.push({
        taxType: t,
        taxCode: taxCode || t,
        subject: true,
        recipientType: 'OT',
      });
    });
  }

  if (wtList.length > 0) {
    // ⚠️  Nav property is to_SupplierWithHoldingTax (NOT to_WithHoldingTax which belongs to A_CustomerCompany)
    // Note: TAN exemption certificate details (WT_EXNR, rate, validity) are posted exclusively via
    // custom OData ZBP_INDIA_SP_SRV (Step 5 / ToTanExemption). Passing them here causes SAP standard
    // plausibility check error "LFBW-WT_EXNR: Plausibility check failed".
    payload.to_SupplierWithHoldingTax = {
      results: wtList.map(w => ({
        WithholdingTaxType:         w.taxType,
        WithholdingTaxCode:         w.taxCode        || '',   // "WTax Code" column in SAP BP transaction
        IsWithholdingTaxSubject:    w.subject !== undefined ? !!w.subject : true,
        RecipientType:              w.recipientType  || 'OT',
      })),
    };
  }

  return payload;
};

/**
 * Step 4 payload — POST A_SupplierPurchasingOrg
 * Purchasing org–level data for a supplier.
 */
const _buildSupplierPurchOrgPayload = (bpNumber, purchasingData, cfg) => {
  // Decide which flag you actually mean:
  //   InvoiceIsGoodsReceiptBased   → GR-based invoice verification
  //   EvaldReceiptSettlementIsActive → ERS (auto-settle without invoice)
  // AutomaticEvaluatedRcptSettlmt only applies to returns — not what you want here.
  let grField = cfg?.grBasedIVField || 'InvoiceIsGoodsReceiptBased';
  if (grField === 'AutoEvalGRSetmt') {
    grField = 'InvoiceIsGoodsReceiptBased';
  }
  return {
    Supplier:                bpNumber,
    PurchasingOrganization:  purchasingData.purchasingOrg,
    PurchaseOrderCurrency:   purchasingData.orderCurrency || 'INR',
    IncotermsClassification: purchasingData.incoterms ? (purchasingData.incoterms).trim().substring(0, 3).toUpperCase() : '',
    IncotermsVersion:        purchasingData.incoterms ? (purchasingData.incotermsVersion || '') : '',
    IncotermsLocation1:      purchasingData.incoterms ? (purchasingData.incotermsLocation || '') : '',
    [grField]:               purchasingData.grBasedIV ?? true,       // Edm.Boolean; default true per SAP manual-entry convention
    PurchasingGroup:                purchasingData.purchasingGroup      || '',
    PaymentTerms:                   purchasingData.paymentTerms         || '',
    PlanningCycle:                  purchasingData.planningCycle        || '',
    SupplierConfirmationControlKey: purchasingData.confirmationControl  || '',
    ShippingCondition:              purchasingData.shippingConditions   || '',
    SupplierABCClassificationCode:  purchasingData.abc                  || '',
  };
};

/**
 * pushToS4HANA — executes the resilient multi-step vendor creation in SAP S/4HANA:
 *
 * Step 1: POST A_BusinessPartner (with deep-insert: Address, TaxNumber, Bank) & MSME
 * Step 2: POST A_BusinessPartnerRole (FI + Purchasing roles) & CVI Supplier generation
 * Step 3: POST A_SupplierCompany (Company Code & Recon Account)
 * Step 4: POST A_SupplierPurchasingOrg (Purchasing Org)
 * Step 5: POST IndiaTaxGeneralSet (PAN, Service Reg, GST Class, TAN Exemptions via ZBP_INDIA_SP_SRV)
 * Step 6: POST BPAttachmentSet (Document stream uploads via ZBP_INDIA_SP_SRV)
 *
 * Supports resumption: if options.existingBpNumber is provided or step is skipped,
 * it bypasses already completed steps and executes only the remaining/failed steps.
 */
const pushToS4HANA = async (vendorData, cfg, options = {}) => {
  const { companyCodeData, purchasingData } = vendorData;
  const crypto = require('crypto');
  const txId = crypto.randomUUID().substring(0, 8).toUpperCase();
  console.log(`\n🚀 [SAP S4HANA] [TX-${txId}] Starting multi-step vendor creation flow…`);

  const reportStep = async (stepKey, status, data = {}) => {
    if (typeof options.onStepProgress === 'function') {
      try {
        await options.onStepProgress(stepKey, status, data);
      } catch (cbErr) {
        console.warn(`⚠️ [SAP Bridge] onStepProgress callback failed for ${stepKey}:`, cbErr.message);
      }
    }
  };

  let bpNumber = options.existingBpNumber || vendorData.sapVendorNumber || vendorData.sapResult?.partialVendorNumber || null;
  let supplierNumber = bpNumber;
  let currentStepKey = 'step1_bp';
  let bpPayload = null;
  let bpRes = null;

  try {
    // ── Step 1: Create Business Partner (or use existing) ────────────────
    currentStepKey = 'step1_bp';
    if (bpNumber) {
      console.log(`⏩ [Step 1] [TX-${txId}] Using existing BusinessPartner: ${bpNumber} (Skipping creation)`);
      await reportStep('step1_bp', 'COMPLETED', { bpNumber });
    } else {
      await reportStep('step1_bp', 'IN_PROGRESS');
      bpPayload = _buildBPPayload(vendorData, cfg);
      console.log(`📦 [Step 1] [TX-${txId}] POST A_BusinessPartner payload:`, JSON.stringify(_maskSensitivePayload(bpPayload), null, 2));
      bpRes = await sapODataWrite(cfg, 'POST', '/A_BusinessPartner', bpPayload);

      const sapWarning = bpRes.headers?.['sap-message'] || bpRes.headers?.['SAP-Message'];
      if (sapWarning) {
        console.warn(`⚠️  [SAP Gateway Warning] [TX-${txId}]:`, sapWarning);
      }

      bpNumber = bpRes.data?.d?.BusinessPartner || bpRes.data?.BusinessPartner;
      if (!bpNumber) throw new Error('[SAP] Step 1 succeeded but no BusinessPartner number returned');
      console.log(`✅ [Step 1] [TX-${txId}] BusinessPartner created: ${bpNumber}`);
      await reportStep('step1_bp', 'COMPLETED', { bpNumber });

      // ── Step 1c: Post MSME BP Identification separately ────────────────
      const taxDetails = vendorData.taxDetails;
      if (taxDetails?.msmeNumber) {
        const bpIdentType = {
          'MICRO': 'MSME01',
          'SMALL': 'MSME02',
          'MEDIUM': 'MSME03',
          'NONE': 'MSME04',
          'NOT_AN_MSME': 'MSME04',
          'CANCELLED': 'MSME05',
          'MSME01': 'MSME01',
          'MSME02': 'MSME02',
          'MSME03': 'MSME03',
          'MSME04': 'MSME04',
          'MSME05': 'MSME05'
        }[taxDetails.msmeStatus] || 'MSME02';

        let entityName = 'A_BuPaIdentification';
        try {
          await sapODataRead(cfg, `/A_BuPaIdentification?$top=1&$format=json`);
        } catch (e) {
          entityName = 'A_BPIdentification';
        }

        console.log(`📦 [Step 1c] [TX-${txId}] Posting MSME BP Identification to /${entityName}`);
        try {
          await sapODataWrite(cfg, 'POST', `/${entityName}`, {
            BusinessPartner: bpNumber,
            BPIdentificationType: bpIdentType,
            BPIdentificationNumber: taxDetails.msmeNumber.trim().toUpperCase(),
            ValidityStartDate: _toSapODataDate(taxDetails.msmeRegDate),
            ValidityEndDate: _toSapODataDate(taxDetails.msmeValTo),
            BPIdentificationEntryDate: _toSapODataDate(taxDetails.msmeEntryDate),
            Region: taxDetails.msmeRegion || '',
            Country: 'IN'
          });
          console.log(`✅ [Step 1c] [TX-${txId}] MSME BP Identification assigned`);
        } catch (err) {
          console.error(`❌ [Step 1c] [TX-${txId}] Failed to assign MSME BP Identification: ${err.message}`);
        }
      }
    }

    // ── Step 2: Roles & CVI Supplier Generation ──────────────────────────
    currentStepKey = 'step2_roles_cvi';
    if (options.skipSteps && options.skipSteps.includes('step2_roles_cvi')) {
      console.log(`⏩ [Step 2] [TX-${txId}] Skipping Step 2 per options`);
      await reportStep('step2_roles_cvi', 'SKIPPED');
    } else {
      await reportStep('step2_roles_cvi', 'IN_PROGRESS');

      // Post FI Role (Trigger for Supplier CVI)
      const roleFI = cfg?.vendorRoleFI || 'FLVN00';
      if (roleFI) {
        console.log(`📦 [Step 2] [TX-${txId}] Posting FI Role (${roleFI}) for BP: ${bpNumber}`);
        try {
          await sapODataWrite(cfg, 'POST', '/A_BusinessPartnerRole', {
            BusinessPartner: bpNumber,
            BusinessPartnerRole: roleFI,
          });
          console.log(`✅ [Step 2] [TX-${txId}] FI Role ${roleFI} assigned`);
        } catch (err) {
          if (_isRoleAlreadyAssigned(err)) {
            console.warn(`⚠️  [Step 2] [TX-${txId}] FI Role ${roleFI} is already assigned, skipping.`);
          } else {
            throw err;
          }
        }
      }

      // Verification of CVI Supplier generation (Poller helper)
      supplierNumber = await waitForSupplier(bpNumber, cfg, txId);

      // Post Purchasing Role
      const rolePurchasing = cfg?.vendorRolePurchasing || 'FLVN01';
      if (rolePurchasing) {
        console.log(`📦 [Step 2b] [TX-${txId}] Posting Purchasing Role (${rolePurchasing}) for BP: ${bpNumber}`);
        try {
          await sapODataWrite(cfg, 'POST', '/A_BusinessPartnerRole', {
            BusinessPartner: bpNumber,
            BusinessPartnerRole: rolePurchasing,
          });
          console.log(`✅ [Step 2b] [TX-${txId}] Purchasing Role ${rolePurchasing} assigned`);
        } catch (err) {
          if (_isRoleAlreadyAssigned(err)) {
            console.warn(`⚠️  [Step 2b] [TX-${txId}] Purchasing Role ${rolePurchasing} is already assigned, skipping.`);
          } else {
            throw err;
          }
        }
      }

      await reportStep('step2_roles_cvi', 'COMPLETED', { supplierNumber });
    }

    // ── Step 3: Company Code data ────────────────────────────────────────
    currentStepKey = 'step3_companyCode';
    if (companyCodeData?.companyCode) {
      if (options.skipSteps && options.skipSteps.includes('step3_companyCode')) {
        console.log(`⏩ [Step 3] [TX-${txId}] Skipping Step 3 per options`);
        await reportStep('step3_companyCode', 'SKIPPED');
      } else {
        await reportStep('step3_companyCode', 'IN_PROGRESS');
        const ccPayload = _buildSupplierCompanyPayload(supplierNumber || bpNumber, companyCodeData, vendorData.taxDetails);
        console.log(`📦 [Step 3] [TX-${txId}] POST A_SupplierCompany:`, JSON.stringify(_maskSensitivePayload(ccPayload), null, 2));
        await postSupplierChildWithRetry(cfg, '/A_SupplierCompany', ccPayload, txId, 'Step 3: Company Code');
        await reportStep('step3_companyCode', 'COMPLETED');
      }
    } else {
      console.log(`⏭️  [Step 3] [TX-${txId}] Skipped — no companyCode provided`);
      await reportStep('step3_companyCode', 'SKIPPED');
    }

    // ── Step 4: Purchasing Org data ──────────────────────────────────────
    currentStepKey = 'step4_purchasingOrg';
    if (purchasingData?.purchasingOrg) {
      if (options.skipSteps && options.skipSteps.includes('step4_purchasingOrg')) {
        console.log(`⏩ [Step 4] [TX-${txId}] Skipping Step 4 per options`);
        await reportStep('step4_purchasingOrg', 'SKIPPED');
      } else {
        await reportStep('step4_purchasingOrg', 'IN_PROGRESS');
        const poPayload = _buildSupplierPurchOrgPayload(supplierNumber || bpNumber, purchasingData, cfg);
        console.log(`📦 [Step 4] [TX-${txId}] POST A_SupplierPurchasingOrg:`, JSON.stringify(_maskSensitivePayload(poPayload), null, 2));
        await postSupplierChildWithRetry(cfg, '/A_SupplierPurchasingOrg', poPayload, txId, 'Step 4: Purchasing Org');
        await reportStep('step4_purchasingOrg', 'COMPLETED');
      }
    } else {
      console.log(`⏭️  [Step 4] [TX-${txId}] Skipped — no purchasingOrg provided`);
      await reportStep('step4_purchasingOrg', 'SKIPPED');
    }

    // ── Step 5: India Tax & TAN Details (ZBP_INDIA_SP_SRV) ───────────────
    currentStepKey = 'step5_indiaTax';
    if (vendorData.taxDetails) {
      if (options.skipSteps && options.skipSteps.includes('step5_indiaTax')) {
        console.log(`⏩ [Step 5] [TX-${txId}] Skipping Step 5 per options`);
        await reportStep('step5_indiaTax', 'SKIPPED');
      } else {
        await reportStep('step5_indiaTax', 'IN_PROGRESS');
        console.log(`📦 [Step 5] [TX-${txId}] Calling ZBP_INDIA_SP_SRV for BP: ${bpNumber}`);
        await sapIndiaTaxBridge.postIndiaTaxDetails(cfg, bpNumber, vendorData);
        await reportStep('step5_indiaTax', 'COMPLETED');
      }
    } else {
      await reportStep('step5_indiaTax', 'SKIPPED');
    }

    // ── Step 6: Upload Attachments (ZBP_INDIA_SP_SRV BPAttachmentSet) ───
    currentStepKey = 'step6_attachments';
    if (Array.isArray(vendorData.documents) && vendorData.documents.length > 0) {
      if (options.skipSteps && options.skipSteps.includes('step6_attachments')) {
        console.log(`⏩ [Step 6] [TX-${txId}] Skipping Step 6 per options`);
        await reportStep('step6_attachments', 'SKIPPED');
      } else {
        await reportStep('step6_attachments', 'IN_PROGRESS');
        console.log(`📦 [Step 6] [TX-${txId}] Uploading ${vendorData.documents.length} attachments to SAP for BP: ${bpNumber}`);
        for (const doc of vendorData.documents) {
          try {
            await sapIndiaTaxBridge.uploadIndiaTaxAttachment(cfg, bpNumber, doc);
          } catch (attErr) {
            console.warn(`⚠️ [Step 6] [TX-${txId}] Attachment upload failed for ${doc.fileName}: ${attErr.message}`);
          }
        }
        await reportStep('step6_attachments', 'COMPLETED');
      }
    } else {
      await reportStep('step6_attachments', 'SKIPPED');
    }

    console.log(`\n🎉 [SAP S4HANA] [TX-${txId}] Vendor creation workflow fully completed — SAP Supplier No: ${supplierNumber || bpNumber}\n`);
    return {
      vendorNumber: supplierNumber || bpNumber,
      bpNumber: bpNumber,
      payload: bpPayload,
      response: bpRes?.data,
    };

  } catch (err) {
    console.error(`💥 [SAP S4HANA Error] [TX-${txId}] Step '${currentStepKey}' failed: ${err.message}`);
    await reportStep(currentStepKey, 'FAILED', { error: err.message, bpNumber });

    if (bpNumber) {
      console.error(`🚨 [CHECKPOINT ALERT] [TX-${txId}] Business Partner '${bpNumber}' was preserved in SAP. Failed at step: ${currentStepKey}`);
      err.bpNumber = bpNumber;
      err.vendorNumber = bpNumber;
    }
    err.failedStep = currentStepKey;
    throw err;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION B — S/4HANA: Vendor PATCH (modification)
//
//  Entities used for update:
//    PATCH A_BusinessPartner('{bp}')                                  — general data
//    PATCH A_BusinessPartnerAddress(BusinessPartner='{bp}',AddressID='{id}') — address
//    PATCH/POST A_BusinessPartnerTax(BusinessPartner='{bp}',BPTaxType='{t}') — GSTIN
//    PATCH A_SupplierCompany(Supplier='{bp}',CompanyCode='{cc}')      — company code
//    PATCH A_SupplierPurchasingOrg(Supplier='{bp}',PurchasingOrganization='{po}') — purch org
// ═══════════════════════════════════════════════════════════════════════════

/**
 * patchVendorInSAP — updates an existing SAP vendor via PATCH calls.
 * @param {string} bpNumber       SAP BusinessPartner / Supplier number (LIFNR)
 * @param {object} vendorData     Updated vendor data from VMM
 * @param {string} [addressId]    SAP AddressID (from A_BusinessPartnerAddress).
 *                                If not provided, address update is skipped.
 * @param {object} cfg            SAP config
 */
const patchVendorInSAP = async (bpNumber, vendorData, addressId, cfg) => {
  const { generalData, companyCodeData, purchasingData, taxDetails } = vendorData;
  console.log(`\n🔧 [SAP S4HANA] Patching vendor: ${bpNumber}`);

  // ── PATCH A_BusinessPartner (general data) ────────────────────────────
  const bpPatch = {
    OrganizationBPName1: generalData.vendorName,
    OrganizationBPName2: generalData.vendorName2 || '',
    SearchTerm1: (generalData.searchTerm || generalData.vendorName).substring(0, 20).toUpperCase(),
    SearchTerm2: generalData.searchTerm2 || '',
    Language: generalData.language || 'EN',
    FormOfAddress: generalData.title || '0003',   // '0001'=M/s. '0002'=Mr. '0003'=Company
  };
  await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartner('${bpNumber}')`, bpPatch);
  console.log(`✅ [PATCH] A_BusinessPartner updated`);

  // ── PATCH/POST A_BusinessPartnerTax (GSTIN) ────────────────────────────
  // NOTE: PAN is deliberately NOT synced here — see file header note. Only
  // GSTIN round-trips through this OData service in this landscape.
  if (taxDetails?.gstin) {
    const taxTypeGst = cfg?.taxTypeGst || 'IN3';
    const taxKey = `BusinessPartner='${bpNumber}',BPTaxType='${taxTypeGst}'`;
    try {
      await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartnerTax(${taxKey})`, {
        BPTaxNumber: taxDetails.gstin,
      });
      console.log(`✅ [PATCH] A_BusinessPartnerTax (GSTIN) updated`);
    } catch (err) {
      console.warn(`⚠️  [PATCH] GSTIN tax record not found, attempting creation…`);
      try {
        await sapODataWrite(cfg, 'POST', '/A_BusinessPartnerTax', {
          BusinessPartner: bpNumber,
          BPTaxType: taxTypeGst,
          BPTaxNumber: taxDetails.gstin,
        });
        console.log(`✅ [POST] A_BusinessPartnerTax (GSTIN) created successfully`);
      } catch (postErr) {
        console.error(`❌ [POST] Failed to create GSTIN tax record: ${postErr.message}`);
      }
    }
  }

  // ── PATCH A_BusinessPartnerAddress (dynamic AddressID resolution) ────
  let targetAddressId = addressId;
  if (!targetAddressId) {
    try {
      console.log(`🔍 [PATCH] AddressID not provided. Fetching from SAP for BP: ${bpNumber}...`);
      const getRes = await sapODataRead(cfg, `/A_BusinessPartner('${bpNumber}')/to_BusinessPartnerAddress?$format=json`);
      const firstAddr = getRes.data?.d?.results?.[0] || getRes.data?.results?.[0];
      if (firstAddr && firstAddr.AddressID) {
        targetAddressId = firstAddr.AddressID;
        console.log(`✅ [PATCH] Found AddressID: ${targetAddressId}`);
      }
    } catch (err) {
      console.warn(`⚠️  [PATCH] Failed to retrieve target AddressID: ${err.message}`);
    }
  }

  if (targetAddressId) {
    const addrPatch = {
      StreetName:  generalData.street     || '',
      CityName:    generalData.city       || '',
      District:    generalData.district   || generalData.city || '', // Maps to CITY2 (District)
      Region:      generalData.state      || '',
      PostalCode:  generalData.postalCode || '',
      Country:     generalData.country    || 'IN',
    };
    const addrKey = `BusinessPartner='${bpNumber}',AddressID='${targetAddressId}'`;
    await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartnerAddress(${addrKey})`, addrPatch);
    console.log(`✅ [PATCH] A_BusinessPartnerAddress updated`);

    // Dynamic PATCH A_AddressEmailAddress
    if (generalData.email) {
      try {
        const emailRes = await sapODataRead(cfg, `/A_BusinessPartnerAddress(${addrKey})/to_EmailAddress?$format=json`);
        const emailResults = emailRes.data?.d?.results || emailRes.data?.results || [];
        const targetEmail = emailResults.find(e => e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'X') || emailResults[0];

        if (targetEmail) {
          const emailKey = `AddressID='${targetAddressId}',Person='${targetEmail.Person || ''}',OrdinalNumber='${targetEmail.OrdinalNumber}'`;
          await sapODataWrite(cfg, 'PATCH', `/A_AddressEmailAddress(${emailKey})`, {
            EmailAddress: generalData.email
          });
          console.log(`✅ [PATCH] A_AddressEmailAddress updated`);
        }
      } catch (err) {
        console.warn(`⚠️  [PATCH] Could not update address email entity: ${err.message}`);
      }
    }

    // Dynamic PATCH A_AddressPhoneNumber
    if (generalData.phone) {
      try {
        const phoneRes = await sapODataRead(cfg, `/A_BusinessPartnerAddress(${addrKey})/to_PhoneNumber?$format=json`);
        const phoneResults = phoneRes.data?.d?.results || phoneRes.data?.results || [];
        const targetPhone = phoneResults.find(p => p.IsDefaultPhoneNumber === true || p.IsDefaultPhoneNumber === 'X') || phoneResults[0];

        if (targetPhone) {
          const phoneKey = `AddressID='${targetAddressId}',Person='${targetPhone.Person || ''}',OrdinalNumber='${targetPhone.OrdinalNumber}'`;
          await sapODataWrite(cfg, 'PATCH', `/A_AddressPhoneNumber(${phoneKey})`, {
            PhoneNumber: generalData.phone
          });
          console.log(`✅ [PATCH] A_AddressPhoneNumber updated`);
        }
      } catch (err) {
        console.warn(`⚠️  [PATCH] Could not update address phone entity: ${err.message}`);
      }
    }

    // Dynamic PATCH A_AddressPhoneNumber (mobile)
    if (generalData.mobile) {
      try {
        const mobileRes = await sapODataRead(cfg, `/A_BusinessPartnerAddress(${addrKey})/to_MobilePhoneNumber?$format=json`);
        const mobileResults = mobileRes.data?.d?.results || mobileRes.data?.results || [];
        const targetMobile = mobileResults.find(p => p.IsDefaultPhoneNumber === true || p.IsDefaultPhoneNumber === 'X') || mobileResults[0];

        if (targetMobile) {
          const mobileKey = `AddressID='${targetAddressId}',Person='${targetMobile.Person || ''}',OrdinalNumber='${targetMobile.OrdinalNumber}'`;
          await sapODataWrite(cfg, 'PATCH', `/A_AddressPhoneNumber(${mobileKey})`, {
            PhoneNumber: generalData.mobile
          });
          console.log(`✅ [PATCH] A_AddressPhoneNumber (mobile) updated`);
        }
      } catch (err) {
        console.warn(`⚠️  [PATCH] Could not update address mobile phone entity: ${err.message}`);
      }
    }
  }

  // ── PATCH A_SupplierCompany ───────────────────────────────────────────
  if (companyCodeData?.companyCode) {
    const ccPatch = {
      ReconciliationAccount:      companyCodeData.reconciliationAccount || '',
      PaymentTerms:               companyCodeData.paymentTerms          || '',
      IsToBeCheckedForDuplicates: companyCodeData.checkDoubleInvoice === 'Yes' || companyCodeData.checkDoubleInvoice === true,
      PaymentMethodsList:         companyCodeData.paymentMethod         || '',
      AccountingClerk:            companyCodeData.clerksName            || '',
      HouseBank:                  companyCodeData.houseBank             || '',
      PaymentBlockingReason:      companyCodeData.dmeDInd               || '',
      APARToleranceGroup:         companyCodeData.toleranceGroup        || '',
    };
    const ccKey = `Supplier='${bpNumber}',CompanyCode='${companyCodeData.companyCode}'`;
    await sapODataWrite(cfg, 'PATCH', `/A_SupplierCompany(${ccKey})`, ccPatch);
    console.log(`✅ [PATCH] A_SupplierCompany updated`);

    // Withholding tax PATCH/POST updates
    const wtList = companyCodeData.withholdingTax || [];
    if (wtList.length === 0 && companyCodeData.withholdingTaxType) {
      console.warn(`⚠️  [sapBridge PATCH] withholdingTax array empty; falling back to auto-generate AP+NP.`);
      const taxCode = companyCodeData.withholdingTaxCode || '';
      const types = ['AP', 'NP'];
      types.forEach(t => {
        wtList.push({
          taxType: t,
          taxCode: taxCode || t,
          subject: true,
          recipientType: 'OT',
        });
      });
    }

    if (wtList.length > 0) {
      for (const w of wtList) {
        const wtKey = `Supplier='${bpNumber}',CompanyCode='${companyCodeData.companyCode}',WithholdingTaxType='${w.taxType}'`;
        try {
          await sapODataWrite(cfg, 'PATCH', `/A_SupplierWithHoldingTax(${wtKey})`, {
            WithholdingTaxCode:         w.taxCode        || '',
            IsWithholdingTaxSubject:    w.subject !== undefined ? !!w.subject : true,
            RecipientType:              w.recipientType  || 'OT',
          });
          console.log(`✅ [PATCH] A_SupplierWithHoldingTax (${w.taxType}) updated`);
        } catch (err) {
          console.warn(`⚠️  [PATCH] Withholding tax (${w.taxType}) not found, attempting creation…`);
          try {
            await sapODataWrite(cfg, 'POST', '/A_SupplierWithHoldingTax', {
              Supplier:                   bpNumber,
              CompanyCode:                companyCodeData.companyCode,
              WithholdingTaxType:         w.taxType,
              WithholdingTaxCode:         w.taxCode        || '',
              IsWithholdingTaxSubject:    w.subject !== undefined ? !!w.subject : true,
              RecipientType:              w.recipientType  || 'OT',
            });
            console.log(`✅ [POST] A_SupplierWithHoldingTax (${w.taxType}) created successfully`);
          } catch (postErr) {
            console.error(`❌ [POST] Failed to create withholding tax (${w.taxType}): ${postErr.message}`);
          }
        }
      }
    }
  }

  // ── PATCH A_SupplierPurchasingOrg ─────────────────────────────────────
  if (purchasingData?.purchasingOrg) {
    const grField = 'InvoiceIsGoodsReceiptBased';
    const poPatch = {
      PurchaseOrderCurrency:   purchasingData.orderCurrency    || 'INR',
      IncotermsClassification: purchasingData.incoterms ? (purchasingData.incoterms).trim().substring(0, 3).toUpperCase() : '',
      IncotermsVersion:        purchasingData.incoterms ? (purchasingData.incotermsVersion || '') : '',
      IncotermsLocation1:      purchasingData.incoterms ? (purchasingData.incotermsLocation || '') : '',
      [grField]:               purchasingData.grBasedIV ?? true,   // default true per SAP manual-entry convention
      PurchasingGroup:                purchasingData.purchasingGroup      || '',
      PaymentTerms:                   purchasingData.paymentTerms         || '',
      PlanningCycle:                  purchasingData.planningCycle        || '',
      SupplierConfirmationControlKey: purchasingData.confirmationControl  || '',
      ShippingCondition:              purchasingData.shippingConditions   || '',
      SupplierABCClassificationCode:  purchasingData.abc                  || '',
    };
    const poKey = `Supplier='${bpNumber}',PurchasingOrganization='${purchasingData.purchasingOrg}'`;
    await sapODataWrite(cfg, 'PATCH', `/A_SupplierPurchasingOrg(${poKey})`, poPatch);
    console.log(`✅ [PATCH] A_SupplierPurchasingOrg updated`);
  }

  console.log(`\n🎉 [SAP S4HANA] Vendor ${bpNumber} patched successfully\n`);
  return { vendorNumber: bpNumber, updated: true };
};

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION C — S/4HANA: Fetch vendor list / single vendor from SAP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * fetchVendorsFromSAP — reads A_BusinessPartner from SAP with supplier filter.
 * Expands Address and TaxNumber inline.
 * @param {object} cfg
 * @param {object} [opts]  { top, skip, search }
 */
const fetchVendorsFromSAP = async (cfg, opts = {}) => {
  const { top = 50, skip = 0, search = '', vendorGroup = '', fromVendor = '', toVendor = '', companyCode = '' } = opts;

  let bpResults = [];
  let totalCount = 0;

  if (companyCode) {
    // 1. Fetch all matching supplier IDs for the company code and range from A_SupplierCompany.
    // We select only 'Supplier' to keep the response small and query fast.
    const compParams = {
      $select: 'Supplier',
      $top:    '100000', // high limit to get all in the range
      $format: 'json',
    };
    const compFilters = [`CompanyCode eq '${companyCode}'`];
    if (fromVendor) compFilters.push(`Supplier ge '${fromVendor}'`);
    if (toVendor)   compFilters.push(`Supplier le '${toVendor}'`);
    compParams.$filter = compFilters.join(' and ');

    const compQs = new URLSearchParams(compParams);
    const compRes = await sapODataRead(cfg, `/A_SupplierCompany?${compQs}`);
    const compResults = compRes.data?.d?.results || compRes.data?.results || [];
    if (compResults.length === 0) {
      return { vendors: [], total: 0 };
    }

    const companySupplierSet = new Set(compResults.map(c => c.Supplier));

    // 2. Query A_Supplier filtering by vendorGroup, range, and search term.
    // Fetch a slightly larger batch (top * 2) to ensure we satisfy page size after filtering.
    const queryTop = parseInt(top);
    const querySkip = parseInt(skip);
    const fetchLimit = queryTop > 1000 ? queryTop : queryTop * 2;

    const params = {
      $select:      'Supplier,SupplierName,SupplierAccountGroup',
      $top:         String(fetchLimit),
      $skip:        String(querySkip),
      $inlinecount: 'allpages',
      $format:      'json',
    };

    const filters = [];
    if (vendorGroup) {
      filters.push(`SupplierAccountGroup eq '${vendorGroup}'`);
    }
    if (fromVendor) {
      filters.push(`Supplier ge '${fromVendor}'`);
    }
    if (toVendor) {
      filters.push(`Supplier le '${toVendor}'`);
    }
    if (search) {
      filters.push(`(substringof('${search}',Supplier) or substringof('${search}',SupplierName))`);
    }
    if (filters.length > 0) {
      params.$filter = filters.join(' and ');
    }

    const qs = new URLSearchParams(params);
    const res = await sapODataRead(cfg, `/A_Supplier?${qs}`);
    const rawBpResults = res.data?.d?.results || res.data?.results || [];
    const rawTotalCount = res.data?.d?.__count || res.data?.__count || rawBpResults.length;

    // Filter against company suppliers set
    const filteredBpResults = rawBpResults.filter(bp => companySupplierSet.has(bp.Supplier));
    
    bpResults = filteredBpResults.slice(0, queryTop);
    
    // Estimate total count based on how many matched
    if (rawBpResults.length > 0) {
      const matchRatio = filteredBpResults.length / rawBpResults.length;
      totalCount = Math.round(parseInt(rawTotalCount) * matchRatio);
    } else {
      totalCount = 0;
    }
  } else {
    const params = {
      $select:      'Supplier,SupplierName,SupplierAccountGroup',
      $top:         String(top),
      $skip:        String(skip),
      $inlinecount: 'allpages',
      $format:      'json',
    };

    const filters = [];
    if (vendorGroup) {
      filters.push(`SupplierAccountGroup eq '${vendorGroup}'`);
    }
    if (fromVendor) {
      filters.push(`Supplier ge '${fromVendor}'`);
    }
    if (toVendor) {
      filters.push(`Supplier le '${toVendor}'`);
    }
    if (search) {
      filters.push(`(substringof('${search}',Supplier) or substringof('${search}',SupplierName))`);
    }
    if (filters.length > 0) {
      params.$filter = filters.join(' and ');
    }

    const qs = new URLSearchParams(params);
    const res = await sapODataRead(cfg, `/A_Supplier?${qs}`);
    bpResults = res.data?.d?.results || res.data?.results || [];
    totalCount = res.data?.d?.__count || res.data?.__count || bpResults.length;
  }

  if (bpResults.length === 0) {
    return { vendors: [], total: 0 };
  }

  // Step 2: Fetch default email addresses for the retrieved Suppliers in separate light chunked queries to avoid 414 Request-URI Too Long errors
  const bpNumbers = bpResults.map(bp => bp.Supplier);
  const emailMap = {};

  try {
    // Chunk size of 100 to keep the filter query length safe
    const chunkSize = 100;
    const chunks = [];
    for (let i = 0; i < bpNumbers.length; i += chunkSize) {
      chunks.push(bpNumbers.slice(i, i + chunkSize));
    }

    await Promise.all(chunks.map(async (chunk) => {
      const bpFilters = chunk.map(num => `BusinessPartner eq '${num}'`).join(' or ');
      const emailParams = {
        $select: 'BusinessPartner,AddressID,to_EmailAddress/EmailAddress,to_EmailAddress/IsDefaultEmailAddress',
        $expand: 'to_EmailAddress',
        $filter: `(${bpFilters})`,
        $format: 'json'
      };
      
      const emailQs = new URLSearchParams(emailParams);
      const emailRes = await sapODataRead(cfg, `/A_BusinessPartnerAddress?${emailQs}`);
      const addrResults = emailRes.data?.d?.results || emailRes.data?.results || [];

      addrResults.forEach(addr => {
        const emails = addr.to_EmailAddress?.results || [];
        const defaultEmail = emails.find(e => e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'X') || emails[0];
        if (defaultEmail && defaultEmail.EmailAddress) {
          emailMap[addr.BusinessPartner] = defaultEmail.EmailAddress;
        }
      });
    }));
  } catch (err) {
    console.warn(`⚠️ [sapBridge] Failed to resolve emails in step 2:`, err.message);
  }

  const results = bpResults.map(item => ({
    BusinessPartner:        item.Supplier            || '',
    BusinessPartnerFullName: item.SupplierName       || item.Supplier || '',
    email:                  emailMap[item.Supplier]  || '',
    SearchTerm1:            '',
    Language:               'EN',
  }));

  return {
    vendors: results,
    total:   totalCount,
  };
};

const getVendorFromSAP = async (bpNumber, cfg) => {
  let formattedBp = bpNumber;
  if (bpNumber && /^\d+$/.test(bpNumber) && bpNumber.length < 10) {
    formattedBp = bpNumber.padStart(10, '0');
  }

  const expand = [
    'to_BusinessPartnerAddress/to_EmailAddress',
    'to_BusinessPartnerAddress/to_PhoneNumber',
    'to_BusinessPartnerAddress/to_MobilePhoneNumber',
    'to_BusinessPartnerAddress/to_FaxNumber',
    'to_BusinessPartnerAddress/to_URLAddress',
    'to_BusinessPartnerTax',
    'to_BusinessPartnerBank',
    'to_Supplier',
    'to_BusinessPartnerRole',
  ].join(',');

  // Query A_BusinessPartner by matching either the BP key itself or the linked Supplier ID (both padded and raw)
  const filter = `BusinessPartner eq '${formattedBp}' or BusinessPartner eq '${bpNumber}' or to_Supplier/Supplier eq '${formattedBp}' or to_Supplier/Supplier eq '${bpNumber}'`;

  const res = await sapODataRead(
    cfg,
    `/A_BusinessPartner?$filter=${encodeURIComponent(filter)}&$expand=${encodeURIComponent(expand)}&$format=json`
  );

  const results = res.data?.d?.results || res.data?.results || [];
  const bp = results[0] || null;
  if (!bp) return null;

  // Retrieve BP Identification separately to avoid Resource Not Found issues on older Gateway CVI services
  let bpIdentifications = [];
  try {
    const actualBpNum = bp.BusinessPartner || formattedBp;
    const identRes = await sapODataRead(cfg, `/A_BuPaIdentification?$filter=BusinessPartner eq '${actualBpNum}'&$format=json`);
    bpIdentifications = identRes.data?.d?.results || identRes.data?.results || [];
  } catch (err) {
    console.warn(`⚠️ [sapBridge] Failed to read A_BuPaIdentification separately, trying A_BPIdentification: ${err.message}`);
    try {
      const actualBpNum = bp.BusinessPartner || formattedBp;
      const identRes = await sapODataRead(cfg, `/A_BPIdentification?$filter=BusinessPartner eq '${actualBpNum}'&$format=json`);
      bpIdentifications = identRes.data?.d?.results || identRes.data?.results || [];
    } catch (fallbackErr) {
      console.warn(`⚠️ [sapBridge] Failed fallback to A_BPIdentification: ${fallbackErr.message}`);
    }
  }
  bp.to_BPIdentification = { results: bpIdentifications };

  // Fetch Supplier sub-entities separately to avoid OData Gateway dump on missing associations
  let supplierObj = bp.to_Supplier;
  if (supplierObj && Array.isArray(supplierObj.results)) {
    supplierObj = supplierObj.results[0];
  }
  const supplierId = supplierObj?.Supplier;

  if (supplierId) {
    let formattedSupplier = supplierId;
    if (supplierId && /^\d+$/.test(supplierId) && supplierId.length < 10) {
      formattedSupplier = supplierId.padStart(10, '0');
    }

    console.log(`🔍 [sapBridge] BP ${formattedBp} has Supplier ${supplierId}. Fetching company codes and purchasing orgs safely...`);
    try {
      const [companyCodeRes, purchasingOrgRes] = await Promise.all([
        sapODataRead(cfg, `/A_SupplierCompany?$filter=Supplier eq '${formattedSupplier}'&$expand=to_SupplierDunning,to_SupplierWithHoldingTax&$format=json`).catch(err => {
          console.warn(`⚠️ [sapBridge] Failed to read company codes directly for supplier ${formattedSupplier}:`, err.message);
          return { data: { d: { results: [] } } };
        }),
        sapODataRead(cfg, `/A_SupplierPurchasingOrg?$filter=Supplier eq '${formattedSupplier}'&$format=json`).catch(err => {
          console.warn(`⚠️ [sapBridge] Failed to read purchasing orgs directly for supplier ${formattedSupplier}:`, err.message);
          return { data: { d: { results: [] } } };
        })
      ]);

      const ccResults = companyCodeRes.data?.d?.results || companyCodeRes.data?.results || [];
      const poResults = purchasingOrgRes.data?.d?.results || purchasingOrgRes.data?.results || [];

      if (bp.to_Supplier && Array.isArray(bp.to_Supplier.results)) {
        bp.to_Supplier.results[0].to_SupplierCompany = { results: ccResults };
        bp.to_Supplier.results[0].to_SupplierPurchasingOrg = { results: poResults };
      } else if (bp.to_Supplier) {
        bp.to_Supplier.to_SupplierCompany = { results: ccResults };
        bp.to_Supplier.to_SupplierPurchasingOrg = { results: poResults };
      }
    } catch (err) {
      console.error(`💥 [sapBridge] Error resolving child details for Supplier ${supplierId}:`, err.message);
    }
  }

  return bp;
};



// ═══════════════════════════════════════════════════════════════════════════
//  SECTION F — STUB mode
// ═══════════════════════════════════════════════════════════════════════════

const pushStub = async (vendorData, options = {}) => {
  console.log('🧪 [SAP] STUB — simulated multi-step vendor creation');
  const reportStep = async (stepKey, status, data = {}) => {
    if (typeof options.onStepProgress === 'function') {
      try { await options.onStepProgress(stepKey, status, data); } catch (_) {}
    }
  };

  const num = Math.floor(100_000 + Math.random() * 900_000);
  const vendorNumber = options.existingBpNumber || `V${num}`;

  // Simulate sequential step progression
  await reportStep('step1_bp', 'COMPLETED', { bpNumber: vendorNumber });
  await new Promise((r) => setTimeout(r, 100));

  await reportStep('step2_roles_cvi', 'COMPLETED', { supplierNumber: vendorNumber });
  await new Promise((r) => setTimeout(r, 100));

  await reportStep('step3_companyCode', 'COMPLETED');
  await new Promise((r) => setTimeout(r, 100));

  await reportStep('step4_purchasingOrg', 'COMPLETED');
  await new Promise((r) => setTimeout(r, 100));

  await reportStep('step5_indiaTax', 'COMPLETED');
  await new Promise((r) => setTimeout(r, 100));

  await reportStep('step6_attachments', 'COMPLETED');

  return {
    vendorNumber,
    bpNumber: vendorNumber,
    payload:  { info: 'STUB', vendorName: vendorData?.generalData?.vendorName },
    response: { status: 'SUCCESS_STUB' },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
//  Main export
// ═══════════════════════════════════════════════════════════════════════════

/**
 * pushVendor — main entry point called after final MDT approval.
 * Dispatches to STUB / ECC / S4HANA / S4HANA_BAPI based on sapConfig.sapVersion.
 * Supports options: { existingBpNumber, onStepProgress, skipSteps }
 */
const pushVendor = async (vendorData, sapConfig, options = {}) => {
  const mode = (sapConfig.sapVersion || 'STUB').toUpperCase();
  console.log(`\n📡 [SAP Bridge] Mode: ${mode} ${'─'.repeat(40)}`);
  switch (mode) {
    case 'S4HANA':      return pushToS4HANA(vendorData, sapConfig, options);
    case 'STUB':        return pushStub(vendorData, options);
    default: throw new Error(`[SAP Bridge] Unsupported mode: "${mode}" (valid: STUB | S4HANA)`);
  }
};

/**
 * pushVendorChangeRequest — updates existing SAP BP details for change requests.
 */
const pushVendorChangeRequest = async (bpNumber, proposedChanges, cfg) => {
  const { bankDetails, taxDetails, addressDetails } = proposedChanges;
  console.log(`\n📡 [sapBridge] Pushing Change Request for BP: ${bpNumber}`);

  let formattedBp = bpNumber;
  if (bpNumber && /^\d+$/.test(bpNumber) && bpNumber.length < 10) {
    formattedBp = bpNumber.padStart(10, '0');
  }

  // 1. Fetch current details from SAP to resolve target Address, Company Code, and Bank IDs
  const existingVendor = await getVendorFromSAP(formattedBp, cfg);
  if (!existingVendor) {
    throw new Error(`Vendor ${formattedBp} not found in SAP`);
  }

  // 2. GSTIN (IN3) Update
  if (taxDetails?.gstin) {
    const taxTypeGst = cfg?.taxTypeGst || 'IN3';
    const taxKey = `BusinessPartner='${formattedBp}',BPTaxType='${taxTypeGst}'`;
    try {
      await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartnerTax(${taxKey})`, {
        BPTaxNumber: taxDetails.gstin,
      });
      console.log(`✅ [CR PATCH] GSTIN updated`);
    } catch (err) {
      console.warn(`[CR PATCH] GSTIN not found, attempting creation…`);
      try {
        await sapODataWrite(cfg, 'POST', '/A_BusinessPartnerTax', {
          BusinessPartner: formattedBp,
          BPTaxType: taxTypeGst,
          BPTaxNumber: taxDetails.gstin,
        });
        console.log(`✅ [CR POST] GSTIN created`);
      } catch (postErr) {
        console.error(`❌ [CR POST] Failed to write GSTIN: ${postErr.message}`);
      }
    }
  }

  // 3. MSME Number (BP Identification MSME01-MSME05) Update
  if (taxDetails?.msmeNumber) {
    const bpIdentType = {
      'MICRO': 'MSME01',
      'SMALL': 'MSME02',
      'MEDIUM': 'MSME03',
      'NONE': 'MSME04',
      'NOT_AN_MSME': 'MSME04',
      'CANCELLED': 'MSME05',
      'MSME01': 'MSME01',
      'MSME02': 'MSME02',
      'MSME03': 'MSME03',
      'MSME04': 'MSME04',
      'MSME05': 'MSME05'
    }[taxDetails.msmeStatus] || 'MSME02';

    let entityName = 'A_BuPaIdentification';
    try {
      await sapODataRead(cfg, `/A_BuPaIdentification?$top=1&$format=json`);
    } catch (e) {
      entityName = 'A_BPIdentification';
    }

    try {
      const msmeRes = await sapODataRead(cfg, `/${entityName}?$filter=BusinessPartner eq '${formattedBp}' and (BPIdentificationType eq 'MSME01' or BPIdentificationType eq 'MSME02' or BPIdentificationType eq 'MSME03' or BPIdentificationType eq 'MSME04' or BPIdentificationType eq 'MSME05')&$format=json`);
      const existingMsme = msmeRes.data?.d?.results || msmeRes.data?.results || [];
      
      const payload = {
        BusinessPartner: formattedBp,
        BPIdentificationType: bpIdentType,
        BPIdentificationNumber: taxDetails.msmeNumber.trim().toUpperCase(),
        ValidityStartDate: _toSapODataDate(taxDetails.msmeRegDate),
        ValidityEndDate: _toSapODataDate(taxDetails.msmeValTo),
        BPIdentificationEntryDate: _toSapODataDate(taxDetails.msmeEntryDate),
        Region: taxDetails.msmeRegion || '',
        Country: 'IN'
      };

      if (existingMsme.length > 0) {
        const oldNo = existingMsme[0].BPIdentificationNumber;
        const oldType = existingMsme[0].BPIdentificationType;
        const oldValStart = existingMsme[0].ValidityStartDate ? new Date(existingMsme[0].ValidityStartDate).getTime() : 0;
        const newValStart = taxDetails.msmeRegDate ? new Date(taxDetails.msmeRegDate).getTime() : 0;
        
        const oldValEnd = existingMsme[0].ValidityEndDate ? new Date(existingMsme[0].ValidityEndDate).getTime() : 0;
        const newValEnd = taxDetails.msmeValTo ? new Date(taxDetails.msmeValTo).getTime() : 0;
        
        const oldEntry = existingMsme[0].BPIdentificationEntryDate ? new Date(existingMsme[0].BPIdentificationEntryDate).getTime() : 0;
        const newEntry = taxDetails.msmeEntryDate ? new Date(taxDetails.msmeEntryDate).getTime() : 0;
        
        const oldReg = existingMsme[0].Region || '';
        const newReg = taxDetails.msmeRegion || '';

        if (oldNo !== taxDetails.msmeNumber || oldType !== bpIdentType || oldValStart !== newValStart || oldValEnd !== newValEnd || oldEntry !== newEntry || oldReg !== newReg) {
          const deleteKey = `BusinessPartner='${formattedBp}',BPIdentificationType='${oldType}',BPIdentificationNumber='${oldNo}'`;
          try {
            await sapODataWrite(cfg, 'DELETE', `/${entityName}(${deleteKey})`);
          } catch (delErr) {
            console.error(`❌ [CR PATCH] Failed to delete old MSME Identification: ${delErr.message}`);
          }
          await sapODataWrite(cfg, 'POST', `/${entityName}`, payload);
          console.log(`✅ [CR PATCH] MSME BP Identification updated (Re-created as ${bpIdentType})`);
        } else {
          console.log(`ℹ️ [CR PATCH] MSME BP Identification matches, no update needed`);
        }
      } else {
        await sapODataWrite(cfg, 'POST', `/${entityName}`, payload);
        console.log(`✅ [CR POST] MSME BP Identification created as ${bpIdentType}`);
      }
    } catch (err) {
      console.error(`❌ [CR PATCH] Failed to update MSME BP Identification: ${err.message}`);
    }
  }



  // 5. Bank Details Update (A_BusinessPartnerBank)
  if (bankDetails && bankDetails.length > 0) {
    const existingBanks = existingVendor.to_BusinessPartnerBank?.results || [];
    
    for (let i = 0; i < bankDetails.length; i++) {
      const b = bankDetails[i];
      let matchedBank = null;
      if (b.bankIdentification) {
        matchedBank = existingBanks.find(ex => ex.BankIdentification === b.bankIdentification);
      }
      if (!matchedBank) {
        matchedBank = existingBanks.find(ex => ex.BankAccount === b.accountNumber);
      }
      
      const bankPayload = {
        BankCountryKey:        b.bankCountry || 'IN',
        BankNumber:            b.bankKey || '',
        BankAccount:           b.accountNumber || '',
        BankAccountHolderName: b.accountHolder || '',
        BankControlKey:        b.controlKey || 'EN',
        BankAccountReferenceText: b.ifsc || '',
      };

      if (matchedBank) {
        const bankId = matchedBank.BankIdentification;
        const bankKey = `BusinessPartner='${formattedBp}',BankIdentification='${bankId}'`;
        try {
          await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartnerBank(${bankKey})`, bankPayload);
          console.log(`✅ [CR PATCH] Bank detail updated for ID: ${bankId}`);
        } catch (err) {
          console.error(`❌ [CR PATCH] Failed to update bank ${bankId}: ${err.message}`);
        }
      } else {
        const newId = String(existingBanks.length + i + 1).padStart(4, '0');
        try {
          await sapODataWrite(cfg, 'POST', '/A_BusinessPartnerBank', {
            BusinessPartner:    formattedBp,
            BankIdentification: newId,
            ...bankPayload
          });
          console.log(`✅ [CR POST] New bank detail created with ID: ${newId}`);
        } catch (err) {
          console.error(`❌ [CR POST] Failed to create bank detail: ${err.message}`);
        }
      }
    }
  }

  // 6. Address Details Update (A_BusinessPartnerAddress)
  if (addressDetails && Object.keys(addressDetails).length > 0) {
    const addrList = existingVendor.to_BusinessPartnerAddress?.results || 
                     (Array.isArray(existingVendor.to_BusinessPartnerAddress) ? existingVendor.to_BusinessPartnerAddress : (existingVendor.to_BusinessPartnerAddress ? [existingVendor.to_BusinessPartnerAddress] : []));
    const addrObj = addrList[0];
    if (addrObj) {
      const addrId = addrObj.AddressID;
      const addrKey = `BusinessPartner='${formattedBp}',AddressID='${addrId}'`;
      const addrPayload = {};
      if (addressDetails.street)      addrPayload.StreetName  = addressDetails.street;
      if (addressDetails.houseNumber) addrPayload.HouseNumber = addressDetails.houseNumber;
      if (addressDetails.city)         addrPayload.CityName    = addressDetails.city;
      if (addressDetails.district) {
        addrPayload.District   = addressDetails.district;
      }
      if (addressDetails.state)        addrPayload.Region      = addressDetails.state;
      if (addressDetails.postalCode)   addrPayload.PostalCode   = addressDetails.postalCode;
      if (addressDetails.country)      addrPayload.Country      = addressDetails.country;

      if (Object.keys(addrPayload).length > 0) {
        try {
          await sapODataWrite(cfg, 'PATCH', `/A_BusinessPartnerAddress(${addrKey})`, addrPayload);
          console.log(`✅ [CR PATCH] Business Partner Address updated for ID: ${addrId}`);
        } catch (err) {
          console.error(`❌ [CR PATCH] Failed to update BP Address ${addrId}: ${err.message}`);
          throw new Error(`SAP address update failed: ${err.message}`);
        }
      }
    } else {
      console.warn(`⚠️ [CR PATCH] No Address ID resolved for BP ${formattedBp}, skipping address update`);
    }
  }

  return { vendorNumber: formattedBp, updated: true };
};

/**
 * checkDuplicateInSAP — checks for duplicate Business Partners in SAP using OData API_BUSINESS_PARTNER/DuplicateCheck
 * @param {object} cfg SAP Config
 * @param {object} vendorData VendorRequest document/object data
 */
const checkDuplicateInSAP = async (cfg, vendorData) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    console.log('🧪 [SAP] STUB duplicate check');
    if (vendorData.generalData?.vendorName?.toLowerCase().includes('duplicate')) {
      return [{
        businessPartner: '9991234',
        fullName: 'Stub Duplicate Vendor Ltd',
        houseNumber: '123',
        streetName: 'Stub St',
        city: 'Mumbai',
        country: 'IN',
        matchRuleName: 'Organization_Address',
        matchScore: 95.50
      }];
    }
    return [];
  }

  // Build input parameters
  const inputObj = {
    BusinessPartnerCategory: "2" // 2 = Organization
  };

  if (vendorData.generalData?.vendorName) {
    inputObj.OrganizationBPName1 = vendorData.generalData.vendorName;
  }

  // Composite address
  const addressDetails = {};
  if (vendorData.addressDetails?.houseNumber) addressDetails.HouseNumber = vendorData.addressDetails.houseNumber;
  if (vendorData.addressDetails?.street)      addressDetails.StreetName  = vendorData.addressDetails.street;
  if (vendorData.addressDetails?.city)        addressDetails.CityName    = vendorData.addressDetails.city;
  if (vendorData.addressDetails?.country)     addressDetails.Country     = vendorData.addressDetails.country;
  if (vendorData.addressDetails?.state)       addressDetails.Region      = vendorData.addressDetails.state;
  if (vendorData.addressDetails?.postalCode)  addressDetails.PostalCode  = vendorData.addressDetails.postalCode;

  if (Object.keys(addressDetails).length > 0) {
    inputObj._BusinessPartnerAddress = [addressDetails];
  }

  // Composite unique ID (PAN/GSTIN mapped to BPIdentificationType)
  const identifications = [];
  if (vendorData.taxDetails?.pan) {
    identifications.push({
      BPIdentificationType: 'IN0', // IN0 is standard PAN in this configuration
      BPIdentificationNumber: vendorData.taxDetails.pan.trim().toUpperCase()
    });
  }
  if (vendorData.taxDetails?.gstin) {
    identifications.push({
      BPIdentificationType: 'IN3', // IN3 is standard GSTIN
      BPIdentificationNumber: vendorData.taxDetails.gstin.trim().toUpperCase()
    });
  }

  if (identifications.length > 0) {
    inputObj._BuPaIdentification = identifications;
  }

  const inputStr = JSON.stringify(inputObj);
  const path = `/DuplicateCheck?Input='${encodeURIComponent(inputStr)}'`;

  try {
    const res = await sapODataRead(cfg, path);
    const results = res.data?.d?.results || res.data?.results || [];
    return results.map(r => ({
      businessPartner: r.BusinessPartner || '',
      fullName: r.BusinessPartnerFullName || '',
      houseNumber: r.HouseNumber || '',
      streetName: r.StreetName || '',
      city: r.City || '',
      country: r.Country || '',
      matchRuleName: r.MatchRuleName || '',
      matchScore: parseFloat(r.MatchScore || '0')
    }));
  } catch (err) {
    console.error('❌ [SAP DuplicateCheck] OData call failed:', err.message);
    // Do not crash the entire flow if SAP is down, but log the error
    return [];
  }
};

module.exports = {
  // ── Core ──────────────────────────────────────────────────────────────
  pushVendor,
  patchVendorInSAP,
  pushVendorChangeRequest,

  // ── Read from SAP ─────────────────────────────────────────────────────
  fetchVendorsFromSAP,
  getVendorFromSAP,
  checkDuplicateInSAP,

  // ── CSRF (exposed for testing / admin health-check) ───────────────────
  fetchCsrfToken,
  getCsrfToken,
  invalidateCsrfToken,

  // ── Payload builders (exposed for unit testing) ───────────────────────
  _buildBPPayload,

  // ── India Tax Sub-Bridge ──────────────────────────────────────────────
  sapIndiaTaxBridge,
};