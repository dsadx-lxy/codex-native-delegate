# Codex Native Delegate

本地 DeepSeek Harness Host 插件及监督命令行工具。监督端负责范围、单次权限审核和独立验收；Harness 会话执行任务。它使用本机文件队列通信，不启动网络服务，不读取或迁移账号凭据。

这是独立开发的插件项目，不是 OpenAI 或 DeepSeek 官方发布、认证的插件。当前版本采用私有仓库保存，许可证待作者确认；暂设 `private: true` 和 `UNLICENSED`，阻止意外npm发布。

## 支持范围

- 需要现有 DeepSeek Harness Desktop、已登录模型和有效 agent/permission preset；不附带 Harness。
- Node.js 22及以上；本机已测Node 24。CI配置包含Windows/Linux与Node 22/24，尚未把CI配置当作已通过记录。
- Host 使用Cordis公开的服务访问方式，但所需服务接口由Harness提供，未来版本可能变化。详见[兼容性](docs/compatibility.md)。
- 支持任务创建、同会话续作、取消、逐次允许/拒绝、结果和验收记录。只允许 `workspace-write + ask`，不会自动批准工具。

## 本地安装

1. 将本仓库放在允许任务根目录下的独立目录。
2. `npm test`运行离线测试；没有第三方运行依赖，无须执行npm install。
3. 复制 `installer.example.json` 为 `installer.local.json`，将所有占位符改成实际绝对路径。`allowedRoot`必须包含插件及任务工作目录；选择专用范围，避免设置为整块磁盘。配置文件不入库。
4. 查看当前目标profile的SHA256并记录。PowerShell可运行 `Get-FileHash -Algorithm SHA256 -LiteralPath <profile>`；Linux可运行 `sha256sum <profile>`。
5. 先预览，再安装：

```sh
node installer.mjs --config installer.local.json --baseline-sha256 <当前profile哈希>
node installer.mjs --config installer.local.json --baseline-sha256 <当前profile哈希> --apply
```

安装器只维护本插件的托管配置块，备份原配置。更新可加 `--versioned` 生成独立版本目录；已有托管块时无需首次安装基线。它不会自动重启程序，也不会关闭现有任务。**完全退出并重新打开Harness后**再运行doctor。热加载未经实际验证。

```sh
node native.mjs doctor --control-dir <与安装器一致的controlDir> --json
node native.mjs start --control-dir <controlDir> --owner <监督对话标识> --cwd <工作目录> --task-file <任务文件> --title <任务名称>
node native.mjs status <taskId> --control-dir <controlDir>
node native.mjs pending --control-dir <controlDir>
```

CLI默认队列为仓库下的 `native/control`；若配置了其他位置，每条命令均应传 `--control-dir`。

## 监督和验收

```sh
node native.mjs approve <requestId> --owner <owner> --control-dir <controlDir>
node native.mjs reject <requestId> --owner <owner> --reason <原因> --control-dir <controlDir>
node native.mjs continue <taskId> --owner <owner> --task-file <后续任务文件> --control-dir <controlDir>
node native.mjs cancel <taskId> --owner <owner> --reason <原因> --control-dir <controlDir>
node native.mjs review <taskId> --owner <owner> --verdict accepted --evidence <独立验证证据> --control-dir <controlDir>
```

批准前查看请求的完整工具参数与影响范围。执行完成不代表验收通过；新round会使旧验收失效。owner防止误操作，不是用户身份认证；其他能写队列目录的进程仍可干预，详见[安全说明](SECURITY.md)。

## 升级和卸载

更新前结束或取消自己的委派任务；安装新版本并重启Harness。旧版本和备份保留在本机records/releases目录。卸载时只移除profile中 `codex-native-delegate` 的完整托管块；不要覆盖其他插件的配置。需要回退时先确认备份之后没有其他配置变化，再恢复本插件路径。

## 开发与发布

```sh
npm run check
npm pack --dry-run
```

发布清单见[发布说明](docs/releasing.md)。不要上传control、运行记录、profile、凭据或本机配置。仓库包含可安装的功能插件，但不声称已经进入官方插件商店。GitHub上传和npm发布是两件事；当前不进行npm发布。
