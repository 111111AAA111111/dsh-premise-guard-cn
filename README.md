# dsh-premise-guard-cn · 前提守卫

面向中文小说／长文创作的 DeepSeek Harness 插件：上下文压缩后，摘要遗漏关键前提锚点时注入一次中文告警。

fork of [ICCuse/dsh-premise-guard](https://github.com/ICCuse/dsh-premise-guard)（MIT）。本版本识别中文引号、书名号、术语链、编号、中文笔记路径与长中文串，同时保留原有 ASCII 锚点。

## 安全与存放策略

- 自动清单**绝不写入工作区**。默认写入 `~/.dsh/premise-guard-cn/workspaces/<不可逆路径哈希>/anchors.md`；不同项目互相隔离。可用 `anchorsFile` 或 `anchorsStoreDir` 显式覆盖。
- `premise_anchor` 默认只读。只有用户在配置中显式设置 `allowAnchorEdits: true` 后，`add`／`remove` 才会写入。
- 删除只接受**完整、精确**的锚点；写入走临时文件原子替换，写前生成同目录 `.bak` 备份。
- 插件仅提示可能遗漏的字面锚点，不能取代正式笔记、来源裁定或因果审查。

## 配置

```yaml
- insert:
    - id: premise-guard-cn
      name: 'dsh-premise-guard-cn'
      config:
        anchorsFile: ''       # 显式文件优先；建议放在工作区外
        anchorsStoreDir: ''   # 为空时为 ~/.dsh/premise-guard-cn
        allowAnchorEdits: false
        maxAnchors: 5
        minAnchorLength: 4
        maxNoticeChars: 700
```

`premise_anchor` 支持 `list`、`add`、`remove`。`list` 始终可用；写操作需要 `allowAnchorEdits: true`。安装后重启 DSH 生效。

## 开发

```bash
npm test
npm run build
```

支持并在 CI 中检查 DeepSeek Harness `0.1.0-rc.5` 至 `<0.2.0` 的公开 peer 范围；实际加载仍应在目标 Harness 版本中验证。
