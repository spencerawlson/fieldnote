import PDFDocument from 'pdfkit';
import type { ResolvedPresentation, ResolvedReport } from './document.ts';
import type { ReportBlock } from '../domain/types.ts';
import { fitImage } from './docx.ts';
import { calloutStyles, getTheme, hex, type Theme } from './themes.ts';
import { buildCover, formatDate } from './cover.ts';

/**
 * PDF rendering.
 *
 * pdfkit rather than headless Chrome: no 150 MB browser download, no sandbox to
 * manage, and deterministic output. The cost is that layout is written by hand,
 * which is why pagination, figure placement and page numbering are handled
 * explicitly below.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 points
const MARGIN = { top: 64, bottom: 72, left: 64, right: 64 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

type Doc = InstanceType<typeof PDFDocument>;

/**
 * Resolved theme colours and fonts for one render pass. pdfkit only ships the
 * 14 standard PDF fonts, so a theme selects between Helvetica and Times rather
 * than naming an arbitrary family — embedding a font file would bloat every
 * export for a cosmetic gain.
 */
interface PdfStyle {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  surface: string;
  cover: string;
  coverInk: string;
  coverMuted: string;
  body: string;
  bold: string;
  italic: string;
  bodySize: number;
  sectionRule: boolean;
  coverStyle: Theme['cover'];
}

function styleFor(themeKey: string): PdfStyle {
  const theme = getTheme(themeKey);
  return {
    ink: hex(theme.palette.ink),
    muted: hex(theme.palette.muted),
    line: hex(theme.palette.line),
    accent: hex(theme.palette.accent),
    surface: hex(theme.palette.surface),
    cover: hex(theme.palette.cover),
    coverInk: hex(theme.palette.coverInk),
    coverMuted: hex(theme.palette.coverMuted),
    body: theme.fonts.pdfBody,
    bold: theme.fonts.pdfBold,
    italic: theme.fonts.pdfItalic,
    bodySize: theme.bodyPt,
    sectionRule: theme.sectionRule,
    coverStyle: theme.cover,
  };
}

function collect(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/** Starts a new page when the next block would not fit on the current one. */
function ensureRoom(doc: Doc, needed: number): void {
  if (doc.y + needed > PAGE.height - MARGIN.bottom) doc.addPage();
}

export async function renderReportPdf(report: ResolvedReport): Promise<Buffer> {
  const style = styleFor(report.theme);
  const theme = getTheme(report.theme);
  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    info: {
      Title: report.title,
      Author: report.author ?? 'Fieldnote',
      Subject: report.projectTitle,
      Creator: 'Fieldnote',
    },
    autoFirstPage: false,
  });
  const done = collect(doc);

  // --- cover page ---
  doc.addPage();
  drawCover(doc, report, style);

  // --- contents ---
  doc.addPage();
  doc.font(style.bold).fontSize(16).fillColor(style.ink).text('Contents');
  doc.moveDown(0.75);
  report.sections.forEach((section, index) => {
    doc.font(style.body).fontSize(11).fillColor(style.ink);
    doc.text(`${index + 1}.  ${section.heading}`, { continued: false });
    doc.moveDown(0.35);
  });

  // --- body ---
  doc.addPage();
  report.sections.forEach((section, index) => {
    ensureRoom(doc, 90);
    doc.moveDown(index === 0 ? 0 : 0.8);
    doc.font(style.bold).fontSize(15).fillColor(style.ink).text(section.heading);
    if (style.sectionRule) {
      const underlineY = doc.y + 3;
      doc.moveTo(MARGIN.left, underlineY).lineTo(PAGE.width - MARGIN.right, underlineY)
        .strokeColor(style.line).lineWidth(0.75).stroke();
    }
    doc.moveDown(0.8);

    for (const block of section.blocks) drawBlock(doc, block, report, style, theme);
  });

  // --- page numbers and running header (added after layout is known) ---
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    if (i === range.start) continue; // no furniture on the title page
    doc.font(style.body).fontSize(8).fillColor(style.muted);
    doc.text(`${report.title}  ·  ${formatDate(new Date(report.generatedAt))}`, MARGIN.left, MARGIN.top - 28, {
      width: CONTENT_WIDTH,
      align: 'right',
      lineBreak: false,
    });
    doc.text(`${i - range.start + 1} of ${range.count - 1}`, MARGIN.left, PAGE.height - MARGIN.bottom + 28, {
      width: CONTENT_WIDTH,
      align: 'center',
      lineBreak: false,
    });
  }

  doc.end();
  return done;
}

/**
 * The cover page.
 *
 * Left-aligned rather than centred: a title block that shares the text column
 * with the body reads as one document, where a centred title floats. The
 * document-control table at the foot carries the information a reviewer looks
 * for first — version, date, status, classification.
 */
function drawCover(doc: Doc, report: ResolvedReport, style: PdfStyle): void {
  const cover = buildCover(report);
  const filled = style.coverStyle === 'filled';

  if (filled) {
    doc.rect(0, 0, PAGE.width, PAGE.height).fillColor(style.cover).fill();
  } else if (style.coverStyle === 'banded') {
    // A full-bleed band across the head of the page, rather than a hairline.
    doc.rect(0, 0, PAGE.width, 10).fillColor(style.accent).fill();
  }

  const ink = filled ? style.coverInk : style.ink;
  const muted = filled ? style.coverMuted : style.muted;

  let y = PAGE.height * 0.28;

  doc.font(style.bold).fontSize(9.5).fillColor(filled ? style.coverMuted : style.accent);
  doc.text(cover.documentType.toUpperCase(), MARGIN.left, y, {
    width: CONTENT_WIDTH,
    characterSpacing: 1.6,
  });
  y = doc.y + 14;

  doc.font(style.bold).fontSize(30).fillColor(ink);
  doc.text(cover.title, MARGIN.left, y, { width: CONTENT_WIDTH, lineGap: 2 });
  y = doc.y + 8;

  if (cover.subtitle) {
    doc.font(style.body).fontSize(14).fillColor(muted);
    doc.text(cover.subtitle, MARGIN.left, y, { width: CONTENT_WIDTH });
    y = doc.y + 6;
  }

  // A rule the width of the accent, tying the title block together.
  doc.rect(MARGIN.left, y + 10, 96, 3).fillColor(style.accent).fill();
  y += 34;

  if (cover.project) {
    doc.font(style.body).fontSize(10.5).fillColor(muted);
    doc.text(`Project — ${cover.project}`, MARGIN.left, y, { width: CONTENT_WIDTH });
  }

  // Prepared-for / prepared-by, only when there is something to say.
  const parties: string[] = [];
  if (cover.preparedBy) parties.push(`Prepared by  ${cover.preparedBy}`);
  if (cover.preparedFor) parties.push(`Prepared for  ${cover.preparedFor}`);
  if (parties.length > 0) {
    y = PAGE.height * 0.62;
    doc.font(style.body).fontSize(10.5).fillColor(muted);
    for (const line of parties) {
      doc.text(line, MARGIN.left, y, { width: CONTENT_WIDTH });
      y = doc.y + 2;
    }
  }

  // Document control table.
  const tableY = PAGE.height * 0.74;
  const columnWidth = CONTENT_WIDTH / cover.control.length;
  doc.moveTo(MARGIN.left, tableY - 12)
    .lineTo(PAGE.width - MARGIN.right, tableY - 12)
    .strokeColor(filled ? style.coverMuted : style.line)
    .lineWidth(0.75)
    .stroke();

  cover.control.forEach((field, index) => {
    const x = MARGIN.left + index * columnWidth;
    doc.font(style.body).fontSize(7.5).fillColor(muted);
    doc.text(field.label.toUpperCase(), x, tableY, { width: columnWidth - 8, characterSpacing: 0.8 });
    doc.font(style.bold).fontSize(10).fillColor(ink);
    doc.text(field.value, x, tableY + 12, { width: columnWidth - 8 });
  });

  doc.font(style.italic).fontSize(7.5).fillColor(muted);
  doc.text(cover.notice, MARGIN.left, PAGE.height - MARGIN.bottom - 24, {
    width: CONTENT_WIDTH,
    lineGap: 1,
  });
}

function drawBlock(
  doc: Doc,
  block: ReportBlock,
  report: ResolvedReport,
  style: PdfStyle,
  theme: Theme,
): void {
  const INK = style.ink;
  const MUTED = style.muted;
  const LINE = style.line;
  switch (block.type) {
    case 'paragraph':
      ensureRoom(doc, 40);
      doc.font(style.body).fontSize(10.5).fillColor(INK).text(block.text, { width: CONTENT_WIDTH, align: 'left', lineGap: 2 });
      doc.moveDown(0.6);
      break;

    case 'heading':
      ensureRoom(doc, 50);
      doc.moveDown(0.4);
      doc
        .font(style.bold)
        .fontSize(block.level === 2 ? 13 : block.level === 3 ? 11.5 : 10.5)
        .fillColor(INK)
        .text(block.text, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);
      break;

    case 'bullets':
      for (const [index, item] of block.items.entries()) {
        ensureRoom(doc, 28);
        doc.font(style.body).fontSize(10.5).fillColor(INK);
        doc.text(`${block.ordered ? `${index + 1}.` : '•'}  ${item}`, MARGIN.left + 12, doc.y, {
          width: CONTENT_WIDTH - 12,
          lineGap: 1.5,
        });
        doc.moveDown(0.25);
      }
      doc.moveDown(0.35);
      doc.x = MARGIN.left;
      break;

    case 'procedure':
      for (const [index, item] of block.items.entries()) {
        ensureRoom(doc, 36);
        doc.font(style.bold).fontSize(10.5).fillColor(INK);
        doc.text(`${index + 1}.  ${item.text}`, MARGIN.left + 12, doc.y, { width: CONTENT_WIDTH - 12 });
        if (item.detail) {
          doc.font(style.body).fontSize(9.5).fillColor(MUTED);
          doc.text(item.detail, MARGIN.left + 26, doc.y, { width: CONTENT_WIDTH - 26 });
        }
        doc.moveDown(0.35);
      }
      doc.moveDown(0.3);
      doc.x = MARGIN.left;
      break;

    case 'code': {
      const lines = block.content.split('\n');
      const lineHeight = 11.5;
      const boxHeight = lines.length * lineHeight + 16;
      ensureRoom(doc, Math.min(boxHeight, 260) + 20);
      const top = doc.y;
      doc.rect(MARGIN.left, top, CONTENT_WIDTH, Math.min(boxHeight, PAGE.height - MARGIN.bottom - top)).fillColor(style.surface).fill();
      doc.rect(MARGIN.left, top, 3, Math.min(boxHeight, PAGE.height - MARGIN.bottom - top)).fillColor(style.line).fill();
      doc.fillColor(INK).font('Courier').fontSize(8.5);
      let y = top + 8;
      for (const line of lines) {
        if (y + lineHeight > PAGE.height - MARGIN.bottom) {
          doc.addPage();
          y = MARGIN.top;
        }
        doc.text(line || ' ', MARGIN.left + 12, y, { width: CONTENT_WIDTH - 24, lineBreak: false, ellipsis: true });
        y += lineHeight;
      }
      doc.y = y + 8;
      doc.x = MARGIN.left;
      if (block.caption) {
        doc.font(style.italic).fontSize(8.5).fillColor(MUTED).text(block.caption, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.7);
      break;
    }

    case 'table': {
      const columns = block.headers.length;
      const colWidth = CONTENT_WIDTH / columns;
      const rowHeight = 20;
      ensureRoom(doc, rowHeight * Math.min(block.rows.length + 1, 6) + 24);

      const drawRow = (cells: string[], isHeader: boolean) => {
        const heights = cells.map(
          (cell) => doc.font(isHeader ? style.bold : style.body).fontSize(8.5).heightOfString(String(cell), { width: colWidth - 10 }),
        );
        const height = Math.max(rowHeight, Math.max(...heights) + 10);
        if (doc.y + height > PAGE.height - MARGIN.bottom) doc.addPage();
        const top = doc.y;
        if (isHeader) doc.rect(MARGIN.left, top, CONTENT_WIDTH, height).fillColor(style.surface).fill();
        cells.forEach((cell, index) => {
          const x = MARGIN.left + index * colWidth;
          doc.rect(x, top, colWidth, height).strokeColor(LINE).lineWidth(0.5).stroke();
          doc
            .font(isHeader ? style.bold : style.body)
            .fontSize(8.5)
            .fillColor(INK)
            .text(String(cell), x + 5, top + 5, { width: colWidth - 10, height: height - 10, ellipsis: true });
        });
        doc.y = top + height;
        doc.x = MARGIN.left;
      };

      drawRow(block.headers, true);
      for (const row of block.rows) drawRow(row, false);
      if (block.caption) {
        doc.moveDown(0.3);
        doc.font(style.italic).fontSize(8.5).fillColor(MUTED).text(block.caption, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.8);
      break;
    }

    case 'figure': {
      const figure = report.figures.get(block.evidenceId);
      if (!figure?.bytes) {
        doc.font(style.italic).fontSize(9).fillColor(MUTED)
          .text(`[Figure ${block.number ?? '?'} unavailable: ${figure?.missingReason ?? 'not found'}]`, { width: CONTENT_WIDTH });
        doc.moveDown(0.6);
        break;
      }
      const { width, height } = fitImage(figure.width, figure.height, CONTENT_WIDTH, 340);
      ensureRoom(doc, height + 34);
      try {
        const imageX = MARGIN.left + (CONTENT_WIDTH - width) / 2;
        const imageY = doc.y;
        doc.image(figure.bytes, imageX, imageY, { width, height });
        // Screenshots are usually white-backgrounded. Without a rule around
        // them they bleed into a white page and read as nothing at all, so
        // every figure gets the same hairline the HTML export already draws.
        doc.save();
        doc.lineWidth(0.5).strokeColor(style.line)
          .rect(imageX, imageY, width, height).stroke();
        doc.restore();
        doc.y = imageY + height + 6;
      } catch {
        // pdfkit only decodes PNG and JPEG; anything else gets a placeholder
        // rather than aborting the whole export.
        doc.font(style.italic).fontSize(9).fillColor(MUTED)
          .text(`[Figure ${block.number ?? '?'} could not be embedded in PDF (${figure.mimeType}). It is present in the DOCX and HTML exports.]`, {
            width: CONTENT_WIDTH,
          });
        doc.moveDown(0.3);
      }
      doc.font(style.italic).fontSize(8.5).fillColor(MUTED)
        .text(`Figure ${block.number ?? '?'} — ${block.caption}`, MARGIN.left, doc.y, { width: CONTENT_WIDTH, align: 'center' });
      doc.moveDown(0.9);
      doc.x = MARGIN.left;
      break;
    }

    case 'callout': {
      const styles = calloutStyles(theme);
      const resolved = styles[block.variant] ?? styles.note!;
      const colours = {
        fill: hex(resolved.fill),
        bar: hex(resolved.bar),
        label: resolved.label.toUpperCase(),
        ink: hex(resolved.ink),
      };
      doc.font(style.body).fontSize(10);
      const textHeight = doc.heightOfString(block.text, { width: CONTENT_WIDTH - 32 });
      const boxHeight = textHeight + 30;
      ensureRoom(doc, boxHeight + 10);
      const top = doc.y;
      doc.rect(MARGIN.left, top, CONTENT_WIDTH, boxHeight).fillColor(colours.fill).fill();
      doc.rect(MARGIN.left, top, 3.5, boxHeight).fillColor(colours.bar).fill();
      doc.font(style.bold).fontSize(7).fillColor(colours.bar)
        .text(colours.label, MARGIN.left + 14, top + 8, { width: CONTENT_WIDTH - 28, characterSpacing: 0.6 });
      doc.font(style.body).fontSize(10).fillColor(colours.ink)
        .text(block.text, MARGIN.left + 14, top + 19, { width: CONTENT_WIDTH - 28 });
      doc.y = top + boxHeight + 10;
      doc.x = MARGIN.left;
      break;
    }

    case 'diagram': {
      if (block.title) {
        doc.font(style.bold).fontSize(10.5).fillColor(INK).text(block.title, { width: CONTENT_WIDTH });
      }
      drawBlock(doc, { type: 'code', language: 'text', content: block.ascii, caption: block.caption }, report, style, theme);
      break;
    }

    case 'reference-list':
      block.items.forEach((item, index) => {
        ensureRoom(doc, 26);
        doc.font(style.body).fontSize(9.5).fillColor(INK);
        doc.text(`[${index + 1}]  ${item.label}${item.url ? ` — ${item.url}` : ''}${item.detail ? ` — ${item.detail}` : ''}`, {
          width: CONTENT_WIDTH,
        });
        doc.moveDown(0.25);
      });
      doc.moveDown(0.5);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Presentation PDF (landscape 16:9, with an optional notes page per slide)
// ---------------------------------------------------------------------------

const SLIDE = { width: 720, height: 405 };

export async function renderPresentationPdf(
  presentation: ResolvedPresentation,
  options: { includeNotes?: boolean } = {},
): Promise<Buffer> {
  const style = styleFor(presentation.theme);
  const doc = new PDFDocument({
    size: [SLIDE.width, SLIDE.height],
    margin: 0,
    bufferPages: true,
    info: { Title: presentation.title, Author: presentation.presenter ?? 'Fieldnote', Creator: 'Fieldnote' },
    autoFirstPage: false,
  });
  const done = collect(doc);

  for (const slide of presentation.slides) {
    doc.addPage({ size: [SLIDE.width, SLIDE.height], margin: 0 });
    drawSlide(doc, slide, presentation, style);
    if (options.includeNotes && slide.speakerNotes.trim()) {
      doc.addPage({ size: 'A4', margin: 56 });
      doc.font(style.bold).fontSize(13).fillColor(style.ink).text(`Notes — ${slide.title}`);
      doc.moveDown(0.6);
      doc.font(style.body).fontSize(11).fillColor(style.ink).text(slide.speakerNotes, { lineGap: 3 });
    }
  }

  doc.end();
  return done;
}

function drawSlide(
  doc: Doc,
  slide: ResolvedPresentation['slides'][number],
  presentation: ResolvedPresentation,
  style: PdfStyle,
): void {
  const INK = style.ink;
  const MUTED = style.muted;
  const pad = 48;
  const isTitle = slide.layout === 'title';
  const isClosing = slide.layout === 'closing';

  doc.rect(0, 0, SLIDE.width, SLIDE.height).fillColor(isTitle || isClosing ? style.cover : '#ffffff').fill();
  const textColour = isTitle || isClosing ? style.coverInk : INK;
  const subColour = isTitle || isClosing ? style.coverMuted : MUTED;

  if (isTitle || isClosing) {
    doc.font(style.bold).fontSize(30).fillColor(textColour)
      .text(slide.title, pad, SLIDE.height / 2 - 50, { width: SLIDE.width - pad * 2 });
    if (slide.subtitle) {
      doc.font(style.body).fontSize(14).fillColor(subColour)
        .text(slide.subtitle, pad, doc.y + 8, { width: SLIDE.width - pad * 2 });
    }
    if (isTitle && presentation.presenter) {
      doc.font(style.body).fontSize(12).fillColor(subColour)
        .text(presentation.presenter, pad, SLIDE.height - pad - 14, { width: SLIDE.width - pad * 2 });
    }
    return;
  }

  // Title bar
  doc.font(style.bold).fontSize(21).fillColor(textColour).text(slide.title, pad, pad - 12, { width: SLIDE.width - pad * 2 });
  const ruleY = doc.y + 6;
  doc.moveTo(pad, ruleY).lineTo(pad + 56, ruleY).strokeColor(style.accent).lineWidth(3).stroke();

  const hasImage = slide.figures.some((f) => f.bytes);
  const textWidth = hasImage ? (SLIDE.width - pad * 2) * 0.55 : SLIDE.width - pad * 2;
  let y = ruleY + 22;

  for (const bullet of slide.bullets) {
    if (y > SLIDE.height - pad) break;
    doc.circle(pad + 4, y + 6, 2.5).fillColor(style.accent).fill();
    doc.font(style.body).fontSize(13).fillColor(INK)
      .text(bullet, pad + 16, y, { width: textWidth - 16, lineGap: 2 });
    y = doc.y + 10;
  }

  if (slide.body.code) {
    const lines = slide.body.code.content.split('\n').slice(0, 10);
    doc.rect(pad, y, textWidth, lines.length * 13 + 14).fillColor(style.surface).fill();
    doc.font('Courier').fontSize(9.5).fillColor(INK);
    lines.forEach((line, i) => doc.text(line || ' ', pad + 10, y + 8 + i * 13, { width: textWidth - 20, lineBreak: false, ellipsis: true }));
    y += lines.length * 13 + 22;
  }

  if (slide.body.diagram) {
    const lines = slide.body.diagram.ascii.split('\n').slice(0, 12);
    doc.font('Courier').fontSize(9.5).fillColor(MUTED);
    lines.forEach((line, i) => doc.text(line, pad, y + i * 12, { width: textWidth, lineBreak: false }));
    y += lines.length * 12 + 10;
  }

  if (slide.body.table) {
    const table = slide.body.table;
    const colWidth = textWidth / Math.max(1, table.headers.length);
    doc.font(style.bold).fontSize(9).fillColor(INK);
    table.headers.forEach((h, i) => doc.text(h, pad + i * colWidth, y, { width: colWidth - 6, ellipsis: true }));
    y += 14;
    doc.font(style.body).fontSize(9).fillColor(MUTED);
    for (const row of table.rows.slice(0, 8)) {
      row.forEach((cell, i) => doc.text(String(cell), pad + i * colWidth, y, { width: colWidth - 6, ellipsis: true }));
      y += 13;
    }
  }

  if (slide.body.before || slide.body.after) {
    const half = (SLIDE.width - pad * 2 - 24) / 2;
    const columns = [slide.body.before, slide.body.after].filter(Boolean) as NonNullable<typeof slide.body.before>[];
    columns.forEach((column, index) => {
      const x = pad + index * (half + 24);
      doc.font(style.bold).fontSize(11).fillColor(style.accent).text(column.heading, x, y, { width: half });
      let cy = doc.y + 6;
      for (const bullet of column.bullets) {
        doc.font(style.body).fontSize(11).fillColor(INK).text(`• ${bullet}`, x, cy, { width: half });
        cy = doc.y + 4;
      }
    });
  }

  const figure = slide.figures.find((f) => f.bytes);
  if (figure?.bytes) {
    const boxWidth = SLIDE.width - pad * 2 - textWidth - 24;
    const { width, height } = fitImage(figure.width, figure.height, boxWidth, SLIDE.height - ruleY - pad - 30);
    try {
      doc.image(figure.bytes, SLIDE.width - pad - width, ruleY + 22, { width, height });
      doc.font(style.italic).fontSize(7.5).fillColor(MUTED)
        .text(figure.caption, SLIDE.width - pad - width, ruleY + 26 + height, { width, align: 'center' });
    } catch {
      doc.font(style.italic).fontSize(9).fillColor(MUTED)
        .text('[image could not be embedded]', SLIDE.width - pad - boxWidth, ruleY + 22, { width: boxWidth });
    }
  }

  // Slide number
  doc.font(style.body).fontSize(8).fillColor(subColour)
    .text(String(slide.position + 1), SLIDE.width - pad, SLIDE.height - 28, { width: 24, align: 'right', lineBreak: false });
}
