// @ts-check
/**
 * Extended Analysis Schema
 *
 * Defines the standard data structure for document analysis results.
 * This schema is used by the LLM prompt, the renaming service, and the indexing service
 * to ensure consistent data flow across the pipeline.
 *
 * @module shared/analysisSchema
 */

/**
 * @typedef {Object} ExtendedAnalysisResult
 * @property {string} [date] - The document's primary date (ISO YYYY-MM-DD)
 * @property {string} [entity] - The primary entity/sender/provider (e.g. "Amazon", "IRS", "John Doe")
 * @property {string} [type] - The specific document type (e.g. "Invoice", "Contract", "Bank Statement")
 * @property {string} [category] - The broader category (e.g. "Finance", "Legal", "Personal")
 * @property {string} [project] - The project or subject this relates to
 * @property {string} [purpose] - The primary intent or purpose of the document
 * @property {string} [summary] - A brief summary of the content (1-2 sentences)
 * @property {string[]} [keywords] - Key terms for search and filtering
 * @property {string[]} [keyEntities] - Key named entities mentioned (people, orgs, places)
 * @property {number} confidence - Confidence score (0-100)
 * @property {string} [suggestedName] - A suggested filename based on the content
 * @property {string|null} [reasoning] - Brief explanation of why this category was chosen
 */

/**
 * The full pipeline analysis-result shape. It carries the LLM/schema fields of
 * {@link ExtendedAnalysisResult} plus the fields different analyzers attach
 * downstream (extraction method, content length, document type, source, error,
 * …). Prefer this over a bare `Record<string, any>` at result sites so an object
 * reads as what it is and the common fields are documented.
 *
 * All fields are optional and an index signature keeps genuinely analyzer-specific
 * extras permissive — this is an intent/readability type, not a tightening.
 * Removing the index signature (to make typecheck catch shape mismatches) is a
 * separate coordinated pass across the whole pipeline.
 *
 * @typedef {{
 *   date?: string | null,
 *   entity?: string | null,
 *   type?: string,
 *   category?: string,
 *   project?: string | null,
 *   purpose?: string | null,
 *   summary?: string,
 *   keywords?: string[],
 *   keyEntities?: string[],
 *   confidence?: number,
 *   suggestedName?: string | null,
 *   reasoning?: string | null,
 *   extractionMethod?: string | null,
 *   contentLength?: number | null,
 *   documentType?: string,
 *   source?: string,
 *   error?: string,
 *   isFallback?: boolean,
 *   _isFallback?: boolean,
 *   content_type?: string,
 *   has_text?: boolean,
 *   [key: string]: any
 * }} AnalysisResult
 */

/**
 * The JSON schema definition used to guide the LLM's output.
 * We use a descriptive object structure that can be injected into prompts.
 */
const ANALYSIS_SCHEMA_PROMPT = {
  date: 'YYYY-MM-DD format. The primary date explicitly found in the document (invoice date, statement date, etc.). If NONE found, leave null.',
  entity:
    "The primary organization, person, or company responsible for the document (e.g., 'Amazon', 'Chase Bank', 'City of Seattle').",
  type: "The specific type of document (e.g., 'Invoice', 'Receipt', 'Contract', 'Meeting Notes', 'Tax Form').",
  category:
    'The high-level category (must match one of the provided Smart Folder names if applicable).',
  project: 'The specific project, case, or subject matter (2-5 words).',
  purpose: 'The primary purpose or intent of the document (1 sentence).',
  summary: "A concise 1-2 sentence summary of the document's content.",
  keywords: ['keyword1', 'keyword2', 'keyword3', 'keyword4', 'keyword5'],
  keyEntities: ['person_or_org_1', 'person_or_org_2', 'location_or_product', 'project_or_event'],
  confidence: 'Number 0-100 indicating confidence in the extraction.',
  suggestedName:
    "A short, concise topic-based filename (max 3 words) using underscores (e.g., 'budget_report', 'sunset_beach', 'meeting_notes'). Do NOT include the extension.",
  reasoning:
    'Brief explanation (1 sentence) of why this category was chosen based on the content and folder description.'
};

/**
 * Default empty/fallback analysis result
 * @type {{ date: string|null, entity: string|null, type: string, category: string, project: string|null, purpose: string|null, summary: string, keywords: string[], keyEntities: string[], confidence: number, suggestedName: string|null, reasoning: string|null }}
 */
const DEFAULT_ANALYSIS_RESULT = {
  date: null,
  entity: null,
  type: 'Document',
  category: 'Uncategorized',
  project: null,
  purpose: null,
  summary: '',
  keywords: [],
  keyEntities: [],
  confidence: 0,
  suggestedName: null,
  reasoning: null
};

module.exports = {
  ANALYSIS_SCHEMA_PROMPT,
  DEFAULT_ANALYSIS_RESULT
};
