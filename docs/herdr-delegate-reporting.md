# Herdr delegate reporting

Design owner: Claude Opus 5.5, for issue #51. Revised 2026-09-29 to the direction Martin accepted.
This is the durable record that `AGENTS.md` requires before dependent implementation. The rules
agents follow live in [`interactive-agent-sessions`](../skills/interactive-agent-sessions/SKILL.md);
this record keeps the decision, the evidence, and the gaps.

## Decision

An earlier revision of this record (commit `1b44830`) proposed a file inbox and a new Pi extension.
Martin rejected it as overbuilt:

> "re 51, uhm... if you can send prompts to an agent im pretty sure the agent can send prompts back?"
>
> "let the parent decide if its watching the subagent or if its expected a longer run and tells the
> agent to send back an im done prompt"

The accepted direction:

1. **Transport.** The delegate calls back with `herdr agent prompt` from its own shell, addressed to
   the originating parent's pane. No inbox, no new Pi extension, no delivery service, no scheduler.
2. **The parent chooses per assignment.** For a short task it watches the pane or runs `herdr agent
   wait`, as before. For a longer run it ends its own turn and tells the delegate, in the handoff, to
   send one completion prompt back.
3. **Evidence, not authority.** A callback grants nothing and cannot widen scope. The parent verifies
   its claims.
4. **Bounded failure.** Before prompting, the delegate reads `herdr pane get <pane>` and compares the
   pane's `agent_session` kind, source, and value with the identity in its handoff. On a mismatch,
   `agent_not_found`, `agent_blocked`, `agent_prompt_stalled`, or any other error it raises `herdr
   notification show`, leaves the full report in its own pane, and makes at most one further attempt.
   A delegate sends at most one completion or blocker callback per assignment, and the parent never
   prompts the delegate because of a callback unless Martin says so.
5. **Observed limits only.** What follows reports what was run and seen, not what was inferred.

## Observed behavior

Run on 2026-09-29 with Herdr 0.9.1, Pi 0.87.1, Claude Code 2.1.283, and Codex CLI 0.157.1. The parent
was a fresh Pi started with `launch-command --profile pi-ambient` in a named tab `Demo · parent Pi`
(pane `w5:pG`) of this checkout's workspace. The Pi session it reported was
`2026-09-29T08-48-49-689Z_01a0ec5a-….jsonl`. Callbacks were sent from this Claude Code session's
shell, standing in for a delegate. The tab was closed afterwards.

| Case | Command | Observed |
| --- | --- | --- |
| Parent identity | `herdr pane get w5:pG` | `agent: pi`, `agent_session: {kind: path, source: herdr:pi, value: <session .jsonl>}` |
| Idle parent | `herdr agent prompt w5:pG '<callback>' --wait --timeout 120000` | Exit 0 after 2 s. A turn started at once, and Pi replied "Acknowledged completion of assignment demo-51-idle." |
| Transcript | Pi session file | The callback is an ordinary `message` with `role: user`, the same as text Martin types |
| Working parent | Same, sent 6 s into a 25 s `sleep` tool call | Exit 0 when the whole run settled. Pi stored the callback as a `user` message right after the tool result and answered both in one reply ("The command finished; acknowledged completion of assignment demo-51-busy."). It acted as steering inside the running turn, not as a separate later turn. |
| Missing target | `herdr agent prompt w5:p999 x`; `herdr pane get w5:p999` | Exit 1 with `{"error":{"code":"agent_not_found",…}}` and `{"error":{"code":"pane_not_found",…}}` |
| Codex delegate | Prompted the `codex-sol-write` session in `w5:pE` once to run `herdr agent prompt w5:pG "codex callback test"` and `herdr pane get w5:pG` | Both exited 1 with `Error: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }`. Nothing reached the parent's session file. |

### Round trip through the helper

Run the same day, after the helper existed. A fresh Pi parent (`launch-command --profile
pi-ambient`) sat in a named tab `Demo · parent Pi` (pane `w5:pH`, session
`2026-09-29T08-54-39-601Z_01a0ec5f-….jsonl`). Its prompt told it to run `callback-handoff`, open a
second named tab `Demo · delegate`, launch `claude-opus` at effort `low` there through
`launch-command` with a read-only task and the `Report back:` line, and end its turn without waiting.
The prompt also told it what to do with a callback, and with an identical second one. Both tabs were
closed afterwards.

| Step | Observed |
| --- | --- |
| Handoff | The parent ran `callback-handoff`, which printed the command bound to `--pane 'w5:pH' --session-kind 'path' --session-source 'herdr:pi'` and its session file. It created the delegate tab (pane `w5:pJ`), launched Claude, replied "Delegate launched in pane `w5:pJ`", and ended its turn at 08:55:02 UTC. |
| Delegate | Claude counted the headings with `grep` and ran the `callback` command once with `--status completed`. Its transcript shows the helper printing `{"ok":true,"sent":"yes","pane":"w5:pH","status":"completed"}` and exit `0`. |
| Parent transcript | At 08:55:05, a `message` with `role: user`: "Delegate callback · completed · from pane w5:pJ · Result: 6 lines start with '## '; the last is '## Non-goals'. Check: … Your turn: nothing." |
| Parent turn | A turn started without anyone typing. The parent re-ran the count with one read-only `awk` command, replied "Matches: 6 headings; the last is `## Non-goals`", and gave its next step without taking it: "record this verified callback as evidence for issue #51. Not taken." It did not prompt the delegate. |
| Duplicate | Re-running the identical command by hand from another shell (with `HERDR_PANE_ID=w5:pJ`, so the text was identical) also exited `0` with `sent: yes`. The parent got a second `user` message and a second turn, and replied "Identical duplicate callback received. Verification not repeated." Only its prompt made it hold back. Nothing in the transport suppressed the duplicate. |

Documented but not observed here: `agent_blocked`, which Herdr's help says rejects the prompt before
any input is sent, and `agent_prompt_stalled`, returned when `--wait` sees no activity within 5 s. The
following were not tried: a callback arriving while Martin has a half-written draft in the parent's
editor, a Claude Code or Codex parent, and a Pi delegate.

## How it works

**Choosing.** The parent watches or waits when it expects the task to finish while it is still
paying attention. For a longer run, it asks for a callback and ends its turn. A callback is never
the default; the handoff says which one was chosen.

**Handing over the identity.** From its own shell, the parent runs
`node <pi-clean>/scripts/github-work.mjs callback-handoff`. It reads `HERDR_PANE_ID`, runs `herdr
pane get` on it, and prints a `Report back:` line for the handoff. That line holds the exact
`callback` command, with the parent's pane and its `agent_session` kind, source, and value. The pane
ID is only the routing handle. The session identity is what makes the callback land in the same
conversation.

**Calling back.** The delegate runs that command once, adding `--status completed|failed|needs-input`
and a one-paragraph `--message` with its Result, Check, and Your turn. `github-work.mjs callback`:

1. Runs `herdr pane get <pane>` and requires `agent_session` kind, source, and value to equal the
   expected ones.
2. Sends one `herdr agent prompt <pane> 'Delegate callback · <status> · from pane <HERDR_PANE_ID> ·
   <message>' --wait --until working --until blocked --timeout 10000`, collapsed to one line and
   limited to 2000 characters.
3. Exits `0` when Herdr reports the parent working or blocked after the prompt, and says so.
4. Otherwise runs `herdr notification show 'Delegate callback not sent' --body '<reason> · full report
   in pane <HERDR_PANE_ID>' --sound request` once and exits `3` or `4`:

| Exit | Meaning | The delegate may |
| --- | --- | --- |
| `0` | Prompt accepted and the parent became, or already was, active | stop |
| `3` | Not sent: identity mismatch, pane or agent not found, `agent_blocked`, or `pane get` failed | run it once more, only after the cause is cleared |
| `4` | May have been sent: `agent_prompt_stalled`, timeout, or another error during the prompt | not run it again |
| `1` | Invalid arguments; nothing was sent | fix them and run it |

The helper exists because the check is several steps of JSON comparison and error classification.
Written as a shell one-liner in each handoff, it would drift.

**On receipt**, the parent treats the callback as evidence. It re-runs the stated checks and reads
the diff or file named. It continues only with work Martin has already authorized for the current
increment, then reports in Result / Check / Your turn form. For `failed`, it does not retry or
reassign. For `needs-input`, it relays the question to Martin and stops, because the callback is not
his consent. It does not prompt the delegate in reply unless Martin tells it to.

## Supported and unsupported

- **Delegates.** Claude Code (`claude-opus`, `claude-fable`) is supported: its shell reached the
  Herdr socket in this session. Pi (`pi-ambient`) is expected to work the same way but was not tried.
  Codex (`codex-sol-write`, `codex-sol-read`, `codex-astra-write`) cannot call back: the sandbox
  denied the Herdr socket in the run above. For Codex the parent must watch or wait.
- **Parents.** Pi in a Herdr pane was observed. The helper compares whatever `agent_session` Herdr
  reports, so a Claude Code or Codex parent should work too, but neither was tried.

## Mismatches with the issue's acceptance criteria

Where this direction cannot meet a criterion as written, the gap is stated rather than claimed:

- **Duplicates.** Nothing suppresses a duplicate callback. The bounds are one callback per
  assignment, no re-run after exit `4`, and at most one re-run after exit `3`. A delegate that ignores
  them can make the parent act twice, and the round trip above shows it: an identical second
  callback started a second turn.
- **Replaced parent.** The identity check refuses to prompt a replaced parent (`/new`, `/resume`,
  `/fork`, or a different agent in the pane), notifies Martin, and leaves the report in the
  delegate's pane. The report is never delivered later. Martin reads it there.
- **Busy parent.** A callback to a working Pi steers the running turn, as observed. The parent is
  expected to have ended its turn when it asked for a callback, so this only happens if Martin or
  something else set it working again.
- **Distinguishing and authority.** The status is a word in the callback's fixed prefix. The parent's
  transcript records the callback as `role: user`, indistinguishable from Martin's typing except by
  that prefix. Authority separation is a rule the parent follows, not something the transport
  enforces.
- **Real round trip (criterion 1).** Met once, live: a Pi parent launched a Claude delegate through
  `launch-command` with the `Report back:` line and ended its turn. The delegate called back through
  the helper with exit `0`, and the parent verified the result and stated a bounded next step
  without Martin relaying anything. The parent was a demo session with scripted instructions, and
  its model came from personal settings (`pi-ambient`).
- **Focused checks and a live trial (criterion 7).** Met: the helper's routing, exit codes, and
  notification are covered by automated tests with a fake `herdr`, and the round trip and the
  duplicate above ran live. Not observed live: `agent_blocked`, `agent_prompt_stalled`, and a
  replaced parent through the helper.
- **Crashes.** A delegate that crashes sends nothing, so a crash cannot read as success. Nothing tells
  the parent, either; Martin sees the pane in Herdr.

## Non-goals

A file inbox, a Pi extension, or any delivery service; queuing callbacks for a missing or replaced
parent; duplicate suppression beyond the one-callback rule; Codex callbacks; replies from parent to
delegate; retries beyond one; polling; changes to `launch-command` prompts, since a callback is a
per-assignment choice rather than something every managed delegate needs; personal settings.
