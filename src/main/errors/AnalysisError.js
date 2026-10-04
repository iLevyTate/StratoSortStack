// @ts-check
/**
 * Structured Error System for AI-First Document Analysis
 * Provides operational error handling with actionable user guidance
 */

class AnalysisError extends Error {
  /**
   * @param {string} code
   * @param {Record<string, any> & { cause?: unknown }} [metadata]
   */
  constructor(code, metadata = {}) {
    // Extract cause from metadata if provided (for error cause chaining)
    const { cause, ...restMetadata } = metadata;

    // Call super with cause option for proper error chain (ES2022+)
    super(undefined, cause ? { cause } : undefined);

    this.name = 'AnalysisError';
    this.code = code;
    /** @type {Record<string, any>} */
    this.metadata = restMetadata;
    this.isOperational = true;
    this.timestamp = new Date().toISOString();

    // Store cause reference for environments that don't support Error cause option
    if (cause && !this.cause) {
      this.cause = cause;
    }

    // Set error message based on code
    this.message = this.generateMessage();
  }

  generateMessage() {
    /** @type {Record<string, string>} */
    const messages = {
      PDF_PROCESSING_FAILURE: 'Failed to extract text from PDF document',
      IMAGE_ANALYSIS_FAILURE: 'Failed to analyze image content',
      MODEL_NOT_INSTALLED: `AI model not found: ${this.metadata.requiredModel}`,
      AI_ENGINE_CONNECTION_FAILURE: 'AI engine unavailable or failed to initialize',
      DOCUMENT_ANALYSIS_FAILURE: 'Document analysis failed',
      PDF_NO_TEXT_CONTENT: 'PDF contains no extractable text',
      MODEL_VERIFICATION_FAILED: 'Failed to verify AI model availability',
      DEPENDENCY_MISSING: `Required dependency missing: ${this.metadata.dependency}`,
      FILE_TYPE_UNSUPPORTED: `Unsupported file type: ${this.metadata.fileType}`,
      FILE_TOO_LARGE: 'File size exceeds processing limits',
      FILE_EMPTY: 'File is empty or contains no readable text',
      FILE_READ_ERROR: 'Failed to read file from disk',
      PDF_ENCRYPTED: 'PDF is password-protected or encrypted',
      DOC_ENCRYPTED: 'Word document is password-protected or encrypted',
      DOC_EXTRACTION_FAILURE: 'Failed to extract text from Word document',
      LEGACY_FORMAT_UNSUPPORTED: `No reader for ${this.metadata.fileType || 'this legacy format'} in this build`,
      XLSX_EXTRACTION_FAILURE: 'Failed to extract text from spreadsheet',
      PPTX_EXTRACTION_FAILURE: 'Failed to extract text from presentation',
      ODF_EXTRACTION_FAILURE: 'Failed to extract text from OpenDocument file'
    };

    return messages[this.code] || 'Unknown analysis error';
  }

  getUserFriendlyMessage() {
    /** @type {Record<string, string>} */
    const userMessages = {
      PDF_PROCESSING_FAILURE:
        "This PDF file couldn't be processed. It may be corrupted or password-protected.",
      IMAGE_ANALYSIS_FAILURE:
        "This image couldn't be analyzed. Please check the file format and try again.",
      MODEL_NOT_INSTALLED: `Missing AI model: ${this.metadata.requiredModel}. Please install it to continue.`,
      AI_ENGINE_CONNECTION_FAILURE: 'AI engine unavailable. Check Settings > Models and try again.',
      DOCUMENT_ANALYSIS_FAILURE: 'Failed to analyze this document. Please check the file format.',
      PDF_NO_TEXT_CONTENT: 'This PDF appears to be image-based. Try using image analysis instead.',
      MODEL_VERIFICATION_FAILED: 'AI model verification failed. Please check your model downloads.',
      DEPENDENCY_MISSING: `System component missing: ${this.metadata.dependency}. Please reinstall the application.`,
      FILE_TYPE_UNSUPPORTED: `File type "${this.metadata.fileType}" is not supported for AI analysis.`,
      FILE_TOO_LARGE: 'File is too large for processing. Please use a smaller file.',
      FILE_EMPTY: 'This file is empty, so there was nothing to analyze.',
      FILE_READ_ERROR:
        "This file couldn't be read. It may be locked, moved, or you may not have permission to access it.",
      PDF_ENCRYPTED: 'This PDF is password-protected. Remove the password and try again.',
      DOC_ENCRYPTED: 'This Word document is password-protected. Remove the password and try again.',
      DOC_EXTRACTION_FAILURE:
        "This Word document couldn't be read. It may be corrupted or in an unsupported format.",
      LEGACY_FORMAT_UNSUPPORTED:
        `StratoSort cannot read the contents of ${this.metadata.fileType || 'this legacy format'} files; it organizes them by name and date. ${this.metadata.suggestion || ''}`.trim(),
      XLSX_EXTRACTION_FAILURE:
        "This spreadsheet couldn't be read. It may be corrupted or in an unsupported format.",
      PPTX_EXTRACTION_FAILURE:
        "This presentation couldn't be read. It may be corrupted or in an unsupported format.",
      ODF_EXTRACTION_FAILURE:
        "This OpenDocument file couldn't be read. It may be corrupted or in an unsupported format."
    };

    return userMessages[this.code] || 'An unexpected error occurred during analysis.';
  }

  getActionableSteps() {
    /** @type {Record<string, string[]>} */
    const actions = {
      MODEL_NOT_INSTALLED: ['Open Settings > Models and download the missing model'],
      AI_ENGINE_CONNECTION_FAILURE: ['Check Settings > Models', 'Restart the app'],
      DEPENDENCY_MISSING: [
        `Check that ${this.metadata.dependency} is installed correctly`,
        'Restart the application',
        'Reinstall the application if the issue persists'
      ],
      PDF_NO_TEXT_CONTENT: ['Try image analysis instead', 'Convert PDF to text format'],
      FILE_TYPE_UNSUPPORTED: [
        'Convert file to supported format',
        'Check supported file types in documentation'
      ],
      FILE_TOO_LARGE: ['Use smaller files', 'Increase file size limit in settings'],
      FILE_READ_ERROR: [
        'Check that the file still exists and is not open in another program',
        'Verify you have permission to read the file'
      ],
      PDF_ENCRYPTED: [
        'Remove the password protection from the PDF',
        'Try a decrypted copy of the file'
      ],
      DOC_ENCRYPTED: [
        'Remove the password protection from the document in Word',
        'Try an unprotected copy of the file'
      ]
    };

    return actions[this.code] || [];
  }
}

class ModelMissingError extends AnalysisError {
  /** @param {string} modelName */
  constructor(modelName) {
    super('MODEL_NOT_INSTALLED', {
      requiredModel: modelName,
      installCommand: `Download model in Settings > Models: ${modelName}`,
      category: 'model'
    });
  }
}

class DependencyMissingError extends AnalysisError {
  /** @param {string} dependencyName */
  constructor(dependencyName) {
    super('DEPENDENCY_MISSING', {
      dependency: dependencyName,
      installCommand: `Install via Settings or check documentation for: ${dependencyName}`,
      category: 'dependency'
    });
  }
}

/**
 * Thrown when the in-process AI engine fails to initialize or run inference.
 * Named for backward compatibility (was HTTP-based, now in-process).
 */
class AiEngineConnectionError extends AnalysisError {
  /** @param {Record<string, any>} [details] */
  constructor(details = {}) {
    super('AI_ENGINE_CONNECTION_FAILURE', {
      category: 'ai_engine',
      ...details
    });
  }
}

class FileProcessingError extends AnalysisError {
  /**
   * @param {string} code
   * @param {string} fileName
   * @param {Record<string, any>} [additionalMetadata]
   */
  constructor(code, fileName, additionalMetadata = {}) {
    const safeFileName = typeof fileName === 'string' ? fileName : String(fileName || '');
    super(code, {
      fileName: safeFileName,
      fileExtension: require('path').extname(safeFileName),
      ...additionalMetadata
    });
  }
}

module.exports = {
  AnalysisError,
  ModelMissingError,
  DependencyMissingError,
  AiEngineConnectionError,
  FileProcessingError
};
