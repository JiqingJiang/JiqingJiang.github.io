---
title: "把笼子真的造出来：一个 Agent 沙箱的最小实现"
published: 2026-10-23
updated: 2026-10-23
tags: ["Agent", "Security", "沙箱"]
category: Agent
description: "上次写完 Agent 安全的纵深防御后，沙箱一直停留在架构图层面。这次因为面试被追问沙箱的具体实现，索性动手造了一个最小版本：Seatbelt 的实现思路、怎么验证它起作用、工作区和沙箱的关系、网络出口怎么开，以及为什么绝对安全不存在。"
draft: false
---
## 写在前面：这篇文章是怎么来的

上一篇[《当 Agent 拿到 Shell：从路径围栏到纵深防御》](/posts/tech/Agent/当Agent拿到Shell从路径围栏到纵深防御)写完之后，我没有继续往下探索。那篇文章的结论是「守方应该把执行放进笼子」，还画了一张沙箱架构图：非 root 用户、系统目录只读、仅挂载工作区、默认断网。图画得很完整，但沙箱本身始终是一个概念，我没有真的造过它。

最近面试的时候，面试官顺着安全这条线往深追：你说路径围栏和命令黑名单能防御的很有限，需要沙箱，那沙箱具体怎么实现？确实「知道该做沙箱」和「知道沙箱怎么做」是两回事，于是面试结束后，我带着下面几个问题，开始和DeepSeek Harness聊天。然后用这篇文章对沙箱这块的了解做一个简单的记录。

1. 做沙箱要达到的目标是什么？
2. 实现沙箱的思路
3. 困惑1：如果要在工作区干活，是要把沙箱套在工作区外面？
4. 困惑2：如果确实有一些情况需要跳出工作区外去操作，这种情况怎么解决？
5. 困惑3：沙箱直接断网固然安全，但是也会限制能力，如果确实需要联网，那又该怎么办？
6. 困惑4：沙箱虽然物理上把Agent放进了一个笼子里，但这样是否就是绝对安全？


## 一、目标：沙箱到底要保证什么

一句话：**给不可完全信任的代码（比如模型的 bash 命令）造一个损失封顶的执行环境。**

拆开是三个保证，缺一不可：

1. **文件封顶**：即使模型执行 `rm -rf /`，它能碰到的磁盘范围只有工作区。注意措辞——不是「被规则拒绝」，是**物理上不可写**。
2. **网络封顶**：模型跑的命令不能外传代码和密钥，不能下载攻击载荷。断网一条解决。
3. **失效即封死**：沙箱机制本身不可用时（比如 macOS 哪天移除了 `sandbox-exec`），拒绝执行，而不是退化为裸跑。安全组件的失败方向必须是「不做事」，绝不是「不设防地做事」。

同样重要的是目标里**没有**的东西：沙箱不判断命令「好坏」（那是权限门的事）、不记录审计（那是 hook 的事）。它只做一件事：划一块封顶的牢笼。职责单一，正是它能兜底的原因。

## 二、思路：不要在应用层检查行为，让操作系统替你执法

上一篇的结论是黑名单防不住语义变形。这一篇想清楚了一层原因：**权限门和黑名单工作在「字符串」层面，而攻击发生在「系统调用」层面。**

模型说 `rm -rf /tmp/x`，黑名单检查的是这串字符。但同一个效果可以写成：

```bash
echo rm -rf / | bash                      # 字符串里没有 "rm -rf /"
bash script.sh                            # 恶意内容藏在文件里
python -c "import shutil; shutil.rmtree('/')"
ln -s / ~/p && write_file p/etc/passwd    # 软链逃逸
```

字符串检查注定是打地鼠。而操作系统层面没有字符串，只有系统调用。`open("/etc/passwd", O_WRONLY)` 发到内核时，内核问的是「这个进程被授权写这里吗」——没有商量余地，也没有变体可绕。无论 bash 套多少层、脚本藏多深，syscall 总要发。

所以思路是三步：

```text
① 找到 OS 提供的隔离原语（macOS: Seatbelt；Linux: mount namespace）
② 用声明式配置告诉内核：这棵进程树，禁网络、只许写这几个路径
③ 所有不可信命令都通过这个原语启动子进程，绝不裸跑
```

这和工具分发用查表是同一个设计品味：**把执法权从自己的代码移交给更底层、更无法被欺骗的机制。**

## 三、实现：完整的 Seatbelt 沙箱代码

macOS 上选了 Seatbelt（`sandbox-exec`），这也是 Claude Code 在 macOS 上的实际做法：不起容器，直接用内核原语，毫秒级启动，适合 agent 高频跑命令的场景。完整实现如下：

```python
#!/usr/bin/env python3
"""miniagent/sandbox.py —— 生产级沙箱（教学最小版）"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


class SandboxDenied(Exception):
    """进程被沙箱拦截（如访问网络、越权写文件）。"""


class SandboxUnavailable(Exception):
    """本平台没有可用沙箱后端——宁可拒绝执行，绝不裸跑。"""


def _seatbelt_profile(writable: list[str]) -> str:
    """生成 Seatbelt 策略文本。语法是 Scheme 风格的 S 表达式。"""
    allow_write = " ".join(f'(allow file-write* (subpath "{p}"))' for p in writable)
    return f"""(version 1)
(allow default)
(deny network*)
(deny file-write*)
{allow_write}
"""


class Sandbox:
    def __init__(self, writable_paths: list[Path | str] | None = None):
        # 基目录也要 resolve：macOS 的 /var 是 /private/var 软链
        self.writable = [str(Path(p).resolve()) for p in (writable_paths or [])]
        self.backend = self._pick_backend()

    @staticmethod
    def _pick_backend() -> str:
        import shutil
        if sys.platform == "darwin" and shutil.which("sandbox-exec"):
            return "seatbelt"
        if sys.platform == "linux" and shutil.which("bwrap"):
            return "bwrap"
        return "none"   # 宁可拒绝执行，绝不裸跑

    def run(self, command: str, timeout: int = 30) -> str:
        """在沙箱里跑一条 shell 命令，返回合并输出。越权行为 → SandboxDenied。"""
        if self.backend == "seatbelt":
            argv = [
                "/usr/bin/sandbox-exec",
                "-p", _seatbelt_profile(self.writable),   # 声明式策略，-p 内联传给命令行
                "/bin/bash", "-c", command,
            ]
        elif self.backend == "bwrap":
            # Linux：mount namespace 造假根，只挂必要的 + 工作区可写
            argv = ["bwrap", "--unshare-all", "--die-with-parent",
                    "--ro-bind", "/", "/",
                    "--dev", "/dev", "--proc", "/proc"]
            for p in self.writable:
                argv += ["--bind", p, p]
            argv += ["/bin/bash", "-c", command]
        else:
            raise SandboxUnavailable(
                f"no sandbox backend on {sys.platform}; refusing to run unsandboxed")

        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise SandboxDenied(f"timeout after {timeout}s") from e

        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        # Seatbelt 拦截时进程非零退出，stderr 留有 Operation not permitted
        if proc.returncode != 0 and "Operation not permitted" in out:
            raise SandboxDenied(out[:2000])
        return out or "(no output)"
```

代码里几个容易看混的点，一次说清：

`sandbox-exec -p '<策略>' /bin/bash -c '<命令>'` 就是一条普通命令：`sandbox-exec` 把策略文本交给内核、给当前进程打上沙箱标签，然后把自己**替换**成后面的 bash。标签随 `fork`/`exec` 继承，所以 bash 及其派生的一切进程从第一条指令起就在笼内。`_seatbelt_profile` 没有魔法，就是字符串拼接——Python 只负责**生成**策略，**读懂并执法**的是内核。也因此，`run()` 里事后检查 `Operation not permitted` 只是解读结果，安全本身不依赖它，真正的执法在内核里。

策略本身五行：`allow default` 是黑名单式宽放行，因为白名单误伤率太高（`ls` 都要读一堆系统路径），误伤多了用户就开始无脑放行——警告疲劳是权限系统的头号失败模式。deny 优先级高于 allow，所以最后一行是在「全禁写」的墙上给工作区凿一个门。`file-write*` 的 `*` 匹配所有形式的写（写、建目录、删除、改权限），`subpath` 匹配目录树下所有路径。

### 一个必须有的零件：失效即封死

`_pick_backend()` 找不到可用原语时返回 `"none"`，`run()` 直接抛 `SandboxUnavailable`。这个分支最容易被当成废话删掉，但它是三个保证之一：**沙箱不可用时的行为本身就是安全属性。**

## 四、验证：只认外部事实，不认报错字符串

验证沙箱 = 验证「越权尝试真的失败」+「正常工作真的成功」：

| 用例 | 命令 | 期望 |
|---|---|---|
| 笼内写（必须成功） | `echo hello > ws/probe && cat` | 文件真的创建且可读 |
| 网络 | `curl -s -m 3 example.com` | 被拦截 |
| 越权写 | `echo x > /tmp/probe` | 被拦截且 `/tmp/probe` 不存在 |

## 五、困惑1：工作区怎么办？——不是把工作区放进沙箱，是给工作区发通行证

这是我之前最想不通的问题：如果用户真的需要 Agent 在某个目录里改东西，「放进沙箱」听起来像要把文件复制到隔离的小世界，那用户目录下的真实文件怎么办？

想反了。**沙箱不改变文件系统的事实，只改变进程的能力。** 真实磁盘上，工作区原地不动，一个字节没复制。沙箱给子进程打标签：

```text
整个文件系统 = 真实的那一套（唯一）
子进程的能力 = 读：基本全开    写：只有工作区那几个前缀    网络：无
```

所以「在 `~/my-project` 改东西」和沙箱不冲突——那个目录就是 `Sandbox(writable_paths=[...])` 的参数：

```python
sb = Sandbox(writable_paths=[Path.home() / "my-project"])
sb.run("echo fix > ~/my-project/src/bug.py")   # ✓ 该干的活照干
sb.run("rm -rf ~/Documents")                    # ✗ 物理不可达
```

体会一下取舍的反转：**没有沙箱时，「能写工作区」和「能写全盘」是同一种能力**，只能靠检查字符串猜哪次写是好的；有沙箱后两种能力被物理拆开——风险不是「降低了」，是那一类风险**消失了**。

真正的问题从「工作区怎么办」变成「**门该开多宽**」，递进三档：

1. **最小开头，按需加宽**：默认只放工作区。任务要碰 `~/.ssh/config`？走人工审批，批准一次就把路径加进 `writable_paths`。审批粒度从「命令」升级成「能力」：以前问「允许这条命令吗」（问完就忘），现在问「允许写这个目录吗」（问完持久收编）。
2. **工作区内部再收窄**：只放 `src/`，禁 `.git/`（防改历史）、禁 `.env`（防密钥被写进交付文件）。粒度是策略配置，不是机制改动。
3. **任务级强隔离：git worktree**：连工作区本体都不想让模型碰时（「帮我重构，改砸了算我的」），开一个 worktree 副本，沙箱只放行副本，改完人审再合并。

顺带一个隐藏问题的答案：为什么读基本全开？Agent 要干活必须读，把读也白名单化误伤率高到没法用。生产上靠**网络封顶**消化「能读敏感文件」的风险：模型就算读到私钥，也传不出去。**断网把「读得到」和「拿得走」切成了两个独立问题**——这是整个 profile 里价值最高的一行。

## 六、困惑2：确实需要跳出工作区，怎么办？

如果出口处理不好，用户被反复打扰后开始无脑点 y——警告疲劳，整套防御形同虚设。所以答案不是「放行」，是**给逃逸修一条受控的、贵的、留痕的路**。四个原则：

**① 出口必须显式建模，不能是绕过。**「跳出」的合法形态是**收窄后的临时加宽**：

```python
# 任务需要 pip install（要写 site-packages、要连 pypi）
sb = Sandbox(
    writable_paths=[WORKDIR, site_packages_dir],                # 只加这一个写点
    network_allowlist=["pypi.org", "files.pythonhosted.org"],   # 网络只开到 pypi
)
sb.run("pip install requests")
```

注意加宽的形状：**按资源开，不按命令开**。命令可以变形，资源是物理的。

**② 加宽必须人工审批，且展示「能力」而不是「命令」。** 审批对话框应该说人话：「任务需要**永久修改系统 Python 包目录**并**访问 pypi**，批准吗？」批准后：会话级有效、任务结束收回、进审计日志。

**③ 分级：不是所有逃逸都同等危险。**

| 逃逸类型 | 危险度 | 处理 |
|---|---|---|
| 写临时目录（`/tmp`） | 低 | 直接放进默认 writable，不打扰用户 |
| 写另一个项目目录 | 中 | 审批一次，会话内收编 |
| 装系统包 / 改系统配置 | 高 | 审批 + 会话级 + 审计，或引导到容器里做 |
| 网络 | 最高 | 域名白名单代理，永远不给裸网（怎么开见下一节） |

把低档做成免打扰，才保得住高档审批的严肃性。

**④ 留好「做不到」的选项：任务可以失败。** 反直觉但重要：如果某个操作连审批都不该给，正确答案是 Agent 明确报告「这超出我的权限，请你手动执行这步」然后停。**安全系统最危险的设计是暗示「总有办法办成」**——留一条体面的失败路径，模型才不会为了完成任务去钻空子。

## 七、困惑3：确实需要联网，开口怎么设？

断网很干净，但任务需要 `pip install`、查文档，这就需要开口。网络门比文件门难开，因为它天生**双向**：能连出去 = 能上传（外传密钥/代码）也能下载（拉攻击载荷）。而且它有三个阴险属性：

1. **目标不是它看起来的样子**：允许了 `pypi.org`，URL 重定向可以带到别处；DNS 域名和最终 IP 是两件事（DNS 重绑定）。
2. **DNS 本身就是出口**：只放行 DNS 也不安全，查询串可以编码外传数据（DNS exfil）。
3. **粒度错位**：内核只能看清 **IP:端口**，看不懂「域名」——`pypi.org` 是应用层概念，内核只见到一串漂移的 CDN IP。

第三条是设计开口时最容易踩的坑，它直接推出结论：**在沙箱进程里「开域名白名单」是不可能的，正确做法是沙箱保持全断，网络能力整体移交给笼子外的代理进程。**

Seatbelt 其实可以表达细粒度网络规则（`(allow network-outbound (remote tcp "*:443"))`），但按 IP/端口授权没实用价值——放行所有 443 等于没拦，外传数据挂个 TLS 就出去了。

### 架构：两个进程，两种信任级别

```text
┌─────── 沙箱（deny network* 全断）──────────┐
│  bash → pip / curl                       │
│      │ 唯一能连的：127.0.0.1 代理端口       │ ← Seatbelt 精确放行这一条出站
└──────┼───────────────────────────────────┘
       ▼
┌─ 代理进程（笼外，沙箱管不到它）───────────┐
│  1. 校验目标域名 ∈ allowlist           │
│  2. 自己做 DNS（沙箱内假 DNS 查不到）    │
│  3. 重定向链每一跳重新过白名单           │
│  4. 拒绝私网/回环/云元数据 IP           │
│  5. 限方法（GET/HEAD）、限大小、限速率   │
│  6. 全程记日志：URL → 解析 IP → 字节数  │
└──────────────────┬───────────────────┘
                   ▼
              真实互联网
```

关键在职责切分：

- **沙箱进程**：物理上只有一条出站路——连本机代理。想绕没有第二条路。它甚至**不需要 DNS**（连代理用 127.0.0.1），DNS 隧道从根上不存在。
- **代理进程**：唯一持有网络能力的组件。它是专门写的、代码可审计的小程序，**不是模型的执行对象**——模型无法让代理执行任意操作，只能发请求，代理按白名单决定放不放。

这就是**信任分离**：把「需要联网」从「不可信代码」身上剥下来，交给一个可信的、极小的守门人。信不过模型，但信得过 300 行自己写的 proxy。核心逻辑不复杂：

```python
ALLOWED = {"pypi.org", "files.pythonhosted.org"}
DENIED_IP = ipaddress.ip_network("169.254.169.254/32")  # 云元数据

def handle_connect(host, port):
    if host not in ALLOWED:
        return reject("domain not in allowlist")
    ip = socket.gethostbyname(host)          # 代理自己做 DNS
    if ipaddress.ip_address(ip).is_private or ip in DENIED_IP:
        return reject("resolves to private/metadata IP")   # 防 DNS 重绑定
    log(f"{host} → {ip}")                     # 全程留痕
    return tunnel(host, port)
```

重定向会重新走一遍 `handle_connect`，域名白名单 + 解析后 IP 黑名单，域名伪装和重绑定都堵死。实现不用造轮子：`mitmproxy`（可编程拦截）、Squid（`http_access` 域名白名单）都是成熟零件。

### 网络开口也分级

和文件门一样按危险度递进，默认停在最底档：

| 档位 | 能力 | 适用场景 | 实现 |
|---|---|---|---|
| 0 | 全断 | 默认。绝大多数编码任务 | `deny network*` |
| 1 | 只许连本机代理 | 需要装依赖、查文档 | profile 放行 `127.0.0.1:3128` |
| 2 | 代理白名单放行特定域名 | `pip install` | allowlist 加 `pypi.org`，审批一次 |
| 3 | 任意 HTTPS | 极少 | 审批 + 严格审计 + 限时长。最好这档不存在——访问陌生站点该让用户自己开浏览器 |

1→2 是配置变更，不是架构变更。所有放行**会话级有效、任务结束收回**。还有一条横切规则：**「能读秘密」和「能联网」不能同时自动获得**——需要 `pip install` 的会话里，环境变量就不该带 `GITHUB_TOKEN`。两个能力拆开授权，哪怕代理策略配漏了，笼子里也没有值得偷的东西。

## 八、困惑4：绝对安全了吗？——不，剩下的风险按「哪里最可能被打穿」排序

沙箱 + PathGuard + CommandGuard 是很好的纵深防御，但「绝对安全」在系统安全里不存在：

1. **执法点本身的漏洞**。沙箱是系统组件，组件自己有 bug：内核 0day 可以逃逸 namespace；`sandbox-exec` 已被 Apple 标记 deprecated。这是高敏感场景升级到 Firecracker 微 VM（不共享内核）的理由。
2. **你自己就是攻击面：提示注入**。最现实的一条。三层防御防「模型乱来」，防不住「模型被诱导」：它读了一个藏着恶意指令的文件，然后每一步都合规——审批弹窗了，用户看着貌似合理的解释点了 y。**沙箱拦不住被合法授权的恶意操作。** 审计日志依然是必需品：不是防模型，是防「授权本身被骗」。
3. **配置错误**。最常见的事故来源：`writable_paths` 手滑传了 `~`、路径没 resolve 被软链改了语义。安全系统最大的漏洞往往不在机制里，在使用机制的人手里——这也是「失效即封死」值钱的原因。
4. **允许的通道被滥用**。断网了，但任务需要 `pip install` 呢？白名单不是「安全了」，是**把攻击面收缩到一个可以审查的小口**。

安全是概率和成本的博弈，不是布尔值。做得好的标志不是「攻不破」，是**被攻破时有边界、有痕迹、有恢复手段**。

## 九、收拢：四件套，一个心法

把两篇文章合起来，Agent 安全的完整形态是四件套：

```text
默认封顶   —— 沙箱兜底：全盘锁死，只给工作区发通行证
显式提权   —— 按资源开扇门，人工审批，会话级收回
全程留痕   —— 审计不是防模型，是防「授权本身被骗」
允许失败   —— 留一条体面的「这步我做不了」，比万能出口更安全
```

> 应用层检查（permission、黑名单）管「流程与升级」，内核层隔离（sandbox）管「物理兜底」；验证隔离只认外部事实（文件存在与否、退出码），不认报错字符串。

## 参考资料

- [Apple Seatbelt / sandbox-exec 相关公开研究（saagarjha 的梳理）](https://saagarjha.com/blog/2020/07/09/what-it-takes-to-run-sandbox-exec/)
- [Linux Landlock Documentation](https://docs.kernel.org/userspace-api/landlock.html)
- [bubblewrap](https://github.com/containers/bubblewrap)
- [Firecracker microVM](https://firecracker-microvm.github.io/)
- [当 Agent 拿到 Shell：从路径围栏到纵深防御（上一篇）](/posts/tech/Agent/当Agent拿到Shell从路径围栏到纵深防御)
