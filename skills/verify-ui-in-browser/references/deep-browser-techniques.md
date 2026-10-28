# 浏览器深度自动化技巧（SPA 注入 / API 捕获 / 组件交互）

> 2026-10-14 沉淀，全部经真实任务验证（AlphaFlow 设计器自动化）。适用：把站点操作固化成 API、脚本操作失败定位、SPA 深度交互。
> 配套：静态 webpack 反查与对照实验方法论见记忆 `tooling-frontend-api-archaeology`。

## 一、页内 hook：捕获请求全姿势（最常用）

```js
// 三个 prototype 方法都必须 patch：open（记录 URL）、send（记录 body）、setRequestHeader（记录 headers）
window.__cap = [];
const { open, send, setRequestHeader } = XMLHttpRequest.prototype;
XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__m = m; this.__u = u; return open.call(this, m, u, ...rest); };
XMLHttpRequest.prototype.setRequestHeader = function (k, v) { (this.__h = this.__h || {})[k] = v; return setRequestHeader.call(this, k, v); };
XMLHttpRequest.prototype.send = function (body) {
  try {
    const u = String(this.__u || '');
    if (u.includes('/api/')) {
      let b = null;
      if (typeof body === 'string') b = body;                       // 完整保留，勿截断（除非确认够用）
      else if (body instanceof FormData) b = 'FormData:[' + [...body.keys()].join(',') + ']';
      else if (body instanceof URLSearchParams) b = body.toString();
      window.__cap.push({ m: this.__m, u, h: this.__h, body: b });
    }
  } catch (e) {}
  return send.call(this, body);
};
// fetch 也要 hook（部分请求非 XHR）
const of = window.fetch;
window.fetch = function (input, init) { /* 同样记录 URL/body 到 __cap */ return of.apply(this, arguments); };
```

**头号踩坑（本次 debug 多轮的教训）**：只 patch `send` 时 `this.__u` 恒空 → 过滤条件永远为假 → 看起来"请求没发出"，其实是 **hook 自身瞎了**。**hook 抓不到请求时，先自检 hook**（触发一个已知请求验证有效性），再怀疑页面/iframe。

- 过滤条件从宽开始（先全收 `/api/`，后面再筛），避免条件写错吞掉一切
- 捕获数据放 `window.__cap`；**SPA 内路由跳转不丢，整页刷新丢**（跨 app 导航后需重装）
- 网络工具（`list_network_requests`）只有摘要无 body——细节必须页内 hook；但它可确认"请求是否发出"，用于观察行为差异（例：无改动保存只发 record-version、有改动才发 update/form）

## 二、SPA 导航保 hook

- 同应用内部导通用 `location.hash = '#/目标路由'`——**不刷新页面、hook 存活**
- 需要跨微前端（不同 app）时整页导航 → hook 丢，落地后重装
- 页面 URL 自动补全路由参数（如 `/designFormSetting/{operateId}`）属正常，说明页面内跳转成功

## 三、点击策略阶梯（JS click 无效时逐级升级）

1. **找对目标元素**：文本节点的 handler 常在父元素——`el.closest('button') || el.parentElement`
2. **派发完整鼠标事件序列**（比单发 click 兼容）：
   ```js
   const r = el.getBoundingClientRect();
   const o = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, view: window };
   ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t, o)));
   ```
   双击额外发 `dblclick`（`detail: 2`）——图形库画布（mxGraph）实测：对 SVG `image` 元素派发全序列可触发 DOUBLE_CLICK handler（打开节点配置对话框）
3. **browser-use 真实点击**：`take_snapshot` 拿 uid → `click` 工具——复杂组件（下拉菜单子项、门户 menubar）JS 事件无效时用真实事件
4. **绕 UI**：菜单/路由数据常存 sessionStorage（如菜单树含 `href_link`）——直接读出目标 URL 导航，比点 UI 稳

## 四、Vue 组件交互（读状态 / 调方法 / 写输入）

- **找组件**：`element.__vue__`；向父链上溯 `while (el.__vue__ === undefined) el = el.parentElement`。注意 mxGraph 等库自建的 DOM（如 `.geDiagramContainer`）**不在 Vue 树里**，需从别的已挂载元素上溯到根，再 BFS 翻 `$children` 搜目标（按方法名/组件名）
- **直接调组件方法**：绕过 UI 事件，如步骤条切页、打开对话框（`vm.showDialog(cell)`）——先用方法名 BFS 定位持有者
- **应用常暴露全局引用**（`window.xxxVm`）——直接读组件 data（如 `vm.baseInfo.wftempId`）拿运行时状态
- **受控输入赋值**（Vue/React 通用）：native setter + input 事件：
  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, '新值'); input.dispatchEvent(new Event('input', { bubbles: true }));
  ```
  `textarea` 用 `HTMLTextAreaElement.prototype`（用错报 `Illegal invocation`）

## 五、对话框与可见性判断

- Element UI 可见对话框：`[...document.querySelectorAll('.el-dialog__wrapper')].find(d => d.style.display !== 'none')`
- 通用可见性：`el.offsetParent !== null`（隐藏元素 offsetParent 为 null）
- 对话框内动作：按钮/输入框限定在 dialog 容器内查询，避免命中背景页同名元素

## 六、会话与诊断

- `sessionStorage` / `localStorage` 是关键状态源：token（如 ecoToken）、菜单树（SYSTEM_MENUS）、应用配置（appConfig）——诊断与绕 UI 都靠它
- token 过期 → 重新走 SSO 导航（整页）刷新会话，不必重启浏览器
- iframe 排查：hook 抓不到时查 `document.querySelectorAll('iframe')` 并尝试 `contentWindow` 同源访问（`about:blank` 空壳通常无关）；结合"先自检 hook"原则（见 §一）
- 截图/快照用于定位组件；交互定位优先用脚本（快照可能对 iframe 内容不可见）

## 七、副作用意识（自动化探查纪律）

- **SPA 自动保存**：切 tab / 切设计步骤常触发"自动保存上一页"（一串写请求）——探查时注意操作顺序，测试对象用探针/可删资源
- 同一操作前后**多点几次对比**请求数量差异（有改动 vs 无改动行为不同）
- 探针纪律：在真实系统上探查一律用 `__af_probe__` 类前缀的可辨识测试对象，任务尾部清理并验证归零
