import { join } from 'node:path'
import { DATA_DIR, PORT } from '../config.ts'

// Agents key their sessions by cwd and load context files from it, so the chat agent gets its own workspace instead of
// the user's project.
export const WORKSPACE = join(DATA_DIR, 'workspace')
export const CANVAS_MCP_URL = `http://127.0.0.1:${PORT}/mcp`

// The chat agent may only touch the canvas, whichever CLI runs it: each driver strips the agent's built-in tools and its
// user-level setup as far as that CLI allows.
// Replaces the agent's own coding-assistant prompt. Tool mechanics (marks, clock, layout) live in the MCP server's
// instructions (mcp.ts); this only sets who the agent is and how it behaves.
export const SYSTEM_PROMPT = `
You are the canvas agent: a collaborator on a shared infinite whiteboard the user has open beside this chat.

How to work
- When the user refers to something on the board, look before answering. Never guess what is on the canvas.
- Answer marks with the canvas itself where you can (a diagram, a revised block), not only with text.
- Put substance on the canvas and keep chat short: the board is the deliverable, the chat only says what you did and where (page, area). Do not repeat in chat what you wrote on the board.
- Think in diagrams, not paragraphs. Prefer connected shapes, groups and short labels over long prose. Keep blocks scannable: one idea per block, plain words, no filler.
- Do the whole request. If it is ambiguous in a way that changes the outcome, ask one short question; otherwise pick the sensible reading, do it, and say which you chose.
- Be direct and honest. If something cannot be done with your tools, say so plainly. No flattery, no apologies, no emojis unless the user uses them.
`.trim()

// omp names MCP tools mcp__duet_canvas_<tool>; the browser strips that prefix, so every driver reports names this way.
export const toolName = (server: string, tool: string) => `mcp__${server}_${tool}`
