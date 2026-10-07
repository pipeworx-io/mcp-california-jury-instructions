# @pipeworx/california-jury-instructions

Official California jury instructions as adopted by the Judicial Council of
California — CACI (civil, e.g. "303" = Breach of Contract—Essential Factual
Elements) and CALCRIM (criminal, e.g. "200" = Duties of Judge and Jury),
current (2026) edition, full instruction text with Directions for Use/Bench
Notes, Sources and Authority/Authority, and revision history.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1715+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `caci_lookup(number)` — full official text of one CACI (civil) instruction or
  verdict form by number ("303", "VF-303"): instruction text, Directions for
  Use, Sources and Authority, Secondary Sources, revision history.
- `calcrim_lookup(number)` — full official text of one CALCRIM (criminal)
  instruction or verdict form by number ("200", "VF-200"): instruction text,
  Bench Notes (incl. Instructional Duty), Authority, Related Issues, Secondary
  Sources, Commentary where present, revision history.
- `ca_ji_search(query, set?)` — find the official instruction NUMBER for a
  claim or charge by keyword ("breach of contract" -> CACI No. 303), across
  CACI, CALCRIM, or both. Title search, not full-text search.
- `ca_ji_editions(set?)` — current edition year/adoption date and archived
  edition PDF links for either or both sets.

## Auth

Keyless. This reads the Judicial Council's own published, public PDFs — not a
third-party API, no registration of any kind.

## Data sources

- <https://www.courts.ca.gov/system/files/file/judicial_council_of_california_civil_jury_instructions_2026.pdf>
  — CACI (civil), current 2026 edition, the single source for every
  `caci_lookup` response.
- <https://courts.ca.gov/system/files/file/calcrim-2026.pdf> — CALCRIM
  (criminal), current 2026 edition, the single source for every
  `calcrim_lookup` response.
- <https://courts.ca.gov/partners/juryinstructions.htm> — the Judicial
  Council's own index page linking to both resource centers, current editions,
  and archived editions back to ~2019-2021 (surfaced via `ca_ji_editions`, not
  text-extracted).

### Why this pack bakes the index instead of fetching per call

Both editions are published as ONE full-edition PDF — CACI 2026 is ~3,560
pages/11MB, CALCRIM 2026 is ~2,680 pages/84MB. There is no per-instruction
endpoint, and parsing either document takes tens of seconds even outside a
Worker, so `scripts/bake-index.mjs` downloads and parses both ONCE (re-run when
a new edition is adopted, roughly annually) into `src/ca-ji-index-data.ts`,
which the gateway uploads to KV and injects as `args._bakedIndex` on first call
per isolate — see that script's header and `src/index.ts`'s top comment for the
full mechanism (same pattern as `south-dakota-code`, `hawaii-code`).

**`shared/src/pdf-text.ts` does not work on these PDFs.** Tested directly
against the real CACI PDF: it silently drops every inter-word space (this
typesetter encodes word gaps as TJ-array kerning adjustments, not space
glyphs — e.g. `"Thiseditionof CACI includes..."`) and mis-decodes several
ligatures (fi/fl -> "®", en-dash -> "±") via subsetted font encodings outside
its documented scope. `pdftotext` (poppler-utils) reconstructs spacing
correctly via real glyph positioning and is used instead — a **build-time
dependency only**; the Worker never runs the bake script. Re-running it (to
pick up a new edition) needs `pdftotext` on the machine that runs it
(`brew install poppler` / `apt install poppler-utils`).

**Parsing approach**: both documents' running headers name the instruction on
every content page ("CACI No. 303", "CALCRIM No. 200"), and every
series/category has its own divider page listing every instruction number +
official title — used as the ground-truth index, independent of body-text
parsing. Verified 2026-10-07 against the live 2026 editions: CACI 1,140/1,140
ground-truth numbers accounted for (1 — #4001 — correctly revoked, not a parse
gap); CALCRIM 780/780, 100%.

**Known limits** (said plainly, not papered over):
- Only the CURRENT edition's text is baked. Archived editions (back to
  ~2019-2021) are linked by URL via `ca_ji_editions`, not text-extracted —
  a past edition's exact wording is not retrievable from this pack.
- "Proposed revisions" (the Council's separate public-comment process for
  pending changes) are NOT covered at all. Everything served is ADOPTED,
  in-force text (`status: "adopted"` on every successful lookup).
- `ca_ji_search` matches official instruction/verdict-form TITLES and series
  names, not full instruction body text.

**Licensing**: both documents carry an explicit reprint grant on their own
copyright page — "In accord with Cal. Rules of Court, Rule 2.1050(c), these
instructions and verdict forms are freely available for use and reproduction,
with appropriate citation to this publication." This pack cites the
publication via `source`/`source_url` on every response.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "california-jury-instructions": {
      "url": "https://gateway.pipeworx.io/california-jury-instructions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/california-jury-instructions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1715+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/caci_lookup \
  -H 'Content-Type: application/json' \
  -d '{"number":"303"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/caci_lookup`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "california-jury-instructions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-california-jury-instructions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-california-jury-instructions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about California Jury Instructions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
