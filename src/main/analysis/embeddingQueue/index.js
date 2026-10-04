// @ts-check
/**
 * Embedding Queue Module
 *
 * Main entry point for embedding queue with singleton instance.
 *
 * @module embeddingQueue
 */

const EmbeddingQueue = require('./EmbeddingQueueCore');

// Export singleton instance
module.exports = new EmbeddingQueue();

// Also export the class for testing
module.exports.EmbeddingQueue = EmbeddingQueue;
