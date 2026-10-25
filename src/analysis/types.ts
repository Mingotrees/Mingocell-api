export type AnalysisState = 'queued' | 'running' | 'succeeded' | 'failed';
export type ModelMetadata = {
  package_id: string; package_version: number; class_order: string[];
  architecture_order: string[]; temperature: number; abstention_threshold: number; device: string;
};
export type Prediction = {
  schema_version: number; package_id: string; package_version: number; class_order: string[];
  probabilities: number[]; predicted_class: string; calibrated_confidence: number;
  normalized_entropy: number; abstained: boolean;
};
export type Provenance = {
  originalSha256: string; inputSha256: string; pageIndex: number;
  extractionVersion: string; pillowVersion: string | null; model: ModelMetadata; analyzedAt: string;
};
export type AnalysisResult = { prediction: Prediction; provenance: Provenance };
export type AnalysisView = {
  id: string; submissionId: string; state: AnalysisState; attempts: number;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  statusUrl: string; retryable: boolean; error: {code: string; message: string} | null;
  result: AnalysisResult | null;
};
export type AnalysisResponse = {analysis: AnalysisView | {state: 'not_requested'; submissionId: string}};
export type Claim = {
  jobId: string; submissionId: string; attemptId: string; attempts: number;
  originalStorageKey: string; originalSha256: string; format: 'png'|'jpeg'|'tiff';
  pageIndex: number; pageCount: number; width: number; height: number;
};
export class AnalysisFailure extends Error {
  constructor(public code: string, public classification: 'permanent'|'transient'|'suspend', public uncertain = false) {
    super('Analysis could not be completed.');
  }
}
