# 本机外部资源接入

项目支持把独立 Chrome 番茄账号目录和大型小说素材库登记为本机资源。登记只保存绝对路径和元数据：Chrome Cookie/Profile 原地保留，素材源保持只读，真实路径配置位于 Git 已忽略的 `config/local/`。

## 一次性登记

先预览，再应用：

```powershell
node control.mjs resources import --fanqie-root "C:\Users\Administrator\Desktop\番茄账号-独立Chrome" --material-root "D:\素材库" --json
node control.mjs resources import --fanqie-root "C:\Users\Administrator\Desktop\番茄账号-独立Chrome" --material-root "D:\素材库" --apply --json
```

账号导入会扫描 `Profiles/fanqie-NN` 和对应 `.lnk`，优先采用带 `【备注】` 的快捷方式。若某个 Profile 已在 `fanqie-accounts.json` 中登记，会保留原来的 `accountRef` 和有效 CDP 端口，避免破坏已有书籍绑定。这个过程不会启动 Chrome。

`fanqie local-status` 会区分 Profile 是否已初始化、是否存在 Cookie 存储，但不会把“存在 Cookie 文件”当成已验证登录。真实番茄登录仍只在用户手工发起远端状态检查时核对。

登记后，新书可直接使用账号引用绑定，无需再填写快捷方式或 Profile 路径：

```powershell
node scripts/bind-fanqie.mjs --book "书名" --account-ref fanqie-02 --work-id 123456789 --work-title "番茄作品名" --ai-used true --first-chapter 1 --first-date 2026-07-20 --chapters-per-day 2 --time 18:00
node scripts/bind-fanqie.mjs --book "书名" --account-ref fanqie-02 --work-id 123456789 --work-title "番茄作品名" --ai-used true --first-chapter 1 --first-date 2026-07-20 --chapters-per-day 2 --time 18:00 --apply
```

命令仍然默认只预览。`work-id`、作品名、AI 使用声明和排期属于作品级决策，不会从账号或浏览器标签页猜测。

## 建立与搜索素材索引

索引仅包含文件名、相对路径、大小、修改时间以及从文件名解析出的标题/标签，不读取或复制正文：

```powershell
node control.mjs material local-status --json
node control.mjs material index              # 只预览
node control.mjs material index --apply      # 写入本机状态索引
node control.mjs material search --query "快穿 女" --limit 30
```

索引保存在 `书籍/.state/materials/catalog.json`，不会提交到 Git。

## 选择性导入一本素材

默认只显示源路径和目标路径；加 `--apply` 后，单个文件会复制到 `书籍/<书名>/素材/<素材源ID>/<原相对路径>`。源文件永远不会被修改，已有目标文件也不会被覆盖。

```powershell
node control.mjs material import --source main --file "S/0017_示例.txt" --book "我的书"
node control.mjs material import --source main --file "S/0017_示例.txt" --book "我的书" --apply
```

本机面板 `npm run ui` 也提供素材状态、重建索引、搜索和选择性导入入口。
