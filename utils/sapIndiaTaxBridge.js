'use strict';
/**
 * SAP India Tax & TAN Exemption Bridge — utils/sapIndiaTaxBridge.js
 *
 * Dedicated OData client for ZBP_INDIA_SP_SRV:
 *   - EntitySet: IndiaTaxGeneralSet (PAN, ServiceRegNo, CSTNo, LSTNo, GstVenClass, CorpIdentNo)
 *   - Navigation: ToTanExemption (Assoc_IndiaTaxGeneral_TanExemption -> TanExemptionSet)
 *   - Navigation: ToAttachments  (Assoc_IndiaTaxGeneral_BPAttachment -> BPAttachmentSet)
 */

const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { getMimeType, getFileExtension, getContentDisposition } = require('./mimeHelper');

// ── Constants ──────────────────────────────────────────────────────────────
const CSRF_TTL_MS = 25 * 60 * 1000; // 25 min
const SAP_TIMEOUT = 30_000;

// Shared keep-alive HTTPS agent
const _sharedAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// CSRF cache map for ZBP_INDIA_SP_SRV
const _csrfCache = new Map();

/**
 * Resolve the base OData URL for ZBP_INDIA_SP_SRV
 *
 * Production URL (Port 44301):  https://sapwd.birla-sugar.com:44301/sap/opu/odata/sap/ZBP_INDIA_SP_SRV
 * Development URL (Port 44300): https://sapwd.birla-sugar.com:44300/sap/opu/odata/sap/ZBP_INDIA_SP_SRV
 */
const resolveIndiaTaxUrl = (cfg = {}) => {
  // 1. DB config (tenant.sapConfig.sapIndiaTaxOdataUrl) takes top priority
  if (cfg.sapIndiaTaxOdataUrl && cfg.sapIndiaTaxOdataUrl.trim()) {
    return cfg.sapIndiaTaxOdataUrl.trim().replace(/\/$/, '');
  }
  // 2. Base sapOdataUrl derived (replacing API_BUSINESS_PARTNER with ZBP_INDIA_SP_SRV, preserves host & port)
  if (cfg.sapOdataUrl && cfg.sapOdataUrl.trim()) {
    return cfg.sapOdataUrl.trim().replace(/API_BUSINESS_PARTNER\/?$/i, 'ZBP_INDIA_SP_SRV').replace(/\/$/, '');
  }
  // 3. Environment-aware default fallback:
  // Production (Port 44301) vs Development (Port 44300)
  const isProd = process.env.NODE_ENV === 'production'
    || String(cfg.sapSystemId || '').toUpperCase() === 'PRD'
    || String(cfg.sapClient || '') === '800';

  return isProd
    ? 'https://sapwd.birla-sugar.com:44301/sap/opu/odata/sap/ZBP_INDIA_SP_SRV'
    : 'https://sapwd.birla-sugar.com:44300/sap/opu/odata/sap/ZBP_INDIA_SP_SRV';
};

const _cacheKey = (cfg) => `${resolveIndiaTaxUrl(cfg)}::${cfg.sapClient || '100'}::${cfg.sapUser}`;
const _isFresh  = (e)   => e && (Date.now() - e.fetchedAt.getTime()) < CSRF_TTL_MS;

/**
 * Fetch CSRF token and session cookies specifically for ZBP_INDIA_SP_SRV
 */
const fetchIndiaTaxCsrfToken = async (cfg) => {
  const client = cfg.sapClient || '100';
  const baseUrl = resolveIndiaTaxUrl(cfg);
  const url = `${baseUrl}/$metadata?sap-client=${client}`;
  console.log(`🔑 [IndiaTax CSRF] Fetching token → ${url}`);

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
    httpsAgent: _sharedAgent,
  });

  const token = res.headers['x-csrf-token'];
  if (!token || token === 'Required') {
    throw new Error('[SAP IndiaTax CSRF] No token returned for ZBP_INDIA_SP_SRV. Check credentials and authorizations.');
  }

  const rawCookies = res.headers['set-cookie'];
  const cookie = Array.isArray(rawCookies)
    ? rawCookies.map(c => c.split(';')[0]).join('; ')
    : (typeof rawCookies === 'string' ? rawCookies.split(';')[0] : '');

  _csrfCache.set(_cacheKey(cfg), { token, cookie, fetchedAt: new Date() });
  return { token, cookie };
};

const getIndiaTaxCsrfToken = async (cfg, force = false) => {
  const entry = _csrfCache.get(_cacheKey(cfg));
  if (!force && _isFresh(entry)) return entry;
  return fetchIndiaTaxCsrfToken(cfg);
};

const invalidateIndiaTaxCsrfToken = (cfg) => _csrfCache.delete(_cacheKey(cfg));

/**
 * Axios instance factory for ZBP_INDIA_SP_SRV
 */
const _indiaTaxInstance = (cfg) =>
  axios.create({
    baseURL: resolveIndiaTaxUrl(cfg),
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
    httpsAgent: _sharedAgent,
  });

/**
 * Format Date to SAP OData JSON DateTime literal (/Date(timestamp)/)
 */
const _toSapODataDate = (d) => {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `/Date(${dt.getTime()})/`;
};

/**
 * Normalize and parse OData error responses
 */
const parseIndiaTaxError = (err) => {
  const data = err.response?.data;
  let message = err.message || 'Unknown SAP India Tax Error';
  let details = [];

  if (data) {
    if (typeof data === 'string') {
      const msgMatch = data.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
      if (msgMatch) message = msgMatch[1].trim();
    } else if (data.error) {
      message = data.error.message?.value || data.error.message || message;
      if (Array.isArray(data.error.innererror?.errordetails)) {
        details = data.error.innererror.errordetails.map(d => ({
          code: d.code,
          message: d.message,
          target: d.target,
          severity: d.severity
        }));
      }
    }
  }

  const parsedErr = new Error(`[SAP ZBP_INDIA_SP_SRV] ${message}`);
  parsedErr.sapMessage = message;
  parsedErr.errordetails = details;
  parsedErr.status = err.response?.status;
  return parsedErr;
};

/**
 * Perform a write (POST / PATCH / PUT / DELETE) to ZBP_INDIA_SP_SRV
 */
const sapIndiaTaxWrite = async (cfg, method, endpoint, data, customHeaders = {}) => {
  const instance = _indiaTaxInstance(cfg);

  const executeCall = async () => {
    let { token, cookie } = await getIndiaTaxCsrfToken(cfg);
    const hdrs = {
      'x-csrf-token': token,
      ...customHeaders
    };
    if (cookie) hdrs['Cookie'] = cookie;
    if (method.toUpperCase() === 'PATCH') hdrs['If-Match'] = '*';
    if (method.toUpperCase() === 'POST' && !customHeaders['Content-Type']) {
      hdrs['Prefer'] = 'return=representation';
    }

    try {
      console.log(`📤 [SAP IndiaTax] ${method} ${endpoint}`);
      const res = await instance.request({ method, url: endpoint, data, headers: hdrs });
      console.log(`✅ [SAP IndiaTax] ${method} ${endpoint} → HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (err.response?.status === 403) {
        console.warn('⚠️ [SAP IndiaTax] 403 Forbidden — refreshing CSRF token & retrying…');
        invalidateIndiaTaxCsrfToken(cfg);
        const fresh = await getIndiaTaxCsrfToken(cfg, true);
        const freshHdrs = { ...hdrs, 'x-csrf-token': fresh.token };
        if (fresh.cookie) freshHdrs['Cookie'] = fresh.cookie;
        return instance.request({ method, url: endpoint, data, headers: freshHdrs });
      }
      throw parseIndiaTaxError(err);
    }
  };

  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await executeCall();
    } catch (err) {
      if (attempt < maxRetries && (!err.status || err.status >= 500)) {
        console.warn(`⚠️ [SAP IndiaTax] Retrying after transient error (${err.message})…`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
};

/**
 * Perform a GET read from ZBP_INDIA_SP_SRV
 */
const sapIndiaTaxRead = async (cfg, endpoint) => {
  const instance = _indiaTaxInstance(cfg);
  const entry = _csrfCache.get(_cacheKey(cfg));
  const hdrs = (entry && entry.cookie) ? { Cookie: entry.cookie } : {};

  try {
    console.log(`📥 [SAP IndiaTax] GET ${endpoint}`);
    const res = await instance.get(endpoint, { headers: hdrs });
    console.log(`✅ [SAP IndiaTax] GET ${endpoint} → HTTP ${res.status}`);
    return res;
  } catch (err) {
    throw parseIndiaTaxError(err);
  }
};

/**
 * Build the deep-insert payload for IndiaTaxGeneralSet + ToTanExemption
 */
const _buildIndiaTaxPayload = (bpNumber, vendorData = {}) => {
  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const taxDetails = vendorData.taxDetails || {};
  const companyCode = vendorData.companyCodeData?.companyCode || '1000';

  // 1. Base Tax Payload (IndiaTaxGeneral)
  const payload = {
    BusinessPartner: formattedBp,
    PAN: (taxDetails.pan || '').trim().toUpperCase().substring(0, 40),
    ServiceRegNo: (taxDetails.serviceRegNo || '').trim().toUpperCase().substring(0, 40),
    CSTNo: (taxDetails.cstNo || '').trim().toUpperCase().substring(0, 40),
    LSTNo: (taxDetails.lstNo || '').trim().toUpperCase().substring(0, 40),
    GstVenClass: (taxDetails.gstVenClass !== undefined && taxDetails.gstVenClass !== null ? String(taxDetails.gstVenClass) : ' ').substring(0, 1),
  };

  // 2. TAN Exemptions list
  const tanList = [];
  if (Array.isArray(taxDetails.tanExemptions) && taxDetails.tanExemptions.length > 0) {
    for (const tan of taxDetails.tanExemptions) {
      if (tan.sectionCode || tan.withholdingCode || tan.exemptionNumber) {
          const cc = (tan.companyCode || companyCode).trim().toUpperCase().substring(0, 4);
          const defaultSec = cc === '5000' ? '5005' : cc === '6000' ? '6006' : (tan.sectionCode || '5005');
          const secCode = (tan.sectionCode || defaultSec).trim().toUpperCase().substring(0, 4);
          tanList.push({
            BusinessPartner: formattedBp,
            CompanyCode: cc,
            SectionCode: secCode,
          WithholdingCode: (tan.withholdingCode || '').trim().toUpperCase().substring(0, 2),
          WithholdingTaxType: (tan.withholdingTaxType || 'W1').trim().toUpperCase().substring(0, 2),
          ValidFrom: _toSapODataDate(tan.validFrom || new Date()),
          ValidTo: _toSapODataDate(tan.validTo || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
          ExemptionNumber: (tan.exemptionNumber || '').trim().substring(0, 15),
          ExemptionRate: Number(tan.exemptionRate || 0).toFixed(2),
          ExemThreshold: Number(tan.exemThreshold || 0).toFixed(2),
          Currency: (tan.currency || 'INR').trim().toUpperCase().substring(0, 5),
        });
      }
    }
  }

  // Fallback: If no explicit tanExemptions but companyCodeData has withholdingTax exemptions
  if (tanList.length === 0 && Array.isArray(vendorData.companyCodeData?.withholdingTax)) {
    for (const wt of vendorData.companyCodeData.withholdingTax) {
      if (wt.exemptionNumber || wt.exemptionPercent) {
        tanList.push({
          BusinessPartner: formattedBp,
          CompanyCode: companyCode.substring(0, 4),
          SectionCode: (wt.taxCode || '194C').substring(0, 4),
          WithholdingCode: (wt.taxCode || 'C1').substring(0, 2),
          WithholdingTaxType: (wt.taxType || 'W1').substring(0, 2),
          ValidFrom: _toSapODataDate(wt.exemptFrom || new Date()),
          ValidTo: _toSapODataDate(wt.exemptTo || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
          ExemptionNumber: (wt.exemptionNumber || '').substring(0, 15),
          ExemptionRate: Number(wt.exemptionPercent || 0).toFixed(2),
          ExemThreshold: '0.00',
          Currency: 'INR',
        });
      }
    }
  }

  if (tanList.length > 0) {
    payload.ToTanExemption = tanList;
  }

  return payload;
};

/**
 * Post India Tax Details (PAN, Service Reg, TAN Exemptions) to SAP
 */
const postIndiaTaxDetails = async (cfg, bpNumber, vendorData) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    console.log(`🧪 [SAP IndiaTax STUB] Simulated postIndiaTaxDetails for BP: ${bpNumber}`);
    await new Promise(r => setTimeout(r, 400));
    return {
      status: 'SUCCESS_STUB',
      businessPartner: bpNumber,
      taxData: _buildIndiaTaxPayload(bpNumber, vendorData)
    };
  }

  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const payload = _buildIndiaTaxPayload(formattedBp, vendorData);
  console.log(`📦 [SAP IndiaTax] Deep-inserting IndiaTaxGeneralSet for BP: ${formattedBp}`);

  try {
    // Attempt 1: Deep insert POST
    const res = await sapIndiaTaxWrite(cfg, 'POST', '/IndiaTaxGeneralSet', payload);
    console.log(`🎉 [SAP IndiaTax] IndiaTaxGeneralSet created successfully for BP: ${formattedBp}`);
    return res.data?.d || res.data;
  } catch (err) {
    // If already exists or cannot create with POST, try PATCH on header and separate inserts on TanExemptionSet
    console.warn(`⚠️ [SAP IndiaTax] Deep insert POST failed: ${err.message}. Checking if record already exists…`);
    
    // Header PATCH payload (without navigation property)
    const headerPatch = { ...payload };
    delete headerPatch.ToTanExemption;
    delete headerPatch.ToAttachments;

    const patchKey = `IndiaTaxGeneralSet('${formattedBp}')`;
    try {
      await sapIndiaTaxWrite(cfg, 'PATCH', `/${patchKey}`, headerPatch);
      console.log(`✅ [SAP IndiaTax] IndiaTaxGeneralSet updated via PATCH for BP: ${formattedBp}`);

      // If TAN exemptions provided, insert them individually
      if (Array.isArray(payload.ToTanExemption) && payload.ToTanExemption.length > 0) {
        for (const tan of payload.ToTanExemption) {
          try {
            await sapIndiaTaxWrite(cfg, 'POST', '/TanExemptionSet', tan);
            console.log(`✅ [SAP IndiaTax] TanExemption inserted: ${tan.SectionCode}`);
          } catch (tanErr) {
            console.warn(`⚠️ [SAP IndiaTax] Failed to insert individual TanExemption: ${tanErr.message}`);
          }
        }
      }
      return { status: 'UPDATED', businessPartner: formattedBp };
    } catch (patchErr) {
      console.error(`❌ [SAP IndiaTax] PATCH fallback also failed: ${patchErr.message}`);
      throw patchErr;
    }
  }
};

/**
 * Upload a document stream to BPAttachmentSet
 * Verified in Postman:
 * POST /sap/opu/odata/sap/ZBP_INDIA_SP_SRV/BPAttachmentSet
 * Headers:
 *   Slug: 0001013533;Sample_Document.pdf  (<10-digit-BP>;<Actual_File_Name>)
 *   Content-Type: application/pdf (or application/octet-stream)
 *   Accept: application/json
 *   x-csrf-token: <active_token>
 * Body: binary buffer
 */
const uploadIndiaTaxAttachment = async (cfg, bpNumber, documentItem) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();

  // 1. Ensure Business Partner is 10-digit zero-padded (e.g. 0001013533)
  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  // 2. CRITICAL: Use the actual original file name (e.g. "Sample_Document.pdf" or "GST_Certificate.pdf")
  // Sanitize illegal separator characters (';' or path separators) so SAP's SPLIT AT ';' functions properly
  const rawFileName = documentItem?.fileName ||
    (documentItem?.filePath ? path.basename(documentItem.filePath) : 'Document.pdf');
  const safeFileName = rawFileName.replace(/[;/\\]/g, '_').trim();
  const fileExt = getFileExtension(safeFileName, 'pdf').toUpperCase();
  const mimeType = (documentItem?.mimeType && documentItem.mimeType !== 'application/octet-stream')
    ? documentItem.mimeType
    : getMimeType(safeFileName, 'application/pdf');

  if (mode === 'STUB') {
    const stubId = `FOL37000000000004EXT${Date.now().toString().slice(-8)}`;
    console.log(`🧪 [SAP IndiaTax STUB] Simulated attachment upload for BP: ${formattedBp}, file: ${safeFileName}`);
    return {
      status: 'ATTACHED_STUB',
      attachmentId: stubId,
      AttachmentId: stubId,
      fileName: safeFileName,
      FileName: safeFileName,
      fileExt: fileExt,
      FileExt: fileExt,
      mimeType: mimeType,
      MimeType: mimeType,
      businessPartner: formattedBp,
      BusinessPartner: formattedBp,
      mediaSrc: `${resolveIndiaTaxUrl(cfg)}/BPAttachmentSet('${stubId}')/$value`,
    };
  }

  // 3. Obtain binary buffer: from in-memory buffer or from disk file
  let fileBuffer = null;
  if (documentItem.buffer && Buffer.isBuffer(documentItem.buffer)) {
    fileBuffer = documentItem.buffer;
  } else if (documentItem.filePath) {
    let resolvedPath = null;
    try {
      const { getSafeAbsolutePath } = require('../config/storage');
      resolvedPath = getSafeAbsolutePath(documentItem.filePath);
    } catch (_) {
      // ignore
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      const fallback = path.isAbsolute(documentItem.filePath)
        ? documentItem.filePath
        : path.resolve(process.cwd(), documentItem.filePath);
      if (fs.existsSync(fallback)) {
        resolvedPath = fallback;
      }
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      console.warn(`⚠️ [SAP IndiaTax Attachment] File not found on disk: ${documentItem.filePath}, skipping upload.`);
      return null;
    }
    fileBuffer = fs.readFileSync(resolvedPath);
  }

  if (!fileBuffer) {
    throw new Error(`[SAP IndiaTax Attachment] No binary file content found to upload for BP ${formattedBp}`);
  }

  console.log(`📤 [SAP IndiaTax Attachment] Uploading '${safeFileName}' (${mimeType}) for BP ${formattedBp}…`);

  // Slug header format verified in Postman: <10-digit-BP>;<Actual_File_Name>
  const headers = {
    'Content-Type': mimeType,
    'Slug': `${formattedBp};${safeFileName}`,
    'Accept': 'application/json',
  };

  const res = await sapIndiaTaxWrite(cfg, 'POST', '/BPAttachmentSet', fileBuffer, headers);
  console.log(`✅ [SAP IndiaTax Attachment] Uploaded '${safeFileName}' successfully`);

  const attData = res.data?.d || res.data || {};
  const attachmentId = attData.AttachmentId || attData.attachmentId;

  return {
    attachmentId: attachmentId,
    AttachmentId: attachmentId,
    businessPartner: attData.BusinessPartner || attData.businessPartner || formattedBp,
    BusinessPartner: attData.BusinessPartner || attData.businessPartner || formattedBp,
    fileName: attData.FileName || safeFileName,
    FileName: attData.FileName || safeFileName,
    fileExt: attData.FileExt || safeFileName.split('.').pop().toUpperCase(),
    FileExt: attData.FileExt || safeFileName.split('.').pop().toUpperCase(),
    mimeType: attData.MimeType || mimeType,
    MimeType: attData.MimeType || mimeType,
    mediaSrc: attData.__metadata?.media_src || (attachmentId ? `${resolveIndiaTaxUrl(cfg)}/BPAttachmentSet('${attachmentId}')/$value` : null),
    raw: attData,
  };
};

/**
 * Query BPAttachmentSet for a Business Partner from SAP
 * Verified in Postman:
 * GET /sap/opu/odata/sap/ZBP_INDIA_SP_SRV/BPAttachmentSet?$filter=BusinessPartner eq '1003818'
 */
const getBPAttachments = async (cfg, bpNumber) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    return [
      {
        attachmentId: 'FOL37000000000004EXT51000000168324',
        AttachmentId: 'FOL37000000000004EXT51000000168324',
        businessPartner: String(bpNumber || '0001003818'),
        BusinessPartner: String(bpNumber || '0001003818'),
        fileName: 'GST_Certificate.pdf',
        FileName: 'GST_Certificate.pdf',
        fileExt: 'PDF',
        FileExt: 'PDF',
        mimeType: 'application/pdf',
        MimeType: 'application/pdf',
        mediaSrc: `${resolveIndiaTaxUrl(cfg)}/BPAttachmentSet('FOL37000000000004EXT51000000168324')/$value`,
      },
      {
        attachmentId: 'FOL37000000000004EXT51000000160626',
        AttachmentId: 'FOL37000000000004EXT51000000160626',
        businessPartner: String(bpNumber || '0001003818'),
        BusinessPartner: String(bpNumber || '0001003818'),
        fileName: 'deepa enterprises.pdf',
        FileName: 'deepa enterprises.pdf',
        fileExt: 'PDF',
        FileExt: 'PDF',
        mimeType: 'application/pdf',
        MimeType: 'application/pdf',
        mediaSrc: `${resolveIndiaTaxUrl(cfg)}/BPAttachmentSet('FOL37000000000004EXT51000000160626')/$value`,
      }
    ];
  }

  const cleanBp = String(bpNumber || '').trim();
  const unpaddedBp = cleanBp.replace(/^0+/, '');
  const paddedBp = /^\d+$/.test(unpaddedBp) ? unpaddedBp.padStart(10, '0') : cleanBp;

  // Filter expression: supports unpadded ('1003818') or padded ('0001003818')
  let filterExpr = `BusinessPartner eq '${cleanBp}'`;
  if (unpaddedBp && paddedBp && unpaddedBp !== paddedBp) {
    filterExpr = `BusinessPartner eq '${unpaddedBp}' or BusinessPartner eq '${paddedBp}'`;
  }

  const endpoint = `/BPAttachmentSet?$filter=${encodeURIComponent(filterExpr)}&$format=json`;
  console.log(`📥 [SAP IndiaTax] Querying BP attachments: ${endpoint}`);

  try {
    const res = await sapIndiaTaxRead(cfg, endpoint);
    const results = res.data?.d?.results || (Array.isArray(res.data?.d) ? res.data.d : (res.data?.results || []));
    return results.map(item => {
      const attId = item.AttachmentId;
      const fName = item.FileName || `${attId}.${(item.FileExt || 'pdf').toLowerCase()}`;
      const fExt = (item.FileExt || getFileExtension(fName, 'pdf')).toUpperCase();
      const detectedMime = getMimeType(fName) || getMimeType(fExt);
      const finalMime = (item.MimeType && item.MimeType !== 'application/octet-stream')
        ? item.MimeType
        : detectedMime;

      return {
        attachmentId: attId,
        AttachmentId: attId,
        businessPartner: item.BusinessPartner,
        BusinessPartner: item.BusinessPartner,
        fileName: fName,
        FileName: fName,
        fileExt: fExt,
        FileExt: fExt,
        mimeType: finalMime,
        MimeType: finalMime,
        mediaSrc: item.__metadata?.media_src || `${resolveIndiaTaxUrl(cfg)}/BPAttachmentSet('${attId}')/$value`,
        uri: item.__metadata?.uri,
        raw: item,
      };
    });
  } catch (err) {
    console.warn(`⚠️ [SAP IndiaTax] Failed to query BP attachments for BP ${bpNumber}:`, err.message);
    return [];
  }
};

/**
 * Download attachment binary stream from SAP BPAttachmentSet
 * Verified in Postman:
 * GET /sap/opu/odata/sap/ZBP_INDIA_SP_SRV/BPAttachmentSet('<AttachmentId>')/$value
 */
const downloadBPAttachmentStream = async (cfg, attachmentId, preferredFileName = null) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  const ext = preferredFileName ? getFileExtension(preferredFileName) : 'pdf';
  const inferredMime = preferredFileName ? getMimeType(preferredFileName) : 'application/pdf';

  if (mode === 'STUB') {
    const stubPdf = Buffer.from(`%PDF-1.4 STUB ATTACHMENT STREAM FOR ${attachmentId}`);
    return {
      data: stubPdf,
      contentType: inferredMime,
      contentDisposition: getContentDisposition(preferredFileName || `${attachmentId}.${ext}`, inferredMime),
      status: 200,
    };
  }

  const instance = _indiaTaxInstance(cfg);
  const entry = _csrfCache.get(_cacheKey(cfg));
  const hdrs = (entry && entry.cookie) ? { Cookie: entry.cookie } : {};
  const cleanId = String(attachmentId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) {
    throw new Error('[SAP IndiaTax] Invalid attachment ID specified.');
  }
  const endpoint = `/BPAttachmentSet('${cleanId}')/$value`;

  console.log(`📥 [SAP IndiaTax] Downloading attachment stream: ${endpoint}`);
  const res = await instance.get(endpoint, {
    headers: {
      ...hdrs,
      Accept: '*/*',
    },
    responseType: 'arraybuffer',
  });

  // Extract or infer content-type and filename
  let contentType = res.headers['content-type'];
  if (!contentType || contentType === 'application/octet-stream') {
    contentType = inferredMime;
  }

  let resolvedFileName = preferredFileName;
  const sapDisposition = res.headers['content-disposition'];
  if (!resolvedFileName && sapDisposition) {
    const match = sapDisposition.match(/filename=["']?([^"';]+)["']?/i);
    if (match && match[1]) {
      resolvedFileName = match[1].trim();
      contentType = getMimeType(resolvedFileName, contentType);
    }
  }

  if (!resolvedFileName) {
    const extFromMime = getFileExtension(contentType, 'pdf');
    resolvedFileName = `${cleanId}.${extFromMime}`;
  }

  return {
    data: Buffer.from(res.data),
    contentType,
    contentDisposition: getContentDisposition(resolvedFileName, contentType),
    status: res.status,
  };
};

/**
 * Read India Tax & TAN details from SAP, augmented with live BPAttachmentSet attachments
 */
const getIndiaTaxDetails = async (cfg, bpNumber) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    const stubAtts = await getBPAttachments(cfg, bpNumber);
    return {
      BusinessPartner: bpNumber,
      PAN: 'AABCS1234F',
      ServiceRegNo: 'SRN999888',
      GstVenClass: '1',
      ToTanExemption: { results: [] },
      ToAttachments: { results: stubAtts }
    };
  }

  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  // Fetch tax general data and attachments in parallel
  const [taxRes, attachments] = await Promise.allSettled([
    sapIndiaTaxRead(cfg, `/IndiaTaxGeneralSet('${formattedBp}')?$expand=ToTanExemption&$format=json`),
    getBPAttachments(cfg, bpNumber)
  ]);

  const taxData = taxRes.status === 'fulfilled' ? (taxRes.value?.data?.d || taxRes.value?.data || {}) : {};
  const attResults = attachments.status === 'fulfilled' ? attachments.value : [];

  taxData.BusinessPartner = taxData.BusinessPartner || formattedBp;
  taxData.ToAttachments = { results: attResults };

  return taxData;
};

module.exports = {
  resolveIndiaTaxUrl,
  fetchIndiaTaxCsrfToken,
  getIndiaTaxCsrfToken,
  invalidateIndiaTaxCsrfToken,
  sapIndiaTaxWrite,
  sapIndiaTaxRead,
  _buildIndiaTaxPayload,
  postIndiaTaxDetails,
  uploadIndiaTaxAttachment,
  getBPAttachments,
  downloadBPAttachmentStream,
  getIndiaTaxDetails,
};
