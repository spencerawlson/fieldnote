import { useEffect, useState } from 'react';
import { api, type TemplateInfo } from '../lib/api.ts';
import { Card, CardHead } from '../components/ui.tsx';

export function TemplatesPage() {
  const [data, setData] = useState<{ reports: TemplateInfo[]; presentations: TemplateInfo[] } | null>(null);

  useEffect(() => {
    void api
      .get<{ reports: TemplateInfo[]; presentations: TemplateInfo[] }>('/api/templates')
      .then(setData)
      .catch(() => setData({ reports: [], presentations: [] }));
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>Templates</h1>
      </div>
      <div className="content stack loose">
        <p className="small muted" style={{ maxWidth: '60ch' }}>
          Templates decide which sections a document has and what each is for. They never supply content — if
          your project holds nothing for a section, the section says so rather than being filled with plausible
          prose.
        </p>

        <section className="stack">
          <h2>Report templates</h2>
          <div className="grid two">
            {data?.reports.map((template) => (
              <Card key={template.key}>
                <CardHead title={template.name} subtitle={`${template.defaultTone} · ${template.defaultAudience}`} />
                <div className="card-body stack tight">
                  <p className="small muted">{template.description}</p>
                  <div className="row wrap" style={{ gap: '0.25rem' }}>
                    {template.sections?.map((section) => (
                      <span
                        key={section.key}
                        className="badge"
                        title={section.derived ? 'Assembled from your project records' : 'Written by the AI from your project'}
                      >
                        {section.heading}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>

        <section className="stack">
          <h2>Presentation templates</h2>
          <div className="grid two">
            {data?.presentations.map((template) => (
              <Card key={template.key}>
                <CardHead title={template.name} subtitle={`${template.slideCount} slides · ${template.defaultAudience}`} />
                <div className="card-body stack tight">
                  <p className="small muted">{template.description}</p>
                  <div className="row wrap" style={{ gap: '0.25rem' }}>
                    {template.slides?.map((slide) => (
                      <span key={slide.key} className="badge">
                        {slide.title}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
