# Brainstorm & Prototype

**Targets: unknown knowns.** The user has criteria they can only articulate by reacting — taste, layout, tone, scope, "I'll know it when I see it". These are cheap to discover during prototyping and expensive to discover during implementation: a small change in a spec can mean a drastically different implementation, and reverting built work is much harder than discarding a mock.

## When to run it

- Visual or UX work where the user says they can't describe what they want ("no visual taste", "not sure what's possible").
- The start of almost any substantial session — a short brainstorm sets scope *with intent* and prevents both too-narrow and too-wide framing.
- The user asks to "see options", "try a few directions", or wants to react to something before committing.
- You're about to make a taste-level decision silently (a layout, a naming scheme, an interaction pattern) inside a larger task — pause and make it reactable instead.

## How to run it

### Brainstorming (scope and approach)

1. Take the user's rough problem statement and search the codebase/context first.
2. Generate a range of interventions, ordered along a useful axis — typically **cheapest to most ambitious**. Aim for genuine spread: the list should contain at least one option the user will find too small and one too ambitious; that's how you find the edges of their scope.
3. Invite reaction, not selection pressure: "tell me which of these resonate" beats "pick one".
4. Expect two kinds of wins: approaches the user would have missed, and the realization that the problem should be framed differently. Both are the point — say them out loud.

### Prototyping (taste and form)

1. Build the **cheapest artifact the user can react to**. For UI: a single self-contained HTML file with fake data. No backend routes, no state management, no wiring — the mock exists to be judged and discarded.
2. When taste is the unknown, make **3–5 genuinely different directions**, not variations on one idea. Different layout structures, different information hierarchies, different personalities — a palette swap teaches the user nothing about what they want.
3. Label each direction with what it's optimizing for ("dense/analyst-oriented", "calm/executive summary", "playful") so reactions attach to intent, not just surface.
4. Collect reactions, then **converge**: take what resonated, cut what didn't, and either re-prototype once more or graduate the winner into a spec.
5. Treat prototypes as disposable by design. Their value is the reaction they extract; carrying prototype code into implementation is optional, not the goal.

## Example requests this serves

- "I want a dashboard for this data but I have no visual taste and don't know what's possible. Make me an HTML page with 4 wildly different design directions so I can react to them."
- "Before wiring anything up, make a single HTML file mocking the new editor toolbar with fake data. I want to react to the layout before you touch the real app."
- "Here's my rough problem: users churn after onboarding. Search the codebase and brainstorm 10 places we could intervene, from cheapest to most ambitious. I'll tell you which ones resonate."

## Pitfalls

- **Convergent "options".** Three near-identical variants waste a round trip. Divergence is the deliverable.
- **Over-building the mock.** Every hour spent wiring a prototype raises the cost of discarding it — which defeats its purpose.
- **Skipping the brainstorm on "obvious" tasks.** The framing the user arrived with is a map too. A two-minute brainstorm at session start regularly reveals a better problem to solve.
- **Collecting reactions and not verbalizing them.** After the user reacts, write down the newly-discovered criteria explicitly — an unknown known that stays unverbalized will be violated again later.
