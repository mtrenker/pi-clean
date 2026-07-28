---
description: Groom a configured GitHub portfolio from deterministic evidence
argument-hint: "[portfolio]"
---
Load the `github-issues` skill and follow its deterministic planning workflow. Run the planning CLI's `groom` command for `$1` (omit the portfolio argument when blank), investigate its stable findings, and separate mechanical evidence from semantic decisions that require me. Report the portfolio using the skill's project-grooming format: use linked issue/PR titles rather than bare numbers, explain dependency and gate consequences in plain language, and give a concrete next move for every item needing attention. End with the smallest descriptive decision I need to make. Before any remote change, present the complete proposed GitHub mutations and obtain confirmation.
