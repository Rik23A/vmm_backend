// ── PAN Validation (India) ─────────────────────────────────────────
// Format: 5 uppercase letters + 4 digits + 1 uppercase letter
// Example: ABCDE1234F
const validatePAN = (pan) => {
  if (!pan) return { valid: false, message: 'PAN is required' };
  const cleaned = pan.toString().trim().toUpperCase();
  const regex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  if (!regex.test(cleaned)) {
    return { valid: false, message: 'Invalid PAN format. Expected: ABCDE1234F' };
  }
  return { valid: true, value: cleaned };
};

// ── GSTIN Validation (India) ───────────────────────────────────────
// Format: 2 digits (state) + 10 char PAN + 1 digit + Z + 1 alphanumeric
// Example: 22ABCDE1234F1Z5
const validateGSTIN = (gstin) => {
  if (!gstin) return { valid: false, message: 'GSTIN is required' };
  const cleaned = gstin.toString().trim().toUpperCase();
  // Relaxed: 2 digits + 10 alphanumeric + anything else for last 3
  const regex = /^[0-9]{2}[A-Z0-9]{13}$/;
  if (cleaned.length !== 15) {
    return { valid: false, message: 'GSTIN must be exactly 15 characters' };
  }
  if (!regex.test(cleaned)) {
    return { valid: false, message: 'Invalid GSTIN format. Expected: 22ABCDE1234F1Z5' };
  }
  return { valid: true, value: cleaned };
};

// ── IFSC Validation (India) ────────────────────────────────────────
// Format: 4 uppercase letters + 0 + 6 alphanumeric characters
// Example: HDFC0001234
const validateIFSC = (ifsc) => {
  if (!ifsc) return { valid: false, message: 'IFSC is required' };
  const cleaned = ifsc.toString().trim().toUpperCase();
  const regex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  if (!regex.test(cleaned)) {
    return { valid: false, message: 'Invalid IFSC format. Expected: HDFC0001234' };
  }
  return { valid: true, value: cleaned };
};

// ── SWIFT/BIC Validation (International) ──────────────────────────
const validateSWIFT = (swift) => {
  if (!swift) return { valid: false, message: 'SWIFT code is required' };
  const cleaned = swift.trim().toUpperCase();
  const regex = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
  if (!regex.test(cleaned)) {
    return { valid: false, message: 'Invalid SWIFT/BIC format' };
  }
  return { valid: true, value: cleaned };
};

// ── Email validation ───────────────────────────────────────────────
const validateEmail = (email) => {
  if (!email) return { valid: false, message: 'Email is required' };
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(email.trim())) {
    return { valid: false, message: 'Invalid email format' };
  }
  return { valid: true, value: email.trim().toLowerCase() };
};

// ── Phone validation ───────────────────────────────────────────────
const validatePhone = (phone) => {
  if (!phone) return { valid: true, value: '' }; // optional field
  const cleaned = phone.trim().replace(/[\s\-\(\)]/g, '');
  const regex = /^\+?[0-9]{7,15}$/;
  if (!regex.test(cleaned)) {
    return { valid: false, message: 'Invalid phone number' };
  }
  return { valid: true, value: cleaned };
};

// ── Postal code validation (flexible — country-aware) ──────────────
const validatePostalCode = (code, country = 'IN') => {
  if (!code) return { valid: false, message: 'Postal code is required' };
  const rules = {
    IN: /^[1-9][0-9]{5}$/,          // India: 6 digits
    US: /^[0-9]{5}(-[0-9]{4})?$/,   // USA: 5 or 5-4
    GB: /^[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}$/i, // UK
  };
  const regex = rules[country];
  if (regex && !regex.test(code.trim())) {
    return { valid: false, message: `Invalid postal code for country ${country}` };
  }
  return { valid: true, value: code.trim() };
};

// ── Validate full vendor submission ───────────────────────────────
// Returns array of errors. Empty array = all valid.
const validateVendorSubmission = (data, checkAll = false, options = {}) => {
  const errors = [];

  // General Data
  if (!data.generalData?.vendorName?.trim()) {
    errors.push({ field: 'generalData.vendorName', message: 'Vendor name is required' });
  }
  if (!data.generalData?.street?.trim()) {
    errors.push({ field: 'generalData.street', message: 'Street address is required' });
  }
  if (!data.generalData?.city?.trim()) {
    errors.push({ field: 'generalData.city', message: 'City is required' });
  }
  if (!data.generalData?.country?.trim()) {
    errors.push({ field: 'generalData.country', message: 'Country is required' });
  }
  if (data.generalData?.email) {
    const emailResult = validateEmail(data.generalData.email);
    if (!emailResult.valid) errors.push({ field: 'generalData.email', message: emailResult.message });
  }

  // Tax Details
  if (data.generalData?.country === 'IN' || !data.generalData?.country) {
    if (checkAll) {
      if (!data.taxDetails?.pan?.trim()) {
        errors.push({ field: 'taxDetails.pan', message: 'PAN is required' });
      } else {
        const panResult = validatePAN(data.taxDetails.pan);
        if (!panResult.valid) errors.push({ field: 'taxDetails.pan', message: panResult.message });
      }
    } else {
      if (data.taxDetails?.pan) {
        const panResult = validatePAN(data.taxDetails.pan);
        if (!panResult.valid) errors.push({ field: 'taxDetails.pan', message: panResult.message });
      }
    }

    // GSTIN is optional in all cases, but must be valid if provided
    if (data.taxDetails?.gstin?.trim()) {
      const gstResult = validateGSTIN(data.taxDetails.gstin);
      if (!gstResult.valid) errors.push({ field: 'taxDetails.gstin', message: gstResult.message });
    }
  }

  // Bank Details
  if (data.bankDetails && data.bankDetails.length > 0) {
    data.bankDetails.forEach((bank, i) => {
      if (!bank.accountNumber?.trim()) {
        errors.push({ field: `bankDetails[${i}].accountNumber`, message: 'Bank account number is required' });
      }
      if (!bank.bankCountry?.trim()) {
        errors.push({ field: `bankDetails[${i}].bankCountry`, message: 'Bank country is required' });
      }
      if (checkAll && !bank.bankKey?.trim()) {
        errors.push({ field: `bankDetails[${i}].bankKey`, message: 'Bank key is required' });
      }
      if (bank.bankCountry === 'IN' || !bank.bankCountry) {
        if (!bank.ifsc?.trim()) {
          errors.push({ field: `bankDetails[${i}].ifsc`, message: 'Bank IFSC is required for Indian bank accounts' });
        } else {
          const ifscResult = validateIFSC(bank.ifsc);
          if (!ifscResult.valid) {
            errors.push({ field: `bankDetails[${i}].ifsc`, message: ifscResult.message });
          }
        }
      }
    });
  }

  // Company Code Data (Only required on checkAll)
  if (checkAll) {
    if (!data.companyCodeData?.companyCode?.trim()) {
      errors.push({ field: 'companyCodeData.companyCode', message: 'Company code is required' });
    }
    if (!data.companyCodeData?.reconciliationAccount?.trim()) {
      errors.push({ field: 'companyCodeData.reconciliationAccount', message: 'Reconciliation account is required' });
    }
  }

  // Document Upload Validation based on provided fields
  // TEMPORARILY DISABLED for all approval stages as per user request
  const DISABLE_DOC_CHECK_ON_APPROVAL = true;
  const hasPassedAnyApproval = (data.approvalChain && data.approvalChain.length > 0) || (data.currentStepIndex && data.currentStepIndex > 0);
  const skipDocs = (options && options.skipDocumentCheck) || hasPassedAnyApproval || (checkAll && DISABLE_DOC_CHECK_ON_APPROVAL);

  if (!skipDocs) {
    const uploadedDocTypes = (data.documents || []).map(d => d.docType);

    if (data.taxDetails?.pan?.trim()) {
      if (!uploadedDocTypes.includes('PAN_CARD')) {
        errors.push({ field: 'documents.PAN_CARD', message: 'PAN Card document upload is required when PAN number is provided' });
      }
    }

    if (data.taxDetails?.gstin?.trim()) {
      if (!uploadedDocTypes.includes('GST_CERTIFICATE')) {
        errors.push({ field: 'documents.GST_CERTIFICATE', message: 'GST Certificate document upload is required when GSTIN is provided' });
      }
    }

    if (data.taxDetails?.msmeNumber?.trim() || (data.taxDetails?.msmeStatus && data.taxDetails.msmeStatus !== 'NONE')) {
      if (!uploadedDocTypes.includes('MSME_CERTIFICATE')) {
        errors.push({ field: 'documents.MSME_CERTIFICATE', message: 'MSME Certificate document upload is required when MSME details are provided' });
      }
    }

    if (data.bankDetails && data.bankDetails.length > 0 && data.bankDetails.some(b => b.accountNumber?.trim())) {
      const hasBankDoc = uploadedDocTypes.includes('CANCELLED_CHEQUE') || uploadedDocTypes.includes('BANK_LETTER');
      if (!hasBankDoc) {
        errors.push({ field: 'documents.CANCELLED_CHEQUE', message: 'Cancelled Cheque or Bank Letter document upload is required when Bank details are provided' });
      }
    }
  }

  return errors;
};

module.exports = {
  validatePAN,
  validateGSTIN,
  validateIFSC,
  validateSWIFT,
  validateEmail,
  validatePhone,
  validatePostalCode,
  validateVendorSubmission,
};
