# Implementation Plan

**Targets: residual unknowns before commitment.** Exploration is done and building is about to start. The plan's job is *not* to enumerate every step — it's to surface the decisions the user is most likely to want changed, while they're still cheap to change.

## The key move: lead with what's most likely to change

A conventional plan is ordered by execution sequence, which buries the contestable decisions under mechanical steps. Invert it. Order by **likelihood the user will want it different**:

1. **Data model changes and migrations** — expensive to reverse, opinions guaranteed.
2. **Type interfaces / API shapes / contracts** — everything downstream depends on them.
3. **Anything user-facing** — UX flows, copy, defaults, error states; this is where unknown knowns live.
4. **Notable tradeoffs you decided unilaterally** — with the rejected alternative and why.
5. *(bottom, clearly marked as low review priority)* Mechanical refactors, wiring, tests, cleanup — the parts where the user trusts you.

For each leading decision, give: the choice, the strongest alternative, why you chose as you did, and **what else changes if the user overrides it**. That last part is what lets the user veto cheaply — they can see the blast radius without asking.

## How to run it

1. **Write the plan from the territory, not the map.** Ground every decision in what you actually found in the codebase — name the files, the existing patterns you're following or breaking, the constraints you hit. A plan written purely from the prompt just re-encodes the user's unknowns.

2. **State your assumptions as assumptions.** Anywhere you guessed, say so explicitly ("assuming soft-delete since the users table has `deleted_at`"). Each named assumption is an unknown converted into a one-second confirmation.

3. **Mark the improvisation zones.** Long-horizon work will hit unknowns no plan can foresee. Say where you expect them ("the vendor API's pagination behavior is undocumented; I'll adapt when I hit it") so mid-flight deviations are expected, not alarming. This is also where you agree on the deviation protocol — see `implementation-notes.md`.

4. **Keep it reviewable in minutes.** The plan is a reaction surface, not documentation. If the environment renders HTML, an artifact with the contestable decisions up top works well; either way, someone should be able to veto the important parts in a five-minute read.

5. **Get the reaction, then freeze scope.** Once the user has reacted and the top decisions are settled, the plan plus the decision log becomes the hand-off artifact — often to a fresh session with clean context.

## Example requests this serves

- "Write an implementation plan, but lead with the decisions I'm most likely to tweak: data model changes, new type interfaces, and anything user-facing. Bury the mechanical refactoring at the bottom — I trust you on that part."

## Pitfalls

- **Step-list plans.** "1. Create branch 2. Add model 3. Wire routes…" hides the two decisions that matter inside twenty that don't.
- **Plans without alternatives.** A single-option plan invites yes/no; showing the rejected alternative invites the correction you actually need.
- **Treating the plan as a contract.** The plan is the best map available at freeze time. When the territory disagrees mid-build, the answer is a logged deviation, not blind compliance — and if the disagreement is fundamental, stop and re-plan.
- **Planning forever.** The plan reduces unknowns to an acceptable level; it cannot reach zero. When the remaining unknowns are cheaper to hit than to predict, start building.
