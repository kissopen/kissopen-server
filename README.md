# KissOpen Server

独立的 KissOpen 开源服务端，源码仓库为 https://github.com/kissopen/kissopen-server 。客户端在 [kissopen](https://github.com/kissopen/kissopen)，模型与工具执行在 [kissopen-agent](https://github.com/kissopen/kissopen-agent)；本仓库不包含二者的源码依赖，不包含商业仓库历史、线上配置、凭证或用户数据。本次公开源码不发布安装包、不部署服务，`releaseReady` 仍为 false。

## 服务边界

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| `packages/kissopen-server` | GitHub / Google / NodeLoc OAuth、设备配对、加密会话/项目同步、设备 RPC 中继、加密附件 | 云端模型调用、看板、收费 |
| `accounts` | OAuth 身份对应的账号资料、头像、身份信息、主题保存/广场、只读插件目录和校验后的安装包下载 | 订阅、账单、点数、云端 Agent、云端任务调度 |
| `packages/kissopen-wire` | 客户端与中继的公共协议类型 | UI、执行器 |
| `packages/kissopen-server-self-host` | 可独立运行的 Node 中继打包壳 | 自动构建手机端或桌面端 |

聊天、模型、插件安装与启停、语义创建和调度定时任务均在用户自己的 Agent。手机访问本地资料库仍需要对应电脑在线；中继不因此变成一份明文云盘。桌面和手机使用同一账号登录后自动关联，不要求扫码。工作区密钥由中继账号服务以 AES-GCM 加密托管，新设备登录后自动恢复，无需旧设备在线。服务器具备恢复密钥的能力，因此不能宣称服务器无法解密的端到端加密。已有设备保管的旧密钥只能在匹配原绑定后迁入托管，不覆盖旧密钥或合并不同账号。

账号服务兼容原有资料和主题记录，采用增量建表，不删除旧表；旧商业表不读取、不执行迁移。`/api/cloud/catalog` 是为了兼容已安装客户端保留的只读插件目录 URL，并不创建云端工作空间。`/api/workspace/*` 返回明确的升级提示，不再生成独立于社区账号的第二套工作区密钥。所有新客户端统一使用中继 `/v1/community/workspace/session`，数据库和服务器主密钥必须分别备份。

管理员仅由 `KISSOPEN_ADMIN_IDENTITIES` 的稳定身份白名单或现有 `admins` 记录授权，不会把首个注册用户变成管理员。保留用户封禁/会话撤销、主题审核及操作审计 API；没有复制商业后台界面或模型/套餐管理接口。

## 本地构建

用户名密码、验证器 2FA、恢复码和 OAuth 绑定管理的接口、迁移及安全边界见 [账号安全规范](docs/account-security.md)。它们使用同一个账号身份，不修改工作区加密密钥。已完成授权部署，验证范围及回滚注意事项见 [部署记录](docs/deployment-account-security-2026-10-06.md)。

要求 Node 22+、pnpm 10.28.1、Go 1.25+，中继打包另需 Bun。运行账号 API 还需要独立 PostgreSQL；中继 standalone 模式使用 PGlite，不要求 Redis、MinIO 或云端 Agent。

```sh
pnpm install --frozen-lockfile
pnpm --filter kissopen-server generate
pnpm build
pnpm typecheck
pnpm test
pnpm audit:source
pnpm smoke
```

账号二进制输出 `dist/kissopen-accounts`，中继打包输出 `packages/kissopen-server-self-host/dist/standalone.mjs`。二者都不包含用户数据。首次构建的 Prisma 客户端生成和构建都在本仓库，不借用客户端仓库的 `node_modules`。

启动前通过进程环境加载私有配置。先运行 `pnpm relay:migrate`，再分别运行 `pnpm relay:start` 和 `pnpm accounts:start`。根 `.env.example` 对应中继，`accounts/.env.example` 对应账号服务。工具不自动载入或打印真实配置，详见 `docs/self-hosting.md`。

## 发布边界

包暂时设置 `private: true`，没有自动发布或生产部署脚本。现有产品仓库和线上进程仍使用原来的源码快照，本次拆分不自动切换它们；先通过兼容验证，再另行部署。复制源码不等于迁移数据库。

插件目录的 51 个现有包没有从线上目录或商业部署拷进 Git。目录可挂载独立数据目录，但第三方插件包须逐项核对再分发。源码公开不代表已完成依赖许可证、OAuth 配置和安全审计的正式发行检查；自动扫描并不构成完整安全审计。详见 `docs/release-checklist.md`。

验证结果和未关闭的依赖安全告警见 `docs/verification.md`。2026-10-06 已经授权部署到现有站点，部署记录见 `docs/deployment-2026-10-06.md`；这不代表源码公开发布审查已经完成。

## 来源与维护

中继和协议保留原 Happy Coder 的 MIT 许可证及作者信息；见 `LICENSE`、`NOTICE.md`。账号服务使用 `LICENSE.accounts`。`EXTRACTION.json` 记录原始快照哈希，哈希针对拆出时的输入，不代表后续精简后的文件内容。

`sources/test-contract` 是现有客户端协议的测试快照，消除了服务器测试跨仓库导入手机端同步层的依赖。协议升级时要同步刷新快照并验证客户端兼容性，而不是修改快照来掩盖服务端不兼容。正式协议分发以版本化的 wire 包为边界。
