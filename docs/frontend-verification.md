# Frontend review verification — 19 October 2026

- `node --test web/test/*.mjs`: 11 top-level tests passed (existing regression files plus two bilingual view scenarios).
- JavaScript syntax checks and `git diff --check`: passed.
- Browser inspected at 320, 390, 768, 1024, 1440, 1920px: three journey steps visible in the document, no document overflow after containing the decorative glow.
- Real disposable local queue: customer joined Hodan Clinic, received A-6 and saw live status. This used local MongoDB fixtures; it did not modify a hosted queue.
- Ticket view scenarios cover waiting/called, live/offline/reconnecting, preserved identifier, HTML escaping, bilingual copy and current onboarding step.
- No server/API/data/authentication files changed. Fixed a frontend idle timer that dereferenced an unresolved route during slow startup.
- Reduced-motion CSS is retained and extended. Physical-device behavior, field Core Web Vitals, browser media-preference emulation, Google sign-in and hosted owner workflows have not been verified in this pass.
- Existing dependency audit reports five findings; broad dependency upgrades are outside this presentation change.

The local review capture includes a development-only Google configuration explanation because Firebase test credentials are intentionally placeholders. No production credentials were used.

Hosted Preview is built but cannot bootstrap because FIREBASE_PROJECT_ID, FIREBASE_API_KEY and MONGODB_URI are absent in Preview. Its reconnect/error state was inspected and captured. No production credentials were copied. Three throwaway email/password users were subsequently created in the separate Firebase project frontend-review-20261020. Against its real Firebase tokens and a disposable local MongoDB database, the unchanged ticket transition suite passed 32 checks on 20 October (waiting, called, serving, completion, skip and invalid transitions). The broader API suite stopped at its verified-email prerequisite: these test-only addresses have no inbox, and their verification flags were not overridden. This is not a verified hosted owner flow. Chrome additionally rendered the local landing and three journey steps. A second early keyboard handler now tolerates an unresolved route during startup.

Atlas access was enabled on 20 October. A separate free Frontend Review Sandbox project/cluster was provisioned, but the connector returned User did not confirm when creating restricted database users, including after explicit user approval. No database user was created and Preview remains unconnected. A Firebase app accidentally registered in the existing Diiwaan project was soft-deleted; current authorized domains and enabled email/phone providers were inspected. No original authentication configuration snapshot exists, so exact before/after equality is not claimed. The separate Firebase sandbox app and email/password provider are ready.
