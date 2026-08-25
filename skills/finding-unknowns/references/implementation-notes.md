# Implementation Notes

**Targets: unknowns discovered in flight.** No matter how much planning you did, unknown unknowns lurk in the territory: an edge case in existing code, an undocumented API behavior, a plan step that turns out impossible as written. The notes file is the protocol for hitting one without stalling *and* without silently guessing.

## When to run it

- Any implementation session long enough that decisions will be made while the user isn't watching.
- Whenever a plan from a previous session is being executed — the notes are that plan's feedback channel.
- The user asks for it directly: "keep an implementation-notes file", "log your deviations".

## The protocol

When you hit an unknown the plan didn't cover:

1. **Try to resolve it from the territory** — read more code, check the docs, run the experiment. Most in-flight unknowns are resolvable without the user.
2. **If it requires a judgment call: pick the conservative option** — the choice that's easiest to reverse and least surprising given the plan's intent. Prefer the smaller diff, the existing pattern, the behavior that matches what's already there.
3. **Log it, then keep going.** Do not stall the whole task on a question the user can answer at review time; do not silently absorb the decision either. The log entry *is* the escalation.
4. **Unless it invalidates the plan.** If the discovery means the approach itself is wrong — not a detail, the approach — stop and surface it immediately. Logging a deviation is for detours, not for driving off a cliff politely.

## File format

Keep a working file (`implementation-notes.md`, or `.html` if artifacts render) in the workspace:

```markdown
# Implementation Notes — <task>

## Decisions
- <decision made within the plan's latitude, and why>

## Deviations
- **Planned**: <what the plan said>
  **Found**: <what the territory actually was>
  **Did**: <the conservative option taken>
  **Revisit if**: <what would make this the wrong call>

## Surprises
- <things learned that future sessions should know — undocumented behavior, misleading names, fragile spots>

## Open questions
- <judgment calls the user should confirm at review>
```

## Why this works

- **The user reviews decisions, not just diffs.** A code review shows *what* changed; the notes show *what was chosen and why* — which is where the actual unknowns were.
- **The next attempt starts smarter.** Deviations and surprises are exactly the unknowns the next plan should account for. The notes convert this session's discoveries into the next session's known knowns.
- **It keeps momentum honest.** "Pick conservative, log it, continue" prevents both failure modes: the agent that stops every ten minutes to ask, and the agent that improvises a different project than the one requested.

## Example requests this serves

- "Keep an implementation-notes.md file. If you hit an edge case that forces you to deviate from the plan, pick the conservative option, log it under 'Deviations', and keep going."

## Pitfalls

- **Logging everything.** Routine choices within the plan's latitude drown the three entries that matter. Log decisions a reviewer might contest, not keystrokes.
- **Logging instead of escalating.** A deviation that changes scope, contracts, or user-facing behavior in ways the plan's author wouldn't expect deserves a pause, not a footnote.
- **Write-only notes.** The file earns its cost at review time and at next-plan time. Feed it into the pitch/explainer and the quiz (see those references) — don't let it rot in the repo.
