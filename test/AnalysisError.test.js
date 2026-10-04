/**
 * Tests for AnalysisError
 */

describe('AnalysisError', () => {
  let AnalysisError;
  let ModelMissingError;
  let DependencyMissingError;
  let AiEngineConnectionError;
  let FileProcessingError;

  beforeEach(() => {
    jest.resetModules();
    const module = require('../src/main/errors/AnalysisError');
    AnalysisError = module.AnalysisError;
    ModelMissingError = module.ModelMissingError;
    DependencyMissingError = module.DependencyMissingError;
    AiEngineConnectionError = module.AiEngineConnectionError;
    FileProcessingError = module.FileProcessingError;
  });

  test('creates error with code and metadata', () => {
    const error = new AnalysisError('PDF_PROCESSING_FAILURE', { fileName: 'test.pdf' });
    expect(error.name).toBe('AnalysisError');
    expect(error.code).toBe('PDF_PROCESSING_FAILURE');
    expect(error.metadata.fileName).toBe('test.pdf');
  });

  test('provides AI engine connection guidance', () => {
    const error = new AiEngineConnectionError();
    const message = error.getUserFriendlyMessage();
    const steps = error.getActionableSteps();
    expect(message).toContain('AI engine');
    expect(steps).toContain('Check Settings > Models');
  });

  test('model missing error formats message', () => {
    const error = new ModelMissingError('llama3.2');
    expect(error.getUserFriendlyMessage()).toContain('Missing AI model');
  });

  test('file processing error includes file name', () => {
    const error = new FileProcessingError('FILE_TOO_LARGE', 'big.pdf');
    expect(error.metadata.fileName).toBe('big.pdf');
  });

  test('dependency missing error includes dependency', () => {
    const error = new DependencyMissingError('sharp');
    expect(error.metadata.dependency).toBe('sharp');
  });

  test.each([
    'FILE_EMPTY',
    'FILE_READ_ERROR',
    'PDF_ENCRYPTED',
    'DOC_EXTRACTION_FAILURE',
    'XLSX_EXTRACTION_FAILURE',
    'PPTX_EXTRACTION_FAILURE',
    'ODF_EXTRACTION_FAILURE'
  ])('maps %s to a specific message instead of the unknown default', (code) => {
    const error = new AnalysisError(code);
    expect(error.message).not.toBe('Unknown analysis error');
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.getUserFriendlyMessage()).not.toBe(
      'An unexpected error occurred during analysis.'
    );
  });

  test('FILE_EMPTY conveys the empty-file reason', () => {
    const error = new FileProcessingError('FILE_EMPTY', 'empty.txt');
    expect(error.message).toBe('File is empty or contains no readable text');
    expect(error.code).toBe('FILE_EMPTY');
    expect(error.isOperational).toBe(true);
  });

  test('FILE_READ_ERROR preserves the underlying cause', () => {
    const fsError = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const error = new FileProcessingError('FILE_READ_ERROR', 'missing.txt', {
      osCode: fsError.code,
      cause: fsError
    });
    expect(error.message).toBe('Failed to read file from disk');
    expect(error.cause).toBe(fsError);
    expect(error.metadata.osCode).toBe('ENOENT');
  });
});
