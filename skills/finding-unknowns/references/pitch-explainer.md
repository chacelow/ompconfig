# Pitch & Explainer

**Targets: the reviewers' unknowns.** Shipping usually requires other people — approvers, teammates, stakeholders — and they arrive with the *same unknowns you started with*, minus your journey. A pitch/explainer artifact walks them across the gap quickly, in the order that serves them.

Two audiences, two jobs:

- **People who start where you started** need accelerated understanding: what this is, why it matters, what it looks like working.
- **Experts who know the potholes** need evidence you accounted for them: the failure points they'd probe, already addressed.

One artifact can serve both — demo first, diligence below.

## When to run it

- Work is done and needs buy-in, review, or approval from anyone who wasn't in the loop.
- The user asks: "package this up for Slack", "write the PR description", "make something I can show my team".
- Proactively, at the end of a multi-artifact effort: the spec, prototype, and implementation notes you already have are 80% of the pitch — offer to assemble them.

## How to build it

1. **Lead with the demo.** A GIF, a before/after, a screenshot, a two-line "what you can do now that you couldn't". Reviewers decide how much attention to give in the first ten seconds — spend those on the outcome, not the architecture.

2. **Compress the journey, don't replay it.** State the problem, the chosen approach, and the one or two alternatives that were seriously considered and why they lost. Reviewers trust conclusions more when they can see the rejected branch — but nobody wants the full transcript.

3. **Answer the expert's questions before they're asked.** Pull from the implementation notes: the edge cases hit, the deviations made and why, what was tested, what's known-incomplete. An expert who finds their pet failure mode already addressed approves quickly; one who has to ask writes a comment and comes back tomorrow.

4. **Reuse the artifacts you already have.** Package the prototype, the spec, and the implementation notes into a single document — that's usually assembly, not authorship. Match the medium to the venue: single HTML artifact for a link drop, markdown for a PR body, short prose + demo for chat.

5. **End with what you're asking for.** Approval? Feedback on a specific decision? A holder for a known risk? Reviewers act faster when the ask is explicit.

## Structure that works

- **The demo** (or before/after) — first, always.
- **The problem, in one paragraph** — for readers who lack context.
- **What was built & the key decisions** — with the rejected alternatives, briefly.
- **What the skeptic will ask** — edge cases, deviations, testing, known gaps; sourced from the implementation notes.
- **The ask** — what response this document wants.

## Example requests this serves

- "Package the prototype, the spec, and the implementation notes into a single doc I can drop in Slack to get buy-in. Lead with the demo GIF."

## Pitfalls

- **Architecture-first ordering.** Explaining the implementation before the outcome loses the non-expert audience in the first paragraph.
- **Hiding the deviations.** Omitting the awkward parts doesn't remove them; it just means they're discovered by the reviewer instead of disclosed by you — at a trust discount.
- **Writing it from memory.** The implementation notes exist so the pitch is grounded in what actually happened, not what the plan intended.
