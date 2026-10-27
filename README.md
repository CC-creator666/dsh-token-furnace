# 烧钱炉 · Token Furnace

一个 DeepSeek Harness（DSH）插件：把**没有意义的问题**反复丢给模型，让它一本正经地认真想，以此白烧 token。

跑够轮数、或者花到控制中心里设的钱，它自己停。

## 它干什么

- 内置 32 个没意义但足够让人认真想一会儿的问题，轮流问、不重复：

  > 把「差不多」精确到小数点后六位，是多少？
  > 如果一根面条无限长，它还算不算一道菜？
  > 电梯关门的那一下，是在拒绝谁？

- 这些人设会写进 system prompt：必须正经分析、不许点破「这问题没意义」、不许反问、不许写「没有标准答案」。
- 每轮结束按 adapter 返回的 `usage` 记账（拿不到 usage 时按字数粗估，面板会标「含估算」）。

## 控制中心

设置 → **烧钱炉**（排在「启动动画」后面）。

| 项 | 作用 |
| --- | --- |
| 跑几轮 | 跑够这么多轮自动停 |
| 花到多少（元） | 按单价估算到这个数自动停 |
| 输入 / 输出单价 | 元 / 百万 token，默认 ¥2 / ¥8，按实际模型改 |
| 开始烧 / 停下来 / 归零 | 手动控制 |

面板顶部实时显示：已跑轮数、已花多少、进出 token、当前模型、上次为什么停。

## 安装

```
plugin_manager install_bundle target=<本目录绝对路径>
```

或在 DSH 的插件管理页里选本地目录安装。装完是 bundle 行 `token-furnace`，默认启用。

## 注意

- **停的精度是一轮**：设 ¥0.5 可能跑到 ¥0.52 才停，记账发生在每轮结束。
- 单价默认值只是 DeepSeek 的常见档位，**不保证等于你的账单**；想看得准就自己填。
- 配置落在 `~/.dsh/token-furnace.json`（或 `$DSH_HOME/token-furnace.json`），重开 DSH 还在。
- Host 侧的 HTTP 路由都过 `connection.requestRejection` 信任栅栏，非浏览器凭证一律 401。

## 结构

```
index.js          Host 半侧：焚烧循环、记账、/dsh-token-furnace 路由
client.js         Client 半侧：settings.section 里的控制中心
cordis.patch.yml  bundle 补丁，插入 token-furnace 行
locale/           插件管理页显示用的标题与描述
icon.svg          图标
```
