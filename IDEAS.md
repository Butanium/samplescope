# samplescope — ideas parking lot

Unbuilt ideas worth a future instance's attention. Each signed; delete when done
or when decided-against (say why).

## Stats histograms: click a bin → range filter

The stats view already does click-to-filter for **categorical** values (an
exact-match chip via `toggleValue`). Numeric **histograms** have no equivalent
because the filter model is regex-only (`FilterSpec {column, regex}`), and a
range doesn't lower to a regex cleanly.

Now that filters are a compiled AND-list, the clean move is a *new filter kind*:
`{column, op: "between", lo, hi}` compiling to a `col BETWEEN lo AND hi` QUALIFY
clause in `_build_rows_query`, alongside the existing `regexp_matches` branch.
Then `StatsView`'s histogram bars get an `onClick` mirroring the categorical
path. The URL triple would need a 4th mode (`range`) or a separate param.
Scoped, but touches the filter schema end-to-end (models, state, url.ts,
compileTriple, CLI). — fable, 2026-07-20

Update 2026-09-26 (opus-5.5): comparison filters exist now (`op`/`value` on
FilterSpec, URL mode `cmp`, typed as `>= 3` in the header box). A bin click can
author the pair `[col, ">= lo", "cmp"]` + `[col, "< hi", "cmp"]`; what's left is
the click handler and toggling the pair off as a unit.

## `sscope view fields`: expose the show/hide default + body/drawer, not just pins

The CLI now drives the *shared* field layout (chat + JSON cards), but only its
`header` list — `add`/`rm`/`set`/`clear` all pin. The layout also has a
`defaultHidden` policy and a body/drawer (`shown`/`hidden`) split that only the
browser toolbar can reach. Round out parity: `sscope view fields hide-all` /
`show-all` (flip `defaultHidden`, clearing the opposing exception list, exactly
like the UI's `setDefaultHidden`), and maybe `fields drawer <col>` / `body <col>`.
Everything needed is already in `cli.py:_get_layout`/`_set_layout`. — fable, 2026-07-20

## Dev-loop friction: frontend rebuild + full suite is ~70s

Every UI change is `cd web && npm run build` (~30s, tsc+vite) then the full
pytest suite (~40-66s, most of it Playwright). The editable install serves
`web/dist` from disk, so there's no watch during iteration. A `vite build
--watch` recipe (or a documented `npm run dev` proxy pointed at a running
`sscope`) for pure-frontend work, plus a fast smoke subset marker, would cut the
inner loop a lot. Low priority — it's friction, not a blocker. — fable, 2026-07-20
