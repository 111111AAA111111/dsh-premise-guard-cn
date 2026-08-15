# dsh-premise-guard-cn · 前提守卫

面向**中文小说／长文创作项目**的前提防丢插件（DeepSeek Harness）：上下文压缩时，若摘要丢失了关键前提锚点，自动注入一条中文告警。

fork of [ICCuse/dsh-premise-guard](https://github.com/ICCuse/dsh-premise-guard)（MIT）。上游只认 ASCII 锚点（代码路径、报错码、`key=value`、点号命令），对中文内容基本空转；本版把锚点提取改成**中文优先**，并增加**手动标注清单**。

## 解决的问题

- 长会话被压缩后，模型自己不知道"丢了什么"。本插件在压缩摘要生成时比对被压缩区间与摘要文本，发现关键锚点消失，就在下一步注入告警，指回日志。
- 中文项目里真正致命的是设定前提："应世、日轮已对调""诸星归核，日轮初升""十死无生"。原版抓不到这些，本版能。

## 功能

### 1. 中文优先的自动锚点提取

| 模式 | 示例 |
|---|---|
| 中文引号／书名号／直角引号内短语 | “万象同出一恒星”、《大静默》、「诸星归核，日轮初升」 |
| 顿号／箭头术语链 | 应世、日轮、垂象；感→择→通→引→留→化→复 |
| 编号锚点 | W01、W14 |
| 仓内中文相对路径 | 力量体系/中阶·应世日轮垂象.md |
| 数字区间与数量 | 300—1000公里 |
| 长中文串（≥12 字） | 太阳系是外部仙道文明已经撤离的边疆天然贫瘠星域 |
| 原版 ASCII 模式（保留兜底） | 路径、键值、错误码、点号 token |

判定规则：汉字 ≥4 即视为关键锚点；内置中英文停用词表过滤虚词。

### 2. 手动锚点清单（标注入口）

清单文件默认 `<工作区>/.dsh-meow/anchors.md`，每行一条；`#` 开头为注释；行首 `- ` 可省。**被压缩区间里出现过、却未出现在压缩摘要中的清单锚点，会以【标注】优先报警**（不出现则不报警，不会刷屏）。

### 3. 工具与命令

- `premise_anchor` 工具（模型可调用）：`list` / `add` / `remove`，维护当前工作区清单；
- `/anchor` 命令（用户）：操作默认清单（`$DSH_HOME/anchors.md`），工作区清单请用工具或直接编辑文件。

### 4. 告警样例

```
⚠️ 前提告警【前提守卫 premise-guard-cn】：刚才的上下文压缩（seqs 12-40）生成的摘要丢失了以下关键锚点：
- 【标注】原“日轮、应世”已正式对调为“应世、日轮”
- 第二次日轮突破成功率约为第一次的三成；第三次强行突破十死无生
若这些前提仍然重要，用 session 事件工具从日志读回被压缩区间核对；若摘要已用等价表述保留，或前提已不再影响当前工作，忽略本提醒。
```

## 安装

```bash
dsh plugin --profile web add "github:111111AAA111111/dsh-premise-guard-cn"
# 或本地目录安装：
dsh plugin --profile web add "file:/path/to/dsh-premise-guard-cn"
```

重启 DSH 后生效（重启前安装无效，插件随 bundle 在启动时加载）。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖（字段均可选）：

```yaml
- insert:
    - id: premise-guard-cn
      name: 'dsh-premise-guard-cn'
      config:
        anchorsFile: ''      # 手动锚点清单路径；空=自动回退 <cwd>/.dsh-meow/anchors.md → $DSH_HOME/anchors.md
        maxAnchors: 5        # 一次告警最多列出的锚点数
        minAnchorLength: 4   # 自动锚点最短长度
        maxNoticeChars: 700  # 告警文本最大长度
```

## 锚点清单写法

```markdown
# 关键前提锚点清单（# 开头为注释行）
- 原“日轮、应世”已正式对调为“应世、日轮”
- 感→择→通→引→留→化→复
架构冻结后内容细化
```

增删行后下一次压缩立即生效，无需重启。更多示例见 [docs/anchors.example.md](docs/anchors.example.md)。

## 与上游的差异

| | ICCuse/dsh-premise-guard | 本版 |
|---|---|---|
| 自动锚点 | 仅 ASCII（引号／路径／键值／错误码） | 中文六类模式 + 原 ASCII 模式 |
| 手动标注 | 无 | 锚点清单 + `premise_anchor` 工具 + `/anchor` 命令 |
| 告警语言 | 中文 | 中文（标注锚点带【标注】前缀） |
| 其它 | — | 事件、注入、一次性告警机制与上游一致 |

## 边界说明

- 只在 `compaction/summary` 事件后检查；命中片段是字面匹配（子串），不是语义判断——摘要用等价表述保留的前提可能误报，告警文案已提示模型自行判断。
- 清单与告警都是工具线索，不替代项目的正式笔记与来源裁定。

## 许可

MIT。基于 [ICCuse/dsh-premise-guard](https://github.com/ICCuse/dsh-premise-guard)（MIT）修改，保留原项目署名。
