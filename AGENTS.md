# XXSBooks agent rules

This repository is a two-stage GPTS queue organized by book. Each book lives under `书籍/书名/` and contains three subdirs: `原文/` (chai input) -> `拆分/` (chai output / xie input) -> `正文/` (xie output). `chai` must finish before `xie` starts. State and logs live in `书籍/.state/`, never inside book folders.

Volume mode is optional (`volumeMode` in config, default false). When enabled, an extra `卷名/` layer sits between `书名/` and the subdirs: `书籍/书名/卷名/原文/`. Volume names support Chinese numerals (第一卷/第二卷/...第十一卷) and are sorted correctly. Use volume mode for long novels to prevent context window overflow; short/medium books can stay flat.

Each book (or volume, when volume mode is on) keeps its own ChatGPT conversation URL per stage (recorded in `state.novelConversations["书名"]` or `state.novelConversations["书名/卷名"]`); chapters of the same book/volume reuse one conversation, different books/volumes never cross addresses.

Book enrollment is explicit. Every active book must have one independent `config/books/*.json` file. Unconfigured folders under `书籍/` are ignored by queue building and preflight so a newly copied book cannot interfere with an existing run. Prefer `node control.mjs start <stage> --book "书名"` for book-scoped work; scoped state merges must preserve tasks and conversations belonging to all unselected books.

For xie, the chapter title is immutable: read it from the first non-empty line of the matching `原文/NNNN.txt` or `.md`, inject it into the prompt as `{{originalTitle}}`, and enforce it again before writing the reply. Never replace an original title with a generated summary title.

Prior volume context injection (`priorVolumeContext` in config-xie, only effective with `volumeMode: true`): when xie processes a volume, it reads all prior volumes' `拆分/` files as background context, injected via `{{priorVolumes}}` placeholder in the prompt template.

## Control contract

- Use `node control.mjs ...` for Codex control operations.
- Before every action, run `node control.mjs status --json` and check both the live process and single-instance lock reported there.
- `status --json` is the canonical pure read-only queue overview. Plain `--dry-run` is also read-only, but it previews send tasks rather than reporting controller health; `--reset-state` remains mutating.
- Map common requests literally: 查看进度 -> `status --json`; 继续拆 -> `resume chai`; 开始写 -> verify chai complete, then `start xie`; 停止 -> `stop`; 修复状态 -> preview `reconcile` first.
- Never run `force`, reset state, or `reconcile --apply` unless the user explicitly authorizes that write operation. Never auto-reset after failure.
- Never delete a lock blindly. If status is inconsistent, inspect live Node command lines and saved ownership before deciding.
- Preserve one independent ChatGPT conversation per book (or per volume in volume mode), strict chapter order, and failure-stop semantics.
- Only persist concrete `https://chatgpt.com/c/...` conversation URLs. Never save a GPT introduction URL as a book conversation, and never allow two books in the same stage to claim the same conversation URL.
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
