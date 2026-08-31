/**
 * The AI facade.
 *
 * Everything in the product that needs the model goes through these named
 * operations. They match the operation set the product specification calls for;
 * each is a thin, testable service over the provider abstraction, and each
 * carries its own prompt, schema and safety fencing.
 */

export { proposeStructure as structureProject, commitStructure } from './services/intake.ts';
export { analyzeEvidenceImage as analyzeImage, runOcr, storeOcrText, reindexEvidence } from './services/vision.ts';
export { classifyEvidence } from './services/evidence.ts';
export { elaborateStep, elaborateProblem, elaborateProject, explainCommands } from './services/elaborate.ts';
export { analyzeProject, computeCompleteness } from './services/consistency.ts';
export { generateReport } from './services/report.ts';
export { generatePresentation, generateSpeakerNotes, reviewPresentation } from './services/presentation.ts';
export { generateQuestions, askAssistant } from './services/qa.ts';
export { providerInfo, getProvider, setProvider } from './registry.ts';
export { buildProjectContext, buildStepContext } from './context.ts';
export {
  detectSecrets,
  detectInjection,
  detectInternalIdentifiers,
  redactSecrets,
  maskValue,
  fenceUntrusted,
} from './safety.ts';
