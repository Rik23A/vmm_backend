const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const OcrUsage = require('../models/OcrUsage');

// Default daily request limits per model
const MODEL_DAILY_LIMITS = {
  'gemini-3.5-flash-lite': 400,
  'gemma-4-31b-it': 5000,
};

function getModelDailyLimit(modelName) {
  if (MODEL_DAILY_LIMITS[modelName] !== undefined) {
    return MODEL_DAILY_LIMITS[modelName];
  }
  return 1000; // Default fallback for any other custom model
}

/**
 * Helper to convert local file to the inline data format Gemini accepts.
 */
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
      mimeType
    },
  };
}

/**
 * Executes content generation with specified model using Google GenAI SDK.
 */
async function callGenerativeModel(ai, modelName, prompt, docPart, responseSchema) {
  const response = await ai.models.generateContent({
    model: modelName,
    contents: [prompt, docPart],
    config: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
    }
  });

  const responseText = response.text;
  return JSON.parse(responseText);
}

/**
 * Validates a document (GST Certificate, PAN Card, Cancelled Cheque).
 * Handles daily request tracking per model, daily limit checks, and automatic fallback.
 */
async function validateDocument(filePath, docType, mimeType, vendorData, geminiConfig = {}, tenantId = 'system') {
  const apiKey = geminiConfig.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[OCR] Skipping validation: GEMINI_API_KEY is not defined.');
    return null;
  }

  const ai = new GoogleGenAI({ apiKey });

  const primaryModel = geminiConfig.primaryModel || geminiConfig.geminiModel || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const fallbackModel = geminiConfig.fallbackModel && geminiConfig.fallbackModel !== 'NONE' ? geminiConfig.fallbackModel : 'gemma-4-31b-it';

  const docPart = fileToGenerativePart(filePath, mimeType);

  let prompt = '';
  let responseSchema = {};

  if (docType === 'GST_CERTIFICATE') {
    prompt = `You are an expert document parser. Read this GST certificate and extract:
1. "gstin": The 15-character Goods and Services Tax Identification Number.
2. "legalName": The Legal Name of Business or Company Name as stated in the registration details.
Return the output strictly in the requested JSON structure.`;
    
    responseSchema = {
      type: "OBJECT",
      properties: {
        gstin: { type: "STRING", description: "15-char GSTIN number" },
        legalName: { type: "STRING", description: "Legal name of the business" }
      },
      required: ["gstin", "legalName"]
    };
  } else if (docType === 'PAN_CARD') {
    prompt = `You are an expert document parser. Read this PAN card photo and extract:
1. "pan": The 10-character Permanent Account Number.
Return the output strictly in the requested JSON structure.`;

    responseSchema = {
      type: "OBJECT",
      properties: {
        pan: { type: "STRING", description: "10-character PAN number" }
      },
      required: ["pan"]
    };
  } else if (docType === 'CANCELLED_CHEQUE') {
    prompt = `You are an expert document parser. Read this cancelled cheque or bank statement/passbook image and extract:
1. "ifsc": The 11-character Indian Financial System Code (IFSC), typically starts with 4 letters, followed by a '0', then 6 characters.
2. "accountNumber": The bank account number.
Return the output strictly in the requested JSON structure.`;

    responseSchema = {
      type: "OBJECT",
      properties: {
        ifsc: { type: "STRING", description: "11-character IFSC code" },
        accountNumber: { type: "STRING", description: "Bank Account Number" }
      },
      required: ["ifsc", "accountNumber"]
    };
  } else {
    // Other documents skip validation
    return null;
  }

  // Determine current UTC date string YYYY-MM-DD
  const dateStr = new Date().toISOString().split('T')[0];

  // Fetch current request counts for today
  const dailyCounts = await OcrUsage.getCounts(tenantId, dateStr);

  const primaryLimit = getModelDailyLimit(primaryModel);
  const primaryCount = dailyCounts[primaryModel] || 0;

  const fallbackLimit = getModelDailyLimit(fallbackModel);
  const fallbackCount = dailyCounts[fallbackModel] || 0;

  console.log(`\n📊 [OCR TRACKER] Date: ${dateStr} | Tenant: ${tenantId}`);
  console.log(`   Primary model '${primaryModel}': ${primaryCount}/${primaryLimit}`);
  console.log(`   Fallback model '${fallbackModel}': ${fallbackCount}/${fallbackLimit}`);

  let chosenModel = null;
  let fallbackReason = null;
  let extracted = null;
  let executionError = null;

  // STEP 1: Attempt Primary Model if within daily limit
  if (primaryCount < primaryLimit) {
    chosenModel = primaryModel;
    try {
      console.log(`🚀 [OCR] Processing ${docType} using Primary Model '${primaryModel}'...`);
      extracted = await callGenerativeModel(ai, primaryModel, prompt, docPart, responseSchema);
      await OcrUsage.incrementCount(tenantId, dateStr, primaryModel);
    } catch (err) {
      console.warn(`⚠️ [OCR WARNING] Primary model '${primaryModel}' failed: ${err.message}`);
      executionError = err.message;
      fallbackReason = `Primary model runtime error: ${err.message}`;
      chosenModel = null; // Mark as failed to trigger fallback
    }
  } else {
    console.warn(`⚠️ [OCR WARNING] Primary model '${primaryModel}' reached daily limit (${primaryCount}/${primaryLimit}).`);
    fallbackReason = `Primary model reached daily limit (${primaryCount}/${primaryLimit})`;
  }

  // STEP 2: Attempt Fallback Model if Primary failed or exceeded limit
  if (!extracted && fallbackModel && fallbackModel !== primaryModel) {
    if (fallbackCount < fallbackLimit) {
      chosenModel = fallbackModel;
      try {
        console.log(`🔄 [OCR FALLBACK] Switching to Fallback Model '${fallbackModel}' (Reason: ${fallbackReason})...`);
        extracted = await callGenerativeModel(ai, fallbackModel, prompt, docPart, responseSchema);
        await OcrUsage.incrementCount(tenantId, dateStr, fallbackModel);
      } catch (fbErr) {
        console.error(`❌ [OCR ERROR] Fallback model '${fallbackModel}' also failed: ${fbErr.message}`);
        executionError = `Primary model error (${executionError || 'Limit reached'}), Fallback model error (${fbErr.message})`;
      }
    } else {
      console.error(`❌ [OCR ERROR] Both primary and fallback models reached daily limits! Primary (${primaryCount}/${primaryLimit}), Fallback (${fallbackCount}/${fallbackLimit})`);
      executionError = `Daily request limits exceeded for all models (${primaryModel}: ${primaryCount}/${primaryLimit}, ${fallbackModel}: ${fallbackCount}/${fallbackLimit})`;
    }
  }

  if (!extracted) {
    return {
      extracted: null,
      mismatches: [],
      confidence: 'FAILED',
      ocrEngine: chosenModel || primaryModel,
      error: executionError || 'OCR processing failed',
      processedAt: new Date()
    };
  }

  console.log(`\n🤖 [GEMINI OCR RESPONSE] Successfully processed docType: ${docType}`);
  console.log(`   Selected Engine: ${chosenModel}`);
  console.log(`   Extracted JSON:`, JSON.stringify(extracted, null, 2));

  // Cross-validate extracted values with form data
  const mismatches = [];

  if (docType === 'GST_CERTIFICATE') {
    const formGstin = vendorData.taxDetails?.gstin || '';
    const formName = vendorData.generalData?.vendorName || '';

    if (extracted.gstin && extracted.gstin.trim().toUpperCase() !== formGstin.trim().toUpperCase()) {
      mismatches.push({
        field: 'taxDetails.gstin',
        expected: formGstin,
        found: extracted.gstin
      });
    }
    
    if (extracted.legalName && formName) {
      const cleanExtracted = extracted.legalName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const cleanForm = formName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (!cleanExtracted.startsWith(cleanForm) && !cleanExtracted.includes(cleanForm) && !cleanForm.includes(cleanExtracted)) {
        mismatches.push({
          field: 'generalData.vendorName',
          expected: formName,
          found: extracted.legalName
        });
      }
    }
  } else if (docType === 'PAN_CARD') {
    const formPan = vendorData.taxDetails?.pan || '';

    if (extracted.pan && extracted.pan.trim().toUpperCase() !== formPan.trim().toUpperCase()) {
      mismatches.push({
        field: 'taxDetails.pan',
        expected: formPan,
        found: extracted.pan
      });
    }
  } else if (docType === 'CANCELLED_CHEQUE') {
    const banks = vendorData.bankDetails || [];
    const primaryBank = banks.find(b => b.isPrimary) || banks[0] || {};
    
    const formIfsc = primaryBank.ifsc || '';
    const formAcc = primaryBank.accountNumber || '';

    if (extracted.ifsc && extracted.ifsc.trim().toUpperCase() !== formIfsc.trim().toUpperCase()) {
      mismatches.push({
        field: 'bankDetails.ifsc',
        expected: formIfsc,
        found: extracted.ifsc
      });
    }

    if (extracted.accountNumber && extracted.accountNumber.trim() !== formAcc.trim()) {
      mismatches.push({
        field: 'bankDetails.accountNumber',
        expected: formAcc,
        found: extracted.accountNumber
      });
    }
  }

  console.log(`   Validation Mismatches found: ${mismatches.length}`);
  if (mismatches.length > 0) {
    console.log(`   Mismatches details:`, JSON.stringify(mismatches, null, 2));
  }
  console.log(`---------------------------------------------------\n`);

  return {
    extracted,
    mismatches,
    confidence: mismatches.length === 0 ? 'HIGH' : 'MEDIUM',
    ocrEngine: chosenModel,
    isFallbackUsed: chosenModel !== primaryModel,
    fallbackReason: chosenModel !== primaryModel ? fallbackReason : null,
    processedAt: new Date()
  };
}

module.exports = {
  validateDocument,
  MODEL_DAILY_LIMITS,
};
