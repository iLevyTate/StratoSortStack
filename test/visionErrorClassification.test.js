const {
  isVisionRuntimeDecodePressure,
  classifyVisionError,
  isVisionDecodePressureError,
  isVisionInputDataError
} = require('../src/main/services/visionErrorClassification');

describe('visionErrorClassification', () => {
  test('treats decode-pressure hints as runtime pressure', () => {
    const message =
      'failed to process image [vision-runtime: decode failed to find a memory slot for batch of size 1024]';
    const classification = classifyVisionError(message);
    expect(classification.isDecodePressure).toBe(true);
    expect(classification.isInputData).toBe(false);
  });

  // The runtime's stderr travels beside the message, not in it.
  test('reads decode pressure from the stderr hint an error carries', () => {
    const error = Object.assign(new Error('Vision runtime error'), {
      visionRuntimeHint: ' [vision-runtime: decode: failed to find a memory slot for batch]'
    });
    expect(isVisionRuntimeDecodePressure(error)).toBe(true);
    expect(isVisionRuntimeDecodePressure(new Error('Vision runtime error'))).toBe(false);
    expect(isVisionRuntimeDecodePressure(new Error('failed to process image'))).toBe(true);
  });

  test('treats unsupported format as input-data error', () => {
    const message = 'unsupported image format';
    expect(isVisionInputDataError(message)).toBe(true);
    expect(isVisionDecodePressureError(message)).toBe(false);
  });
});
