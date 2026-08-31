import type { ResolvedPresentation, ResolvedReport } from './document.ts';

/**
 * Pre-export validation.
 *
 * Runs before a byte is written, on the resolved document, so the findings are
 * the same whatever format the user picked. Nothing here blocks an export —
 * the user may have good reason to ship a deck with a dense slide — but the
 * findings are stored with the export and shown next to the download.
 */

export interface ValidationFinding {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location?: string;
}

const MAX_SLIDE_WORDS = 60;
const MAX_BULLET_WORDS = 16;
const MIN_IMAGE_PIXELS = 240;

export function validateReport(report: ResolvedReport): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  if (report.sections.length === 0) {
    findings.push({ level: 'error', code: 'empty-document', message: 'The report has no sections. Generate it before exporting.' });
    return findings;
  }

  for (const section of report.sections) {
    if (section.blocks.length === 0) {
      findings.push({
        level: 'warning',
        code: 'empty-section',
        message: `Section "${section.heading}" is empty and will render as a bare heading.`,
        location: section.key,
      });
    }
    for (const block of section.blocks) {
      switch (block.type) {
        case 'figure': {
          const figure = report.figures.get(block.evidenceId);
          if (!figure || !figure.bytes) {
            findings.push({
              level: 'error',
              code: 'missing-image',
              message: `Figure ${block.number ?? '?'} cannot be rendered: ${figure?.missingReason ?? 'evidence not found'}.`,
              location: section.key,
            });
          } else {
            if (!block.caption?.trim()) {
              findings.push({
                level: 'warning',
                code: 'missing-caption',
                message: `Figure ${block.number} has no caption.`,
                location: section.key,
              });
            }
            if (figure.width && figure.height && Math.min(figure.width, figure.height) < MIN_IMAGE_PIXELS) {
              findings.push({
                level: 'warning',
                code: 'low-resolution',
                message: `Figure ${block.number} is ${figure.width}×${figure.height}; it may look poor in print.`,
                location: section.key,
              });
            }
          }
          break;
        }
        case 'table': {
          const width = block.headers.length;
          const ragged = block.rows.some((row) => row.length !== width);
          if (ragged) {
            findings.push({
              level: 'error',
              code: 'table-shape',
              message: `A table in "${section.heading}" has rows that do not match its header count.`,
              location: section.key,
            });
          }
          if (width > 6) {
            findings.push({
              level: 'warning',
              code: 'table-overflow',
              message: `A table in "${section.heading}" has ${width} columns and will likely overflow the page.`,
              location: section.key,
            });
          }
          break;
        }
        case 'code': {
          if (!block.content.trim()) {
            findings.push({
              level: 'warning',
              code: 'empty-code-block',
              message: `An empty code block appears in "${section.heading}".`,
              location: section.key,
            });
          }
          const longest = Math.max(0, ...block.content.split('\n').map((l) => l.length));
          if (longest > 110) {
            findings.push({
              level: 'info',
              code: 'code-wrap',
              message: `A code block in "${section.heading}" has lines up to ${longest} characters and will wrap.`,
              location: section.key,
            });
          }
          break;
        }
        case 'paragraph': {
          if (containsControlChars(block.text)) {
            findings.push({
              level: 'warning',
              code: 'invalid-characters',
              message: `Text in "${section.heading}" contains control characters that some renderers drop.`,
              location: section.key,
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  return findings;
}

export function validatePresentation(presentation: ResolvedPresentation): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  if (presentation.slides.length === 0) {
    findings.push({ level: 'error', code: 'empty-deck', message: 'The presentation has no slides. Generate it before exporting.' });
    return findings;
  }

  const seenTitles = new Map<string, number>();
  for (const slide of presentation.slides) {
    const label = `Slide ${slide.position + 1} — ${slide.title}`;

    const words = slide.bullets.join(' ').split(/\s+/).filter(Boolean).length;
    if (words > MAX_SLIDE_WORDS) {
      findings.push({
        level: 'warning',
        code: 'slide-text-heavy',
        message: `${label} carries ${words} words of bullet text; move detail into the speaker notes.`,
        location: slide.id,
      });
    }
    for (const bullet of slide.bullets) {
      const bulletWords = bullet.split(/\s+/).filter(Boolean).length;
      if (bulletWords > MAX_BULLET_WORDS) {
        findings.push({
          level: 'info',
          code: 'bullet-too-long',
          message: `${label} has a ${bulletWords}-word bullet that will wrap to several lines.`,
          location: slide.id,
        });
      }
    }

    const normalized = slide.title.trim().toLowerCase();
    const previous = seenTitles.get(normalized);
    if (previous !== undefined) {
      findings.push({
        level: 'warning',
        code: 'duplicate-slide',
        message: `${label} repeats the title of slide ${previous + 1}.`,
        location: slide.id,
      });
    }
    seenTitles.set(normalized, slide.position);

    for (const figure of slide.figures) {
      if (!figure.bytes) {
        findings.push({
          level: 'error',
          code: 'missing-image',
          message: `${label} references an image that cannot be rendered: ${figure.missingReason ?? 'not found'}.`,
          location: slide.id,
        });
      }
    }

    if (slide.layout !== 'title' && slide.layout !== 'closing' && !slide.speakerNotes.trim()) {
      findings.push({
        level: 'info',
        code: 'missing-notes',
        message: `${label} has no speaker notes.`,
        location: slide.id,
      });
    }

    if (slide.layout === 'before-after' && (!slide.body.before || !slide.body.after)) {
      findings.push({
        level: 'warning',
        code: 'incomplete-layout',
        message: `${label} uses the before/after layout but only supplies one side.`,
        location: slide.id,
      });
    }
    if (slide.layout === 'table' && (!slide.body.table || slide.body.table.rows.length === 0)) {
      findings.push({
        level: 'warning',
        code: 'incomplete-layout',
        message: `${label} uses the table layout but has no rows.`,
        location: slide.id,
      });
    }
  }

  const hasClosing = presentation.slides.some((s) => s.layout === 'closing' || /conclusion|summary|thank/i.test(s.title));
  if (!hasClosing) {
    findings.push({ level: 'info', code: 'missing-conclusion', message: 'The deck has no closing slide.' });
  }

  return findings;
}

function containsControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x09 || (code > 0x0d && code < 0x20)) return true;
  }
  return false;
}

export function hasBlockingErrors(findings: ValidationFinding[]): boolean {
  return findings.some((f) => f.level === 'error');
}
