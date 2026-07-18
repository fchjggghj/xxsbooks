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

## Fanqie publishing contract

- Each Fanqie account/work binding belongs in that book's `config/books/*.json` under `fanqie`; never infer an account from an open browser tab.
- Start only the bound dedicated Chrome profile with `npm run fanqie:chrome`; never kill Chrome processes or reuse the ChatGPT CDP profile.
- Before publishing, run `npm run fanqie:status`. `fanqie:upload` is preview-only unless the user explicitly requests publishing and `--apply` is supplied.
- Publishing is strictly ordered and fail-stop. Compare every existing remote chapter title with the corresponding local title; never skip a missing chapter, overwrite a mismatched work, or continue after an uncertain submission.
- `aiUsed` must be an explicit boolean in the binding. Do not guess or silently change the AI disclosure or schedule.
- Respect account-scoped `书籍/.state/fanqie/.publish.<accountRef>.lock.json` files (and the legacy `.publish.lock.json`); inspect ownership before handling an existing lock and never delete one blindly.
- Treat `config/local/fanqie-accounts.json` as machine-private. Commit only `accountRef` and portable work/schedule settings in book configs.
- A publish apply requires a passing quality/schedule preflight and durable chapter phases. On uncertain submission, capture evidence and stop; use preview reconcile before any state repair.
- The local UI must never poll Fanqie remotely or publish automatically. Remote access is user-triggered; apply requires typed confirmation plus a second confirmation dialog.

## External resource contract

- Chrome login profiles and bulk material libraries remain outside the repository. Register their absolute paths in ignored `config/local/*.json`; never copy cookies, browser caches, or a whole material library into Git.
- Import accounts by matching the normalized Profile path so an existing `accountRef` remains stable. Account discovery and indexing must not launch Chrome.
- Material sources are read-only. `material index` only writes metadata under `书籍/.state/materials/`; `material import` copies only one explicitly selected file and is preview-only without `--apply`.
- Never overwrite an already imported material file automatically, and reject any source or destination path traversal.

## Campaign contract

- The monthly workflow has six persistent lanes and three cycles starting on days 1, 11, and 21. Initial and continuation targets are 60 chapters unless `config/campaign.json` explicitly changes them.
- A lane owns one active book and one local Fanqie `accountRef`. A continue decision keeps both and extends the target; a replace decision disables the old book before a material novel can enter that lane.
- Campaign enrollment must preserve material provenance, split only recognized `第N章` blocks, create an explicit book config, and never overwrite an existing book.
- `campaign tick` may start chai/xie only when the global queue is idle. It may publish only with both `--apply` and `--publish`, and it must keep all Fanqie preflight, lock, title, schedule, and confirmation gates.
- Metrics and decisions are durable and auditable. Do not infer performance thresholds or automatically retire a book while performance mode is manual.

## Validation

Use these non-starting checks:

```powershell
node --check control.mjs
npm run check
node control.mjs status --json
node control.mjs preflight
python -X utf8 "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" .agents/skills/xxsbooks-control
```
