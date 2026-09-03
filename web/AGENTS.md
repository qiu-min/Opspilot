# AGENTS.md

## 1. 项目概述与核心技术栈

本目录为 Web 前端工程。

核心技术栈：

* React
* TypeScript
* Vite
* Tailwind CSS
* shadcn/ui
* Lucide Icons

开发时优先使用现有技术栈和已有组件，不得随意引入新的 UI 框架、状态管理库或工具链。

所有代码必须兼容 TypeScript strict 模式。

---

## 2. 环境搭建与开发 / 构建指令

使用项目根目录指定的包管理器，不得混用 npm、pnpm、yarn。

常用命令应以 `package.json` 中定义的 scripts 为准，例如：

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
```

修改代码后至少保证：

```bash
pnpm build
```

能够成功执行。

如果项目已配置 lint、format 或 test，应同时执行对应检查。

不得通过关闭 TypeScript、ESLint 或构建检查来规避错误。

---

## 3. 测试规范

新增非纯展示逻辑时，应优先考虑可测试性。

测试重点包括：

* 数据转换逻辑
* 状态转换逻辑
* API Client 行为
* 错误处理
* 用户关键交互
* 自定义 Hooks

测试应验证外部可观察行为，不依赖组件内部实现细节。

避免：

* 为简单静态 JSX 编写无意义测试
* 大量 snapshot 测试
* 通过 mock 所有内部模块让测试失去实际价值
* 为通过测试而修改生产代码语义

修复 Bug 时，如条件允许，应增加能够复现该问题的测试。

---

## 4. 代码风格与命名规范

### TypeScript

必须：

* 使用 TypeScript
* 保持 strict 类型安全
* 避免 `any`
* 避免无必要的类型断言
* 优先使用类型收窄
* 对外部输入进行明确类型约束
* 不使用 `@ts-ignore` 隐藏类型错误

优先：

```ts
unknown
```

而不是：

```ts
any
```

类型仅在具有复用价值时抽取，避免制造大量仅使用一次的类型别名。

### React

统一使用函数组件。

组件保持单一职责。

避免在一个组件中同时处理：

* 大量数据请求
* 数据转换
* 页面布局
* 复杂交互状态
* UI 渲染

复杂逻辑应根据职责拆分为：

* components
* hooks
* lib
* api
* utilities

不要为了“组件化”把简单 JSX 拆成大量没有语义价值的小文件。

不要使用 `useEffect` 实现本可以通过 props、事件处理或派生状态完成的逻辑。

避免冗余 state。

例如可以由已有状态计算得到的数据，不应再次存入 state。

### 命名

React 组件：

```text
PascalCase
```

例如：

```text
UserMenu.tsx
MessageList.tsx
```

函数、变量、Hooks：

```text
camelCase
```

Hooks 必须以 `use` 开头：

```text
useAuth
useConversation
```

布尔值使用能够表达状态的名称：

```text
isLoading
isOpen
hasError
canSubmit
```

避免：

```text
flag
data1
temp
obj
value2
```

除非其作用域极小且语义明确。

### 文件组织

按职责组织代码。

避免建立纯粹为了分层而存在的深层目录结构。

推荐：

```text
components/
hooks/
api/
lib/
types/
```

业务相关代码应尽量保持局部聚合，而不是把一个功能拆散到整个项目。

### UI 与样式

优先复用 shadcn/ui 和已有公共组件。

不得重复实现已有基础组件，例如：

* Button
* Input
* Dialog
* Dropdown
* Tooltip
* Select

样式优先使用 Tailwind CSS。

避免：

* 大量行内 style
* 重复 CSS
* 无统一规范的魔法数字
* 无必要的自定义 CSS
* 过度嵌套布局

UI 应保持：

* 清晰的视觉层级
* 一致的间距
* 一致的字体层级
* 克制的圆角
* 克制的阴影
* 克制的动画

默认避免：

* 渐变背景
* Glassmorphism
* 大面积发光效果
* 过度使用 Card
* 过大的圆角
* 装饰性动画
* emoji 作为功能图标

功能图标优先使用 Lucide Icons。

### API

页面组件不得直接散落 `fetch` 调用。

HTTP 请求应集中到明确的 API Client 或对应模块。

API 层负责：

* 请求构造
* 序列化
* 响应解析
* HTTP 错误转换

UI 层负责：

* Loading
* Success
* Empty
* Error

不得把后端 DTO 不加区分地传播到整个 UI。

仅在确有需要时增加前端 View Model。

### 错误处理

不得静默吞掉异常。

避免：

```ts
try {
  // ...
} catch {
}
```

错误必须：

* 被明确处理；
* 转换为上层能够理解的错误；
* 或继续抛出。

用户可恢复的错误应在 UI 中提供明确反馈。

开发错误和用户错误不得混为一谈。

---

## 5. 操作边界与绝对禁止事项

未经明确要求，不得：

* 修改后端代码
* 修改其他子项目
* 修改仓库整体架构
* 替换现有技术栈
* 引入新的大型框架
* 引入第二套 UI 组件库
* 引入新的状态管理方案
* 修改构建工具
* 修改 TypeScript 严格性配置
* 修改 lint 规则以绕过错误
* 删除已有测试
* 删除已有功能
* 大规模重构无关代码
* 修改与当前任务无关的文件
* 添加没有实际使用场景的抽象层

禁止：

* 使用 `any` 逃避类型设计
* 使用 `@ts-ignore` 掩盖错误
* 使用空 `catch`
* 复制粘贴重复组件
* 为未来可能需求提前设计复杂抽象
* 一次性进行与当前任务无关的大范围格式化
* 未确认已有实现前重复创建组件或工具

修改前应先阅读相关现有代码。

优先进行最小范围修改。

如果已有代码可以扩展，应优先扩展现有实现，而不是创建平行方案。

如果任务需要突破上述边界，应停止扩大修改范围，并明确说明原因。
