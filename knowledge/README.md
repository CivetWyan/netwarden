# 离线知识库

本目录存放网管在本机检索的离线资料（CPU BM25 + 中文双字索引，不占显存）。**仓库不附带任何知识数据**，需要自行导入；没有知识库时网管照常工作，只是模型回答原理类问题时没有资料可引用。

检索会读取本目录下的两个文件（都是可选的）：

| 文件 | 内容 | 生成方式 |
|---|---|---|
| `chunks.jsonl` | 网络原理资料（例如自己整理的 HCIA 笔记） | `npm run knowledge:import -- <目录>`，目录里需有 `chunks.jsonl` |
| `router-chunks.jsonl` | 设备手册（例如小米路由器接口文档） | `node scripts/import-router-knowledge.mjs <文档.md>`，按 `##`/`###` 标题切分 |

每行一个 JSON 对象，至少包含：

```json
{"id": "唯一ID", "breadcrumb": "章节 > 小节", "text": "正文", "type": "concept 或 reference", "sources": ["来源文件"], "has_warning": false}
```

- `type` 为 `concept` 的片段在排序时略有加分；`has_warning` 为 true 的片段会提示模型"资料有疑点"。
- 资料只作为**数据**提供给模型，不会被当作指令执行。厂商设备命令（如华为 VRP）仅用于理解原理，不会在本机执行。
- 导入设备手册前请自行去掉手册里的真实 IP、MAC、账号和密码。
