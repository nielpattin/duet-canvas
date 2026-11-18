# canvas-idea

A local tldraw canvas that you use in the browser **and** your coding agent edits over MCP.
The server owns the canvas (SQLite), so the agent can read and edit it with the browser closed.

Any MCP client (Claude Code, omp, ...) can connect to it. The web app also has a built-in chat panel that drives [omp](https://github.com/can1357/oh-my-pi). You draw, mark things you want help with, and the agent answers next to them on the canvas.

Status: early (0.1). Expect rough edges. It is a local, single-user tool.

```
agent --MCP (HTTP)--> server (TLSocketRoom + SQLite) <--WebSocket-- browser (normal tldraw)
                                ^
                                +-- POST /api/context: selection + viewport from the browser
```

## Requirements

- Node.js 24 (the server runs TypeScript directly) and pnpm 12.
- A browser tab open on the app, for `capture` (tldraw renders only in a browser).
- Optional: [omp](https://github.com/can1357/oh-my-pi) on your `PATH` for the in-app chat. Not needed if you only connect an MCP client.
- Optional: Docker, to run the server without Node.

## Run

```sh
git clone <this repo> && cd canvas-idea
pnpm install
pnpm dev          # web http://localhost:5173 (use this one), server on :5858
# or production-style:
pnpm build && pnpm start   # everything on http://localhost:5858
# or Docker:
docker compose up --build
```

## Agent chat (native only)

The web app has an **Agent chat** panel that drives your own `omp` over its RPC mode (omp must be on your `PATH`, or set `OMP_BIN`). The server starts omp on first use and keeps it alive.

```
browser --WS /chat?token--> server --stdio JSONL--> omp --mode rpc --MCP http--> server (canvas)
```

### Run it with the CLI

```sh
pnpm add -g .            # once, from this repo: puts `canvas-idea` on your PATH (pnpm 12 has no `link --global`)
canvas-idea              # start in the foreground and print the unlock link
canvas-idea start -d     # run in the background (log: <data dir>/canvas-idea.log)
canvas-idea status | stop | url | token | rotate
canvas-idea start --port 5859 --data-dir D:\canvas
```

`start` builds `web/dist` if it is missing and prints a link ending in `?chat=<token>`. Open that link once (or paste it, or the bare `canvas-idea token`, into the locked chat panel) and the server gives the browser an HttpOnly cookie. Cookies ignore the port, so one unlock also covers the Vite dev server on the same host (`localhost` and `127.0.0.1` count as different hosts). Without it the chat shows "locked" and `/chat` refuses the socket. The token lives in `<data dir>/chat-token`.

**If the token or its link leaks** (a screenshot, a shared terminal or log), run `canvas-idea rotate`. It writes a new token; the running server reads the file on every check, so the old token stops working at once without a restart: old links, browsers' saved unlock and open chats are cut (the panel shows "locked" until you open the new link, which `canvas-idea url` prints again). Deleting `<data dir>/chat-token` by hand does the same. `start -d` keeps the token out of `canvas-idea.log` (run `canvas-idea url` for the link); entries from older versions are dead after a rotate.

### What it does

- **Docker has no chat.** A container cannot see your omp, so the button is hidden there (the image sets `CANVAS_DOCKER=1`). Docker stays the way to give MCP clients the canvas.
- **The chat agent only has the canvas tools.** omp runs with `--no-tools`, `tools.xdev: false`, no extensions/skills/rules/context files, and `--yolo`: no bash, edit, eval or filesystem access. Servers from your own `~/.omp/agent/mcp.json` are switched off for the chat (a project-level `enabled: false` stub per name); a warning shows if any other tool still gets through.
- **Keys** (same as omp): Enter sends, and steers a running agent; Alt+Enter queues a follow-up for after the run; Esc stops (queued text returns to the box). Queued messages show as chips.
- **Model and effort** come from omp. The picker shows one provider at a time with a search across all. Changing either mid-chat keeps the same session; the provider's prompt cache restarts for that turn.
- **Images:** attach, paste or drop (PNG, JPEG, GIF, WebP, up to 6, shrunk to 2000px).
- **Cost and context** of the current chat show under the box (spend, tokens in context; the bar turns amber, then red).
- **Chats** are omp sessions in `<data dir>/sessions`. **History** lists and reopens them; **New chat** starts a new session and keeps the old file. Long chats render the newest 30 messages and load more as you scroll up.
- **Marks:** Ctrl+M marks the selection, Shift+M jumps to the next open mark, **Ask agent** (pill and context menu) prompts the agent, **Clear answered marks** tidies up.
- The panel follows tldraw's light/dark/system theme.

## Connect your agent

**omp:** add the server to `.omp/mcp.json` in your project, or to `~/.omp/agent/mcp.json` to have it everywhere. This repo already ships the project-level file, so omp started here just works.

```json
{
  "mcpServers": {
    "canvas": { "type": "http", "url": "http://127.0.0.1:5858/mcp", "enabled": true }
  }
}
```

**Claude Code:**

```sh
claude mcp add --transport http canvas http://localhost:5858/mcp
```

**Codex:**

```sh
codex mcp add canvas --url http://localhost:5858/mcp
```

**OpenCode:** add this to `opencode.json` in your project (or your global OpenCode config):

```json
{
  "mcp": {
    "canvas": { "type": "remote", "url": "http://localhost:5858/mcp", "enabled": true }
  }
}
```

Any other MCP client that speaks streamable HTTP works with the same URL.

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

Everything the agent creates has `meta.author = 'agent'`. Its text blocks wear a small purple spark icon in the corner and its pictures
have one before the caption, so you can tell its words and media from yours. Diagram shapes and arrows are not badged. New content is auto-placed in free space so it never overlaps existing shapes.

## Media cards

Pictures, GIFs and videos are one shape (`media-card`): the media plus an editable caption that always moves, resizes and
deletes with it. Pictures you drop or paste are turned into cards too. Double-click a card (or press Enter) to edit its caption.
The shape is defined twice, in `server/src/mediaCard.ts` and `web/src/mediaCard.tsx`: keep them in sync.

## Data

Your OS data dir, or `DATA_DIR` (`/data` in Docker): `canvas.db` (document), `ui-context.json` (last selection/viewport), `uploads/`, and for the chat `sessions/` and `workspace/`.
The default is `%APPDATA%\canvas-idea` on Windows, `~/Library/Application Support/canvas-idea` on macOS and `$XDG_DATA_HOME` (or `~/.local/share`)`/canvas-idea` on Linux. It used to be `.data/` next to where you ran the server: move it over to keep an old canvas.

## Security

Binds to 127.0.0.1 and rejects unknown `Host` headers and cross-origin requests. Extra hosts: `ALLOWED_HOSTS=a.local,b.local`.

- **The MCP endpoint (`/mcp`) and the canvas have no auth.** Anyone who can reach the port can read and edit the canvas. Do not expose it beyond localhost without putting authentication in front of it (the Docker compose file publishes the port on loopback only).
- **The chat is protected by a token** (see above), because it drives an agent on your machine. Never share the unlock link; run `canvas-idea rotate` if it leaks.
- The chat agent runs with `--yolo` but only has the canvas tools. Your own omp MCP servers are switched off for it.

## Development

```sh
pnpm typecheck                 # all packages
pnpm --filter server test      # server unit tests
pnpm --filter web build        # rebuild web/dist (the server serves the built files)
```

`server/` is the Hono + MCP + tldraw sync server, `web/` is the Vite/React app, `bin/` is the `canvas-idea` CLI.

## License

canvas-idea is [MIT](LICENSE).

[tldraw](https://tldraw.dev), which it is built on, is not open source and has its own license. Its SDK needs a license for production use; without a key it shows a "Made with tldraw" watermark. See the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) before you deploy this or build on it. This repo does not include a tldraw license key.
