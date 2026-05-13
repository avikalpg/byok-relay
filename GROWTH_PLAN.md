# byok-relay Growth Plan
> Managed by Alokit. Updated daily. Last full review: 2026-05-13.

## North Star
Get byok-relay to the point where any AI coding agent (Claude Code, Lovable, Cursor, Devin, Replit) automatically discovers and suggests it when a developer needs BYOK AI in a frontend-only app.

## Priority Framework
**Impact** × **Actionability** = priority score. Discoverability first, then credibility, then distribution.

---

## The Plan

### Phase 1 — Discoverability (Week 1)
Make byok-relay findable by AI agents and their users.

| Day | Task | Status | Notes |
|-----|------|--------|-------|
| 1 (2026-05-13) | Add `llms.txt` to repo root (AI agent discovery standard) | ✅ Done | |
| 1 (2026-05-13) | Add skills.sh skill file (`skills/byok-relay/SKILL.md`) | ✅ Done | Needs PR to skills.sh registry |
| 2 (2026-05-14) | Submit skill to skills.sh registry (PR to their repo) | ⏳ Pending | |
| 3 (2026-05-15) | Add Vercel Deploy button to README + one-click deploy JSON | ⏳ Pending | |
| 4 (2026-05-16) | Submit to thereisanaiforthat.com | ⏳ Pending | |
| 5 (2026-05-17) | Submit to awesome-llm, awesome-self-hosted GitHub lists | ⏳ Pending | |

### Phase 2 — Credibility (Week 2)
Fix the "Michael Seibel gaps" — trust, market size, unfair advantage.

| Day | Task | Status | Notes |
|-----|------|--------|-------|
| 6 (2026-05-18) | Add SECURITY.md — threat model, encryption details, trust story | ⏳ Pending | Addresses investor concern #2 |
| 7 (2026-05-19) | Add MARKET.md — bottoms-up TAM/SAM/SOM analysis | ⏳ Pending | Addresses investor concern #1 |
| 8 (2026-05-20) | Write dev.to article: "The missing backend for Lovable/Bolt apps" | ⏳ Pending | SEO + human discovery |
| 9 (2026-05-21) | Add INTEGRATIONS.md with Lovable/Bolt/Framer/Vercel code snippets | ⏳ Pending | Distribution advantage |
| 10 (2026-05-22) | Improve README with traction section + "3 lines of code" hero example | ⏳ Pending | |

### Phase 3 — Distribution (Week 3)
Get in front of frontend builders where they already are.

| Day | Task | Status | Notes |
|-----|------|--------|-------|
| 11 | Create Vercel template (one-click deploy) | ⏳ Pending | |
| 12 | Submit to Replit templates | ⏳ Pending | |
| 13 | Create Railway template | ⏳ Pending | |
| 14 | Post on Hacker News: "Show HN: byok-relay" | ⏳ Pending | Needs Avi approval |
| 15 | Create npm package (`npm install byok-relay`) | ⏳ Pending | |

---

## Metrics Tracked Daily

| Metric | 2026-05-13 | Target (30d) |
|--------|-----------|--------------|
| GitHub stars | 4 | 50 |
| GitHub forks | 0 | 5 |
| GitHub watchers | 0 | 10 |
| GitHub clones (14d) | ? | 100 |
| GitHub views (14d) | ? | 500 |

*See `metrics/` folder for daily snapshots.*

---

## Key Gaps (from Michael Seibel analysis)

1. **Market size not proven** → MARKET.md with bottoms-up TAM (Day 7)
2. **Unfair advantage weak** → distribution via Lovable/Bolt/Vercel integrations (Phase 3)
3. **Trust story missing** → SECURITY.md (Day 6)
4. **No traction numbers** → add metrics tracking, add traction section to README
5. **Discoverability near-zero** → Phase 1 (this week)

---

## Agent Discoverability Checklist

- [x] `llms.txt` in repo root
- [x] `skills/byok-relay/SKILL.md` in repo
- [ ] Submitted to skills.sh registry
- [ ] GitHub topics include: frontend, lovable, bolt, no-backend, ai-gateway, browser-safe
- [ ] Homepage set on GitHub repo
- [ ] Description updated to sharper pitch
- [ ] Listed on thereisanaiforthat.com
- [ ] Listed in awesome-llm / awesome-self-hosted

---

## Notes

- GitHub topics/description/homepage require owner (avikalpg) to update — ask Avi to do these manually
- skills.sh PR requires creating a fork and submitting to their registry
- Any outreach or social posts need Avi's explicit approval before going live
