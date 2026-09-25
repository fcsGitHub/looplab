# 验收标准：Enter 发送（ChatInput 输入框）

## 0. 范围与背景
- 目标：明确「按 Enter 发送消息」功能的验收标准与测试范围。
- 工作区初始为空（无既有代码），因此本文档同时给出**被测对象的接口契约**（第 1 节），
  作为后续实现与测试的共同基准。所有标准均为可核验的「输入 / 操作 / 预期结果」三元组。

## 1. 被测对象（SUT, System Under Test）
| 项 | 定义 |
|---|---|
| 组件 | `ChatInput` —— 聊天输入框组件（单行/多行文本输入 + 发送按钮） |
| 关键 DOM | `<textarea data-testid="chat-input">`，`<button data-testid="send-btn">` |
| 关键事件 | `keydown`（Enter / Shift+Enter）、`input`、`compositionstart` / `compositionend` |
| 核心逻辑单元 | `handleKeyDown(event, value, {disabled, composing}) -> Action` |
| Action 取值 | `"send"` \| `"newline"` \| `"none"` |
| 发送副作用 | 调用 `onSend(trimmedValue)`，随后清空输入框并保持焦点 |
| 状态 | `disabled`（禁用）、`composing`（输入法组合态） |

> 说明：若实际项目使用其他组件名，仅需替换第 1 节标识，第 2–4 节标准不变。

## 2. 预期行为（核心规则）
- **R1**：输入框聚焦、非禁用、非组合态、内容非空（去除首尾空白后非空）时，按 **Enter** → 触发发送。
- **R2**：按 **Shift+Enter** → 插入换行，**不**发送。
- **R3**：内容为空或**纯空白**时，按 Enter → **不**发送（`none`），且不清空、不报错。
- **R4**：**输入法组合态（composing=true）** 时按 Enter → **不**发送（用于确认候选词）。
- **R5**：`disabled=true` 时按 Enter → **不**发送。
- **R6**：发送时以 **trim 后**的内容调用 `onSend`；发送后输入框清空。

## 3. 测试层级
| 层级 | 范围 | 工具/方式 | 覆盖标准 |
|---|---|---|---|
| 单元测试（Unit） | `handleKeyDown` 纯函数逻辑 + 发送副作用 | Python 标准库 `unittest`（参考实现见 `src/chat_input.py`，测试见 `tests/test_enter_send.py`） | AC-01 ~ AC-12 |
| 端到端测试（E2E） | 真实浏览器中聚焦、键入、按键、断言消息列表与输入框状态 | Playwright / Cypress（本工作区无浏览器环境，仅给出用例规格，见第 5 节） | E2E-01 ~ E2E-06 |

## 4. 验收标准清单（输入 / 操作 / 预期结果）

### 4.1 单元测试标准
| ID | 输入（value / 状态） | 操作 | 预期结果 |
|---|---|---|---|
| AC-01 | `"hello"`，enabled，非组合态 | 按 Enter | Action=`send`；`onSend("hello")` 被调用 1 次；输入框清空 |
| AC-02 | `"hello"`，enabled，非组合态 | 按 Shift+Enter | Action=`newline`；`onSend` 未被调用；内容保留 |
| AC-03 | `""`（空串） | 按 Enter | Action=`none`；`onSend` 未被调用；内容仍为 `""` |
| AC-04 | `"   "`（纯空格） | 按 Enter | Action=`none`；`onSend` 未被调用 |
| AC-05 | `"\n\t  "`（纯空白字符） | 按 Enter | Action=`none`；`onSend` 未被调用 |
| AC-06 | `"  hi  "`（首尾空白） | 按 Enter | Action=`send`；`onSend("hi")`（已 trim） |
| AC-07 | `"hi"`，`composing=true` | 按 Enter | Action=`none`；`onSend` 未被调用 |
| AC-08 | `"hi"`，`disabled=true` | 按 Enter | Action=`none`；`onSend` 未被调用 |
| AC-09 | `"hi"`，enabled | 按其他键（如 `"a"`） | Action=`none`；`onSend` 未被调用 |
| AC-10 | 超长文本（10000 字符，非空白） | 按 Enter | Action=`send`；`onSend` 收到完整 10000 字符（不截断） |
| AC-11 | `"hi"`，enabled | 连续按 Enter 两次 | 第 1 次 `send` 且清空；第 2 次（内容已空）`none`，`onSend` 仅调用 1 次 |
| AC-12 | `"hi"`，enabled | 按 Enter 后检查焦点 | 发送后输入框保持聚焦（`focus()` 被调用） |

### 4.2 端到端测试标准
| ID | 输入 | 操作 | 预期结果 |
|---|---|---|---|
| E2E-01 | 输入框聚焦，键入 `"hello"` | 按 Enter | 消息列表新增 1 条 `"hello"`；输入框为空 |
| E2E-02 | 键入 `"line1"` | 按 Shift+Enter，再键入 `"line2"` | 输入框值为 `"line1\nline2"`；消息列表无新增 |
| E2E-03 | 输入框为空 | 按 Enter | 消息列表无新增；无错误提示 |
| E2E-04 | 键入 `"   "` | 按 Enter | 消息列表无新增 |
| E2E-05 | 输入框 `disabled` | 按 Enter | 消息列表无新增 |
| E2E-06 | 输入法组合态（模拟 composition） | 按 Enter 确认候选 | 消息列表无新增；组合结束后再按 Enter 才发送 |

## 5. 边界条件覆盖矩阵
| 边界条件 | 对应标准 | 层级 |
|---|---|---|
| 空输入 | AC-03 / E2E-03 | Unit + E2E |
| 纯空格 / 纯空白 | AC-04, AC-05 / E2E-04 | Unit + E2E |
| 首尾空白（需 trim） | AC-06 | Unit |
| 超长文本 | AC-10 | Unit |
| 输入法组合态 composing | AC-07 / E2E-06 | Unit + E2E |
| 禁用状态 disabled | AC-08 / E2E-05 | Unit + E2E |
| 非 Enter 键 | AC-09 | Unit |
| 重复发送（清空后） | AC-11 | Unit |
| 发送后焦点保持 | AC-12 | Unit |

## 6. 通过判据（Definition of Done）
1. 单元测试 `tests/test_enter_send.py` 全部通过（AC-01 ~ AC-12）。
2. E2E 用例 E2E-01 ~ E2E-06 在目标浏览器全部通过（需具备浏览器环境）。
3. 无回归：Shift+Enter 换行、空内容拦截、组合态拦截、禁用态拦截均成立。
