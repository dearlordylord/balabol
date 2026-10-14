# Issue tracker

**Purpose:** Locate product specifications and decision records.
**Audience:** Contributors, including coding agents.
**Status:** Active.
**Authority:** Maintained project workflow.
**Expected use:** Read before publishing, claiming or resolving issues.
**Lifecycle:** Review when the tracker or planning workflow changes.

Product specifications live in GitHub Issues in dearlordylord/balabol. Use gh with an explicit repository. Specs synthesized through to-spec receive ready-for-agent; this indicates implementation readiness, not completed software.

The existing wayfinder map remains local Markdown under .scratch/voice-prototype with its own child tickets; GitHub is the product-spec tracker. Local wayfinder status and blocker fields are its dependency authority. Research reports are advisory.

## Operations

- Read: gh issue view NUMBER --repo dearlordylord/balabol --json title,body,comments,state,labels,url.
- Publish: gh issue create --repo dearlordylord/balabol --title TITLE --body-file FILE --label ready-for-agent.
- Comment: gh issue comment NUMBER --repo dearlordylord/balabol --body-file FILE.
- Close only after the issue's acceptance requirements are actually met.
- Keep per-ticket implementation evidence and review reports in GitHub issue comments, not repository Markdown reports. Present the owner with a concise summary of delivered behavior, decisions, assumptions and acceptance steps. Implement tickets sequentially. Ordinarily obtain owner acceptance before closing a ticket or starting the next; an explicitly authorized batch may advance after each ticket's required checks and independent reviews, with owner demo acceptance deferred to the end of the batch. The owner has authorized this workflow for #4–#6 and #7–#11. Physical-device qualification remains required wherever the acceptance criteria name it; deferred manual acceptance does not turn missing device evidence into a pass.

## Wayfinding operations

Use the local-markdown convention: map.md indexes resolved decisions; each question is a separate issues/NN-name.md child. Status open/claimed/resolved and Assignee record claims; Blocked by lists prerequisite ticket ids. Append resolution under Answer and index its title/link in the map. Resolve one human decision ticket per session; research tickets may resolve in parallel. Owner's to-spec invocation authorizes synthesis of known requirements, not pretending unfinished wayfinder tickets were resolved.
