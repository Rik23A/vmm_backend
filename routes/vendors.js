const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const VendorRequest = require('../models/VendorRequest');
const VendorInvitation = require('../models/VendorInvitation');
const AuditLog = require('../models/AuditLog');
const { requireLogin, requireRole } = require('../middleware/auth');
const { validateVendorSubmission } = require('../utils/validators');
const { checkDuplicate } = require('../utils/duplicateCheck');
const { sendEmail } = require('../utils/email');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const { injectTenant, getSapConfig } = require('../middleware/tenant');
const { fetchVendorsFromSAP, patchVendorInSAP, getVendorFromSAP, pushVendor } = require('../utils/sapBridge');
const { getIndiaTaxDetails, getBPAttachments, downloadBPAttachmentStream, uploadIndiaTaxAttachment } = require('../utils/sapIndiaTaxBridge');

// ── Multer: Secure external storage outside backend directory ─────────
const { secureUpload, getSafeAbsolutePath } = require('../config/storage');
const upload = secureUpload;

// ── GET /api/vendors/config ───────────────────────────────────────────
// Returns live dynamic settings from DB (bpGroupings, legalForms)
router.get('/config', requireLogin, injectTenant, async (req, res, next) => {
  try {
    const tenant = await Tenant.findOne({ tenantId: req.tenantId });
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    res.json({
      bpGroupings: tenant.sapConfig?.bpGroupings || [],
      legalForms: tenant.sapConfig?.legalForms || [],
    });
  } catch (err) { next(err); }
});

// ── GET /api/vendors ───────────────────────────────────────────────────
// REQUESTOR → own requests only
// Others → all requests in their tenant (excluding drafts of other users)
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const query = { tenantId: req.tenantId };

    const andConditions = [];

    if (req.user.role === 'REQUESTOR') {
      query.createdBy = req.user._id;
    } else {
      andConditions.push({
        $or: [
          { status: { $ne: 'DRAFT' } },
          { createdBy: req.user._id }
        ]
      });
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      query.plant = { $in: req.user.plants };
    }

    if (status) query.status = status;

    if (search) {
      andConditions.push({
        $or: [
          { 'generalData.vendorName': { $regex: search, $options: 'i' } },
          { tempVendorNumber: { $regex: search, $options: 'i' } },
          { sapVendorNumber: { $regex: search, $options: 'i' } },
        ]
      });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      VendorRequest.find(query)
        .select('tempVendorNumber sapVendorNumber generalData.vendorName requestType status createdByName submittedAt updatedAt currentLevel')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('createdBy', 'fullName email'),
      VendorRequest.countDocuments(query),
    ]);

    res.json({ requests, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/draft ────────────────────────────────────────────
// Save a draft — no validation required
router.post('/draft', requireLogin, requireRole('REQUESTOR', 'ADMIN'), async (req, res, next) => {
  try {
    // Guard: if this REQUESTOR is already mapped to an SAP vendor number,
    // they must use the Change Request flow — not create a new vendor.
    if (req.user.role === 'REQUESTOR' && req.user.sapVendorNumber) {
      return res.status(403).json({
        message: `Your account is already linked to SAP Vendor ${req.user.sapVendorNumber}. Please use the Change Request flow to update your details.`,
      });
    }

    const userPlant = req.user.plants && req.user.plants.length > 0 ? req.user.plants[0] : null;
    const targetPlant = req.body.plant !== undefined ? req.body.plant : userPlant;
    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (targetPlant && !req.user.plants.includes(targetPlant)) {
        return res.status(403).json({ message: 'You are not authorized to create requests for this plant.' });
      }
    }

    const vendor = await VendorRequest.create({
      ...req.body,
      tenantId: req.tenantId,
      plant: targetPlant,
      status: 'DRAFT',
      createdBy: req.user._id,
      createdByName: req.user.fullName,
    });
    await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id, action: 'DRAFT_SAVED',
      performedBy: req.user._id, performedByName: req.user.fullName, performedByRole: req.user.role });
    res.status(201).json({ message: 'Draft saved', vendor });
  } catch (err) { next(err); }
});


// ── PUT /api/vendors/:id/draft ─────────────────────────────────────────
// Update an existing draft or SENT_BACK request
router.put('/:id/draft', requireLogin, requireRole('REQUESTOR', 'L1_APPROVER', 'L2_APPROVER', 'ADMIN'), async (req, res, next) => {
  try {
    const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!vendor) return res.status(404).json({ message: 'Request not found' });
    
    // Check if the user is authorized to edit this request based on status and role
    let canEdit = false;
    
    if (['DRAFT', 'SENT_BACK'].includes(vendor.status)) {
      if (vendor.createdBy.toString() === req.user._id.toString() || req.user.role === 'ADMIN') {
        canEdit = true;
      }
    } else if (vendor.status === 'PENDING_L1' || (vendor.status === 'PENDING_APPROVAL' && vendor.currentLevel === 'L1_APPROVER')) {
      if (req.user.role === 'L1_APPROVER' || req.user.role === 'ADMIN') {
        canEdit = true;
      }
    } else if (vendor.status === 'PENDING_L2' || (vendor.status === 'PENDING_APPROVAL' && vendor.currentLevel === 'L2_APPROVER')) {
      if (req.user.role === 'L2_APPROVER' || req.user.role === 'ADMIN') {
        canEdit = true;
      }
    } else if (req.user.role === 'ADMIN') {
      canEdit = true;
    }

    if (!canEdit) {
      return res.status(403).json({ message: 'You are not authorized to edit this request in its current status.' });
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
        return res.status(403).json({ message: 'You are not authorized to update requests for this plant.' });
      }
      const targetPlant = req.body.plant;
      if (targetPlant && !req.user.plants.includes(targetPlant)) {
        return res.status(403).json({ message: 'You are not authorized to set this request to this plant.' });
      }
    }

    const allowedFields = ['generalData', 'companyCodeData', 'purchasingData', 'bankDetails', 'taxDetails', 'plant'];
    allowedFields.forEach(f => {
      if (req.body[f] !== undefined) {
        vendor.set(f, req.body[f]);
        vendor.markModified(f);
      }
    });
    await vendor.save();

    res.json({ message: 'Request updated', vendor });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/:id/submit ───────────────────────────────────────
// Submit for approval — runs all validations + duplicate check
router.post('/:id/submit', requireLogin, requireRole('REQUESTOR', 'ADMIN'), async (req, res, next) => {
  try {
    const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!vendor) return res.status(404).json({ message: 'Request not found' });
    if (!['DRAFT', 'SENT_BACK'].includes(vendor.status)) {
      return res.status(400).json({ message: `Cannot submit a request with status: ${vendor.status}` });
    }

    // ── Run field validations
    const validationErrors = validateVendorSubmission(vendor);
    if (validationErrors.length > 0) {
      return res.status(400).json({ message: 'Validation failed', errors: validationErrors });
    }

    // ── Run duplicate check
    const dupResult = await checkDuplicate(vendor, req.tenantId, vendor._id);
    vendor.duplicateCheck = {
      checked: true,
      isDuplicate: dupResult.isDuplicate,
      matchType: dupResult.matchType,
      matchedRequestId: dupResult.matchedRequest?._id || null,
      checkedAt: new Date(),
      sapMatches: dupResult.sapMatches || [],
    };

    if (dupResult.isDuplicate && dupResult.matchType === 'EXACT') {
      await vendor.save();
      return res.status(409).json({
        message: 'Duplicate vendor detected',
        duplicateInfo: {
          ...dupResult,
          matchedRequest: dupResult.matchedRequest ? {
            _id: dupResult.matchedRequest._id,
            tempVendorNumber: dupResult.matchedRequest.tempVendorNumber,
            sapVendorNumber: dupResult.matchedRequest.sapVendorNumber,
            vendorName: dupResult.matchedRequest.generalData?.vendorName,
            status: dupResult.matchedRequest.status
          } : null
        },
      });
    }

    // Make sure plant is set
    if (req.body.plant !== undefined) {
      vendor.plant = req.body.plant;
    }
    if (!vendor.plant) {
      const userPlant = req.user.plants && req.user.plants.length > 0 ? req.user.plants[0] : null;
      vendor.plant = userPlant;
    }

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
        return res.status(403).json({ message: 'You are not authorized to submit requests for this plant.' });
      }
    }

    // ── Move to PENDING_APPROVAL based on dynamic workflow steps
    const ApprovalSettings = require('../models/ApprovalSettings');
    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: vendor.plant });
    if (!settings) {
      settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
    }
    const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

    vendor.status = 'PENDING_APPROVAL';
    vendor.currentStepIndex = 0;
    vendor.currentLevel = steps[0].role;
    if (vendor.status === 'SENT_BACK') vendor.approvalChain = vendor.approvalChain || [];
    await vendor.save();

    await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id,
      tempVendorNumber: vendor.tempVendorNumber, action: 'SUBMITTED',
      performedBy: req.user._id, performedByName: req.user.fullName, performedByRole: req.user.role,
    });

    // ── Notify stage 1 approvers
    const notifyRole = steps[0].role;
    const queryNextUsers = { tenantId: req.tenantId, role: notifyRole, isActive: true };
    if (vendor.plant) {
      queryNextUsers.plants = vendor.plant;
    }
    const nextRoleUsers = await User.find(queryNextUsers).select('email');
    nextRoleUsers.forEach(u => sendEmail({ 
      to: u.email, 
      templateName: 'SUBMITTED', 
      templateData: { request: vendor }, 
      replyTo: req.user.email,
      tenantId: req.tenantId
    }));

    res.json({ message: 'Request submitted for approval', vendor });
  } catch (err) { next(err); }
});

// ── GET /api/vendors/sap-list ─────────────────────────────────────────────
// Fetches vendor list LIVE from SAP A_BusinessPartner (not from VMM DB).
// Accessible to L1_APPROVER, L2_APPROVER, MASTER_DATA and ADMIN.
router.get('/sap-list', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const sapConfig = getSapConfig(req.tenant);

      if (sapConfig.sapVersion === 'STUB') {
        // Return stub data so UI works in dev without a real SAP system
        return res.json({
          vendors: [
            { BusinessPartner: 'V100001', BusinessPartnerFullName: 'STUB Vendor Alpha Pvt Ltd', SearchTerm1: 'ALPHA' },
            { BusinessPartner: 'V100002', BusinessPartnerFullName: 'STUB Vendor Beta Corp',     SearchTerm1: 'BETA'  },
          ],
          total: 2,
          source: 'STUB',
        });
      }

      const { top = 50, skip = 0, search = '', vendorGroup = '', fromVendor = '', toVendor = '', companyCode = '' } = req.query;
      const result = await fetchVendorsFromSAP(sapConfig, {
        top:    parseInt(top),
        skip:   parseInt(skip),
        search: search.trim(),
        vendorGroup: vendorGroup.trim(),
        fromVendor: fromVendor.trim(),
        toVendor: toVendor.trim(),
        companyCode: companyCode.trim(),
      });

      res.json({ ...result, source: sapConfig.sapVersion });
    } catch (err) { next(err); }
  }
);

// Helper to map SAP BusinessPartner deep object to VMM VendorRequest schema structure
function mapSapToVmm(sapData) {
  const generalData = {};
  const companyCodeData = {};
  const purchasingData = {};
  const bankDetails = [];
  const taxDetails = {};
  const allTaxNumbers = [];
  const communicationData = {};
  const dunningData = {};

  if (sapData) {
    // ── General / Organisation ──────────────────────────────────────────────
    generalData.vendorName    = sapData.OrganizationBPName1 || sapData.BusinessPartnerFullName || '';
    generalData.vendorName2   = sapData.OrganizationBPName2 || '';
    generalData.searchTerm    = sapData.SearchTerm1         || '';
    generalData.searchTerm2   = sapData.SearchTerm2         || '';
    generalData.language      = sapData.Language            || 'EN';
    generalData.vendorType    = 'DOMESTIC';
    generalData.country       = 'IN';
    generalData.businessPartnerCategory = sapData.BusinessPartnerCategory || '';
    generalData.grouping      = sapData.BusinessPartnerGrouping           || '';
    generalData.createdOn     = sapData.CreationDate                      || '';
    generalData.industry      = sapData.Industry                          || '';  // A_BusinessPartnerType: Industry (raw code; A_BuPaIndustryType not expanded)
    generalData.legalForm     = sapData.LegalForm                         || '';  // A_BusinessPartnerType: LegalForm
    generalData.title         = sapData.FormOfAddress                     || '';  // A_BusinessPartnerType: FormOfAddress
    generalData.tradingName   = sapData.OrganizationBPName3               || '';

    // ── Address ─────────────────────────────────────────────────────────────
    const addrList = sapData.to_BusinessPartnerAddress?.results || (Array.isArray(sapData.to_BusinessPartnerAddress) ? sapData.to_BusinessPartnerAddress : (sapData.to_BusinessPartnerAddress ? [sapData.to_BusinessPartnerAddress] : []));
    const address = addrList[0];
    if (address) {
      generalData.tradeName    = address.CareOfName         || sapData.OrganizationBPName3 || '';
      generalData.street       = [address.StreetPrefixName, address.StreetName, address.StreetSuffixName].filter(Boolean).join(' ');
      generalData.houseNumber  = address.HouseNumber        || '';
      generalData.building     = address.Building           || '';
      generalData.floor        = address.Floor              || '';
      generalData.room         = address.RoomNumber         || '';
      generalData.district     = address.District || address.DistrictName || address.CityName2 || '';
      generalData.city         = address.CityName           || '';
      generalData.cityCode     = address.CityCode           || '';
      generalData.poBox        = address.POBox              || '';
      generalData.state        = address.Region             || '';
      generalData.postalCode   = address.PostalCode         || '';
      generalData.country      = address.Country            || 'IN';
      generalData.timeZone     = address.AddressTimeZone    || '';

      // Email addresses
      const emails = address.to_EmailAddress?.results || (Array.isArray(address.to_EmailAddress) ? address.to_EmailAddress : (address.to_EmailAddress ? [address.to_EmailAddress] : []));
      communicationData.emails = emails.map(e => ({ email: e.EmailAddress, isDefault: e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'true' }));
      generalData.email = (emails.find(e => e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'true') || emails[0])?.EmailAddress || '';

      // Phone numbers (Telephone)
      const phones = address.to_PhoneNumber?.results || (Array.isArray(address.to_PhoneNumber) ? address.to_PhoneNumber : (address.to_PhoneNumber ? [address.to_PhoneNumber] : []));
      communicationData.phones = phones.map(p => ({ phone: p.PhoneNumber, extension: p.PhoneNumberExtension, isMobile: p.PhoneNumberType === 'C', isDefault: p.IsDefaultPhoneNumber === true || p.IsDefaultPhoneNumber === 'true' }));
      generalData.phone = (phones.find(p => p.IsDefaultPhoneNumber === true || p.IsDefaultPhoneNumber === 'true') || phones[0])?.PhoneNumber || '';

      // Mobile phone numbers (separate nav property to_MobilePhoneNumber)
      const mobiles = address.to_MobilePhoneNumber?.results || (Array.isArray(address.to_MobilePhoneNumber) ? address.to_MobilePhoneNumber : (address.to_MobilePhoneNumber ? [address.to_MobilePhoneNumber] : []));
      generalData.mobile = (mobiles.find(p => p.IsDefaultPhoneNumber === true || p.IsDefaultPhoneNumber === 'true') || mobiles[0])?.PhoneNumber || '';

      // Fax
      const faxList = address.to_FaxNumber?.results || (Array.isArray(address.to_FaxNumber) ? address.to_FaxNumber : (address.to_FaxNumber ? [address.to_FaxNumber] : []));
      communicationData.faxNumbers = faxList.map(f => ({ fax: f.FaxNumber, isDefault: f.IsDefaultFaxNumber === true || f.IsDefaultFaxNumber === 'true' }));
      generalData.fax = (faxList[0])?.FaxNumber || '';

      // Website / URL
      const urlList = address.to_URLAddress?.results || (Array.isArray(address.to_URLAddress) ? address.to_URLAddress : (address.to_URLAddress ? [address.to_URLAddress] : []));
      communicationData.websites = urlList.map(u => ({ url: u.WebsiteURL, isDefault: u.IsDefaultURLAddress === true || u.IsDefaultURLAddress === 'true' }));
      generalData.website = (urlList[0])?.WebsiteURL || '';
    }

    // ── Tax Numbers ─────────────────────────────────────────────────────────
    const taxes = sapData.to_BusinessPartnerTax?.results || (Array.isArray(sapData.to_BusinessPartnerTax) ? sapData.to_BusinessPartnerTax : []);
    console.log(`🔍 [mapSapToVmm] Tax entries from SAP (${taxes.length}):`, taxes.map(t => ({ type: t.BPTaxType, num: t.BPTaxNumber })));

    // SAP S/4HANA India tax type codes:
    //   IN0  = TIN,  IN3 = GSTIN,  IN2 = TIN,  IN2 = CST
    // Also accept generic strings 'PAN' / 'GST' in case of ECC/custom config.
    const PAN_TYPES   = new Set(['IN0',  'PAN']);
    const GSTIN_TYPES = new Set(['IN3', 'GST', 'GSTIN']);
    const PAN_REGEX   = /^[A-Z]{5}[0-9]{4}[A-Z]$/i;
    const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[0-9A-Z]$/i;

    taxes.forEach(t => {
      const num  = (t.BPTaxNumber || '').trim();
      const type = (t.BPTaxType   || '').toUpperCase();
      if (!num) return;   // skip empty entries
      allTaxNumbers.push({ taxType: t.BPTaxType, taxNumber: num, taxCategory: t.TaxNumberCategory || '' });

      if (GSTIN_TYPES.has(type) || GSTIN_REGEX.test(num)) {
        taxDetails.gstin = num;
      } else if (PAN_TYPES.has(type) || PAN_REGEX.test(num)) {
        taxDetails.pan = num;
      } else if (type === 'IN1') {
        taxDetails.tin = num;
      } else if (type === 'IN2') {
        taxDetails.cst = num;
      }
    });

    // Extract PAN from GSTIN (chars 3–12) only if PAN was not explicitly found
    if (!taxDetails.pan && taxDetails.gstin?.length === 15) {
      taxDetails.pan = taxDetails.gstin.substring(2, 12);
    }
    taxDetails.allTaxNumbers = allTaxNumbers;

    // Helper to parse SAP date strings
    const parseSapDate = (sapDateStr) => {
      if (!sapDateStr) return null;
      if (typeof sapDateStr === 'string') {
        const match = sapDateStr.match(/\/Date\((\d+)\)\//);
        if (match) {
          return new Date(parseInt(match[1], 10));
        }
      }
      const parsed = new Date(sapDateStr);
      return isNaN(parsed.getTime()) ? null : parsed;
    };

    // ── BP Identifications (MSME01-MSME05) ──────────────────────────────────
    const idents = sapData.to_BPIdentification?.results || (Array.isArray(sapData.to_BPIdentification) ? sapData.to_BPIdentification : []);
    const msmeIdent = idents.find(id => ['MSME01', 'MSME02', 'MSME03', 'MSME04', 'MSME05'].includes(id.BPIdentificationType));
    if (msmeIdent) {
      taxDetails.msmeNumber = msmeIdent.BPIdentificationNumber || '';
      taxDetails.msmeRegDate = parseSapDate(msmeIdent.ValidityStartDate);
      taxDetails.msmeValTo = parseSapDate(msmeIdent.ValidityEndDate);
      taxDetails.msmeEntryDate = parseSapDate(msmeIdent.BPIdentificationEntryDate);
      taxDetails.msmeRegion = msmeIdent.Region || '';
      
      const revMap = {
        'MSME01': 'MICRO',
        'MSME02': 'SMALL',
        'MSME03': 'MEDIUM',
        'MSME04': 'NONE',
        'MSME05': 'CANCELLED'
      };
      taxDetails.msmeStatus = revMap[msmeIdent.BPIdentificationType] || 'NONE';
    }

    // ── Bank Accounts ───────────────────────────────────────────────────────
    const banks = sapData.to_BusinessPartnerBank?.results || (Array.isArray(sapData.to_BusinessPartnerBank) ? sapData.to_BusinessPartnerBank : []);
    banks.forEach((b, idx) => {
      bankDetails.push({
        bankCountry:   b.BankCountryKey          || 'IN',
        bankKey:       b.BankNumber              || '',
        ifsc:          b.ifsc || b.BankAccountReferenceText || (b.SWIFTCode && b.SWIFTCode.length === 11 ? b.SWIFTCode : '') || (b.BankNumber && b.BankNumber.length === 11 ? b.BankNumber : '') || b.SWIFTCode || '',
        bankName:      b.BankName               || '',
        accountNumber: b.BankAccount             || '',
        accountHolder: b.BankAccountHolderName   || b.AccountHolderName || '',
        controlKey:    b.BankControlKey          || 'EN',
        iban:          b.IBAN                    || '',
        swiftCode:     b.SWIFTCode               || '',
        validFrom:     b.ValidityStartDate       || '',
        isPrimary:     idx === 0,
        bankIdentification: b.BankIdentification || '',
      });
    });

    // ── Supplier / Company Code / Purchasing ─────────────────────────────────
    const supplier = sapData.to_Supplier;
    if (supplier) {
      generalData.sapSupplierNumber = supplier.Supplier || '';

      const ccList = supplier.to_SupplierCompany?.results || (Array.isArray(supplier.to_SupplierCompany) ? supplier.to_SupplierCompany : (supplier.to_SupplierCompany ? [supplier.to_SupplierCompany] : []));
      const ccObj = ccList[0];
      if (ccObj) {
        companyCodeData.companyCode           = ccObj.CompanyCode                     || '';
        companyCodeData.reconciliationAccount = ccObj.ReconciliationAccount           || '';
        companyCodeData.paymentTerms          = ccObj.PaymentTerms                    || '';
        companyCodeData.paymentMethod         = ccObj.PaymentMethodsList              || '';  // A_SupplierCompanyType: PaymentMethodsList
        companyCodeData.clerksName            = ccObj.AccountingClerk                 || '';
        companyCodeData.houseBank             = ccObj.HouseBank                       || '';
        companyCodeData.dmeDInd               = ccObj.PaymentBlockingReason           || '';
        companyCodeData.toleranceGroup        = ccObj.APARToleranceGroup              || '';  // A_SupplierCompanyType: APARToleranceGroup
        companyCodeData.sortKey               = ccObj.LayoutSortingRule               || '';  // A_SupplierCompanyType: LayoutSortingRule
        companyCodeData.checkDoubleInvoice    = ccObj.IsToBeCheckedForDuplicates === true || ccObj.IsToBeCheckedForDuplicates === 'X' ? 'Yes' : 'No';  // A_SupplierCompanyType: IsToBeCheckedForDuplicates
        companyCodeData.deletionFlag          = ccObj.DeletionIndicator === true || ccObj.DeletionIndicator === 'X' ? 'Yes' : 'No';  // A_SupplierCompanyType: DeletionIndicator

        if (ccObj.MinorityGroup) {
          taxDetails.msmeStatus = ccObj.MinorityGroup;
        }
        if (ccObj.SupplierCertificationDate) {
          taxDetails.msmeRegDate = parseSapDate(ccObj.SupplierCertificationDate);
        }

        // Withholding tax entries (to_SupplierWithHoldingTax)
        const wtResults = ccObj.to_SupplierWithHoldingTax?.results ||
          (Array.isArray(ccObj.to_SupplierWithHoldingTax) ? ccObj.to_SupplierWithHoldingTax : []);
        companyCodeData.withholdingTax = wtResults.map(w => ({
          taxType:          w.WithholdingTaxType          || '',
          taxCode:          w.WithholdingTaxCode          || '',  // "WTax Code" column
          subject:          w.IsWithholdingTaxSubject === true || w.IsWithholdingTaxSubject === 'X',
          recipientType:    w.RecipientType              || 'OT',
          exemptionNumber:  w.WithholdingTaxCertificate  || '',
          exemptionPercent: parseFloat(w.WithholdingTaxExmptPercent || 0),
          exemptFrom:       w.ExemptionDateBegin         || '',
          exemptTo:         w.ExemptionDateEnd           || '',
        }));

        // Dunning data
        const dunList = ccObj.to_SupplierDunning?.results || (Array.isArray(ccObj.to_SupplierDunning) ? ccObj.to_SupplierDunning : []);
        if (dunList[0]) {
          dunningData.dunningArea      = dunList[0].DunningArea      || '';
          dunningData.dunningBlock     = dunList[0].DunningBlock      || '';  // A_SupplierDunningType: DunningBlock
          dunningData.dunningLevel     = dunList[0].DunningLevel      || '';
          dunningData.dunningProcedure = dunList[0].DunningProcedure  || '';
        }
      }

      const poList = supplier.to_SupplierPurchasingOrg?.results || (Array.isArray(supplier.to_SupplierPurchasingOrg) ? supplier.to_SupplierPurchasingOrg : (supplier.to_SupplierPurchasingOrg ? [supplier.to_SupplierPurchasingOrg] : []));
      const poObj = poList[0];
      if (poObj) {
        purchasingData.purchasingOrg       = poObj.PurchasingOrganization          || '';
        purchasingData.orderCurrency       = poObj.PurchaseOrderCurrency            || 'INR';
        purchasingData.incoterms           = poObj.IncotermsClassification          || '';
        purchasingData.incotermsVersion    = poObj.IncotermsVersion                 || '';
        purchasingData.incotermsLocation   = poObj.IncotermsLocation1               || '';
        purchasingData.paymentTerms        = poObj.PaymentTerms                     || '';
        purchasingData.grBasedIV           = poObj.InvoiceIsGoodsReceiptBased === true || poObj.InvoiceIsGoodsReceiptBased === 'X';
        purchasingData.minOrderValue       = poObj.MinimumOrderAmount               || '';
        purchasingData.planningCycle       = poObj.PlanningCycle                    || '';
        purchasingData.purchasingGroup     = poObj.PurchasingGroup                  || '';
        purchasingData.confirmationControl = poObj.SupplierConfirmationControlKey   || '';  // A_SupplierPurchasingOrgType: SupplierConfirmationControlKey
        purchasingData.shippingConditions  = poObj.ShippingCondition                || '';
        purchasingData.abc                 = poObj.SupplierABCClassificationCode    || '';  // A_SupplierPurchasingOrgType: SupplierABCClassificationCode
        purchasingData.deletionFlag        = poObj.DeletionIndicator === true || poObj.DeletionIndicator === 'X' ? 'Yes' : 'No';  // A_SupplierPurchasingOrgType: DeletionIndicator
      }
    }

    // ── BP Roles ─────────────────────────────────────────────────────────────
    const roles = sapData.to_BusinessPartnerRole?.results || (Array.isArray(sapData.to_BusinessPartnerRole) ? sapData.to_BusinessPartnerRole : []);
    generalData.bpRoles = roles.map(r => r.BusinessPartnerRole);
  }

  return { generalData, companyCodeData, purchasingData, bankDetails, taxDetails, communicationData, dunningData };
}

// ── GET /api/vendors/sap/:sapVendorNumber ──────────────────────────────────
router.get('/sap/:sapVendorNumber', requireLogin, requireRole('REQUESTOR', 'L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const { sapVendorNumber } = req.params;

      // Security check: REQUESTOR can only fetch their own SAP Vendor Number
      if (req.user.role === 'REQUESTOR') {
        if (req.user.sapVendorNumber && req.user.sapVendorNumber !== sapVendorNumber) {
          return res.status(403).json({ message: 'Access denied. You can only view your own details.' });
        }
      }

      const sapConfig = getSapConfig(req.tenant);

      if (sapConfig.sapVersion === 'STUB') {
        const stubData = {
          generalData: {
            vendorName: sapVendorNumber === 'V100001' ? 'STUB Vendor Alpha Pvt Ltd' : 'STUB Vendor Beta Corp',
            searchTerm: sapVendorNumber === 'V100001' ? 'ALPHA' : 'BETA',
            vendorType: 'DOMESTIC',
            language: 'EN',
            email: sapVendorNumber === 'V100001' ? 'alpha@example.com' : 'beta@example.com',
            phone: '9876543210',
            street: '123 Main St',
            city: 'Mumbai',
            state: '13',
            postalCode: '400001',
            country: 'IN',
          },
          companyCodeData: {
            companyCode: '1000',
            reconciliationAccount: '160000',
            paymentTerms: '0001',
          },
          purchasingData: {
            purchasingOrg: '1000',
            orderCurrency: 'INR',
            incoterms: 'EXW',
            grBasedInvoice: true,
          },
          bankDetails: [
            {
              bankCountry: 'IN',
              bankKey: 'PNB',
              ifsc: 'PUNB0123400',
              accountNumber: sapVendorNumber === 'V100001' ? '1234567890' : '9876543210',
              accountHolder: sapVendorNumber === 'V100001' ? 'STUB Vendor Alpha Pvt Ltd' : 'STUB Vendor Beta Corp',
              bankName: 'PUNJAB NATIONAL BANK',
              isPrimary: true,
            }
          ],
          taxDetails: {
            pan: sapVendorNumber === 'V100001' ? 'ABCDE1234F' : 'XYZWP5678Q',
            gstin: sapVendorNumber === 'V100001' ? '27ABCDE1234F1Z5' : '27XYZWP5678Q1Z6',
            serviceRegNo: 'SRN999888',
            cstNo: 'CST112233',
            lstNo: 'LST445566',
            gstVenClass: ' ',
            msmeStatus: 'NONE',
            tanExemptions: [
              {
                companyCode: '1000',
                sectionCode: '194C',
                withholdingCode: 'AP',
                withholdingTaxType: 'AP',
                validFrom: new Date('2026-04-01'),
                validTo: new Date('2027-03-31'),
                exemptionNumber: 'CERT-2026-001',
                exemptionRate: 1.5,
                exemThreshold: 500000,
                currency: 'INR',
              }
            ]
          }
        };
        return res.json({ vendor: stubData });
      }

      const [sapDataResult, indiaTaxResult] = await Promise.allSettled([
        getVendorFromSAP(sapVendorNumber, sapConfig),
        getIndiaTaxDetails(sapConfig, sapVendorNumber)
      ]);

      const sapData = sapDataResult.status === 'fulfilled' ? sapDataResult.value : null;
      if (!sapData) return res.status(404).json({ message: 'Vendor not found in SAP' });

      const mapped = mapSapToVmm(sapData);

      if (indiaTaxResult.status === 'fulfilled' && indiaTaxResult.value) {
        const it = indiaTaxResult.value;
        mapped.taxDetails = mapped.taxDetails || {};
        if (it.PAN) mapped.taxDetails.pan = it.PAN;
        mapped.taxDetails.serviceRegNo = it.ServiceRegNo || mapped.taxDetails.serviceRegNo || '';
        mapped.taxDetails.cstNo = it.CSTNo || mapped.taxDetails.cstNo || '';
        mapped.taxDetails.lstNo = it.LSTNo || mapped.taxDetails.lstNo || '';
        mapped.taxDetails.gstVenClass = it.GstVenClass !== undefined && it.GstVenClass !== null ? String(it.GstVenClass) : (mapped.taxDetails.gstVenClass || ' ');
        
        const rawTans = it.ToTanExemption?.results || it.ToTanExemption || [];
        if (Array.isArray(rawTans) && rawTans.length > 0) {
          mapped.taxDetails.tanExemptions = rawTans.map(t => ({
            companyCode: t.CompanyCode || '',
            sectionCode: t.SectionCode || '',
            withholdingCode: t.WithholdingCode || '',
            withholdingTaxType: t.WithholdingTaxType || '',
            validFrom: t.ValidFrom ? (typeof t.ValidFrom === 'string' && t.ValidFrom.includes('/Date(') ? new Date(parseInt(t.ValidFrom.replace(/\/Date\((\d+)\)\//, '$1'))) : t.ValidFrom) : null,
            validTo: t.ValidTo ? (typeof t.ValidTo === 'string' && t.ValidTo.includes('/Date(') ? new Date(parseInt(t.ValidTo.replace(/\/Date\((\d+)\)\//, '$1'))) : t.ValidTo) : null,
            exemptionNumber: t.ExemptionNumber || '',
            exemptionRate: parseFloat(t.ExemptionRate) || 0,
            exemThreshold: parseFloat(t.ExemThreshold) || 0,
            currency: t.Currency || 'INR',
          }));
        }

        const rawAtts = it.ToAttachments?.results || it.ToAttachments || [];
        if (Array.isArray(rawAtts) && rawAtts.length > 0) {
          mapped.taxDetails.sapAttachments = rawAtts.map(a => ({
            attachmentId: a.AttachmentId || a.attachmentId,
            fileName: a.FileName || a.fileName,
            fileExt: a.FileExt || a.fileExt,
            mimeType: a.MimeType || a.mimeType,
            mediaSrc: a.mediaSrc,
          }));
        }
      }

      res.json({ vendor: mapped });
    } catch (err) { next(err); }
  }
);

// ── GET /api/vendors/sap/:sapVendorNumber/attachments ──────────────────────
// Returns live attachments directly from SAP ZBP_INDIA_SP_SRV/BPAttachmentSet
router.get('/sap/:sapVendorNumber/attachments', requireLogin, requireRole('REQUESTOR', 'VENDOR', 'L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const { sapVendorNumber } = req.params;

      // Input validation
      if (!/^[a-zA-Z0-9_-]+$/.test(sapVendorNumber)) {
        return res.status(400).json({ message: 'Invalid vendor identifier parameter.' });
      }

      // RBAC Ownership check for Requestor & Vendor
      if (req.user.role === 'REQUESTOR' || req.user.role === 'VENDOR') {
        if (req.user.sapVendorNumber && req.user.sapVendorNumber !== sapVendorNumber) {
          return res.status(403).json({ message: 'Access denied: You are not authorized to view attachments for this vendor.' });
        }
        if (!req.user.sapVendorNumber) {
          const isOwner = await VendorRequest.exists({
            tenantId: req.tenantId,
            sapVendorNumber,
            createdBy: req.user._id,
          });
          if (!isOwner) {
            return res.status(403).json({ message: 'Access denied: You are not authorized to view attachments for this vendor.' });
          }
        }
      } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.plants && req.user.plants.length > 0) {
        // Approver plant scope check if vendor exists locally
        const vendor = await VendorRequest.findOne({ tenantId: req.tenantId, sapVendorNumber }).select('plant');
        if (vendor && vendor.plant && !req.user.plants.includes(vendor.plant)) {
          return res.status(403).json({ message: 'Access denied: Vendor belongs to a plant outside your authorized scope.' });
        }
      }

      const sapConfig = getSapConfig(req.tenant);
      const attachments = await getBPAttachments(sapConfig, sapVendorNumber);
      res.json({ attachments });
    } catch (err) { next(err); }
  }
);

// ── GET /api/vendors/sap/attachments/:attachmentId/stream ──────────────────
// Proxies binary attachment stream directly from SAP BPAttachmentSet('<id>')/$value to browser
// Security Measures:
// 1. Validates JWT token from Bearer or ?token= query parameter.
// 2. Strict alphanumeric regex on attachmentId to block OData injection / path traversal.
// 3. Reverse Proxy: Keeps SAP host, port, and technical credentials completely hidden from client.
// 4. Sets strict anti-sniffing, sandboxing (CSP), and private cache headers.
router.get('/sap/attachments/:attachmentId/stream', requireLogin, injectTenant, async (req, res, next) => {
  try {
    const { attachmentId } = req.params;

    // 1. Strict Input Sanitization (Prevents OData injection / Path Traversal)
    if (!/^[a-zA-Z0-9_-]+$/.test(attachmentId)) {
      return res.status(400).json({ message: 'Invalid attachment identifier parameter.' });
    }

    // 2. Ownership & RBAC checks
    if (req.user.role === 'REQUESTOR' || req.user.role === 'VENDOR') {
      const isAuthorized = await VendorRequest.exists({
        tenantId: req.tenantId,
        $or: [
          { 'documents.sapAttachmentId': attachmentId, createdBy: req.user._id },
          { 'documents.sapAttachmentId': attachmentId, ...(req.user.sapVendorNumber ? { sapVendorNumber: req.user.sapVendorNumber } : {}) },
        ]
      });

      if (!isAuthorized && req.query.bpNumber) {
        const bpNumber = String(req.query.bpNumber).trim();
        const bpOwned = await VendorRequest.exists({
          tenantId: req.tenantId,
          sapVendorNumber: bpNumber,
          $or: [
            { createdBy: req.user._id },
            ...(req.user.sapVendorNumber ? [{ sapVendorNumber: req.user.sapVendorNumber }] : [])
          ]
        });
        if (!bpOwned) {
          return res.status(403).json({ message: 'Access denied: You are not authorized to view this attachment.' });
        }
      }
    } else if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN' && req.user.plants && req.user.plants.length > 0) {
      // Approver plant scope check
      const docRequest = await VendorRequest.findOne({
        tenantId: req.tenantId,
        'documents.sapAttachmentId': attachmentId,
      }).select('plant');

      if (docRequest && docRequest.plant && !req.user.plants.includes(docRequest.plant)) {
        return res.status(403).json({ message: 'Access denied: Attachment belongs to a vendor outside your authorized plant scope.' });
      }
    }

    const preferredFileName = req.query.fileName || req.query.fName || null;
    const sapConfig = getSapConfig(req.tenant);
    const streamRes = await downloadBPAttachmentStream(sapConfig, attachmentId, preferredFileName);

    // 3. Security Response Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.setHeader('Content-Type', streamRes.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', streamRes.contentDisposition || `inline; filename="${attachmentId}.pdf"`);
    res.send(streamRes.data);
  } catch (err) { next(err); }
});

// ── POST /api/vendors/sap/:sapVendorNumber/attachments ─────────────────────
// Uploads a document stream directly to SAP BPAttachmentSet with Slug: <BP>;<FileName>
router.post('/sap/:sapVendorNumber/attachments', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  injectTenant, upload.any(), async (req, res, next) => {
    try {
      const { sapVendorNumber } = req.params;
      const files = (req.files && req.files.length > 0) ? req.files : (req.file ? [req.file] : []);
      if (files.length === 0) return res.status(400).json({ message: 'No file uploaded' });

      const sapConfig = getSapConfig(req.tenant);
      const results = [];

      for (const f of files) {
        const result = await uploadIndiaTaxAttachment(sapConfig, sapVendorNumber, {
          filePath: f.path,
          fileName: f.originalname,
          mimeType: f.mimetype,
        });
        if (result) results.push(result);

        await AuditLog.log({
          tenantId: req.tenantId,
          sapVendorNumber,
          action: 'SAP_ATTACHMENT_UPLOADED',
          performedBy: req.user._id,
          performedByName: req.user.fullName,
          performedByRole: req.user.role,
          changes: [{ field: 'attachment', newValue: f.originalname, attachmentId: result?.attachmentId }],
        });
      }

      res.status(201).json({
        message: `${results.length} attachment(s) uploaded to SAP successfully`,
        attachment: results[0],
        attachments: results,
      });
    } catch (err) { next(err); }
  }
);

// ── POST /api/vendors/sap/:sapVendorNumber/modify ──────────────────────────
router.post('/sap/:sapVendorNumber/modify', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const { sapVendorNumber } = req.params;
      const sapConfig = getSapConfig(req.tenant);

      let mappedData;
      if (sapConfig.sapVersion === 'STUB') {
        mappedData = {
          generalData: {
            vendorName: sapVendorNumber === 'V100001' ? 'STUB Vendor Alpha Pvt Ltd' : 'STUB Vendor Beta Corp',
            searchTerm: sapVendorNumber === 'V100001' ? 'ALPHA' : 'BETA',
            vendorType: 'DOMESTIC',
            language: 'EN',
            email: sapVendorNumber === 'V100001' ? 'alpha@example.com' : 'beta@example.com',
            phone: '9876543210',
            street: '123 Main St',
            city: 'Mumbai',
            state: '13',
            postalCode: '400001',
            country: 'IN',
          },
          companyCodeData: {
            companyCode: '1000',
            reconciliationAccount: '160000',
            paymentTerms: '0001',
          },
          purchasingData: {
            purchasingOrg: '1000',
            orderCurrency: 'INR',
            incoterms: 'EXW',
            grBasedInvoice: true,
          },
          bankDetails: [
            {
              bankCountry: 'IN',
              bankKey: 'HDFC0001234',
              accountNumber: sapVendorNumber === 'V100001' ? '1234567890' : '9876543210',
              accountHolder: sapVendorNumber === 'V100001' ? 'STUB Vendor Alpha Pvt Ltd' : 'STUB Vendor Beta Corp',
              bankName: 'HDFC Bank',
              isPrimary: true,
            }
          ],
          taxDetails: {
            pan: sapVendorNumber === 'V100001' ? 'ABCDE1234F' : 'XYZWP5678Q',
            gstin: sapVendorNumber === 'V100001' ? '27ABCDE1234F1Z5' : '27XYZWP5678Q1Z6',
            msmeStatus: 'NONE',
          }
        };
      } else {
        const sapData = await getVendorFromSAP(sapVendorNumber, sapConfig);
        if (!sapData) return res.status(404).json({ message: 'Vendor not found in SAP' });
        mappedData = mapSapToVmm(sapData);
      }

      // Check if there is already an active (non-completed) MODIFY request in VMM DB for this vendor
      const existingRequest = await VendorRequest.findOne({
        tenantId: req.tenantId,
        sapVendorNumber: sapVendorNumber,
        status: { $in: ['DRAFT', 'PENDING_APPROVAL', 'PENDING_L1', 'PENDING_L2', 'PENDING_MDT', 'SAP_PENDING', 'SAP_FAILED'] }
      });
      if (existingRequest) {
        return res.status(400).json({
          message: `There is already an active change request in progress for SAP Vendor ${sapVendorNumber}.`,
          requestId: existingRequest._id
        });
      }

      const vendor = await VendorRequest.create({
        ...mappedData,
        tenantId: req.tenantId,
        requestType: 'MODIFY',
        sapVendorNumber: sapVendorNumber,
        status: 'DRAFT',
        createdBy: req.user._id,
        createdByName: req.user.fullName,
      });

      await AuditLog.log({
        tenantId: req.tenantId,
        requestId: vendor._id,
        action: 'MODIFY_INITIATED',
        performedBy: req.user._id,
        performedByName: req.user.fullName,
        performedByRole: req.user.role,
        comments: `Initiated modification for SAP vendor ${sapVendorNumber}`
      });

      res.status(201).json({ message: 'Modify request created', vendor });
    } catch (err) { next(err); }
  }
);

// ── GET /api/vendors/:id ───────────────────────────────────────────────
router.get('/:id', requireLogin, async (req, res, next) => {
  try {
    const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId })
      .populate('createdBy', 'fullName email role')
      .populate('approvalChain.performedBy', 'fullName email role')
      .populate('sapResult.pushedBy', 'fullName email role');
    if (!vendor) return res.status(404).json({ message: 'Request not found' });

    if (req.user.role !== 'ADMIN' && req.user.plants && req.user.plants.length > 0) {
      if (vendor.plant && !req.user.plants.includes(vendor.plant)) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Drafts can only be seen by their creator
    if (vendor.status === 'DRAFT' && vendor.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // REQUESTOR can only see their own
    if (req.user.role === 'REQUESTOR' && vendor.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const ApprovalSettings = require('../models/ApprovalSettings');
    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: vendor.plant });
    if (!settings) {
      settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: 'DEFAULT' });
    }
    const steps = settings?.steps?.length ? settings.steps : ApprovalSettings.getDefaultSteps();

    res.json({ vendor, steps });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/:id/upload ───────────────────────────────────────
router.post('/:id/upload', requireLogin, requireRole('REQUESTOR', 'ADMIN'), injectTenant,
  upload.single('document'), async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });
      if (!['DRAFT', 'SENT_BACK', 'PENDING_L1'].includes(vendor.status)) {
        return res.status(400).json({ message: 'Cannot upload documents in current status' });
      }
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
      if (!req.body.docType) return res.status(400).json({ message: 'docType is required' });

      const doc = {
        docType: req.body.docType,
        fileName: req.file.originalname,
        storedName: req.file.filename,
        filePath: `uploads/${req.tenantId}/${req.file.filename}`,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedBy: req.user._id,
      };

      // Perform OCR validation if Gemini config is present
      const { getGeminiConfig } = require('../middleware/tenant');
      const geminiConfig = getGeminiConfig(req.tenant);

      if ((geminiConfig.enableOcrValidation || process.env.GEMINI_API_KEY) && ['GST_CERTIFICATE', 'PAN_CARD', 'CANCELLED_CHEQUE'].includes(req.body.docType)) {
        try {
          const ocrService = require('../utils/ocrService');
          const fullPath = getSafeAbsolutePath(doc.filePath, req.tenantId);
          const ocrResult = await ocrService.validateDocument(fullPath, doc.docType, doc.mimeType, vendor, geminiConfig, req.tenantId);
          if (ocrResult) {
            doc.ocrResult = ocrResult;
          }
        } catch (ocrErr) {
          console.error('[OCR ROUTE ERROR] Failed processing doc:', ocrErr);
        }
      }

      vendor.documents.push(doc);
      await vendor.save();

      await AuditLog.log({ tenantId: req.tenantId, requestId: vendor._id, action: 'DOCUMENT_UPLOADED',
        performedBy: req.user._id, performedByName: req.user.fullName,
        changes: [{ field: 'docType', newValue: req.body.docType }, { field: 'fileName', newValue: req.file.originalname }],
      });

      const savedDoc = vendor.documents[vendor.documents.length - 1];
      res.json({ message: 'Document uploaded', document: savedDoc });
    } catch (err) { next(err); }
  });

// ── DELETE /api/vendors/:id/documents/:docId ───────────────────────────
router.delete('/:id/documents/:docId', requireLogin, requireRole('REQUESTOR', 'ADMIN'), async (req, res, next) => {
  try {
    const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!vendor) return res.status(404).json({ message: 'Request not found' });
    if (!['DRAFT', 'SENT_BACK'].includes(vendor.status)) {
      return res.status(400).json({ message: 'Cannot delete documents in current status' });
    }

    const docIdx = vendor.documents.findIndex(d => d._id.toString() === req.params.docId);
    if (docIdx === -1) return res.status(404).json({ message: 'Document not found' });

    const doc = vendor.documents[docIdx];
    // Delete from disk
    const filePath = getSafeAbsolutePath(doc.filePath, req.tenantId);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    vendor.documents.splice(docIdx, 1);
    await vendor.save();
    res.json({ message: 'Document deleted' });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/:id/documents/:docId/retry-sap-upload ────────────────
// Retries uploading a specific document to SAP BPAttachmentSet if it previously failed
router.post('/:id/documents/:docId/retry-sap-upload', requireLogin,
  requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'), injectTenant, async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });
      if (!vendor.sapVendorNumber) {
        return res.status(400).json({ message: 'Vendor does not have an SAP Vendor Number yet.' });
      }

      const doc = vendor.documents.id(req.params.docId) || vendor.documents.find(d => String(d._id) === req.params.docId);
      if (!doc) return res.status(404).json({ message: 'Document not found' });

      const sapConfig = getSapConfig(req.tenant);
      const attRes = await uploadIndiaTaxAttachment(sapConfig, vendor.sapVendorNumber, doc);

      if (attRes) {
        doc.sapAttachmentId = attRes.attachmentId || attRes.AttachmentId;
        doc.sapUploaded = true;
        doc.sapUploadStatus = 'UPLOADED';
        doc.sapUploadedAt = new Date();
        doc.sapUploadError = null;
        await vendor.save();

        await AuditLog.log({
          tenantId: req.tenantId,
          requestId: vendor._id,
          sapVendorNumber: vendor.sapVendorNumber,
          action: 'SAP_ATTACHMENT_RETRY_SUCCESS',
          performedBy: req.user._id,
          performedByName: req.user.fullName,
          changes: [{ field: 'attachment', newValue: doc.fileName, attachmentId: doc.sapAttachmentId }],
        });

        return res.json({ message: `'${doc.fileName}' uploaded to SAP successfully!`, document: doc });
      } else {
        doc.sapUploaded = false;
        doc.sapUploadStatus = 'FAILED';
        doc.sapUploadError = 'File missing from storage or empty file buffer';
        await vendor.save();
        return res.status(400).json({ message: doc.sapUploadError });
      }
    } catch (err) {
      try {
        const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
        const doc = vendor?.documents.id(req.params.docId) || vendor?.documents.find(d => String(d._id) === req.params.docId);
        if (doc) {
          doc.sapUploaded = false;
          doc.sapUploadStatus = 'FAILED';
          doc.sapUploadError = err.message || 'Retry failed';
          await vendor.save();
        }
      } catch (_) {}
      next(err);
    }
  }
);



// ── PATCH /api/vendors/:id/sap-patch ──────────────────────────────────────
// Pushes field-level updates for an already-SAP-pushed vendor.
// Used when a vendor's address / company / purchasing data is modified after SAP creation.
// Only MASTER_DATA and ADMIN can trigger this.
router.patch('/:id/sap-patch', requireLogin, requireRole('MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Request not found' });

      if (!vendor.sapVendorNumber) {
        return res.status(400).json({
          message: 'This vendor has not been pushed to SAP yet. No SAP number exists to patch.',
        });
      }

      const sapConfig = getSapConfig(req.tenant);
      const { addressId } = req.body; // optional: SAP AddressID for address PATCH

      const result = await patchVendorInSAP(
        vendor.sapVendorNumber,
        vendor.toObject(),
        addressId || null,
        sapConfig,
      );

      await AuditLog.log({
        tenantId:        req.tenantId,
        requestId:       vendor._id,
        tempVendorNumber: vendor.tempVendorNumber,
        sapVendorNumber:  vendor.sapVendorNumber,
        action:          'SAP_PATCH_SUCCESS',
        performedBy:     req.user._id,
        performedByName: req.user.fullName,
        performedByRole: req.user.role,
      });

      res.json({
        message: `Vendor ${vendor.sapVendorNumber} patched in SAP successfully`,
        sapVendorNumber: vendor.sapVendorNumber,
        result,
      });
    } catch (err) {
      await AuditLog.log({
        tenantId:        req.tenantId,
        requestId:       req.params.id,
        action:          'SAP_PATCH_FAILED',
        performedBy:     req.user._id,
        performedByName: req.user.fullName,
        comments:        err.message,
      }).catch(() => {});
      next(err);
    }
  }
);

// ── DELETE /api/vendors/:id ───────────────────────────────────────────
// Delete a draft request. Only the creator (or ADMIN) can delete it, and only if it's in DRAFT status.
router.delete('/:id', requireLogin, async (req, res, next) => {
  try {
    const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!vendor) return res.status(404).json({ message: 'Request not found' });

    if (vendor.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only drafts can be deleted' });
    }

    if (vendor.createdBy.toString() !== req.user._id.toString() && req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'You can only delete your own drafts' });
    }

    // Delete any uploaded files on disk for this request
    if (vendor.documents && vendor.documents.length > 0) {
      vendor.documents.forEach(doc => {
        const filePath = path.join(__dirname, '..', doc.filePath);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            console.error(`Failed to delete file: ${filePath}`, e);
          }
        }
      });
    }

    await VendorRequest.deleteOne({ _id: vendor._id });

    await AuditLog.log({
      tenantId: req.tenantId,
      requestId: vendor._id,
      action: 'DRAFT_DELETED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      performedByRole: req.user.role,
    });

    res.json({ message: 'Draft deleted successfully' });
  } catch (err) { next(err); }
});

// POST /api/vendors/sap/:sapVendorNumber/request-update
router.post('/sap/:sapVendorNumber/request-update', requireLogin, requireRole('L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'), async (req, res, next) => {
  try {
    const { sapVendorNumber } = req.params;
    const { comments = '' } = req.body;
    const Notification = require('../models/Notification');

    const targetUser = await User.findOne({ sapVendorNumber, tenantId: req.tenantId });
    if (!targetUser) {
      return res.status(404).json({ message: 'No registered user in this portal is mapped to this SAP Vendor Number. Please onboard this vendor user first.' });
    }

    // 1. Create in-app notification
    const msg = `An administrator has requested you to update your details. Comments: ${comments || 'Please verify and submit your latest details.'}`;
    await Notification.create({
      userId: targetUser._id,
      tenantId: req.tenantId,
      title: 'Details Update Requested',
      message: msg,
    });

    // 2. Send email notification
    await sendEmail({
      to: targetUser.email,
      templateName: 'UPDATE_REQUEST',
      templateData: {
        fullName: targetUser.fullName,
        comments: comments,
      },
      replyTo: req.user.email,
      tenantId: req.tenantId,
    });

    // 3. Log audit event
    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'MODIFY_INITIATED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      performedByRole: req.user.role,
      comments: `Requested updates for SAP Vendor ${sapVendorNumber}. Comments: ${comments}`,
    });

    res.json({ message: 'Update request sent to vendor successfully' });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/sap-invitation-tokens ─────────────────────────
// For SAP Module Pool to get tokens to send via SCOT
router.post('/sap-invitation-tokens', requireLogin, injectTenant, async (req, res, next) => {
  try {
    const { vendors } = req.body;
    if (!Array.isArray(vendors) || vendors.length === 0) {
      return res.status(400).json({ message: 'Vendors array is required' });
    }

    const tokens = [];
    for (const v of vendors) {
      let invite = await VendorInvitation.findOne({
        tenantId: req.tenantId,
        sapVendorNumber: v.sapVendorNumber,
        status: 'PENDING',
        expiresAt: { $gt: new Date() }
      });

      let token;
      if (invite) {
        token = invite.token;
      } else {
        token = uuidv4();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        invite = await VendorInvitation.create({
          tenantId: req.tenantId,
          sapVendorNumber: v.sapVendorNumber,
          email: v.email,
          vendorName: v.name || v.vendorName,
          tradeName: v.tradeName || v.careOfName || '',
          vendorGroup: v.vendorGroup || 'UNKNOWN',
          companyCode: v.companyCode || '',
          token,
          expiresAt,
        });
      }

      tokens.push({ sapVendorNumber: v.sapVendorNumber, token, url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/vendor-register?token=${token}` });
    }

    res.json({ message: 'Tokens generated successfully', tokens });
  } catch (err) { next(err); }
});

// ── POST /api/vendors/bulk-invite ────────────────────────────────────
// For VMM App to fetch vendors by group and send bulk emails
router.post('/bulk-invite', requireLogin, requireRole('ADMIN', 'MASTER_DATA'), injectTenant, async (req, res, next) => {
  try {
    const { vendorGroup, fromVendor, toVendor, vendors: requestVendors, companyCode } = req.body;

    let targetVendors = [];
    const sapConfig = await getSapConfig(req.tenantId);

    if (Array.isArray(requestVendors) && requestVendors.length > 0) {
      targetVendors = requestVendors.map(v => ({
        BusinessPartner: v.sapVendorNumber || v.BusinessPartner,
        BusinessPartnerFullName: v.vendorName || v.BusinessPartnerFullName || v.name,
        email: v.email || v.EmailAddress,
        vendorGroup: v.vendorGroup || vendorGroup || 'UNKNOWN',
        companyCode: v.companyCode || companyCode || ''
      }));
    } else {
      if (!vendorGroup) {
        return res.status(400).json({ message: 'Vendor Group is required' });
      }
      // Fetch active vendors from SAP for the group & optional range & company code
      const { vendors } = await fetchVendorsFromSAP(sapConfig, { 
        top: 5000,
        vendorGroup,
        fromVendor: fromVendor ? fromVendor.trim() : '',
        toVendor: toVendor ? toVendor.trim() : '',
        companyCode: companyCode ? companyCode.trim() : ''
      });
      targetVendors = vendors;
    }

    if (targetVendors.length === 0) {
      return res.status(404).json({ message: 'No vendors found to invite.' });
    }

    let sentCount = 0;
    for (const v of targetVendors) {
      // In real scenario, we need the vendor's email. If fetchVendorsFromSAP doesn't return email,
      // we might need to getVendorFromSAP individually, but that's slow.
      // We will assume `fetchVendorsFromSAP` or a custom query returns an email. 
      // If not, we skip or fetch it. Let's fetch details if email is missing.
      let email = v.EmailAddress || v.email;
      let sapVendorNumber = v.BusinessPartner;
      let vendorName = v.BusinessPartnerFullName;
      
      if (!email) {
        try {
          const details = await getVendorFromSAP(sapVendorNumber, sapConfig);
          if (details) {
            // Find email from Address
            const addrList = details.to_BusinessPartnerAddress?.results || [];
            if (addrList.length > 0 && addrList[0].to_EmailAddress?.results?.length > 0) {
              email = addrList[0].to_EmailAddress.results[0].EmailAddress;
            }
          }
        } catch (err) {
          console.warn(`Could not fetch details for BP ${sapVendorNumber}`);
        }
      }

      if (email) {
        let invite = await VendorInvitation.findOne({
          tenantId: req.tenantId,
          sapVendorNumber,
          status: 'PENDING',
          expiresAt: { $gt: new Date() }
        });

        let token;
        if (invite) {
          token = invite.token;
        } else {
          token = uuidv4();
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 7);

          invite = await VendorInvitation.create({
            tenantId: req.tenantId,
            sapVendorNumber,
            email,
            vendorName,
            tradeName: v.tradeName || v.careOfName || '',
            vendorGroup,
            companyCode: v.companyCode || companyCode || '',
            token,
            expiresAt,
          });
        }

        await sendEmail({
          to: email,
          templateName: 'VENDOR_INVITATION',
          templateData: {
            vendorName,
            sapVendorNumber,
            email,
            token,
            tenantId: req.tenantId,
          },
          replyTo: req.user.email,
          tenantId: req.tenantId,
        });
        sentCount++;
      }
    }

    res.json({ message: `Bulk invitation completed. Emails sent: ${sentCount}`, sentCount });
  } catch (err) { next(err); }
});

// ── PATCH /api/vendors/:id/fix-and-resume-sap ─────────────────────────
// Updates specific failed fields (taxDetails, companyCodeData, purchasingData)
// and resumes the SAP push from the failed step.
router.patch('/:id/fix-and-resume-sap', requireLogin, requireRole('MASTER_DATA', 'ADMIN'),
  injectTenant, async (req, res, next) => {
    try {
      const vendor = await VendorRequest.findOne({ _id: req.params.id, tenantId: req.tenantId });
      if (!vendor) return res.status(404).json({ message: 'Vendor request not found' });

      const { taxDetails, companyCodeData, purchasingData, generalData, triggerSync = true } = req.body;

      if (taxDetails) {
        vendor.taxDetails = { ...vendor.taxDetails?.toObject?.() || vendor.taxDetails, ...taxDetails };
      }
      if (companyCodeData) {
        vendor.companyCodeData = { ...vendor.companyCodeData?.toObject?.() || vendor.companyCodeData, ...companyCodeData };
      }
      if (purchasingData) {
        vendor.purchasingData = { ...vendor.purchasingData?.toObject?.() || vendor.purchasingData, ...purchasingData };
      }
      if (generalData) {
        vendor.generalData = { ...vendor.generalData?.toObject?.() || vendor.generalData, ...generalData };
      }

      await vendor.save();

      if (!triggerSync) {
        return res.json({ message: 'Vendor fields updated', vendor });
      }

      const sapConfig = getSapConfig(req.tenant);
      const existingBpNumber = vendor.sapVendorNumber || vendor.sapResult?.partialVendorNumber || null;

      const skipSteps = [];
      if (vendor.sapStepProgress) {
        if (vendor.sapStepProgress.step1_bp?.status === 'COMPLETED' && existingBpNumber) skipSteps.push('step1_bp');
        if (vendor.sapStepProgress.step2_roles_cvi?.status === 'COMPLETED') skipSteps.push('step2_roles_cvi');
        if (vendor.sapStepProgress.step3_companyCode?.status === 'COMPLETED') skipSteps.push('step3_companyCode');
        if (vendor.sapStepProgress.step4_purchasingOrg?.status === 'COMPLETED') skipSteps.push('step4_purchasingOrg');
        if (vendor.sapStepProgress.step5_indiaTax?.status === 'COMPLETED') skipSteps.push('step5_indiaTax');
        if (vendor.sapStepProgress.step6_attachments?.status === 'COMPLETED') skipSteps.push('step6_attachments');
      }

      const onStepProgress = async (stepKey, stepStatus, data = {}) => {
        try {
          const update = {
            [`sapStepProgress.${stepKey}.status`]: stepStatus,
            [`sapStepProgress.${stepKey}.completedAt`]: stepStatus === 'COMPLETED' ? new Date() : null,
            [`sapStepProgress.${stepKey}.error`]: data.error || null,
          };
          if (data.bpNumber) {
            update['sapStepProgress.step1_bp.bpNumber'] = data.bpNumber;
            update['sapResult.partialVendorNumber'] = data.bpNumber;
            update['sapVendorNumber'] = data.bpNumber;
          }
          if (data.supplierNumber) {
            update['sapStepProgress.step2_roles_cvi.supplierNumber'] = data.supplierNumber;
          }
          await VendorRequest.findByIdAndUpdate(vendor._id, { $set: update });
        } catch (err) {
          console.warn(`[fix-and-resume onStepProgress] DB update error for ${stepKey}:`, err.message);
        }
      };

      try {
        const result = await pushVendor(vendor.toObject(), sapConfig, {
          existingBpNumber,
          skipSteps,
          onStepProgress,
        });

        vendor.sapVendorNumber = result.vendorNumber;
        if (Array.isArray(result.documents) && result.documents.length > 0) {
          vendor.documents = result.documents;
        }
        vendor.status = 'SAP_PUSHED';
        vendor.currentLevel = 'DONE';
        vendor.sapResult = {
          vendorNumber: result.vendorNumber,
          partialVendorNumber: result.vendorNumber,
          pushedAt: new Date(),
          pushedBy: req.user._id,
          sapVersion: sapConfig.sapVersion,
          requestPayload: result.payload,
          responsePayload: result.response,
          errorMessage: null,
          failedStep: null,
          retryCount: (vendor.sapResult?.retryCount || 0) + 1,
        };
        await vendor.save();

        await AuditLog.log({
          tenantId: req.tenantId,
          requestId: vendor._id,
          tempVendorNumber: vendor.tempVendorNumber,
          sapVendorNumber: result.vendorNumber,
          action: 'SAP_PUSH_SUCCESS',
          performedBy: req.user._id,
          performedByName: req.user.fullName,
          comments: 'Resumed and completed SAP sync after parameter correction',
          sapPayload: result.payload,
          sapResponse: result.response,
        });

        // ── Notify requestor, L1 creator approver, and MDT team
        const queryMdtUsers = { tenantId: req.tenantId, role: 'MASTER_DATA', isActive: true };
        if (vendor.plant) queryMdtUsers.plants = vendor.plant;
        const mdtUsers = await User.find(queryMdtUsers).select('email');
        const requestor = vendor.createdBy ? await User.findById(vendor.createdBy) : null;

        const recipientEmails = new Set();
        mdtUsers.forEach(u => { if (u.email) recipientEmails.add(u.email); });
        if (requestor && requestor.email) {
          recipientEmails.add(requestor.email);
          if (requestor.createdBy) {
            const creatorUser = await User.findById(requestor.createdBy);
            if (creatorUser && creatorUser.email && (creatorUser.role === 'L1_APPROVER' || creatorUser.role === 'ADMIN')) {
              recipientEmails.add(creatorUser.email);
            }
          }
        }
        if (vendor.approvalChain && vendor.approvalChain.length > 0) {
          for (const entry of vendor.approvalChain) {
            if (entry.performedBy) {
              const approverUser = await User.findById(entry.performedBy);
              if (approverUser && approverUser.email && approverUser.role === 'L1_APPROVER') {
                recipientEmails.add(approverUser.email);
              }
            }
          }
        }

        recipientEmails.forEach(email =>
          sendEmail({ to: email, templateName: 'SAP_PUSHED', templateData: { request: vendor }, replyTo: req.user.email })
        );

        return res.json({
          message: 'Vendor sync resumed and completed successfully in SAP',
          sapVendorNumber: result.vendorNumber,
          vendor,
        });

      } catch (sapError) {
        vendor.status = 'SAP_FAILED';
        vendor.sapResult.errorMessage = sapError.message;
        vendor.sapResult.failedStep = sapError.failedStep || null;
        vendor.sapResult.retryCount = (vendor.sapResult?.retryCount || 0) + 1;

        if (sapError.failedStep && vendor.sapStepProgress && vendor.sapStepProgress[sapError.failedStep]) {
          vendor.sapStepProgress[sapError.failedStep].status = 'FAILED';
          vendor.sapStepProgress[sapError.failedStep].error = sapError.message;
        }
        await vendor.save();

        return res.status(502).json({
          message: 'SAP push resume failed',
          error: sapError.message,
          failedStep: sapError.failedStep || null,
          partialVendorNumber: vendor.sapVendorNumber || vendor.sapResult?.partialVendorNumber,
          sapStepProgress: vendor.sapStepProgress,
          vendor,
        });
      }

    } catch (err) { next(err); }
  }
);

module.exports = router;
