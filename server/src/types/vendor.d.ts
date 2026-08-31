/**
 * Ambient declaration for the optional OCR engine.
 *
 * `tesseract.js` is not a dependency: OCR_DRIVER=tesseract is an opt-in for
 * users who want local, token-free OCR and install it themselves. The dynamic
 * import in ai/services/vision.ts is wrapped in try/catch, so the absence of
 * the package is a supported state rather than a build error.
 */
declare module 'tesseract.js' {
  export function createWorker(lang?: string): Promise<{
    recognize(input: Buffer | string): Promise<{ data: { text: string; confidence?: number } }>;
    terminate(): Promise<void>;
  }>;
}
