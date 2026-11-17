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

Tools: `get_context`, `get_canvas` (one page at a time), `get_changes`, `list_marks`, `reply_to_mark`, `resolve_mark`,
`add_text_block`, `capture`, `create_page`, `create_shapes`, `update_shapes`, `delete_shapes`, `view_image`, `add_media`.

`add_media` takes PNG, JPEG, GIF, WebP, MP4 or WebM from a local `path`, a `url` (the server downloads it) or `base64`.
Sample files to try it with are in `examples/media/`. Only images can be *viewed* by the agent (`view_image`).

**Seeing the canvas:** `get_canvas` returns data. `capture` renders chosen shapes (`shapeIds`) or an area (`bounds`, on any `pageId`) to a PNG. It is read-only and never touches anyone's selection, camera or page. tldraw can only render inside a browser, so a tab must be open on the app.

**Staying in sync:** every read is live, and every result ends with `canvas.clock` and `canvas.openMarks`. The agent
passes its last clock to `get_changes` to see what the user added, edited, moved or deleted since.
The server also sends usage instructions to the agent on connect (see `INSTRUCTIONS` in `server/src/mcp.ts`).

## Talking to the agent: marks

Pick the **Mark** tool in the toolbar (pin icon, key `m`) and click any shape, picture or agent block: a pink note opens
attached to it with a dashed arrow. Click empty canvas for a free note. The agent reads open marks, answers with a violet
block placed next to the mark, and marks it answered (dimmed). Editing an answered mark reopens it. The top-right pill
shows `N items · M open marks`.

To mark several shapes at once, select them, right-click and choose **Mark selection**. A dashed pink box is drawn around the selection and one arrow joins the note to it. The box follows the shapes when you move them. When the agent answers, the box turns violet and the answer arrow points at it. `list_marks` returns the box as `selection` (x, y, w, h).

To give feedback on an answer, click the violet box (its border) or the agent's reply, then choose **Mark selection** (or use the Mark tool on the reply). Feedback on the box reuses it: the box turns pink again until the agent answers. The box cannot be moved by hand; it always wraps its shapes. `list_marks` adds `thread` (what you wrote, what the agent answered, and the box, oldest first) so the agent sees the earlier turns.

Everything the agent creates has `meta.author = 'agent'`. Its text blocks wear a small purple ✦ in the corner and its pictures
have a ✦ before the caption, so you can tell its words and media from yours. Diagram shapes and arrows are not badged. New content is auto-placed in free space so it never overlaps existing shapes.

## Media cards

Pictures, GIFs and videos are one shape (`media-card`): the media plus an editable caption that always moves, resizes and
deletes with it. Pictures you drop or paste are turned into cards too. Double-click a card (or press Enter) to edit its caption.
The shape is defined twice, in `server/src/mediaCard.ts` and `web/src/mediaCard.tsx`: keep them in sync.

## Data

`.data/` (or `/data` in Docker): `canvas.db` (document), `ui-context.json` (last selection/viewport), `uploads/`.

## Security

Binds to 127.0.0.1 and rejects unknown `Host` headers. There is no auth: do not expose it beyond localhost
without adding some. Extra hosts: `ALLOWED_HOSTS=a.local,b.local`.

tldraw needs a license key for production use (the watermark shows without one).
