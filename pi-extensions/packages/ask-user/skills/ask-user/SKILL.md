---
name: ask-user
description: "Use when a decision is consequential or the request is ambiguous: gather evidence, then ask the user one focused question with the ask_user tool before going on."
---

# Asking the user

Use `ask_user` to get an explicit decision from the user at points where guessing would be
costly. It is for decisions, not conversation.

## When to ask

Ask before going on when:

- the next step changes architecture, data schemas, public interfaces, deployment or security;
- the change would be expensive to undo (large refactors, migrations, deletions, anything
  user-facing in production);
- requirements are missing, unclear or contradict each other;
- several reasonable options exist and the choice depends on the user's preferences;
- you would otherwise assume something that changes what you build.

Don't ask when the user has already decided this exact trade-off, for trivial choices such as
formatting, or for anything you can find out by reading code, docs or logs.

## How to ask

1. **Gather evidence first.** Read the relevant code and docs so the user is not deciding blind.
2. **Summarise.** Put a short, neutral summary in `context`: where things stand, the
   constraints, the trade-offs and, if you have one, your recommendation.
3. **Ask one decision.** Write a concrete `question` and 2-5 short, outcome-focused `options`.
   Add a `description` when a trade-off is not obvious. Leave `allowFreeform` on unless only
   the listed answers make sense, and set `allowMultiple` only for genuinely independent picks.
4. **Respect the user's display settings.** Leave `displayMode` and `contextExpanded` unset
   unless there is a reason: `displayMode: "inline"` keeps your previous message visible when
   it is the context the user needs; `contextExpanded: true` opens long context in full.

Several decisions at the same point may go together in `questions` (2-4 entries, each with its
own `question`, `context`, `options`, `allowMultiple`, `allowFreeform`) only when they are
independent of each other and their prerequisites are settled. A top-level `question` sent with
`questions` is only a heading. Ask anything that depends on another answer in a later call.

```json
{
  "question": "Which caching approach should the first release use?",
  "context": "p95 latency is the problem. Redis is fastest but adds infrastructure; an in-process cache is simpler but not shared between instances.",
  "options": [
    { "title": "In-process cache", "description": "Simple to ship; instances may disagree" },
    { "title": "Redis", "description": "Shared and scalable; more to operate" }
  ]
}
```

## After the answer

- Restate the decision in a sentence, say what you will do next, and do it.
- Treat a skipped batch entry like an unclear answer for that decision.
- Ask again only if something materially new comes up; don't re-confirm.

## If the answer is unclear or cancelled

Make at most two attempts per decision. The second attempt is narrower: state your
recommendation and offer "Go with the recommendation", "Something else" (freeform) and "Stop
for now". After that:

- for consequential decisions, stop and explain what is blocked until the user decides;
- for ambiguity only, if the user delegates ("your call"), take the most easily reversed option
  and state your assumptions.

## Avoid

- asking before gathering context;
- several unrelated or dependent questions in one call;
- options that hide the trade-off;
- asking the same thing again without new information;
- going ahead with consequential work after a cancelled or unclear answer.
