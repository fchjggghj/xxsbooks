---
name: xxsbooks-control
description: Safely inspect and control the XXSBooks two-stage GPTS queue. Use for Chinese requests such as “查看进度”, “继续拆”, “开始写”, “停止”, or “修复状态”, and whenever Codex must start, resume, stop, or reconcile the chai/xie workflow.
---

# XXSBooks Control

Run commands from the repository root. Use `node control.mjs ...`; do not use `--dry-run` as a status check.

## Inspect first

1. Run `node control.mjs status --json` before every control action.
2. Read the reported process and lock state. If they disagree, inspect live Node command lines before acting; never delete a lock blindly.
3. Treat status as read-only. Do not start Chrome or a real queue merely to answer a status request.

## Map requests to commands

- 查看进度: `node control.mjs status --json`
- 开始拆: `node control.mjs start chai`
- 继续拆: `node control.mjs resume chai`
- 开始写: verify `chai` is complete, then run `node control.mjs start xie`
- 继续写: verify `chai` is complete, then run `node control.mjs resume xie`
- 停止: `node control.mjs stop`
- 检查状态差异: `node control.mjs reconcile <chai|xie>`
- 修复状态: first show the reconcile preview; only after explicit approval run `node control.mjs reconcile <chai|xie> --apply`

After a write action, rerun `node control.mjs status --json` and report the result.

## Safety rules

- Never run `force`, `reset`, or `reconcile --apply` without an explicit request for that write operation.
- Never automatically reset progress after a failure or stale state. Reconcile saved state against output files instead.
- Never start or resume `xie` until `chai` is complete and its required outputs exist.
- Preserve one independent ChatGPT conversation per top-level novel folder.
- Preserve strict order and stop on the first failed task; diagnose before resuming.
- Rely on the single-instance lock. If another live owner exists, report it instead of launching a second queue.
- Use Node UTF-8/JSON reads when manually checking large state files.

## Validate changes

Run only non-starting checks unless the user explicitly requests a real queue run:

```powershell
node --check control.mjs
npm run check
node control.mjs status --json
```
