const {
  downloadFileAsBuffer,
  uploadFileFromBuffer,
  generateFileKey,
  extractKeysFromURL,
} = require("../storage");
const {
  Invoice,
  Document,
  Purchase,
  Vendor,
  PurchaseLineItem,
  Integration,
  EntityMapping,
  Customer,
  InvoiceLineItem,
} = require("../../db/models");
const { fromBuffer } = require("pdf2pic");
const AI = require("../openai");

const QuickBooks = require("../../channels/quickbooks/Class");
const { purchaseJsonSchema, invoiceJsonSchema } = require("../openai/schemas");
const quickbooksApiClient = require("../../channels/quickbooks/apiClient/quickbooksApiClient");

const aiService = new AI();

const validateInvoiceData = (invoiceData) => {
  const requiredFields = ["CustomerRef", "Line"];
  const errors = [];

  console.log("Validating invoice data:", JSON.stringify(invoiceData, null, 2));

  for (const field of requiredFields) {
    if (!invoiceData[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (invoiceData.Line && Array.isArray(invoiceData.Line)) {
    invoiceData.Line.forEach((line, index) => {
      if (line.DetailType === "SalesItemLineDetail") {
        // Log the line item for debugging
        console.log(
          `Validating line item ${index}:`,
          JSON.stringify(line, null, 2),
        );

        // More lenient validation
        const amount = line.Amount || 0;
        const qty = line.SalesItemLineDetail?.Qty || 1;
        const unitPrice = line.SalesItemLineDetail?.UnitPrice || amount;

        if (amount === undefined || amount === null) {
          errors.push(`Line item ${index}: Missing Amount`);
        }

        // Only validate calculation if both qty and unitPrice are present
        if (qty && unitPrice) {
          const calculatedAmount = qty * unitPrice;
          if (Math.abs(calculatedAmount - amount) > 0.01) {
            console.log(`Amount mismatch in line ${index}:`, {
              calculated: calculatedAmount,
              actual: amount,
              qty,
              unitPrice,
            });
            // Make this a warning rather than an error
            console.warn(`Warning: Amount mismatch in line item ${index}`);
          }
        }
      }
    });
  } else {
    errors.push("Missing or invalid Line items array");
  }

  if (errors.length > 0) {
    throw new Error(`Invoice validation failed: ${errors.join(", ")}`);
  }

  return true;
};

// Modified transformation logic
const transformInvoiceForQuickBooks = (processedJson) => {
  const lines = processedJson.Items.map((item) => {
    const quantity = item.Quantity || 1;
    const unitPrice = item.UnitPrice || item.TotalAmount || 0;
    const amount = item.TotalAmount || quantity * unitPrice;

    return {
      Description: item.Description || "",
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        TaxCodeRef: {
          value: "NON",
        },
        Qty: quantity,
        UnitPrice: unitPrice,
      },
      Amount: amount,
    };
  });

  return {
    Line: [
      ...lines,
      {
        DetailType: "DiscountLineDetail",
        Amount: processedJson.DiscountTotal || 0,
        DiscountLineDetail: {
          PercentBased: false,
        },
      },
    ],
    TxnTaxDetail: {
      TotalTax: 0,
    },
    CurrencyRef: {
      value: processedJson.Currency || "USD",
    },
    DocNumber: (processedJson.InvoiceNumber || "").slice(-20),
    BillAddr: processedJson.BillingAddress || {},
    ShipAddr: processedJson.ShippingAddress || {},
    SalesTermRef: {
      value: processedJson.PaymentTerms || "",
    },
    TxnDate: processedJson.Date,
    DueDate: processedJson.DueDate,
    CustomerMemo: {
      value: processedJson.Notes || "",
    },
  };
};

const processDocument = async (document) => {
  console.log(" - Processing document:", document.file_path);

  try {
    const documentData = await Document.findByPk(document.id);
    await documentData.update({ status: "Extraction" });

    let processedFiles = await processFile(document.file_path);
    await documentData.update({ processed_image_file_paths: processedFiles });

    let processed_data = await aiService.processDocument(
      processedFiles,
      invoiceJsonSchema,
    );

    console.log(
      "Processed JSON:",
      JSON.stringify(processed_data.processed_json, null, 2),
    );

    const invoice = await createInvoice(
      processed_data.processed_json,
      document,
    );

    // Transform the data for QuickBooks
    const transformedInvoiceData = transformInvoiceForQuickBooks(
      processed_data.processed_json,
    );

    // Add CustomerRef after transformation
    const entity = await EntityMapping.findOne({
      where: {
        CompanyId: document.CompanyId,
        entity_type: "Customer",
        local_id: invoice.CustomerId,
      },
    });

    if (!entity) {
      throw new Error("Customer mapping not found");
    }

    transformedInvoiceData.CustomerRef = {
      value: entity.external_id,
    };

    // Validate the transformed data
    try {
      validateInvoiceData(transformedInvoiceData);
    } catch (validationError) {
      console.error("Validation error:", validationError);
      await documentData.update({
        status: "ValidationError",
        error_message: validationError.message,
      });
      throw validationError;
    }

    const integration = await Integration.findOne({
      where: {
        CompanyId: document.CompanyId,
        status: "Connected", // Add this condition
      },
    });
    if (!integration) {
      throw new Error(
        "No active QuickBooks integration found. Please connect to QuickBooks first.",
      );
    }

    const quickbooksApi = new quickbooksApiClient(
      integration.credentials,
      integration.id,
    );

    try {
      const response = await quickbooksApi.invoices.create(
        transformedInvoiceData,
      );

      await documentData.update({
        processed_data: processed_data,
        status: "Processed",
      });

      await EntityMapping.create({
        CompanyId: document.CompanyId,
        IntegrationId: integration.id,
        entity_type: "Invoice",
        local_id: invoice.id,
        external_id: response.body.Invoice.Id,
        UserId: document.UserId,
      });
    } catch (error) {
      console.error("QuickBooks API Error:", {
        message: error.message,
        fault: error.fault,
        intuit_tid: error.intuit_tid,
      });

      if (error.fault && error.fault.type === "ValidationFault") {
        await documentData.update({
          status: "ValidationError",
          error_message: error.fault.Error[0].Detail,
        });
        throw new Error(
          `QuickBooks Validation Error: ${error.fault.Error[0].Detail}`,
        );
      }

      await documentData.update({
        status: "Error",
        error_message: error.message,
      });
      throw error;
    }
  } catch (error) {
    console.error("Error processing document:", error);
    throw error;
  }
};

// process receipt document
const processReceiptDocument = async (document) => {
  const documentData = await Document.findByPk(document.id);
  await documentData.update({ status: "Extraction" });

  console.log("extracting...");

  let processedFiles = await processFile(document.file_path);

  console.log("processed...");

  documentData.update({ processed_image_file_paths: processedFiles }); // extracted

  console.log(" - Processed files:", processedFiles);

  let processed_data = await aiService.processDocument(
    processedFiles,
    purchaseJsonSchema,
  );

  console.log(" - processReceiptDocument - Processed data:");

  const receipt = await createReceipt(processed_data.processed_json, document);

  const integration = await Integration.findOne({
    where: {
      CompanyId: document.CompanyId,
      status: "Connected", // Add this condition
    },
  });
  if (!integration) {
    throw new Error(
      "No active QuickBooks integration found. Please connect to QuickBooks first.",
    );
  }
  const quickbooksApi = new quickbooksApiClient(
    integration.credentials,
    integration.id,
  );

  const vendorEntity = await EntityMapping.findOne({
    where: {
      CompanyId: document.CompanyId,
      entity_type: "Vendor",
      local_id: receipt.VendorId,
    },
  });

  const transformedReceipt = new QuickBooks().receipt.transform(
    processed_data.processed_json,
    vendorEntity.external_id,
  );

  const isReadyReceipt = new QuickBooks().receipt.validate(transformedReceipt);

  if (isReadyReceipt) {
    documentData.update({ processed_data: processed_data, status: "Ready" }); // extracted

    const response = await quickbooksApi.expenses.create(transformedReceipt);

    await EntityMapping.create({
      CompanyId: document.CompanyId,
      IntegrationId: integration.id,
      entity_type: "Receipt",
      local_id: receipt.id,
      external_id: response.Purchase.Id,
      UserIdL: document.UserId,
    });
  } else {
    documentData.update({
      processed_data: processed_data,
      status: "MissingData",
    }); // extracted
  }
};

const createInvoice = async (invoiceJson, document) => {
  const { Invoice, Customer, InvoiceLineItem } = require("../../db/models");

  console.log(" - create invoice - Creating invoice:");

  const {
    InvoiceNumber,
    Date,
    DueDate,
    Currency,
    PaymentTerms,
    Subtotal,
    TotalAmount,
    VendorDetails,
    CustomerDetails,
    Items,
    Notes,
    DiscountTotal,
  } = invoiceJson;

  const [customer, created] = await Customer.findOrCreate({
    where: { name: CustomerDetails.CompanyName, CompanyId: document.CompanyId },
    defaults: {
      email: "",
      billing_address: CustomerDetails.BillingAddress,
      shipping_address: CustomerDetails.ShippingAddress,
      CompanyId: document.CompanyId,
      UserId: document.UserId,
    },
  });

  const integration = await Integration.findOne({
    where: {
      CompanyId: document.CompanyId,
      status: "Connected", // Add this condition
    },
  });
  if (!integration) {
    throw new Error(
      "No active QuickBooks integration found. Please connect to QuickBooks first.",
    );
  }
  const quickbooksApi = new quickbooksApiClient(
    integration.credentials,
    integration.id,
  );
  //QuickBook API credentails validation
  // try {
  //   await quickbooksApi.validateCredentials();
  // } catch (error) {
  //   console.error("Invalid Quickbook API credentials:", error);
  //   throw new Error("Invalid Quickbool API credentials");
  // }

  let entity = await EntityMapping.findOne({
    where: {
      entity_type: "Customer",
      local_id: customer.id,
    },
  });

  console.log("entity at createInvoice:", entity);

  if (!entity) {
    try {
      // Find the customer by name
      const existingCustomer = await quickbooksApi.customers.findByName(
        CustomerDetails.CompanyName,
      );

      if (existingCustomer) {
        // If the customer already exists, use its ID
        entity = await EntityMapping.create({
          entity_type: "Customer",
          external_id: existingCustomer.Id,
          local_id: customer.dataValues.id,
          CompanyId: document.CompanyId,
          IntegrationId: integration.id,
          UserId: document.UserId,
        });
      } else {
        // If the customer doesn't exist, create a new one
        const response = await quickbooksApi.customers.create({
          FullyQualifiedName: CustomerDetails?.CompanyName,
          PrimaryEmailAddr: {
            Address: "",
          },
          DisplayName: CustomerDetails?.CompanyName,
          PrimaryPhone: {
            FreeFormNumber: "",
          },
          CompanyName: "",
          BillAddr: {
            CountrySubDivisionCode: CustomerDetails?.BillingAddress?.State,
            City: CustomerDetails?.BillingAddress?.City,
            PostalCode: CustomerDetails?.BillingAddress?.ZipCode,
            Line1: CustomerDetails?.BillingAddress?.Line1,
            Country: "",
          },
          ShipAddr: {
            CountrySubDivisionCode: CustomerDetails?.ShippingAddress?.State,
            City: CustomerDetails?.ShippingAddress?.City,
            PostalCode: CustomerDetails?.ShippingAddress?.ZipCode,
            Line1: CustomerDetails?.ShippingAddress?.Line1,
            Country: "",
          },
          GivenName: "",
        });

        entity = await EntityMapping.create({
          entity_type: "Customer",
          external_id: response.body.Customer.Id,
          local_id: customer.dataValues.id,
          CompanyId: document.CompanyId,
          IntegrationId: integration.id,
          UserId: document.UserId,
        });
      }
    } catch (error) {
      console.error("Error creating or finding customer:", error);
      throw new Error("Failed to create or find customer in QuickBooks");
    }
  }
  console.log("entity - document:");

  const invoice = await Invoice.create({
    invoice_number: InvoiceNumber,
    date: Date,
    due_date: DueDate,
    currency: Currency,
    payment_terms: PaymentTerms,
    discount_total: DiscountTotal,
    subtotal: Subtotal,
    total_amount: TotalAmount,
    balance_due: TotalAmount,
    customer_details: JSON.stringify(CustomerDetails),
    vendor_details: JSON.stringify(VendorDetails),
    notes: Notes,
    created_by: "System",
    ship_address: CustomerDetails.ShippingAddress
      ? CustomerDetails.ShippingAddress
      : {},
    bill_address: CustomerDetails.BillingAddress
      ? CustomerDetails.BillingAddress
      : {},
    DocumentId: document.id,
    CompanyId: document.CompanyId,
    UserId: document.UserId,
  });

  console.log("invoice is created: invoice");
  invoice.CustomerId = customer.id;
  await invoice.save();

  for (const item of Items) {
    const amount = item.Quantity * item.UnitPrice;
    await InvoiceLineItem.create({
      InvoiceId: invoice.id,
      description: item.Description,
      quantity: item.Quantity,
      unit_price: item.UnitPrice,
      total_amount: amount,
    });
  }

  console.log(`Invoice ${InvoiceNumber} created successfully.`);

  return invoice;
};

async function createReceipt(receiptJson, document) {
  const {
    TransactionDate,
    TotalAmount,
    PaymentType,
    AccountRef,
    PurchaseLines,
    VendorDetails,
  } = receiptJson;

  console.log("receipt json : ", receiptJson);

  try {
    const [vendor] = await Vendor.findOrCreate({
      where: { name: VendorDetails.Name, CompanyId: document.CompanyId },
      defaults: {
        email: VendorDetails.Email,
        address: JSON.stringify(VendorDetails.Address),
        CompanyId: document.CompanyId,
        UserId: document.UserId,
      },
    });
    const integration = await Integration.findOne({
      where: {
        CompanyId: document.CompanyId,
        status: "Connected", // Add this condition
      },
    });
    if (!integration) {
      throw new Error(
        "No active QuickBooks integration found. Please connect to QuickBooks first.",
      );
    }
    const quickbooksApi = new quickbooksApiClient(
      integration.credentials,
      integration.id,
    );

    let entity = await EntityMapping.findOne({
      where: {
        // IntegrationId: integration.id,
        entity_type: "Vendor",
        local_id: vendor.id,
      },
    });

    if (!entity) {
      const response = await quickbooksApi.vendors.create({
        PrimaryEmailAddr: {
          Address: VendorDetails.Email,
        },
        PrimaryPhone: {
          FreeFormNumber: VendorDetails.PhoneNumber,
        },
        DisplayName: VendorDetails.Name,
        Mobile: {
          FreeFormNumber: VendorDetails.PhoneNumber,
        },
        CompanyName: VendorDetails.Name,
        BillAddr: {
          City: VendorDetails.Address.City,
          Line1: VendorDetails.Address.Line1,
          PostalCode: VendorDetails.Address.ZipCode,
          CountrySubDivisionCode: VendorDetails.Address.State,
        },
      });

      await EntityMapping.create({
        entity_type: "Vendor",
        external_id: response.body.Vendor.Id,
        local_id: vendor.dataValues.id,
        CompanyId: document.CompanyId,
        IntegrationId: integration.id,
        UserId: document.UserId,
      });
    }

    const receipt = await Purchase.create({
      txn_date: new Date(TransactionDate),
      total_amount: TotalAmount,
      payment_type: "Cash", // passing cash as default
      account_ref: 93,
      custom_fields: JSON.stringify(),
      DocumentId: document.id,
      CompanyId: document.CompanyId,
      UserId: document.UserId,
      VendorId: vendor.id,
    });

    receipt.VendorId = vendor.id;
    await receipt.save();

    for (const item of PurchaseLines) {
      await PurchaseLineItem.create({
        amount: item.Amount,
        // project_ref: item.ProjectRef,
        account_ref: 92,
        billable_status: "NotBillable", // passing NotBillable for now
        // tax_code_ref: item.TaxCodeRef,
        PurchaseId: receipt.id,
      });
    }

    console.log("Receipt created successfully:", receipt.id);

    return receipt;
  } catch (error) {
    console.error("Error creating receipt:", error.message);
    throw error;
  }
}

const processInvoice = async (invoice) => {
  try {
    const invoiceData = await Invoice.findByPk(invoice.id);

    console.log("Starting to process the file for invoice:", invoiceData.id);

    let processedFiles = await processFile(invoiceData.SourceURL);

    console.log("Processed files:", processedFiles);

    await invoiceData.update({ Status: "processed" });

    console.log("Invoice processed successfully");
    return invoiceData;
  } catch (error) {
    console.error("Error processing invoice:", error.message);
    throw error;
  }
};

const processFile = async (fileURL) => {
  console.log("Downloading file from URL:", fileURL);

  const fileKeys = extractKeysFromURL(fileURL); // bucketName, baseDir, fileName, fileExtension

  let file = await downloadFileAsBuffer(fileKeys);
  let processedFiles = [];

  const isPDF = fileKeys.fileExtension === "pdf";

  let processedFileKey =
    "processed" + "/" + fileKeys.fileName + fileKeys.fileExtension;

  if (isPDF) {
    console.log(" - Converting PDF to images");
    const base64Images = await convertPDFtoImages(file);
    let pageNumber = 1;
    for (const image of base64Images) {
      processedFileKey =
        "processed" + "/" + fileKeys.fileName + "_page_" + pageNumber + ".jpeg";
      const imageURL = await uploadFileFromBuffer(
        Buffer.from(image, "base64"),
        processedFileKey,
        "image/jpeg",
      );
      processedFiles.push(imageURL);
      pageNumber++;
    }
    console.log(" - Converted PDF to images");
  } else {
    const processedFileURL = await uploadFileFromBuffer(
      file,
      processedFileKey,
      "image/jpeg",
    );
    processedFiles.push(processedFileURL);
  }
  console.log("Processed files uploaded:", processedFiles);

  return processedFiles;
};

const convertPDFtoImages = async (file) => {
  let base64Images = [];

  const options = {
    quality: 100,
    density: 100,
    saveFilename: "untitled",
    savePath: "./images",
    format: "JPEG",
    height: 1600,
    preserveAspectRatio: true,
  };

  const convert = fromBuffer(file, options);
  const pagesToConvert = -1; // Convert all pages

  const conversionResults = await convert.bulk(pagesToConvert, {
    responseType: "base64",
  });
  base64Images = conversionResults.map((result) => result.base64);

  return base64Images;
};

module.exports = {
  processInvoice,
  processDocument,
  createInvoice,
  processFile,
  convertPDFtoImages,
  processReceiptDocument,
};
