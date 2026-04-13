---
name: e2e-ui-skill
description: Deterministic E2E skill that marks the workflow UI spec when the UI designer works on it.
license: UNSPECIFIED
compatibility: codex,minimax
---

# E2E UI Skill

Use this skill only when you are editing or creating the workflow UI spec document.

Preferred target paths:

- `docs/ui/01_android_ui_spec.md`
- `docs/ui/01_ui_spec.md`
- `docs/design/ui/01_ui_spec.md`
- `TeamWorkSpace/docs/ui/01_android_ui_spec.md`
- `TeamWorkSpace/docs/ui/01_ui_spec.md`
- `TeamWorkSpace/docs/design/ui/01_ui_spec.md`

Requirements:

1. Add the exact marker `E2E_SKILL_MARKER_V1` to the document.
2. Mention that the marker was added because of the imported E2E skill.
3. Keep the marker as plain text so automated validation can find it.
