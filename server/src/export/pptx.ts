import PptxGenJSDefault from 'pptxgenjs';
import { getTheme } from './themes.ts';
import type { ResolvedPresentation, ResolvedSlide } from './document.ts';

/**
 * PPTX renderer.
 *
 * Real speaker notes (PowerPoint's notes pane, not a text box), 16:9 layout,
 * a consistent title treatment and slide numbers. Layouts map onto the slide
 * kinds the generator produces so a "before/after" slide actually renders as
 * two columns rather than as a bullet list.
 */

/**
 * pptxgenjs ships CommonJS type declarations that use `export default` together
 * with `export as namespace`. Under NodeNext resolution TypeScript hands back
 * the module namespace rather than the class, so the constructor is not visible
 * as constructable. The runtime import is correct (verified against a real
 * generated file in the export tests); only the declaration needs help.
 *
 * Rather than casting to `any`, the surface this renderer actually uses is
 * declared explicitly below. Anything not listed here is not used, so a
 * mistyped call still fails the build.
 */
type PptxTextRun = { text: string; options?: Record<string, unknown> };
type PptxCell = { text: string; options?: Record<string, unknown> };

interface PptxSlide {
  background?: { color: string };
  addText(text: string | PptxTextRun[], options: Record<string, unknown>): void;
  addTable(rows: PptxCell[][], options: Record<string, unknown>): void;
  addImage(options: Record<string, unknown>): void;
  addShape(shape: string, options: Record<string, unknown>): void;
  addNotes(notes: string): void;
}

interface PptxDeck {
  layout: string;
  author: string;
  company: string;
  title: string;
  subject: string;
  addSlide(options?: { masterName?: string }): PptxSlide;
  defineSlideMaster(options: Record<string, unknown>): void;
  write(options: { outputType: 'nodebuffer' }): Promise<Buffer>;
}

const PptxGenJS = PptxGenJSDefault as unknown as new () => PptxDeck;

/**
 * The slide palette, taken from the shared theme registry so a deck looks the
 * same in PPTX, in the PDF export and in the workspace preview.
 */
interface SlideTheme {
  background: string;
  title: string;
  body: string;
  accent: string;
  muted: string;
  cover: string;
  coverInk: string;
  coverMuted: string;
  surface: string;
  line: string;
  headingFont: string;
  bodyFont: string;
  monoFont: string;
}

function slideTheme(key: string): SlideTheme {
  const theme = getTheme(key);
  return {
    background: theme.palette.page,
    title: theme.palette.heading,
    body: theme.palette.ink,
    accent: theme.palette.accent,
    muted: theme.palette.muted,
    cover: theme.palette.cover,
    coverInk: theme.palette.coverInk,
    coverMuted: theme.palette.coverMuted,
    surface: theme.palette.surface,
    line: theme.palette.line,
    headingFont: theme.fonts.heading,
    bodyFont: theme.fonts.body,
    monoFont: theme.fonts.mono,
  };
}

export async function renderPresentationPptx(presentation: ResolvedPresentation): Promise<Buffer> {
  const theme = slideTheme(presentation.theme);
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_16x9'; // 10 x 5.625 inches
  pptx.author = presentation.presenter ?? 'Fieldnote';
  pptx.company = 'Fieldnote';
  pptx.title = presentation.title;
  pptx.subject = presentation.projectTitle;

  pptx.defineSlideMaster({
    title: 'FIELDNOTE_BODY',
    background: { color: theme.background },
    objects: [
      { rect: { x: 0.5, y: 1.02, w: 0.62, h: 0.045, fill: { color: theme.accent } } },
    ],
    slideNumber: { x: 9.3, y: 5.15, color: theme.muted, fontSize: 9 },
  });

  for (const slide of presentation.slides) {
    addSlide(pptx, slide, theme);
  }

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return Buffer.from(data);
}

function addSlide(pptx: PptxDeck, slide: ResolvedSlide, theme: SlideTheme): void {
  const isCover = slide.layout === 'title' || slide.layout === 'closing';
  const s = isCover ? pptx.addSlide() : pptx.addSlide({ masterName: 'FIELDNOTE_BODY' });

  if (isCover) {
    s.background = { color: theme.cover };
    s.addText(slide.title, {
      x: 0.7,
      y: 1.9,
      w: 8.6,
      h: 1.3,
      fontSize: 34,
      bold: true,
      color: theme.coverInk,
      fontFace: theme.headingFont,
      valign: 'middle',
    });
    if (slide.subtitle) {
      s.addText(slide.subtitle, {
        x: 0.7,
        y: 3.1,
        w: 8.6,
        h: 0.6,
        fontSize: 15,
        color: theme.coverMuted,
        fontFace: theme.bodyFont,
      });
    }
    if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
    return;
  }

  s.addText(slide.title, {
    x: 0.5,
    y: 0.38,
    w: 9,
    h: 0.6,
    fontSize: 24,
    bold: true,
    color: theme.title,
    fontFace: theme.headingFont,
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, { x: 0.5, y: 0.95, w: 9, h: 0.35, fontSize: 12, color: theme.muted, fontFace: theme.bodyFont });
  }

  const figure = slide.figures.find((f) => f.bytes);
  const hasImage = Boolean(figure);
  const textWidth = hasImage ? 5.2 : 9;
  let cursorY = 1.35;

  if (slide.bullets.length > 0) {
    s.addText(
      slide.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { code: '2022' }, breakLine: true },
      })),
      {
        x: 0.5,
        y: cursorY,
        w: textWidth,
        h: Math.min(3.4, 0.42 * slide.bullets.length + 0.3),
        fontSize: slide.bullets.length > 5 ? 14 : 16,
        color: theme.body,
        fontFace: theme.bodyFont,
        lineSpacingMultiple: 1.15,
        valign: 'top',
      },
    );
    cursorY += Math.min(3.4, 0.42 * slide.bullets.length + 0.3) + 0.1;
  }

  if (slide.body.code) {
    s.addText(slide.body.code.content.split('\n').slice(0, 12).join('\n'), {
      x: 0.5,
      y: cursorY,
      w: textWidth,
      h: 1.8,
      fontSize: 11,
      fontFace: theme.monoFont,
      color: theme.body,
      fill: { color: theme.surface },
      margin: 8,
      valign: 'top',
    });
    cursorY += 1.9;
  }

  if (slide.body.diagram) {
    s.addText(slide.body.diagram.ascii.split('\n').slice(0, 14).join('\n'), {
      x: 0.5,
      y: cursorY,
      w: textWidth,
      h: 2.4,
      fontSize: 10,
      fontFace: theme.monoFont,
      color: theme.body,
      valign: 'top',
    });
    cursorY += 2.5;
  }

  if (slide.body.table && slide.body.table.rows.length > 0) {
    const table = slide.body.table;
    s.addTable(
      [
        table.headers.map((h) => ({
          text: h,
          options: { bold: true, color: theme.title, fill: { color: theme.surface } },
        })),
        ...table.rows.slice(0, 8).map((row) => row.map((cell) => ({ text: String(cell), options: { color: theme.body } }))),
      ],
      {
        x: 0.5,
        y: cursorY,
        w: textWidth,
        fontSize: 11,
        fontFace: theme.bodyFont,
        border: { type: 'solid', color: theme.line, pt: 0.5 },
        autoPage: false,
      },
    );
    cursorY += 0.4 + 0.28 * Math.min(8, table.rows.length);
  }

  if (slide.body.before || slide.body.after) {
    const columns = [slide.body.before, slide.body.after].filter(Boolean) as NonNullable<typeof slide.body.before>[];
    columns.forEach((column, index) => {
      const x = 0.5 + index * 4.6;
      s.addText(column.heading, { x, y: cursorY, w: 4.3, h: 0.35, fontSize: 14, bold: true, color: theme.accent, fontFace: theme.bodyFont });
      s.addText(
        column.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, breakLine: true } })),
        { x, y: cursorY + 0.4, w: 4.3, h: 2.2, fontSize: 13, color: theme.body, fontFace: theme.bodyFont, valign: 'top' },
      );
    });
  }

  if (slide.body.columns?.length) {
    slide.body.columns.slice(0, 2).forEach((column, index) => {
      const x = 0.5 + index * 4.6;
      s.addText(column.heading, { x, y: cursorY, w: 4.3, h: 0.35, fontSize: 14, bold: true, color: theme.accent, fontFace: theme.bodyFont });
      s.addText(
        column.bullets.map((b) => ({ text: b, options: { bullet: { code: '2022' }, breakLine: true } })),
        { x, y: cursorY + 0.4, w: 4.3, h: 2.2, fontSize: 13, color: theme.body, fontFace: theme.bodyFont, valign: 'top' },
      );
    });
  }

  if (figure?.bytes) {
    const box = { x: 5.9, y: 1.35, w: 3.6, h: 3.0 };
    const fitted = fitBox(figure.width, figure.height, box.w, box.h);
    const imageX = box.x + (box.w - fitted.w) / 2;
    s.addImage({
      data: `data:${figure.mimeType};base64,${figure.bytes.toString('base64')}`,
      x: imageX,
      y: box.y,
      w: fitted.w,
      h: fitted.h,
    });
    // pptxgenjs cannot put a border on an image, so the rule is an unfilled
    // rectangle laid over it. Without one a white-backgrounded screenshot —
    // which is most of them — disappears into a white slide.
    s.addShape('rect', {
      x: imageX,
      y: box.y,
      w: fitted.w,
      h: fitted.h,
      fill: { type: 'none' },
      line: { color: theme.line, width: 0.75 },
    });
    s.addText(figure.caption, {
      x: box.x,
      y: box.y + fitted.h + 0.08,
      w: box.w,
      h: 0.3,
      fontSize: 9,
      italic: true,
      color: theme.muted,
      align: 'center',
      fontFace: theme.bodyFont,
    });
  }

  if (slide.speakerNotes) s.addNotes(slide.speakerNotes);
}

function fitBox(width: number | null, height: number | null, maxW: number, maxH: number): { w: number; h: number } {
  if (!width || !height) return { w: maxW, h: maxH * 0.75 };
  const scale = Math.min(maxW / width, maxH / height);
  return { w: width * scale, h: height * scale };
}
