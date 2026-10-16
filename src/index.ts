interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * California Jury Instructions — CACI (civil) and CALCRIM (criminal),
 * official text as adopted by the Judicial Council of California. Fleet #2785.
 *
 * SOURCE AND SHAPE. The Judicial Council publishes CACI and CALCRIM each as
 * ONE full-edition PDF (courts.ca.gov/partners/juryinstructions.htm) — CACI
 * 2026 is ~3,560 pages, CALCRIM 2026 is ~2,680 pages. There is no
 * per-instruction endpoint, and parsing either document takes tens of
 * seconds, far past what a single Worker request can afford — so every
 * instruction's text is baked ONCE (scripts/bake-index.mjs, re-run when a new
 * edition is adopted — see its own header for why pdftotext/poppler is
 * required instead of shared/src/pdf-text.ts) into src/ca-ji-index-data.ts,
 * which lives in KV (never module scope — see the NEVER-value-import comment
 * below) and is injected by the gateway as `args._bakedIndex` on first call
 * per isolate (workers/gateway/src/pack-baked-indexes.json registers this
 * pack, same pattern as south-dakota-code / hawaii-code).
 *
 * LICENSING. Both documents carry an explicit reprint grant on their own
 * copyright page (Cal. Rules of Court, Rule 2.1050(c)) — the instructions,
 * verdict forms, Directions for Use / Bench Notes, and Sources and
 * Authority / Authority are "freely available for use and reproduction,
 * with appropriate citation to this publication." This pack cites the
 * publication on every response via `source` and `data_as_of`.
 *
 * ADOPTED TEXT ONLY. Everything served here is the Judicial Council's
 * ADOPTED, in-force text for the current edition (`status: "adopted"`). The
 * Council's separate "invitations to comment" (proposed revisions open for
 * public comment) are NOT covered — they are a different, pre-adoption
 * process the Council runs on its own schedule, and baking a point-in-time
 * snapshot of pending proposals would go stale fast with no refresh signal.
 * A number that was revoked or is reserved for future use (one case in the
 * 2026 CACI edition: 4001) returns `status: "revoked_or_reserved"` with no
 * text, never a silent not-found.
 *
 * ARCHIVED EDITIONS are linked by URL (ca_ji_editions) back to ~2019-2021,
 * not text-extracted — only the current edition's text is baked. Versioned
 * retrieval of a PAST edition's exact wording is therefore not available
 * from this pack; the tool descriptions say so rather than silently serving
 * current text under an old year.
 *
 * FIVE TOOLS:
 *   - caci_lookup(number)      -> one CACI (civil) instruction/verdict form, full text
 *   - calcrim_lookup(number)   -> one CALCRIM (criminal) instruction/verdict form, full text
 *   - ca_ji_search(query, set) -> find the official instruction for a claim/charge by
 *     keyword, across official titles (and verdict-form titles) in either or
 *     both sets — e.g. "breach of contract" -> CACI No. 303.
 *   - ca_ji_whats_new(set, edition) -> aggregate list of instructions new or
 *     revised in an edition (fleet #3171) — e.g. CALCRIM 2026 -> No. 1808
 *     (Organized Retail Theft), 3235, 3238, 3459.
 *   - ca_ji_editions(set)      -> current edition metadata + archived edition links.
 *
 * Keyless, no signup — this is a read of the Council's own published, public
 * text, not a third-party API.
 */
import type { CaJiRecord, CaJiEditionRef, CaJiPriorDeltaRecord } from './ca-ji-index-data.js';

// fleet #2785, same reasoning as south-dakota-code/fleet #2754: the baked
// table (~14MB combined) lives in KV, not in every gateway isolate's memory.
// NEVER value-import ./ca-ji-index-data.js here — a type-only import (above)
// is erased at build time; a value import puts the whole table back into
// every isolate and will fail the deploy's bundle-size ceiling.
let CACI: CaJiRecord[] = [];
let CALCRIM: CaJiRecord[] = [];
let CAPTURED_AT = '';
let CACI_EDITION_META: { year: number; adopted: string } | null = null;
let CALCRIM_EDITION_META: { year: number; adopted: string } | null = null;
let CACI_CURRENT_URL = '';
let CALCRIM_CURRENT_URL = '';
let CACI_ARCHIVED: CaJiEditionRef[] = [];
let CALCRIM_ARCHIVED: CaJiEditionRef[] = [];
let CACI_PRIOR_YEAR: number | null = null;
let CACI_PRIOR_CHANGED_NUMBERS: Set<string> = new Set();
let CACI_PRIOR_DELTA: Map<string, CaJiPriorDeltaRecord> = new Map();

function ensureIndex(args: Record<string, unknown>): void {
  if (CACI.length && CALCRIM.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const caci = idx?.CACI_INSTRUCTIONS;
  const calcrim = idx?.CALCRIM_INSTRUCTIONS;
  const capturedAt = idx?.CA_JI_CAPTURED_AT;
  if (!Array.isArray(caci) || !Array.isArray(calcrim) || caci.length === 0 || calcrim.length === 0 || typeof capturedAt !== 'string') {
    // Loud on purpose (silent-zero policy): answering from an empty table
    // would read as "no such instruction", a silent wrong answer, not the
    // server-side fault it actually is.
    throw new Error(
      `california-jury-instructions: the baked CACI/CALCRIM index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad instruction number — retry shortly.',
    );
  }
  CACI = caci as CaJiRecord[];
  CALCRIM = calcrim as CaJiRecord[];
  CAPTURED_AT = capturedAt;
  CACI_EDITION_META = (idx?.CACI_EDITION as { year: number; adopted: string }) ?? null;
  CALCRIM_EDITION_META = (idx?.CALCRIM_EDITION as { year: number; adopted: string }) ?? null;
  CACI_CURRENT_URL = (idx?.CACI_CURRENT_URL as string) ?? '';
  CALCRIM_CURRENT_URL = (idx?.CALCRIM_CURRENT_URL as string) ?? '';
  CACI_ARCHIVED = (idx?.CACI_ARCHIVED_EDITIONS as CaJiEditionRef[]) ?? [];
  CALCRIM_ARCHIVED = (idx?.CALCRIM_ARCHIVED_EDITIONS as CaJiEditionRef[]) ?? [];
  CACI_PRIOR_YEAR = (idx?.CACI_PRIOR_EDITION_YEAR as number) ?? null;
  const priorChanged = (idx?.CACI_PRIOR_EDITION_CHANGED_NUMBERS as string[]) ?? [];
  CACI_PRIOR_CHANGED_NUMBERS = new Set(priorChanged.map((n) => n.toUpperCase()));
  const priorDelta = (idx?.CACI_PRIOR_EDITION_DELTA as CaJiPriorDeltaRecord[]) ?? [];
  CACI_PRIOR_DELTA = new Map(priorDelta.map((r) => [r.number.toUpperCase(), r]));
}

function normalizeNumber(raw: string): string {
  return raw
    .trim()
    .replace(/^(CACI|CALCRIM)\s*(No\.?)?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function lookup(set: 'caci' | 'calcrim', rawNumber: string, rawEdition?: string) {
  const table = set === 'caci' ? CACI : CALCRIM;
  const editionMeta = set === 'caci' ? CACI_EDITION_META : CALCRIM_EDITION_META;
  const currentUrl = set === 'caci' ? CACI_CURRENT_URL : CALCRIM_CURRENT_URL;
  const publication = set === 'caci' ? 'Judicial Council of California Civil Jury Instructions (CACI)' : 'Judicial Council of California Criminal Jury Instructions (CALCRIM)';
  const toolHint = set === 'caci' ? 'calcrim_lookup' : 'caci_lookup';
  const otherSetName = set === 'caci' ? 'CALCRIM (criminal)' : 'CACI (civil)';

  if (!rawNumber || !rawNumber.trim()) {
    return {
      found: false,
      reason: 'empty_number',
      message: `${set}_lookup needs a "number", e.g. ${set === 'caci' ? '"303" (Breach of Contract) or "VF-303"' : '"200" (Duties of Judge and Jury) or "VF-200"'}.`,
    };
  }
  const number = normalizeNumber(rawNumber);
  const rec = table.find((r) => r.number.toUpperCase() === number);
  if (!rec) {
    const sameNumberOtherSet = (set === 'caci' ? CALCRIM : CACI).find((r) => r.number.toUpperCase() === number);
    return {
      found: false,
      reason: 'not_found',
      number: rawNumber,
      message: `No ${set === 'caci' ? 'CACI' : 'CALCRIM'} instruction or verdict form numbered "${rawNumber}" in the ${editionMeta?.year ?? 'current'} edition.`,
      hint: sameNumberOtherSet
        ? `"${rawNumber}" exists in ${otherSetName} instead — try ${toolHint}.`
        : `Try ca_ji_search with a keyword (e.g. the claim or charge name) to find the right number.`,
      source: publication,
      data_as_of: CAPTURED_AT,
    };
  }

  const editionArg = (rawEdition ?? '').trim();
  const wantsPriorEdition = editionArg && editionArg !== 'current' && Number(editionArg) !== (editionMeta?.year ?? NaN);
  if (wantsPriorEdition) {
    if (set !== 'caci' || Number(editionArg) !== CACI_PRIOR_YEAR) {
      return {
        found: false,
        reason: 'edition_not_available',
        number: rec.number,
        requested_edition: editionArg,
        message:
          set === 'caci'
            ? `Only the ${editionMeta?.year ?? 'current'} edition and a ${CACI_PRIOR_YEAR ?? 'prior'}-edition delta (for instructions the Council flagged as new/revised that cycle) are available — "${editionArg}" is not baked. See ca_ji_editions for a link to that year's PDF.`
            : `CALCRIM has no prior-edition text baked at all (its front matter carries no changelog this pack can key a delta from) — only the ${editionMeta?.year ?? 'current'} edition is available via calcrim_lookup. See ca_ji_editions for links to archived CALCRIM PDFs.`,
        source: publication,
        data_as_of: CAPTURED_AT,
      };
    }
    const delta = CACI_PRIOR_DELTA.get(number);
    if (!delta) {
      // Not in the Council's own changed-list for this cycle -> unchanged.
      return {
        found: true,
        status: 'adopted',
        number: rec.number,
        title: rec.title,
        edition_year: CACI_PRIOR_YEAR,
        instruction_text: rec.instruction_text,
        revision_history: rec.revision_history,
        directions_for_use: rec.directions_for_use ?? null,
        sources_and_authority: rec.sources_and_authority ?? null,
        secondary_sources: rec.secondary_sources ?? null,
        note: `CACI No. ${rec.number} was NOT on the Judicial Council's list of instructions changed for the ${editionMeta?.year ?? 'current'} edition, so its text in the ${CACI_PRIOR_YEAR} edition is identical to the current text returned here.`,
        source: publication,
        data_as_of: CAPTURED_AT,
      };
    }
    if (!delta.existed_in_prior) {
      return {
        found: true,
        status: 'not_yet_adopted',
        number: rec.number,
        title: rec.title,
        edition_year: CACI_PRIOR_YEAR,
        message: `CACI No. ${rec.number} ("${rec.title}") did not exist in the ${CACI_PRIOR_YEAR} edition — it is new for ${editionMeta?.year ?? 'the current edition'}.`,
        source: publication,
        data_as_of: CAPTURED_AT,
      };
    }
    return {
      found: true,
      status: 'adopted',
      number: rec.number,
      title: delta.title ?? rec.title,
      edition_year: CACI_PRIOR_YEAR,
      instruction_text: delta.instruction_text ?? null,
      revision_history: delta.revision_history ?? null,
      directions_for_use: delta.directions_for_use ?? null,
      sources_and_authority: delta.sources_and_authority ?? null,
      secondary_sources: delta.secondary_sources ?? null,
      note: `This is the ${CACI_PRIOR_YEAR}-edition text — the Council revised CACI No. ${rec.number} for ${editionMeta?.year ?? 'the current edition'}; call caci_lookup without an edition for the current text.`,
      source: publication,
      data_as_of: CAPTURED_AT,
    };
  }

  if (rec.status === 'revoked_or_reserved') {
    return {
      found: true,
      status: 'revoked_or_reserved',
      number: rec.number,
      title: rec.title,
      series: rec.series,
      message: `${set === 'caci' ? 'CACI' : 'CALCRIM'} No. ${rec.number} ("${rec.title}") has no current text — it was revoked or is reserved for future use in the ${editionMeta?.year ?? 'current'} edition. No in-force instruction text exists under this number.`,
      edition_year: editionMeta?.year ?? null,
      source: publication,
      source_url: currentUrl,
      data_as_of: CAPTURED_AT,
    };
  }

  const base: Record<string, unknown> = {
    found: true,
    status: 'adopted',
    number: rec.number,
    title: rec.title,
    series: rec.series,
    kind: rec.kind,
    instruction_text: rec.instruction_text,
    revision_history: rec.revision_history,
    edition_year: editionMeta?.year ?? null,
    edition_adopted: editionMeta?.adopted ?? null,
    source: publication,
    source_url: currentUrl,
    data_as_of: CAPTURED_AT,
    note: 'ADOPTED text only. Proposed revisions (the Council\'s separate public-comment process) are not covered by this tool.',
  };
  if (set === 'caci') {
    base.directions_for_use = rec.directions_for_use ?? null;
    base.sources_and_authority = rec.sources_and_authority ?? null;
    base.secondary_sources = rec.secondary_sources ?? null;
  } else {
    base.bench_notes = rec.bench_notes ?? null;
    base.authority = rec.authority ?? null;
    base.related_issues = rec.related_issues ?? null;
    base.secondary_sources = rec.secondary_sources ?? null;
    base.commentary = rec.commentary ?? null;
  }
  return base;
}

function caciLookup(args: Record<string, unknown>) {
  return lookup('caci', String(args.number ?? ''), args.edition != null ? String(args.edition) : undefined);
}
function calcrimLookup(args: Record<string, unknown>) {
  return lookup('calcrim', String(args.number ?? ''), args.edition != null ? String(args.edition) : undefined);
}

function searchSet(set: 'caci' | 'calcrim', words: string[]) {
  const table = set === 'caci' ? CACI : CALCRIM;
  const hits: { rec: CaJiRecord; score: number }[] = [];
  for (const rec of table) {
    if (rec.status !== 'adopted') continue; // revoked/reserved numbers are not useful search results
    const haystack = `${rec.title} ${rec.series ?? ''}`.toLowerCase();
    let score = 0;
    for (const w of words) if (haystack.includes(w)) score += w.length >= 6 ? 2 : 1;
    if (score > 0) hits.push({ rec, score });
  }
  return hits;
}

function caJiSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'ca_ji_search needs a "query" — the claim or charge, e.g. "breach of contract", "negligence", "murder", "self-defense".',
      hint: 'To look up a known number directly, use caci_lookup or calcrim_lookup instead.',
    };
  }
  const setArg = String(args.set ?? 'both').toLowerCase();
  const sets: ('caci' | 'calcrim')[] = setArg === 'caci' ? ['caci'] : setArg === 'calcrim' ? ['calcrim'] : ['caci', 'calcrim'];
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));

  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) {
    return { found: false, reason: 'query_too_short', query: q, message: `"${q}" has no word of 3+ characters to match against official titles.` };
  }

  const allHits: { set: 'caci' | 'calcrim'; rec: CaJiRecord; score: number }[] = [];
  for (const set of sets) for (const h of searchSet(set, words)) allHits.push({ set, ...h });
  allHits.sort((a, b) => b.score - a.score);

  if (!allHits.length) {
    return {
      found: false,
      query: q,
      sets_searched: sets,
      message: `No CACI/CALCRIM official title matched "${q}".`,
      hint: 'This matches official instruction and verdict-form TITLES (and series names), not full instruction text — try shorter or more literal terms (e.g. the cause of action or charge name).',
      data_as_of: CAPTURED_AT,
    };
  }

  const results = allHits.slice(0, limit).map(({ set, rec }) => ({
    set,
    number: rec.number,
    title: rec.title,
    series: rec.series,
    kind: rec.kind,
  }));

  return {
    found: true,
    query: q,
    count: results.length,
    total_matched: allHits.length,
    results,
    hint: 'Call caci_lookup or calcrim_lookup with a number above for the full instruction text.',
    match_level: 'official_title',
    data_as_of: CAPTURED_AT,
  };
}

// ---- "what's new/revised this edition" (fleet #3171) ----
//
// CACI already bakes the Judicial Council's OWN "Table of New and Revised
// CACI" front-matter list (CACI_PRIOR_CHANGED_NUMBERS/CACI_PRIOR_DELTA,
// above) — existed_in_prior:false is new-this-edition, true is revised. No
// such table exists in CALCRIM's front matter (checked at bake time — see
// bake-index.mjs's header), so CALCRIM is derived instead from each
// instruction's OWN revision-history line, which the Council writes as
// "New <Month> <Year>[; Revised <Month> <Year>, ...]" — an instruction
// whose line opens with the current edition's exact adoption date (e.g.
// "New February 2026") is new that edition; one whose line contains that
// date after a "Revised"/"Renumbered"/"Restored" clause was changed that
// edition. Verified against the published CALCRIM 2026 revisions: this
// derivation returns exactly 1808, 3235, 3238, 3459 as new for Feb 2026.
// Neither set tracks a REVOCATION date for a withdrawn number (a revoked
// record's text, and with it any date, is dropped at bake time — see the
// one CACI revoked/reserved record this pack carries), so "withdrawn" is
// always empty here, with that limitation stated rather than guessed at.
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const REVISION_DATE_RE = new RegExp(`(${MONTH_NAMES})\\s+(\\d{4})\\*?`, 'g');

function parseRevisionEvents(revisionHistory: string | null): { verbs: Set<string>; monthYear: string }[] {
  if (!revisionHistory) return [];
  // The Council appends a footnote ("* Denotes changes only to bench notes
  // and other commentaries.") directly after the last date with no
  // separator in some lines — strip it before splitting on clauses.
  const cleaned = revisionHistory.replace(/\*?\s*\*\s*Denotes[\s\S]*$/i, '').trim();
  const events: { verbs: Set<string>; monthYear: string }[] = [];
  for (const clause of cleaned.split(/;\s*/)) {
    const verbs = new Set<string>();
    if (/\bNew\b/.test(clause)) verbs.add('new');
    if (/\bRevised\b/.test(clause)) verbs.add('revised');
    if (/\bRenumbered\b/.test(clause)) verbs.add('renumbered');
    if (/\bRevoked\b/.test(clause)) verbs.add('revoked');
    if (/\bRestored\b/.test(clause)) verbs.add('restored');
    const re = new RegExp(REVISION_DATE_RE);
    let m: RegExpExecArray | null;
    while ((m = re.exec(clause))) events.push({ verbs, monthYear: `${m[1]} ${m[2]}` });
  }
  return events;
}

function calcrimEditionChanges(monthYear: string): { added: { number: string; title: string }[]; revised: { number: string; title: string }[]; withdrawn: { number: string; title: string }[] } {
  const added: { number: string; title: string }[] = [];
  const revised: { number: string; title: string }[] = [];
  const withdrawn: { number: string; title: string }[] = [];
  for (const rec of CALCRIM) {
    const events = parseRevisionEvents(rec.revision_history).filter((e) => e.monthYear === monthYear);
    if (!events.length) continue;
    const verbs = new Set<string>();
    for (const e of events) for (const v of e.verbs) verbs.add(v);
    const entry = { number: rec.number, title: rec.title };
    if (verbs.has('new')) added.push(entry);
    else if (verbs.has('revoked')) withdrawn.push(entry);
    else if (verbs.has('revised') || verbs.has('renumbered') || verbs.has('restored')) revised.push(entry);
  }
  return { added, revised, withdrawn };
}

function caciEditionChanges(): { added: { number: string; title: string }[]; revised: { number: string; title: string }[] } {
  const added: { number: string; title: string }[] = [];
  const revised: { number: string; title: string }[] = [];
  for (const number of CACI_PRIOR_CHANGED_NUMBERS) {
    const delta = CACI_PRIOR_DELTA.get(number);
    const current = CACI.find((r) => r.number.toUpperCase() === number);
    const title = current?.title ?? delta?.title ?? number;
    const entry = { number: current?.number ?? number, title };
    if (delta && delta.existed_in_prior === false) added.push(entry);
    else revised.push(entry);
  }
  return { added, revised };
}

const WITHDRAWN_NOTE =
  'A revoked/reserved number\'s text (and any revocation date) is dropped from this index at bake time, so a withdrawal cannot be dated to a specific edition from here — this list is always empty. Call caci_lookup/calcrim_lookup with a number to see if it currently returns status "revoked_or_reserved".';

function caJiWhatsNew(args: Record<string, unknown>) {
  const setArg = String(args.set ?? 'both').toLowerCase();
  const sets: ('caci' | 'calcrim')[] = setArg === 'caci' ? ['caci'] : setArg === 'calcrim' ? ['calcrim'] : ['caci', 'calcrim'];
  const editionArg = (args.edition != null ? String(args.edition) : '').trim();

  const results: Record<string, unknown> = {};
  for (const set of sets) {
    const editionMeta = set === 'caci' ? CACI_EDITION_META : CALCRIM_EDITION_META;
    const publication = set === 'caci' ? 'Judicial Council of California Civil Jury Instructions (CACI)' : 'Judicial Council of California Criminal Jury Instructions (CALCRIM)';
    const currentUrl = set === 'caci' ? CACI_CURRENT_URL : CALCRIM_CURRENT_URL;
    const isCurrentEdition = !editionArg || Number(editionArg) === (editionMeta?.year ?? NaN);
    if (!isCurrentEdition) {
      results[set] = {
        found: false,
        reason: 'edition_not_available',
        requested_edition: editionArg,
        message: `Only the ${editionMeta?.year ?? 'current'} edition's new/revised list is available for ${set === 'caci' ? 'CACI' : 'CALCRIM'} — "${editionArg}" is not baked. See ca_ji_editions for archived edition links.`,
        source: publication,
        data_as_of: CAPTURED_AT,
      };
      continue;
    }
    const changes = set === 'caci' ? { ...caciEditionChanges(), withdrawn: [] as { number: string; title: string }[] } : calcrimEditionChanges(editionMeta?.adopted ?? '');
    results[set] = {
      found: true,
      edition_year: editionMeta?.year ?? null,
      adopted: editionMeta?.adopted ?? null,
      new: changes.added,
      revised: changes.revised,
      withdrawn: changes.withdrawn,
      withdrawn_note: WITHDRAWN_NOTE,
      basis:
        set === 'caci'
          ? 'The Council\'s own "Table of New and Revised CACI" front-matter list for this edition.'
          : `Each instruction's own revision-history line, matched against this edition's adoption date (${editionMeta?.adopted ?? 'unknown'}) — CALCRIM carries no equivalent front-matter changelog table.`,
      source: publication,
      source_url: currentUrl,
      data_as_of: CAPTURED_AT,
    };
  }
  return { found: true, results, data_as_of: CAPTURED_AT };
}

function caJiEditions(args: Record<string, unknown>) {
  const setArg = String(args.set ?? 'both').toLowerCase();
  const out: Record<string, unknown> = { data_as_of: CAPTURED_AT };
  if (setArg !== 'calcrim') {
    out.caci = {
      current: { ...CACI_EDITION_META, url: CACI_CURRENT_URL },
      archived: CACI_ARCHIVED,
      prior_edition_delta: {
        year: CACI_PRIOR_YEAR,
        changed_numbers: [...CACI_PRIOR_CHANGED_NUMBERS],
        note: `caci_lookup(number, edition: "${CACI_PRIOR_YEAR}") returns real ${CACI_PRIOR_YEAR}-edition text for these numbers (the Council's own list of what it changed for ${CACI_EDITION_META?.year ?? 'the current edition'}); any other number is unchanged since ${CACI_PRIOR_YEAR} by the Council's own say-so.`,
      },
      note: 'Only the current edition\'s FULL instruction text is baked into caci_lookup; a bounded prior-edition delta is also available (see prior_edition_delta). Editions further back are linked, not extracted.',
    };
  }
  if (setArg !== 'caci') {
    out.calcrim = { current: { ...CALCRIM_EDITION_META, url: CALCRIM_CURRENT_URL }, archived: CALCRIM_ARCHIVED, note: 'Only the current edition\'s instruction text is baked into calcrim_lookup; no prior-edition delta exists for CALCRIM (its front matter carries no changelog this pack can key one from) — archived editions are linked, not extracted.' };
  }
  return { found: true, ...out };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'caci_lookup',
    description:
      'Get the OFFICIAL text of a California Civil Jury Instruction (CACI) by number — e.g. "303" (Breach of Contract—Essential Factual Elements) or a verdict form like "VF-303". As adopted by the Judicial Council of California, current edition by default. Returns the instruction text (with bracketed/optional language as published), Directions for Use, Sources and Authority, Secondary Sources, and the revision history line ("New ...; Revised ..."). A revoked or reserved number returns status "revoked_or_reserved" with no text rather than a not-found error. ADOPTED text only — proposed revisions open for public comment are not covered. Pass `edition` (a prior year, e.g. a trial that occurred under an older instruction) to get that edition\'s text for instructions the Council flagged as changed since — only a bounded set of prior-year deltas is available (see ca_ji_editions), not a full archive. Use for "what is the official jury instruction for breach of contract" or to check the elements/Sources and Authority a civil claim instruction cites. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: { type: 'string', description: 'CACI instruction or verdict-form number, e.g. "303", "CACI No. 303", or "VF-303".' },
        edition: { type: 'string', description: 'Optional: a prior edition year (e.g. "2025") instead of the current edition. Only available where this pack has baked a delta for that number — call ca_ji_editions to see what is available.' },
      },
      required: ['number'],
    },
  },
  {
    name: 'calcrim_lookup',
    description:
      'Get the OFFICIAL text of a California Criminal Jury Instruction (CALCRIM) by number — e.g. "200" (Duties of Judge and Jury) or a verdict form like "VF-200". As adopted by the Judicial Council of California, current edition only — CALCRIM has no prior-edition delta baked (unlike caci_lookup\'s `edition` param; see ca_ji_editions for archived CALCRIM PDF links instead). Returns the instruction text (with bracketed/optional language as published), Bench Notes (incl. Instructional Duty), Authority, Related Issues, Secondary Sources, Commentary where present, and the revision history line. A revoked or reserved number returns status "revoked_or_reserved" with no text rather than a not-found error. ADOPTED text only — proposed revisions open for public comment are not covered. Use for "what is the official jury instruction for first-degree murder" or to check a criminal charge instruction\'s elements/Authority. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        number: { type: 'string', description: 'CALCRIM instruction or verdict-form number, e.g. "200", "CALCRIM No. 200", or "VF-200".' },
        edition: { type: 'string', description: 'Optional. Any value other than the current edition year returns a clear "not available" response — no CALCRIM prior-edition text is baked.' },
      },
      required: ['number'],
    },
  },
  {
    name: 'ca_ji_search',
    description:
      'Find the official California jury instruction NUMBER for a claim, cause of action, or criminal charge by keyword — "breach of contract" -> CACI No. 303; "first degree murder" -> a CALCRIM number; "self-defense", "negligence", "false imprisonment". Searches official instruction/verdict-form TITLES and series names across CACI (civil), CALCRIM (criminal), or both. Returns matching numbers/titles — call caci_lookup or calcrim_lookup with a number for the full text. This is a title search, not full-text search over instruction bodies. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Claim, cause of action, or charge, e.g. "breach of contract" or "first degree murder".' },
        set: { type: 'string', enum: ['caci', 'calcrim', 'both'], description: 'Restrict to "caci" (civil) or "calcrim" (criminal); default "both".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ca_ji_whats_new',
    description:
      'Which CACI (civil) and/or CALCRIM (criminal) jury instructions are NEW or REVISED in an edition, aggregated in one call — e.g. "what\'s new in the 2026 CALCRIM edition" -> CALCRIM No. 1808 (Organized Retail Theft), 3235, 3238, 3459. For CACI this is the Judicial Council\'s own "Table of New and Revised CACI" front-matter list for that edition; for CALCRIM (which carries no equivalent table) it is derived from each instruction\'s own revision-history line matched against that edition\'s adoption date. Only the CURRENT edition is available (see ca_ji_editions for archived editions). Withdrawn/revoked numbers are not datable from this index and are always returned empty with a note — use caci_lookup/calcrim_lookup on a specific number to check revocation status. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set: { type: 'string', enum: ['caci', 'calcrim', 'both'], description: 'Restrict to "caci" (civil) or "calcrim" (criminal); default "both".' },
        edition: { type: 'string', description: 'Optional edition year, e.g. "2026". Defaults to the current edition; any other year returns a clear "not available" response.' },
      },
      required: [],
    },
  },
  {
    name: 'ca_ji_editions',
    description:
      'List the CURRENT edition year/adoption date and ARCHIVED edition PDF links for CACI (civil) and/or CALCRIM (criminal) jury instructions. Use when a caller needs a past year\'s edition (e.g. for a trial that occurred under an older version) or just wants to confirm which edition caci_lookup/calcrim_lookup text comes from. Archived editions are LINKED, not text-extracted — only the current edition\'s instruction text is available via caci_lookup/calcrim_lookup. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set: { type: 'string', enum: ['caci', 'calcrim', 'both'], description: 'Restrict to "caci" (civil) or "calcrim" (criminal); default "both".' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'caci_lookup':
      return caciLookup(args);
    case 'calcrim_lookup':
      return calcrimLookup(args);
    case 'ca_ji_search':
      return caJiSearch(args);
    case 'ca_ji_whats_new':
      return caJiWhatsNew(args);
    case 'ca_ji_editions':
      return caJiEditions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
