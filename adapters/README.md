# 接口适配文件 v1

在连接设置里展开“接口适配文件”即可导入 JSON、复制给 AI 的完整制作说明、下载规范及示例。请同时向 AI 提供服务商的公开文档或已去密钥的请求/响应示例。不要提供 API 密钥；不要在缺少依据时猜测字段。

- [JSON Schema](nai-lens-adapter-v1.schema.json)
- [YesNAI 示例](yesnai-adapter-v1.json)：扩展参数位于 nai 对象。
- [Aurora 示例](aurora-adapter-v1.json)：主要参数位于顶层，Seed 为字符串；该站仍未进行真实生图验证。

工具在 Schema 之外还执行语义检查：必要 source 为 model、fullPrompt、negativePrompt、steps、scale、sampler、seed、noiseSchedule，以及 size 或 width+height。来源字段按 string/number/integer/boolean 转换，可用 map 描述模型名或枚举值对应；target 是点分对象路径，response.imagePath 支持点分数组下标。不支持表达式和数组写入。

allowedUrls 是无账号、查询、片段和通配符的完整 HTTP(S) 接口地址，按来源和路径精确匹配；运行时查询不改变匹配路径。auth 为 bearer 或 header（name 指定认证头），实际值使用工具内填写的 Token。文件不执行脚本，不改变请求目标地址，不自动重试。

每份最多64KB、96项映射、8层路径；最多保存64份。每次只生成1张图片；n/n_samples 如有须固定为1，action 如有须固定为 generate。请求字段不能含密钥字段或原型路径。工具会拒绝格式或必填映射不符的文件。依赖不支持机制的服务商需进一步开发，不能仅靠 JSON 解决。

首版支持一次 POST JSON 文生图，返回 JSON 中 base64/URL、图片、ZIP；不支持 Vibe、排队轮询、流式、签名计算。跨域限制仍由站点决定。导入成功不代表参数效果已验证，请从实际返回原图核对。

选择文件后保存 API 预设；切换预设会同时切换适配。已被预设引用的文件不能直接移除，同 ID 不同内容另存副本。配置仅保存在当前浏览器，不在档案备份中；换设备需导出 JSON 并重建 API 预设。无需适配时选择“自动识别 / 默认格式”。
