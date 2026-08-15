# 关键前提锚点示例

每行一条锚点；`#` 开头为注释。默认清单由插件保存在工作区之外的
`~/.dsh/premise-guard-cn/workspaces/<路径哈希>/anchors.md`，不会写入小说或其他项目目录。

```markdown
- “主角的师门在灭门之夜全军覆没”
- 炼体→炼气→炼神
- 道基一成，方向不可改
```

要让 `premise_anchor add` 或 `/anchor add` 写入，用户必须在配置中显式设置
`allowAnchorEdits: true`。删除只接受完整锚点，写入前会留下 `.bak` 备份。
