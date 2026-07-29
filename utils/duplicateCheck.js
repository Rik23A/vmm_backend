const VendorRequest = require('../models/VendorRequest');
const { checkDuplicateInSAP } = require('./sapBridge');

// ── Levenshtein Distance ──────────────────────────────────────────────
// Calculates the edit distance between two strings
const levenshteinDistance = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
};

// ── Similarity Score (0 to 1, 1 = identical) ──────────────────────────
const similarity = (a, b) => {
  if (!a || !b) return 0;
  const A = a.toLowerCase().trim();
  const B = b.toLowerCase().trim();
  if (A === B) return 1;
  const dist = levenshteinDistance(A, B);
  return 1 - dist / Math.max(A.length, B.length);
};

// ── FUZZY_THRESHOLD: names above this similarity are flagged ──────────
const FUZZY_THRESHOLD = 0.85;

// ── checkDuplicate ────────────────────────────────────────────────────
// Checks for duplicate vendors within the same tenantId.
// Returns: { isDuplicate, matchType, matchedRequest, details, sapMatches }
const checkDuplicate = async (vendorData, tenantId, excludeRequestId = null) => {
  const { taxDetails, generalData, bankDetails } = vendorData;

  // Build base query — exclude current request if editing
  const baseQuery = { tenantId };
  if (excludeRequestId) {
    baseQuery._id = { $ne: excludeRequestId };
  }
  // Only compare against active/approved vendors (not rejected/cancelled)
  baseQuery.status = { $nin: ['REJECTED', 'CANCELLED'] };

  let isDuplicate = false;
  let matchType = 'NONE';
  let matchField = null;
  let matchedRequest = null;
  const details = [];
  let sapMatches = [];

  // ── 1. Exact match: PAN ────────────────────────────────────────────
  if (taxDetails?.pan) {
    const panMatch = await VendorRequest.findOne({
      ...baseQuery,
      'taxDetails.pan': taxDetails.pan.trim().toUpperCase(),
    }).select('tempVendorNumber sapVendorNumber generalData.vendorName status');
    if (panMatch) {
      isDuplicate = true;
      matchType = 'EXACT';
      matchField = 'PAN';
      matchedRequest = panMatch;
      details.push(`Exact PAN match with ${panMatch.generalData.vendorName} (${panMatch.tempVendorNumber || panMatch.sapVendorNumber})`);
    }
  }

  // ── 2. Exact match: GSTIN ──────────────────────────────────────────
  if (taxDetails?.gstin && matchType !== 'EXACT') {
    const gstMatch = await VendorRequest.findOne({
      ...baseQuery,
      'taxDetails.gstin': taxDetails.gstin.trim().toUpperCase(),
    }).select('tempVendorNumber sapVendorNumber generalData.vendorName status');
    if (gstMatch) {
      isDuplicate = true;
      matchType = 'EXACT';
      matchField = 'GSTIN';
      matchedRequest = gstMatch;
      details.push(`Exact GSTIN match with ${gstMatch.generalData.vendorName} (${gstMatch.tempVendorNumber || gstMatch.sapVendorNumber})`);
    }
  }

  // ── 3. Exact match: Bank Account Number ────────────────────────────
  if (bankDetails && bankDetails.length > 0 && matchType !== 'EXACT') {
    for (const bank of bankDetails) {
      if (bank.accountNumber) {
        const bankMatch = await VendorRequest.findOne({
          ...baseQuery,
          'bankDetails.accountNumber': bank.accountNumber.trim(),
        }).select('tempVendorNumber sapVendorNumber generalData.vendorName status');
        if (bankMatch) {
          isDuplicate = true;
          matchType = 'EXACT';
          matchField = 'BANK_ACCOUNT';
          matchedRequest = bankMatch;
          details.push(`Exact bank account match with ${bankMatch.generalData.vendorName} (${bankMatch.tempVendorNumber || bankMatch.sapVendorNumber})`);
          break;
        }
      }
    }
  }

  // ── 4. Fuzzy match: Vendor Name ────────────────────────────────────
  if (generalData?.vendorName && matchType !== 'EXACT') {
    // Pull recent vendor names in the same tenant (limit to 500 for performance)
    const existing = await VendorRequest.find(baseQuery)
      .select('generalData.vendorName tempVendorNumber sapVendorNumber status')
      .limit(500)
      .lean();

    for (const req of existing) {
      const score = similarity(generalData.vendorName, req.generalData?.vendorName);
      if (score >= FUZZY_THRESHOLD) {
        isDuplicate = true;
        matchType = 'FUZZY';
        matchField = 'VENDOR_NAME';
        matchedRequest = req;
        details.push(`${Math.round(score * 100)}% name similarity with ${req.generalData.vendorName} (${req.tempVendorNumber || req.sapVendorNumber})`);
        break;
      }
    }
  }

  // ── 5. SAP Duplicate Check ─────────────────────────────────────────
  try {
    const Tenant = require('../models/Tenant');
    const { getSapConfig } = require('../middleware/tenant');
    const tenant = await Tenant.findOne({ tenantId, isActive: true })
      .select('+sapConfig.sapPassword');

    if (tenant) {
      const sapConfig = getSapConfig(tenant);
      if (sapConfig.sapVersion) {
        const sapRes = await checkDuplicateInSAP(sapConfig, vendorData);
        if (sapRes && sapRes.length > 0) {
          // Filter results with match score >= 80
          const filteredMatches = sapRes.filter(m => m.matchScore >= 80);
          if (filteredMatches.length > 0) {
            sapMatches = filteredMatches;
            isDuplicate = true;

            // Check if any SAP match is 100% or close to exact
            const hasExactSapMatch = filteredMatches.some(m => m.matchScore === 100);
            if (hasExactSapMatch) {
              matchType = 'EXACT';
              details.push(`Exact match found in SAP ERP (BP ${filteredMatches.find(m => m.matchScore === 100).businessPartner})`);
            } else if (matchType !== 'EXACT') {
              matchType = 'FUZZY';
              const topMatch = filteredMatches[0];
              details.push(`SAP match found: ${topMatch.fullName} (BP ${topMatch.businessPartner}) with ${topMatch.matchScore}% similarity`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Error running SAP duplicate check:', err.message);
  }

  return {
    isDuplicate,
    matchType,
    matchField,
    matchedRequest,
    details: details.join('; '),
    sapMatches
  };
};

module.exports = { checkDuplicate, similarity };
