# canvas-idea

A local tldraw canvas that you use in the browser **and** your coding agent edits over MCP.
The server owns the canvas (SQLite), so the agent can read and edit it with the browser closed.

```
agent --MCP (HTTP)--> server (TLSocketRoom + SQLite) <--WebSocket-- browser (normal tldraw)
                                ^
                                +-- POST /api/context: selection + viewport from the browser
```

## Run

```sh
pnpm install
pnpm dev          # web http://localhost:5173 (use this one), server on :5858
# or production-style:
pnpm build && pnpm start   # everything on http://localhost:5858
# or Docker:
docker compose up --build
```

## Connect your agent

```sh
claude mcp add --transport http canvas http://localhost:5858/mcp
```

Tools: `get_context`, `get_canvas`, `get_changes`, `list_annotations`, `reply_to_annotation`, `resolve_annotation`,
`add_text_block`, `create_shapes`, `update_shapes`, `delete_shapes`, `view_image`, `add_media`.

`add_media` takes PNG, JPEG, GIF, WebP, MP4 or WebM from a local `path`, a `url` (the server downloads it) or `base64`.
Sample files to try it with are in `examples/media/`. Only images can be *viewed* by the agent (`view_image`).

**Staying in sync:** every read is live, and every result ends with `canvas.clock` and `canvas.openAnnotations`. The agent
passes its last clock to `get_changes` to see what the user added, edited, moved or deleted since.
The server also sends usage instructions to the agent on connect (see `INSTRUCTIONS` in `server/src/mcp.ts`).

## Talking to the agent: annotations

Click **Annotate** (top right). Select shapes first (yours, the agent's, images) to aim the note at them; a dashed
arrow links it. The agent reads open annotations, answers with a violet block placed next to it, and marks it
answered (dimmed). Editing an answered annotation reopens it. Everything the agent creates has `meta.author = 'agent'`.
New content is auto-placed in free space so it never overlaps existing shapes.

## Data

`.data/` (or `/data` in Docker): `canvas.db` (document), `ui-context.json` (last selection/viewport), `uploads/`.

## Security

Binds to 127.0.0.1 and rejects unknown `Host` headers. There is no auth: do not expose it beyond localhost
without adding some. Extra hosts: `ALLOWED_HOSTS=a.local,b.local`.

tldraw needs a license key for production use (the watermark shows without one).
