# 发布清单

1. 确认仓库所有者、公开或私有范围、许可证与署名。目前UNLICENSED是待确认状态，GitHub可见不等于允许他人再分发。
2. 运行npm run check及npm pack --dry-run；仅提交源文件、合成测试、示例和文档。
3. 检查git diff --cached：不得包含账号凭据、真实任务、profile、会话或安装备份。
4. 在隔离profile或新机器中测试安装、手动重启、doctor及创建/恢复会话，记录Host版本。不要改动正在使用的业务会话。
5. 上传GitHub后观察真实CI结果；失败则修复。离线测试不能证明真实Host或跨平台均可用。
6. 发布tag或GitHub Release前确定许可证，写明已验证与未验证范围。当前package.private防止误发npm；npm发布需单独决定。

没有仓库URL前，不填写虚假的repository或issue地址。GitHub登录凭据无效时应重新登录，不读取、打印或写入token。
