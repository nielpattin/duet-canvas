# Agent instructions

## After every change: rebuild

The server serves the built `web/dist`, and `duet-canvas start` only builds it when it is missing. After changing anything under `web/`, rebuild it:

```sh
pnpm -r typecheck
pnpm --filter web build
```

Never stop or restart the server: the user runs it. If a change needs a restart (`server/` or `bin/`), say so instead.

## tldraw

Read the tldraw docs (https://tldraw.dev) before building UI on the canvas. Controls that belong to a shape go inside that shape's `ShapeUtil.component` (`pointerEvents: 'all'` + `onPointerDown={stopEventPropagation}`, as in https://tldraw.dev/examples/interactive-shape). Never put them in a floating overlay. Marks are tldraw `note` shapes, drawn by `MarkNoteShapeUtil` in `web/src/markAssist.tsx`.
