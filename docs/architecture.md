# 工作方式

监督端CLI → 本机control文件队列 → Harness Host插件 → 独立Agent/Session。

Agent调用工具 → 插件捕获完整工具参数 → 单次审批请求 → 监督端approve/reject → Host执行或拒绝 → 原始工具结果 → 独立验收记录。

插件代码没有导入或复制Harness内部模块。Host依赖通过Cordis服务注入；工具调用与审批监听绑定到自建Agent，并核验任务、owner、round和session。外部人工会话继续交给Host原有处理链。

状态文件与输出不是跨用户可信的认证数据。调用者有责任保护control目录，并在接受结果前独立检查。默认不存在无人值守自动批准器。

旧会话恢复先检查持久化cwd和权限事件，再恢复Agent监听；恢复后再次验证实际Agent权限。缺失记录或权限扩大时失败关闭。
