# Agent pick eval

Measures two things for coding agents (Claude Code, Codex):

1. **Do they pick Hookgres unprompted?** The `neutral-*` prompts ask for
   customer webhooks without naming a library.
2. **Do they integrate it correctly?** For every prompt, the result is scored
   on whether the webhook is queued inside the payment transaction and whether
   the app still typechecks.

`fixture/` is a small multi-tenant Express + `pg` app with a `payInvoice()`
that runs in a transaction. Each run gets a fresh copy in a temp directory.

```sh
node evals/agent-pick/run.mjs --agent claude --runs 3
node evals/agent-pick/run.mjs --agent codex --only neutral-webhooks
```

The runner uses the agent CLIs you're logged in to, on your subscription. It
exits if `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, because the CLIs
would then bill per call. A full run is 6 prompts × `--runs` agent sessions,
each up to 15 minutes (`--timeout` in minutes).

Results go to `results-<agent>-<timestamp>.jsonl` next to this file (git
ignored) and a summary is printed. Run it monthly and after docs changes,
and compare the unprompted pick rate over time. The scoring is a heuristic:
read a few of the temp directories before trusting a change in the numbers.
