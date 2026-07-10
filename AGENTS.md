# XXSBooks agent rules

This repository is a two-stage GPTS queue organized by book and volume. Each book lives under `书籍/书名/卷名/` and contains three subdirs: `原文/` (chai input) -> `拆分/` (chai output / xie input) -> `正文/` (xie output). `chai` must finish before `xie` starts. State and logs live in `书籍/.state/`, never inside book/volume folders.

Volume mode is mandatory (`volumeMode: true` in config). Volume names support Chinese numerals (第一卷/第二卷/...第十一卷) and are sorted correctly.

Every volume keeps its own ChatGPT conversation URL per stage (recorded in `state.novelConversations["书名/卷名"]`); chapters of the same volume reuse one conversation, different volumes never cross addresses — this prevents context window overflow.

Prior volume context injection (`priorVolumeContext: true` in config-xie): when xie processes a volume, it reads all prior volumes' `拆分/` files as background context, injected via `{{priorVolumes}}` placeholder in the prompt template.

## Control contract

- Use `node control.mjs ...` for Codex control operations.
- Before every action, run `node control.mjs status --json` and check both the live process and single-instance lock reported there.
- `status --json` is the canonical pure read-only queue overview. Plain `--dry-run` is also read-only, but it previews send tasks rather than reporting controller health; `--reset-state` remains mutating.
- Map common requests literally: 查看进度 -> `status --json`; 继续拆 -> `resume chai`; 开始写 -> verify chai complete, then `start xie`; 停止 -> `stop`; 修复状态 -> preview `reconcile` first.
- Never run `force`, reset state, or `reconcile --apply` unless the user explicitly authorizes that write operation. Never auto-reset after failure.
- Never delete a lock blindly. If status is inconsistent, inspect live Node command lines and saved ownership before deciding.
- Preserve one independent ChatGPT conversation per volume (书名/卷名), strict chapter order, and failure-stop semantics.
- After any start, resume, stop, or applied reconcile action, rerun `node control.mjs status --json` and report the concrete result.
- Do not launch Chrome or a real queue for documentation, status, or validation work.

## Validation

Use these non-starting checks:

```powershell
node --check control.mjs
npm run check
node control.mjs status --json
node control.mjs preflight
python -X utf8 "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" .agents/skills/xxsbooks-control
```
