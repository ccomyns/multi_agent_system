import { Sidebar } from "@/components/sidebar";

const SLIDES = [1, 2] as const;

export default function SlideDeckBuilderPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body slide-builder-shell">
        <main className="slide-builder-main">
          <section className="slide-canvas" aria-labelledby="slide-canvas-title">
            <div className="slide-canvas-heading">
              <div>
                <span className="eyebrow">Presentation canvas</span>
                <h1 id="slide-canvas-title">Untitled deck</h1>
              </div>
              <span className="slide-count">2 slides</span>
            </div>

            <div className="slide-stack">
              {SLIDES.map((slideNumber) => (
                <div className="slide-row" key={slideNumber}>
                  <span className="slide-number" aria-hidden="true">
                    {slideNumber}
                  </span>
                  <article
                    className="presentation-slide"
                    aria-label={`Blank slide ${slideNumber}`}
                  />
                </div>
              ))}
            </div>
          </section>

          <aside className="slide-brief-panel" aria-label="Slide deck brief">
            <div className="slide-brief-field slide-brief-field-only">
              <label className="sr-only" htmlFor="deck-vision">
                Task or vision
              </label>
              <textarea
                id="deck-vision"
                placeholder="Describe the audience, objective, key message, visual style, and any must-have slides…"
              />
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
