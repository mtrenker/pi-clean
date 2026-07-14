---
description: Capture and validate an issue without publishing it prematurely
argument-hint: "<owner/repository> [portfolio]"
---
Load the `github-issues` skill and follow its deterministic issue-capture workflow for repository `$1` and optional portfolio `$2`. Inspect repository issue forms and valid labels, search plausible duplicates, draft the complete structured issue, and run the planning CLI's `validate-draft` command. Show me the full validation result and exact proposed issue, relationship, milestone, and Project mutations. Obtain confirmation before publishing anything.
