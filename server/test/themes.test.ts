import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
import type { ResolvedPresentation, ResolvedReport } from '../src/export/document.ts';

/**
 * Themes must reach the bytes.
 *
 * A theme picker that only changes a preview is worse than no picker, so these
 * tests assert that choosing a theme actually changes the exported file — and
 * that the same theme produces a recognisably consistent result across DOCX,
 * PDF, HTML and PPTX.
 */

function reportFixture(theme: string): ResolvedReport {
  return {
    kind: 'report',
    id: 'rpt_1',
    title: 'Themed Report',
    subtitle: 'Testing visual themes',
    author: 'Test Author',
    projectTitle: 'Theme Project',
    templateKey: 'technical',
    theme,
    generatedAt: new Date('2026-01-01').toISOString(),
    meta: { tone: 'technical', audience: 'technical-team', depth: 3, version: 1 },
    figures: new Map(),
    sections: [
      {
        key: 'executive-summary',
        heading: 'Executive Summary',
        blocks: [
          { type: 'paragraph', text: 'A paragraph of body text.' },
          { type: 'callout', variant: 'inference', text: 'Something the model inferred.' },
          { type: 'callout', variant: 'recommendation', text: 'Something the model advises.' },
          { type: 'code', language: 'bash', content: 'systemctl restart apache2' },
          { type: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
        ],
      },
    ],
  };
}

function deckFixture(theme: string): ResolvedPresentation {
  return {
    kind: 'presentation',
    id: 'prs_1',
    title: 'Themed Deck',
    subtitle: null,
    presenter: 'Test Author',
    projectTitle: 'Theme Project',
    generatedAt: new Date('2026-01-01').toISOString(),
    theme,
    slides: [
      {
        id: 'sld_1',
        position: 0,
        layout: 'title',
        title: 'Themed Deck',
        subtitle: 'Subtitle',
        bullets: [],
        body: {},
        speakerNotes: 'Opening remarks.',
        figures: [],
      },
      {
        id: 'sld_2',
        position: 1,
        layout: 'bullets',
        title: 'Content',
        subtitle: null,
        bullets: ['First point', 'Second point'],
        body: {},
        speakerNotes: 'Say more about the points.',
        figures: [],
      },
    ],
  };
}

describe('visual themes', () => {
  it('offers a theme registry for both reports and decks', async () => {
    const { THEMES, themesFor, getTheme } = await import('../src/export/themes.ts');
    assert.ok(THEMES.length >= 4, 'there should be a real choice of themes');
    assert.ok(themesFor('report').length >= 4);
    assert.ok(themesFor('presentation').length >= 4);

    // An unknown key must never break a render.
    assert.equal(getTheme('no-such-theme').key, THEMES[0]!.key);
    assert.equal(getTheme(null).key, THEMES[0]!.key);

    for (const theme of THEMES) {
      assert.ok(theme.name && theme.description, `${theme.key} needs a name and description`);
      for (const [field, value] of Object.entries(theme.palette)) {
        assert.match(value, /^[0-9A-Fa-f]{6}$/, `${theme.key}.${field} must be a bare hex triplet`);
      }
    }
  });

  it('changes the DOCX bytes when the theme changes', async () => {
    const { renderReportDocx } = await import('../src/export/docx.ts');
    const slate = await renderReportDocx(reportFixture('slate'));
    const academic = await renderReportDocx(reportFixture('academic'));
    const forest = await renderReportDocx(reportFixture('forest'));

    for (const buffer of [slate, academic, forest]) {
      assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK', 'DOCX must be a valid zip');
      assert.ok(buffer.length > 5000);
    }
    assert.notEqual(slate.toString('base64'), academic.toString('base64'), 'themes must reach the file');
    assert.notEqual(slate.toString('base64'), forest.toString('base64'));
  });

  it('changes the PDF bytes when the theme changes, and stays a valid PDF', async () => {
    const { renderReportPdf } = await import('../src/export/pdf.ts');
    const slate = await renderReportPdf(reportFixture('slate'));
    const midnight = await renderReportPdf(reportFixture('midnight'));

    for (const buffer of [slate, midnight]) {
      assert.equal(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.ok(buffer.length > 2000);
    }
    // Compare content, not length: two themes differ by colour values and font
    // names of the same size, so identical byte counts are entirely possible
    // and a length check would pass or fail by coincidence.
    assert.notEqual(slate.toString('base64'), midnight.toString('base64'), 'the theme must reach the PDF');
  });

  it('renders the academic theme with a serif family', async () => {
    const { renderReportHtml } = await import('../src/export/markdown.ts');
    const academic = renderReportHtml(reportFixture('academic'));
    const slate = renderReportHtml(reportFixture('slate'));

    assert.match(academic, /Cambria/, 'the academic theme is serif');
    assert.ok(!/Cambria/.test(slate), 'the slate theme is not');
    // The academic theme drops the rule under section headings.
    assert.match(academic, /border-bottom:0/);
    assert.match(slate, /border-bottom:1px solid var\(--line\)/);
  });

  it('carries the theme accent into the HTML for every theme', async () => {
    const { renderReportHtml } = await import('../src/export/markdown.ts');
    const { THEMES } = await import('../src/export/themes.ts');

    for (const theme of THEMES) {
      const html = renderReportHtml(reportFixture(theme.key));
      assert.match(html, /^<!doctype html>/i);
      assert.ok(
        html.includes(`--accent:#${theme.palette.accent}`),
        `${theme.key} accent should appear in the stylesheet`,
      );
      assert.ok(html.includes(`cover ${theme.cover}`), `${theme.key} cover treatment should be applied`);
    }
  });

  it('produces a valid, theme-varying PPTX', async () => {
    const { renderPresentationPptx } = await import('../src/export/pptx.ts');
    const slate = await renderPresentationPptx(deckFixture('slate'));
    const ember = await renderPresentationPptx(deckFixture('ember'));

    for (const buffer of [slate, ember]) {
      assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK');
      assert.ok(buffer.length > 10_000);
    }
    assert.notEqual(slate.toString('base64'), ember.toString('base64'));
  });

  it('applies the deck theme to the presentation PDF, not just the PPTX', async () => {
    const { renderPresentationPdf } = await import('../src/export/pdf.ts');
    const slate = await renderPresentationPdf(deckFixture('slate'));
    const forest = await renderPresentationPdf(deckFixture('forest'));

    assert.equal(slate.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.equal(forest.subarray(0, 5).toString('ascii'), '%PDF-');
    // The title slide is painted in the theme's cover colour, so the content
    // stream differs even though the text is identical.
    assert.notEqual(slate.toString('base64'), forest.toString('base64'));
  });

  it('exposes themes through the templates endpoint', async () => {
    const { buildApp } = await import('../src/app.ts');
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/templates' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.ok(Array.isArray(body.themes.report));
      assert.ok(Array.isArray(body.themes.presentation));

      const first = body.themes.report[0];
      assert.ok(first.key && first.name && first.description);
      assert.match(first.accent, /^#[0-9A-Fa-f]{6}$/, 'the client receives CSS-ready colours');
    } finally {
      await app.close();
    }
  });
});
