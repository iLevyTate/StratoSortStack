'use strict';

// Mock the two collaborators so the partition logic is exercised in isolation
// (the real mediaAnalysis module pulls in optional native media deps).
jest.mock('../../src/main/services/autoOrganize/fileTypeUtils', () => ({
  getFileTypeCategory: (ext) =>
    ['.jpg', '.jpeg', '.png', '.gif'].includes(ext) ? 'Images' : 'Documents'
}));
jest.mock('../../src/main/analysis/mediaAnalysis', () => ({
  classifyMediaFile: (filePath) =>
    /\.(mp4|mov|mp3|wav)$/i.test(filePath) ? { kind: 'media' } : null
}));

const {
  partitionFilesByModality,
  isImageFile,
  isMediaFile
} = require('../../src/main/services/analysisRouting');

describe('analysisRouting', () => {
  describe('isImageFile', () => {
    test('delegates to file-type category', () => {
      expect(isImageFile('.png')).toBe(true);
      expect(isImageFile('.pdf')).toBe(false);
    });
  });

  describe('isMediaFile', () => {
    test('delegates to media classifier', () => {
      expect(isMediaFile('clip.mp4')).toBe(true);
      expect(isMediaFile('notes.txt')).toBe(false);
    });
  });

  describe('partitionFilesByModality', () => {
    test('routes each file into its modality lane', () => {
      const result = partitionFilesByModality(['photo.jpg', 'clip.mp4', 'report.pdf', 'song.mp3']);
      expect(result).toEqual({
        documents: ['report.pdf'],
        images: ['photo.jpg'],
        media: ['clip.mp4', 'song.mp3']
      });
    });

    test('image classification is case-insensitive on the extension', () => {
      const result = partitionFilesByModality(['UPPER.PNG']);
      expect(result.images).toEqual(['UPPER.PNG']);
    });

    test('images take precedence over media for a file that could match both', () => {
      // Image check runs first, so an image extension never falls through to media.
      const result = partitionFilesByModality(['frame.png']);
      expect(result.images).toEqual(['frame.png']);
      expect(result.media).toEqual([]);
    });

    test('preserves input order within each lane', () => {
      const result = partitionFilesByModality(['a.pdf', 'b.pdf', 'c.txt']);
      expect(result.documents).toEqual(['a.pdf', 'b.pdf', 'c.txt']);
    });

    test('returns empty lanes for an empty input', () => {
      expect(partitionFilesByModality([])).toEqual({ documents: [], images: [], media: [] });
    });
  });
});
