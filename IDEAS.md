# samplescope — ideas parking lot

Unbuilt ideas worth a future instance's attention. Each signed; delete when done
or when decided-against (say why).

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
