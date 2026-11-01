# dsh-session-cleanup

DeepSeek Harness 的**已归档会话清理**插件：在设置 →「已归档会话」页面里
为每条会话加上**单独删除**，并为整页加上**全部删除**。

原来的页面只能「取消归档」——把会话从归档里放回侧边栏，磁盘上的会话记录
一直在。会话越攒越多时没有任何清理手段。这个插件补上删除，并且删的是**真实
的会话记录**，不是只把它从列表里移走。

> **删除不可恢复。** 会话日志会被从磁盘上移除。

---

## 一、它到底做了什么

### 为什么这不是一个纯前端改动

DSH 本身**没有任何删除会话的能力**。这不是「没做 UI」，而是底层压根没有这个
操作：

| 层 | 现状 |
|---|---|
| Workspace 控制器 | 只有 `archiveSession` / `unarchiveSession` |
| Session 控制器 | 没有 delete 命令 |
| `SessionPersistence` | 只有 `create` / `open` / `stat` / `list`，**没有 delete**（追加写、不可改） |
| 侧边栏的「删除」 | 删的是**工作区注册**，日志明确保留 |

所以删除必须**新增一个宿主侧能力**，这也是本插件有宿主半（host half）的原因。

### 删除的三个步骤，以及为什么是这个顺序

1. 从磁盘删除会话日志目录；
2. 把该 id 从 Workspace 归档集合里移除；
3. 让客户端重新拉取会话列表。

**顺序本身就是安全属性。** 归档集合直到第 2 步才放手，所以两步之间崩掉，留下
的是一条「归档着、但日志已不在」的记录——页面本来就会把它显示成「不可恢复」，
而取消归档也仍能清掉它。反过来先移除归档 id，就会留下一个**侧边栏看得见、
却打不开**的会话。

第 2 步必须经过 Cordis 服务，而**服务只能在声明了 `inject` 的上下文里访问**：
从一个没有注入 `workspaceRegistry` 的上下文里读 `ctx.workspaceRegistry`，抛的是
`cannot get property "workspaceRegistry" without inject`。宿主半因此改为从
**同时注入 `webServer` + `workspaceRegistry` 的作用域**挂载路由：

- 第 2 步因此真的可达；
- 而且「没有 Workspace 注册表」的 profile 干脆不会挂出这个路由，而不是挂出来
  删掉日志、却永远清不掉归档条目。

> **这一条是踩过的坑**：早期版本只注入 `webServer`，却把外层上下文交给 handler。
> 于是每一次删除都是「日志删掉了 + 归档 id 原封不动 + 接口回一个 failed」——
> 页面上表现为「已删除 N 个，M 个失败」，而且那条记录再也删不掉。
> 详见「六、修复记录」。

第 3 步的理由：删除日志**不会**产生任何 Session 生命周期事件，而客户端手里的列表
是快照。不重拉的话，被删掉的会话会「不再归档、却仍在列表里」——正是上面那句
「侧边栏看得见、却打不开」。所以删除成功后客户端会主动重拉一次列表；重拉失败
只记一条警告，不会把已经成功的删除报成失败。

### 没有删的东西

`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`（会话投影检查点）会留下。
它是**另一个存储域**的记录，上游明确写着「清理已存储检查点属于带外维护」，而直接
删一个活着的域的文件会让内存表与磁盘不一致。留一条死记录不会让会话复活——列表
行来自持久化层，缓存只提供列值——所以这里选择不碰它，而不是冒写坏存储域的风险。


### 一次删除涉及的文件

```none
<DSH_HOME>/sessions/
└─ --D-deepseek--/                            ← 项目目录（由会话的 cwd 推导）
   └─ session-<id>/                           ← 被删除的就是这一层
      └─ session.v3.jsonl.zstd
```

项目目录名由会话的 `cwd` 推导（分隔符折叠成 `-`、不安全字符转义成 `~XXXX`、
首尾包 `--`）。归档集合里**不存 `cwd`**，而压缩日志的头部也不便便宜读取，
所以宿主半的做法是：在有限的几个项目目录里按会话 id 找那一个目录。
`projectKey()` 与持久化后端的实现逐字节对齐，并有测试覆盖。

---

## 二、安装

```bash
dsh plugin --profile web add <本仓库>/plugins/dsh-session-cleanup/0.2.1-rc.5/dsh-session-cleanup-0.1.4.tgz
dsh plugin --profile web install
```

装完**重启 dsh web**（插件的宿主半需要在进程启动时挂载路由）。
然后打开 **设置 → 已归档会话**。

本插件**不替换也不需要**改动任何官方包：它通过 `cordis.patch.yml` 把上游那个
只读页面 `ui-settings-unarchive-sessions` 关掉，再注册自己的同名设置页
（`settings.section` 的 id 同为 `archived-sessions`，两个都挂会渲染出两个入口）。

---

## 三、用法

| 操作 | 位置 | 说明 |
|---|---|---|
| 取消归档 | 每行右侧 | 放回侧边栏，日志保留（与上游行为一致） |
| 删除 | 每行右侧 | 删掉**这一条**及其会话日志，有二次确认 |
| 全部删除 | 列表上方 | 删掉**所有**已归档会话，有二次确认 |

**关于「日志已经不在磁盘上」的行**：归档集合比日志活得久——一次中途失败的删除、
或者手工删掉的目录，都会留下「归档着、但日志已不在」的条目。这种条目**也会显示
出来**（标题写作「会话记录已不在磁盘上」），只是没有「删除」按钮，因为它已经没
东西可删；点「取消归档」就把它从归档列表里移除。上游的只读页面会把这些条目整个
藏起来，而归档集合没有别的入口——藏起来就等于永远清不掉，所以这里选择显示。
「全部删除」也会带上它们（确认框里会说明有几条），这样一次批量删除真的能把
归档列表清空。

**关于搜索框与「全部删除」**：搜索只影响你看到什么。点「全部删除」删的是
**全部**已归档会话，不是当前筛选结果——把破坏性批量操作悄悄收窄到当前筛选，
正是那种让人删错东西的设计。如果删除时筛选条件仍生效，确认框会**明确提示**
这一点。

删除部分失败时页面会报出成功/失败的条数，不会假装全部成功。**失败的那条会
保持归档状态**，这样它仍然可见、可以重试，而不是变成一个系统还在记账、
用户却找不到的会话。

---

## 四、安全边界

- 删除接口只监听 **`POST /plugins/dsh-session-cleanup/delete`**
- **仅限本机回环**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），其他来源一律 403
- 目标路径必须落在 `<DSH_HOME>/sessions` 之内，否则拒绝执行
- 会话 id 按后端同一套规则转义后作为**单个路径段**拼接，`..` 会被转义

---

## 五、开发

```bash
node scripts/build.mjs        # 把 src/ 构建成 lib/
node scripts/smoke.mjs        # 两个 bundle 能解析、导出完整、路径编码一致

# 浏览器半：走 apply() 的注册面拿到页面组件，用 React 替身渲染并断言
node scripts/client-verify.mjs

# 宿主半：临时目录造 fixture，并**按 apply() 的真实接线**跑一遍请求
node scripts/host-verify.mjs

# 端到端（需要一台一次性 harness，见下）
DSH_E2E_HOME=<一次性主目录> DSH_E2E_PORT=3094 node scripts/e2e-auth.mjs
DSH_E2E_HOME=<一次性主目录> DSH_E2E_PORT=3097 node scripts/e2e-delete.mjs
```

`src/` 是源码，`lib/` 是构建产物（tarball 里只带 `lib/`）。客户端那半被构建
脚本包成 `window.__ModuleLoader__.load({ id, factory })` 的形式——浏览器没有
import map，React 与平台包都由 factory 的 `require` 按名字提供。

### 测试怎么造环境

- **`host-verify.mjs` 不碰任何真实主目录**：fixture 在系统临时目录里按真实布局
  造，并且把 `DSH_HOME` 指到它（宿主半的删除根目录由 `DSH_HOME` 解析）。
- 它还带一个**仿 Cordis 的上下文**：`inject()` 只在依赖齐全时挂载、注入作用域
  只暴露被注入的服务、读别的服务属性就抛 Cordis 那句 `without inject`。
  这样「接线错了」这件事能在单元测试里就红，而不是等用户点删除。
- **两个 e2e 都强制要求 `DSH_E2E_HOME`**，并把子进程的 `DSH_HOME` 设成它。
  没有这个变量就直接退出——否则子进程会继承调用者的主目录，测到的是那台上
  装着的另一个版本（这个坑真踩过：它把生产主目录里旧副本的 bug 报成了本次结果）。
- `e2e-delete.mjs` 会在该主目录里种一份 fixture（一个日志还在的归档会话 + 一个
  「日志已没了但还在归档里」的残留），启动真实 harness，打真实路由，然后核对
  磁盘、归档集合、以及重复请求的幂等性。
- 一次性主目录的最省事造法：新建一个 profile，让它的 `node_modules` 里
  `dsh-session-cleanup` 指向本插件工作副本（软链接/junction 即可），
  `dsh.profile.bundles` 只留 `dsh-base`、`dsh-web-app` 与它。

---

## 六、修复记录

### 2026-11-01：dsh 0.2.1-rc.5 复核（版本号不变，0.1.4）

清单通过 rc.5 的插件闸门；装入隔离 `DSH_HOME` 的 rc.5 profile 后 `--dump-config` 组合成功、无兼容性告警；
`scripts/build.mjs`、`smoke.mjs`、`client-verify.mjs`、`host-verify.mjs` 全部通过，构建产物与提交内容无 diff。
rc.3 → rc.5 对 `webServer` 注册面、`workspaceRegistry` 与客户端 `__ModuleLoader__` 外壳逐字未变
（`dsh-app-boot`、`dsh-plugin-manager`、`dsh-host-webserver` 只有 `package.json` 的版本号不同），
因此没有业务代码改动，只把基线提到 rc.5。

### 2026-10-25：dsh 0.2.1-rc.3 复核（0.1.3 → 0.1.4）

清单通过 rc.3 的插件闸门；装入隔离 `DSH_HOME` 的 rc.3 profile 后 `--dump-config` 组合成功、无兼容性告警；
`scripts/build.mjs`、`smoke.mjs`、`client-verify.mjs`、`host-verify.mjs` 全部通过。rc.3 相对 rc.2 对
`webServer` 注册面、`workspaceRegistry` 与客户端 `__ModuleLoader__` 外壳没有破坏性改动，因此没有业务代码改动，
只把基线提到 rc.3。

### 2026-09-17：删除永远清不掉归档条目（0.1.0 → 0.1.1）

**现象**：在「已归档会话」里点删除，提示「已删除 N 个，M 个失败」；会话日志
确实从磁盘消失了，但那条记录一直留在归档集合里——刷新后它从页面上消失（因为
日志没了、列表里也没有它了），却永远占着归档集合，`全部删除` 也清不掉。

**根因**：宿主半只注入了 `webServer`，却把**外层上下文**交给了 handler。删除的
第 1 步（删日志）只用到 `home`，照常成功；第 2 步读 `ctx.workspaceRegistry` 时
Cordis 抛 `cannot get property "workspaceRegistry" without inject`，被逐 id 的
`catch` 记进 `failed`——所以日志没了、归档条目还在。

**为什么测试没拦住**：`host-verify` 当时给 handler 传的是一个**普通对象**
（`{ workspaceRegistry: ... }`），属性随便读；`e2e-auth` 只断言了
`removed` / `missing`，**从不断言 `failed` 为空**。两个测试都绕开了出问题的那一层。

**修复**：路由改为从 `ctx.inject(['webServer', 'workspaceRegistry'], …)` 的作用域
挂载；客户端在删除成功后重拉会话列表。测试补上两处断言，并用仿 Cordis 上下文
覆盖 `apply()` 的接线本身。反向验证过：把接线改回旧写法，
`host-verify` / `e2e-auth` / `e2e-delete` 三个测试会同时红，报的就是上面那条错误。

### 2026-09-17：清掉上面那条 bug 留下的残渣（0.1.1 → 0.1.2）

**现象**：0.1.1 修好之后，历史上被这条 bug 弄坏的条目（日志已删、id 仍归档）
在页面上**没有行**——因为页面只渲染「归档集合 ∩ 已加载的会话摘要」。刷新之后
它们既不在归档页上，也不在侧边栏里，但归档集合一直留着，`全部删除` 也只处理
看得见的那些。页面上写着「这里没有可恢复的已归档会话。」，却永远到不了「暂无
已归档会话。」

**修复**：归档集合里的每个 id 都渲染成行。日志已不在的那类行标题写作「会话记录
已不在磁盘上」、只提供「取消归档」（它已经没东西可删了），并且 `全部删除` 会
把它们一并带上，确认框里注明其中几条只做列表移除。这样批量删除真的能把归档
集合清空。`client-verify.mjs` 覆盖这一点：一条有日志、一条没有，断言两行都在、
只有前者有删除按钮。

---

## 七、许可

MIT。自研插件，作者 HaydenSmith1121。
