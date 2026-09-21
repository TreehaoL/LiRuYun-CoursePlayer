// ==UserScript==
// @name         砺儒云课程播放助手
// @namespace    https://moodle.scnu.edu.cn/
// @version      1.0.1
// @description  单文件油猴脚本：整门课视频清单（带每节进度）+ 队列连播 + 进度监控 + 面板化操作。
// @description  【安全模式】按真实进度自动切下一节（达标线从课程页读取，默认 90%）；
// @description  自适应采集整门课的节次（多容器择优 + 自动展开折叠章节 + 服务端接口兜底），
// @description  暴力模式同样带列表，点一行即可跳过去。站点原生弹窗（“禁止同时观看多个视频”
// @description  那类）自动「确定」并恢复被暂停的播放，不认识的询问照常弹给你。
// @description  另有定时暂停、暂停保活、学习确认自动通过、停摆/冻帧看护、自动重播、日志防刷屏。
// @description  【暴力模式】直接 POST mod_fsresource_set_time 快速完成：默认关闭、高风险、需手动确认，
// @description  带队列预算/停滞判定/硬上限三道闸门，达标后自动催页面读数。两种模式互斥。
// @description  【界面】面板右下角手柄可缩放，视频列表与日志各有一条分隔条，拖完记住；
// @description  日志可往回翻历史（默认跟最新，往上翻就不抢滚动条）。设置里可调透明度、
// @description  自动静音、弹窗拦截、完成后是否自动下一节、自定义达标进度。
// @description  与 v2（LiRuYun-SafePlusBrute.user.js）同页共存时，本版本自动接管。
// @description  【面板版】顶上「安全模式 / 暴力模式」两个按钮分页，视频列表常驻，日志常驻底部；
// @description  「⚙ 设置」弹独立窗口（偏好设置常驻其中），列表刷新后当前视频自动滚到中间；
// @description  列表与日志上方各有一条分隔条、面板右下角有缩放手柄，三处尺寸都能拖、拖完记住；
// @description  日志可往回翻历史（默认跟最新，往上翻就不抢滚动条）；另有「—」最小化与 ◎ 悬浮球。
// @description  装好后 Tampermonkey 会自动比对仓库版本并提示更新（头部带 @downloadURL / @updateURL）。
// @downloadURL  https://raw.githubusercontent.com/TreehaoL/LiRuYun-CoursePlayer/main/LiRuYun-CoursePlayer.user.js
// @updateURL    https://raw.githubusercontent.com/TreehaoL/LiRuYun-CoursePlayer/main/LiRuYun-CoursePlayer.user.js
// @match        https://moodle.scnu.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==
//
// ============================================================================
//  为什么是"合并版"
// ----------------------------------------------------------------------------
//  · 旧方案把「播放助手」和「确认自动通过」拆成两个脚本，需要互相避让
//    （一个检测 div[id^='anti-bot-']，另一个要保证不误触发），既不稳也难维护。
//  · 本文件把两者合成一个：检测弹窗、按住通过、恢复播放都在同一处协调，
//    不再需要任何"跨脚本互不干扰"的约定。
//
//  关于"合成事件点不动弹窗"
// ----------------------------------------------------------------------------
//  · 实测：合成 pointerup 页面收得到（stopCalls 在涨），但遮罩始终不消失。
//    说明页面的 pointerdown 处理器要么没进计时、要么没走完 —— 光靠猜没用。
//  · 因此这里改为：pointer / mouse / touch 三套事件按序下发，谁生效用谁；
//    每个弹窗第一次处理时顺带做一遍"事件体检"，把真正能解除遮罩的类型记下来，
//    后续直接用命中的那一种，不做无用功。
// ============================================================================

(function () {
  "use strict";

  // 取“页面自己的 window”：没有 unsafeWindow 的注入器（部分 Violentmonkey/旧配置）
  // 会拿不到页面注入的 playerdata，所以按 unsafeWindow → wrappedJSObject → window 三级回退。
  var PAGE = (function () {
    try { if (typeof unsafeWindow !== "undefined" && unsafeWindow) return unsafeWindow; } catch (_) {}
    try { if (typeof window !== "undefined" && window.wrappedJSObject) return window.wrappedJSObject; } catch (_) {}
    return window;
  })();
  var TAG = "[liruyun]";

  // ==========================================================================
  //  面板重排层（正式版 LiRuYun-CoursePlayer.user.js 专用，1.0.0 定版）
  //  纯布局代码：建面板、搬区块、加分隔条与悬浮球，不碰任何播放判定。
  // ----------------------------------------------------------------------------
  //  现场反馈（这一版逐条对应）：
  //    1. "窗口太小会没办法显示日志甚至设置，点设置最好新弹出一个新的窗口"
  //       → **设置独立成弹窗**（⚙ 打开，右侧固定浮层，带关闭按钮，自己滚动）
  //    2. "悬浮小胶囊等于没用，和最小化一样；紧凑模式删了吧"
  //       → **两个都删**（原版「—」最小化按钮也一并隐藏）
  //    3. "视频列表多的时候，暴力模式的日志甚至显示不全"
  //       → 列表**可收起**（▾/▸），日志常驻底部**保底 5 行**，不再被列表吃掉
  //    4. "设置按钮两个臃肿了，应该保留一个"
  //       → 只留 bar 上那个「⚙ 设置」，标题栏那个齿轮删掉
  //    5. "开始暴力不够清楚吧？列表都一样，且只有一个按钮，点播放应该自动根据模式自动开始"
  //       → 播放按钮**跟着模式变**：安全模式=「▶ 播放 / 重播」；暴力模式=「▶ 播放并开始暴力」
  //
  //  布局：
  //    标题栏：● 标题 .......... 87.5% / 95%        📌  ⟲
  //    🛡 安全模式 | ⚡ 暴力模式          ← 顶上两个按钮，独立分页
  //    [扫描][刷新列表][只看未完成][▾列表][⚙ 设置]      共 N 节 · 已完成 M
  //    1 视频2.1 ......... ▓▓▓░ 92%  已完成
  //    [⏮] [▶ 播放 / 重播] [⏭]
  //    ── 当前模式那一页 ──（安全=队列/定时暂停/自动通过；暴力=发包参数/批量）
  //    日志：最近 5 行（点「📜 日志」看全部 → 在设置弹窗里）
  //
  //  硬纪律（现场踩出来的，别丢）：
  //    · 不动 `children`（只读 HTMLCollection，赋值抛 TypeError）
  //    · 搬块 + 隐藏外壳必须自检，缺一项就整体回退
  // ==========================================================================

  var PRO_STATE_KEY = "scnu_liruyun_pro_ui";
  var PRO = {
    built: false,
    tab: "list",           // list = 安全模式页；brute = 暴力模式页
    onlyTodo: false,
    listOpen: true,        // 列表是否展开（条目多的时候可以收起来给日志/设置让位）
    dialogOpen: false,     // 设置弹窗
    dlgPos: null,          // 设置弹窗的位置（用户拖过才记；刷新后照旧）
    logH: 0,               // 日志区高度（拖过分隔条才记；0 = 用 CSS 默认）
    pod: false,            // 面板是否收成悬浮球（v5.2 恢复）
    podPos: null,          // 悬浮球的位置
    podDone: false,        // 悬浮球显示"已达标"配色
    opacity: 1,
    autoMute: false,
    lastSig: "",
    moves: [],
    rollback: [],
    prefsEl: null,         // 偏好设置块（v5.4：常驻设置窗口，建的时候用引用带着走）
    autoCollected: false,
    selfPatched: false,
  };

  (function proLoadState() {
    try {
      var saved = gmGet(PRO_STATE_KEY, null);
      if (!saved || typeof saved !== "object") return;
      if (saved.tab === "brute") PRO.tab = "brute";
      PRO.onlyTodo = Boolean(saved.onlyTodo);
      PRO.autoMute = Boolean(saved.autoMute);
      if (saved.listOpen === false) PRO.listOpen = false;
      // v5.2：设置弹窗的位置、悬浮球开合与位置都要跨刷新记住
      //（现场："设置窗口的位置不会记忆吗？刷新页面之后就恢复初始了"）
      if (saved.dlgPos && isFinite(saved.dlgPos.left) && isFinite(saved.dlgPos.top)) {
        PRO.dlgPos = { left: Number(saved.dlgPos.left), top: Number(saved.dlgPos.top) };
      }
      if (saved.podPos && isFinite(saved.podPos.left) && isFinite(saved.podPos.top)) {
        PRO.podPos = { left: Number(saved.podPos.left), top: Number(saved.podPos.top) };
      }
      if (saved.pod === true) PRO.pod = true;
      if (isFinite(Number(saved.logH)) && Number(saved.logH) > 0) PRO.logH = Number(saved.logH);
      if (typeof saved.opacity === "number" && saved.opacity >= 0.35 && saved.opacity <= 1) {
        PRO.opacity = saved.opacity;
      }
      // 说明：老版本存过的 compact / hidden / showSettings / showLog 一律忽略 ——
      // 5.0 把紧凑模式与悬浮胶囊删了，设置和日志搬进弹窗（5.2 又把日志搬回主窗口）。
      // dialogGuard 也**刻意不在这里读**：那个开关的唯一权威是弹窗拦截模块自己的
      // liruyun_dialog_guard 键（proApplyDialogGuard 会把面板显示同步过去），
      // 两边各存一份必然会分叉 —— 这种"两个真相"的坑这个项目已经踩过一次。
      // 同理：autoNext / 达标进度 / 暴力连播 的权威是 liruyun_play_prefs（_prefs-module.js）。
    } catch (_) {}
  })();

  function proSave() {
    try {
      gmSet(PRO_STATE_KEY, {
        tab: PRO.tab, onlyTodo: PRO.onlyTodo, listOpen: PRO.listOpen,
        opacity: PRO.opacity, autoMute: PRO.autoMute,
        dlgPos: PRO.dlgPos, pod: PRO.pod, podPos: PRO.podPos, logH: PRO.logH, listH: PRO.listH,
      });
    } catch (_) {}
  }

  function proEl(id) { return document.getElementById(id); }

  function proMk(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  // 清空容器：**不能写 `el.children.length = 0`**（只读 HTMLCollection，会抛 TypeError）
  function proClear(node) {
    if (!node) return;
    if (typeof node.replaceChildren === "function") { node.replaceChildren(); return; }
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function proMove(node, host, label) {
    if (!node || !host) return false;
    if (node.parentNode === host) return true;
    PRO.rollback.push({ node: node, parent: node.parentNode, next: node.nextSibling });
    // 记住"老家"：设置块和日志块会在弹窗打开/关闭之间来回搬，
    // 关闭时要能各自回到原来的位置（否则列表下面会空掉）。
    if (!node.__proHome) node.__proHome = host;
    try {
      host.appendChild(node);
      PRO.moves.push(label);
      return true;
    } catch (e) {
      log("重排：搬 " + label + " 失败：" + ((e && e.message) || e));
      return false;
    }
  }
  function proMoveHome(node) {
    if (!node || !node.__proHome) return;
    try { node.__proHome.appendChild(node); } catch (_) {}
  }

  function proRollbackAll(why) {
    for (var i = PRO.rollback.length - 1; i >= 0; i--) {
      var r = PRO.rollback[i];
      try {
        if (r.next && r.next.parentNode === r.parent) r.parent.insertBefore(r.node, r.next);
        else if (r.parent) r.parent.appendChild(r.node);
      } catch (_) {}
    }
    PRO.rollback = [];
    PRO.built = false;
    var ui = proEl("scnu-liruyun-helper");
    if (ui) {
      ui.className = String(ui.className || "")
        .replace(/\s*lr-prosettings/g, "").replace(/\s*lr-probruteopen/g, "")
        .replace(/\s*lr-prologopen/g, "").replace(/\s*lr-promode-\w+/g, "")
        .replace(/\s*lr-pro\b/g, "");
      ui.removeAttribute("data-pro");
      ui.removeAttribute("data-pro-moved");
    }
    var dlg = proEl("lr-pro-dialog");
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
    log("面板重排失败，已整体回退到原布局：" + why);
  }

  // ---------------------------------------------------------------- 按钮文案
  // 现场反馈："开启本页视频这个说法太难懂了" / "开始暴力不够清楚"
  var PRO_LABELS = { start: "自动连播本页", current: "只播这一节" };
  var PRO_TITLES = {
    start: "把这一节的视频收进队列、逐个自动播放；达标后自动跳下一节",
    current: "只处理当前这一节，不排后面的",
  };
  function proRelabel(scope) {
    var keys = ["start", "current"];
    for (var i = 0; i < keys.length; i++) {
      var el = null;
      try { el = scope.querySelector('[data-action="' + keys[i] + '"]'); } catch (_) {}
      if (!el) continue;
      el.textContent = PRO_LABELS[keys[i]];
      el.title = PRO_TITLES[keys[i]];
    }
    proFixPauseRow(scope);
  }

  // 定时暂停那一行：原来「定时暂停 [0] 分 [5] 秒」歧义太大
  //（现场："用户可能以为是定时几分几秒后暂停不看了"）。
  // 现在写成「每隔 [N] 分钟，暂停 [M] 秒后自动继续 [应用]」；只改文案，data-* 一律不动。
  function proFixPauseRow(scope) {
    try {
      var every = scope.querySelector("input[data-cfg='every']");
      var row = every && every.parentNode;
      if (!row) return;
      var lab = row.querySelector(".lr-lab");
      if (lab) lab.textContent = "每隔";
      var units = row.querySelectorAll(".lr-unit");
      if (units[0]) units[0].textContent = "分钟，暂停";
      if (units[1]) units[1].textContent = "秒后自动继续";
      var apply = row.querySelector("[data-action='pausecfg']");
      if (apply) apply.title = "保存这一行的设置（0 分钟 = 关闭定时暂停）";
      every.title = "每播放多少分钟短暂暂停一次；填 0 = 关闭这个功能";
      var dur = row.querySelector("input[data-cfg='dur']");
      if (dur) dur.title = "每次暂停多少秒，然后脚本会自动继续播放（不用手动点）";
    } catch (e) {
      log("重命名定时暂停行失败（不影响功能）：" + ((e && e.message) || e));
    }
  }

  // ---------------------------------------------------------------- 样式
  function proInstallCss() {
    var style = document.createElement("style");
    style.setAttribute("data-liruyun", "pro-style");
    style.textContent = [
      "#scnu-liruyun-helper.lr-pro{width:min(440px,46vw);height:min(660px,88vh);min-height:280px;",
      "opacity:var(--lr-pro-op,1);}",
      "#scnu-liruyun-helper.lr-pro:hover{opacity:1;}",
      "#scnu-liruyun-helper.lr-pro .lr-head{padding:7px 9px;align-items:center;gap:6px;}",
      "#scnu-liruyun-helper.lr-pro .lr-title{font-size:12px;-webkit-line-clamp:1;}",
      "#scnu-liruyun-helper.lr-pro .lr-headpct{font-size:16px;}",
      "#scnu-liruyun-helper.lr-pro .lr-chips{display:none;}",
      "#scnu-liruyun-helper.lr-pro .lr-body{overflow:hidden;display:flex;flex-direction:column;}",
      // ---- 顶上两个模式按钮（独立分页）----
      "#scnu-liruyun-helper.lr-pro .lr-promodes{flex:0 0 auto;display:flex;gap:6px;padding:6px 8px 2px;",
      "background:var(--bg2);}",
      "#scnu-liruyun-helper.lr-pro .lr-promode{flex:1 1 0;text-align:center;cursor:pointer;",
      "padding:6px 4px;border-radius:8px;border:1px solid #334155;background:#0b1220;color:#94a3b8;",
      "font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      "#scnu-liruyun-helper.lr-pro .lr-promode:hover{color:#e2e8f0;border-color:#475569;}",
      "#scnu-liruyun-helper.lr-pro.lr-promode-safe #lr-pro-mode-safe{background:#1d4ed8;border-color:#3b82f6;",
      "color:#fff;font-weight:700;}",
      "#scnu-liruyun-helper.lr-pro.lr-promode-brute #lr-pro-mode-brute{background:#b45309;border-color:#f59e0b;",
      "color:#fff;font-weight:700;}",
      // ---- 列表区：可收起；展开时最多占 46vh，给下面的日志留位置 ----
      "#scnu-liruyun-helper.lr-pro .lr-prolistwrap{flex:0 1 auto;max-height:46vh;min-height:96px;display:flex;",
      "flex-direction:column;padding:4px 6px 0;border-bottom:1px solid #1e293b;overflow:hidden;}",
      "#scnu-liruyun-helper.lr-pro.lr-prolistclosed .lr-prolistwrap{max-height:34px;min-height:34px;",
      "border-bottom:1px solid #1e293b;overflow:hidden;}",
      "#scnu-liruyun-helper.lr-pro.lr-prolistclosed .lr-prolist{display:none !important;}",
      "#scnu-liruyun-helper.lr-pro .lr-probar{flex:0 0 auto;display:flex;gap:5px;align-items:center;",
      "flex-wrap:wrap;padding:2px 2px 5px;}",
      "#scnu-liruyun-helper.lr-pro .lr-probar button{padding:3px 8px;font-size:11px;}",
      "#scnu-liruyun-helper.lr-pro .lr-procount{color:#93a3b8;font-size:10.5px;margin-left:auto;white-space:nowrap;}",
      "#scnu-liruyun-helper.lr-pro .lr-prochip{cursor:pointer;border:1px solid #334155;border-radius:999px;",
      "padding:3px 9px;font-size:11px;color:#94a3b8;background:#0b1220;white-space:nowrap;}",
      "#scnu-liruyun-helper.lr-pro .lr-prochip:hover{color:#e2e8f0;border-color:#475569;}",
      "#scnu-liruyun-helper.lr-pro .lr-prochip-on{background:#1d4ed8;border-color:#3b82f6;color:#fff;font-weight:700;}",
      "#scnu-liruyun-helper.lr-pro .lr-prolist{flex:1 1 auto;min-height:48px;overflow:auto;padding-right:2px;}",
      "#scnu-liruyun-helper.lr-pro .lr-prolist::-webkit-scrollbar{width:8px;}",
      "#scnu-liruyun-helper.lr-pro .lr-prolist::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}",
      // ---- 播放行 ----
      "#scnu-liruyun-helper.lr-pro .lr-tools{flex:0 0 auto;border-top:0;background:transparent;",
      "padding:6px 6px 7px;flex-wrap:wrap;}",
      // ---- 模式页（安全 / 暴力）：占剩余高度，自己滚 ----
      "#scnu-liruyun-helper.lr-pro .lr-proset{flex:1 1 auto;min-height:0;overflow:auto;display:none;",
      "border-top:1px dashed #1e293b;padding:6px 8px 8px;background:#0b1220;}",
      "#scnu-liruyun-helper.lr-pro.lr-probruteopen .lr-proset-brute{display:block;}",
      "#scnu-liruyun-helper.lr-pro.lr-promode-safe .lr-proset-set{display:block;}",
      "#scnu-liruyun-helper.lr-pro .lr-proset::-webkit-scrollbar{width:8px;}",
      "#scnu-liruyun-helper.lr-pro .lr-proset::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}",
      // ---- 日志：常驻底部，**高度可用鼠标拖** ----
      // 现场："列表一多日志就显示不全" → 给了保底高度；
      // 现场（2026-09-21）："日志窗口的大小变来变去" → 写死高度；
      // 现场（同一天，"我怎么改"）："日志根本看不全，也没有滚轮了""几大区域都应该能用鼠标调整"
      //   → 内容写满（最多 80 行）+ 框内滚动 + 上面一条 ns-resize 分隔条（拖出来的高度会记住）。
      "#scnu-liruyun-helper.lr-pro .lr-prosplit{flex:0 0 auto;height:6px;cursor:ns-resize;",
      "background:linear-gradient(180deg,#0f172a,#1e293b);border-top:1px solid #1e293b;}",
      "#scnu-liruyun-helper.lr-pro .lr-prosplit:hover{background:#334155;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologbox{flex:0 0 auto;height:150px;min-height:150px;max-height:150px;",
      "display:flex;flex-direction:column;overflow:hidden;",
      "border-top:1px solid #1e293b;padding:4px 8px 6px;background:#080e1a;}",
      // 关键：**外层 #lr-pro-log 才是那个被限高的 flex 项**。以前只给 .lr-log 写了
      // overflow，外层却是 auto 高度，于是内容把整块撑出 150px 再被 overflow:hidden 裁掉 ——
      // 表现就是"没有滚轮、翻不了历史"。两层都要限高，滚动条才会出现。
      "#scnu-liruyun-helper.lr-pro #lr-pro-log{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologbox .lr-log{flex:1 1 auto;min-height:0;max-height:none;",
      "border-top:0;padding:0 4px 0 0;overflow-y:scroll;overflow-x:hidden;font-size:10px;line-height:1.5;",
      "white-space:pre-wrap;word-break:break-word;scrollbar-width:thin;scrollbar-color:#334155 #0b1220;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologbox .lr-log::-webkit-scrollbar{width:9px;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologbox .lr-log::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologcount{color:#64748b;font-size:10px;cursor:pointer;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologcount:hover{color:#bfdbfe;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologhead{color:#93a3b8;font-size:10.5px;display:flex;gap:6px;",
      "align-items:center;padding-bottom:2px;flex:0 0 auto;}",
      // 状态行在标题行右侧：单行 + 省略号（内容太长时省略尾部，不影响日志区的高度）
      "#scnu-liruyun-helper.lr-pro .lr-prologhead .lr-status{flex:1 1 auto;min-width:0;text-align:right;",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:#93a3b8;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologmore{cursor:pointer;color:#bfdbfe;}",
      "#scnu-liruyun-helper.lr-pro .lr-prologmore:hover{color:#fff;}",
      "#scnu-liruyun-helper.lr-pro[data-pro-moved='1'] #lr-safe-area{display:none !important;}",
      "#scnu-liruyun-helper.lr-pro .lr-modeswitch{display:none !important;}",
      "#scnu-liruyun-helper.lr-pro #lr-brute-area,#scnu-liruyun-helper.lr-pro .lr-brute{",
      "display:block !important;padding:0;overflow:visible;flex:0 0 auto;}",
      "#scnu-liruyun-helper.lr-pro .lr-secbox{border-top:1px dashed #1e293b;}",
      "#scnu-liruyun-helper.lr-pro .lr-secbox:first-child{border-top:0;}",
      "#scnu-liruyun-helper.lr-pro .lr-adv{display:block !important;border-top:0;background:transparent;}",
      "#scnu-liruyun-helper.lr-pro .lr-adv>summary{display:none !important;}",
      // 列表行
      "#scnu-liruyun-helper.lr-pro .lr-prorow{display:flex;align-items:center;gap:7px;padding:4px 6px;",
      "border-radius:7px;cursor:pointer;}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow:hover{background:rgba(148,163,184,.14);}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow.lr-procur{background:rgba(245,158,11,.16);}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow.lr-procur .lr-proname{color:#fde68a;font-weight:600;}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow.lr-prodone .lr-proname{color:#86efac;}",
      "#scnu-liruyun-helper.lr-pro .lr-pronum{flex:0 0 auto;width:17px;text-align:right;color:#64748b;",
      "font-size:11px;font-variant-numeric:tabular-nums;}",
      "#scnu-liruyun-helper.lr-pro .lr-proname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;",
      "white-space:nowrap;color:#cbd5e1;font-size:11.5px;}",
      "#scnu-liruyun-helper.lr-pro .lr-progauge{flex:0 0 auto;width:32px;height:4px;border-radius:2px;",
      "background:#1e293b;overflow:hidden;}",
      "#scnu-liruyun-helper.lr-pro .lr-progauge i{display:block;height:100%;background:#3b82f6;}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow.lr-procur .lr-progauge i{background:#f59e0b;}",
      "#scnu-liruyun-helper.lr-pro .lr-prorow.lr-prodone .lr-progauge i{background:#22c55e;}",
      "#scnu-liruyun-helper.lr-pro .lr-protag{flex:0 0 auto;font-size:9px;padding:1px 5px;border-radius:999px;",
      "background:rgba(34,197,94,.18);color:#4ade80;border:1px solid rgba(34,197,94,.35);",
      "font-variant-numeric:tabular-nums;}",
      "#scnu-liruyun-helper.lr-pro .lr-protag-todo{background:rgba(245,158,11,.15);color:#fcd34d;",
      "border-color:rgba(245,158,11,.3);}",
      "#scnu-liruyun-helper.lr-pro .lr-protag-cur{background:rgba(245,158,11,.28);color:#fde68a;",
      "border-color:rgba(245,158,11,.55);font-weight:700;}",
      "#scnu-liruyun-helper.lr-pro .lr-proempty{color:#f87171;font-size:11.5px;padding:8px 6px;line-height:1.5;}",
      // 暴力模式下的播放按钮：换个颜色，避免误以为是"只是播放"
      "#scnu-liruyun-helper.lr-promode-brute button[data-action='nav']{background:#b45309 !important;",
      "border-color:#f59e0b !important;}",
      // 原版「—」最小化按钮在 5.0 里没用（紧凑模式/悬浮胶囊都删了）
      // v5.2：原版「—」最小化**不再隐藏**（现场："最小化和悬浮窗没了，这不好"）。
      // 只把"没有 id 的那个 .lr-minbtn"当最小化按钮用；带 id 的是我们自己的按钮。
      "#scnu-liruyun-helper.lr-pro .lr-head>.lr-minbtn{cursor:pointer;}",
      "#scnu-liruyun-helper.lr-pro .lr-proemg{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.5);color:#fecaca;font-weight:700;}",
      "#scnu-liruyun-helper.lr-pro .lr-proemg:hover{background:rgba(239,68,68,.3);color:#fff;}",
      "#lr-pro-threshval{width:58px;background:#0b1220;color:#e2e8f0;border:1px solid #1e293b;border-radius:6px;padding:3px 6px;font-size:11px;}",
      // 悬浮球：收起面板后留在页面上的小圆球（可拖动，点一下还原）。
      // 注意：**一条规则写在一行里**（别为了好看拆成多行字符串 —— CSS 的花括号会被拆散）
      "#lr-pro-pod{position:fixed;z-index:2147483647;width:46px;height:46px;border-radius:50%;cursor:move;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.92);border:2px solid #3b82f6;color:#dbeafe;font-size:12px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.45);user-select:none;}",
      "#lr-pro-pod:hover{border-color:#60a5fa;color:#fff;}",
      "#lr-pro-pod.lr-pod-done{border-color:#22c55e;color:#bbf7d0;}",
      // ---------------------------------------------------------------- 设置弹窗
      "#lr-pro-dialog{position:fixed;right:16px;top:12px;z-index:2147483646;width:min(380px,46vw);",
      "max-height:88vh;display:flex;flex-direction:column;box-sizing:border-box;border-radius:12px;",
      "background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;box-shadow:0 18px 44px rgba(0,0,0,.55);",
      "font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;",
      "opacity:var(--lr-pro-op,1);}",
      "#lr-pro-dialog:hover{opacity:1;}",
      "#lr-pro-dialog .lr-dlghead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111c33;",
      "border-bottom:1px solid #1e293b;font-weight:600;font-size:12.5px;cursor:move;user-select:none;}",
      "#lr-pro-dialog .lr-dlgtitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      "#lr-pro-dialog .lr-dlgclose{cursor:pointer;color:#94a3b8;font-weight:700;padding:0 4px;}",
      "#lr-pro-dialog .lr-dlgclose:hover{color:#fff;}",
      "#lr-pro-dialog .lr-dlgbody{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 4px 10px;}",
      "#lr-pro-dialog .lr-dlgbody::-webkit-scrollbar{width:9px;}",
      "#lr-pro-dialog .lr-dlgbody::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}",
      "#lr-pro-dialog .lr-sec{color:#93a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.5px;",
      "margin:6px 10px 2px;}",
      "#lr-pro-dialog .lr-row{display:flex;align-items:center;gap:6px;padding:6px 10px;flex-wrap:wrap;}",
      "#lr-pro-dialog .lr-lab{color:#94a3b8;font-size:11px;}",
      "#lr-pro-dialog .lr-unit{color:#94a3b8;font-size:11px;}",
      "#lr-pro-dialog .lr-num{width:56px;background:#0b1220;color:#e2e8f0;border:1px solid #1e293b;",
      "border-radius:6px;padding:4px 6px;font-size:11px;text-align:center;}",
      "#lr-pro-dialog .lr-hint{color:#94a3b8;font-size:10px;line-height:1.45;padding:0 10px 6px;}",
      "#lr-pro-dialog button{cursor:pointer;border:1px solid #1e293b;border-radius:7px;padding:6px 9px;",
      "background:#1e293b;color:#e2e8f0;font-size:11px;white-space:nowrap;}",
      "#lr-pro-dialog button:hover{background:#26364d;}",
      "#lr-pro-dialog button.lr-on{background:rgba(59,130,246,.22);border-color:#3b82f6;color:#bfdbfe;}",
      "#lr-pro-dialog .lr-status{color:#cbd5e1;font-size:11px;padding:2px 10px 6px;word-break:break-word;}",
      "#lr-pro-dialog .lr-log{max-height:170px;overflow:auto;white-space:pre-wrap;color:#7c8aa0;",
      "font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:6px 10px 8px;",
      "border-top:1px dashed #1e293b;}",
      "#lr-pro-dialog .lr-prochips{display:flex;flex-wrap:wrap;gap:4px;padding:2px 10px 8px;}",
      "#lr-pro-dialog .lr-chip{font-size:10px;color:#94a3b8;background:rgba(148,163,184,.12);",
      "border:1px solid rgba(148,163,184,.18);border-radius:999px;padding:1px 7px;white-space:nowrap;}",
      "#lr-pro-dialog .lr-chip-on{color:#86efac;background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.3);}",
      "#lr-pro-dialog .lr-chip-warn{color:#fcd34d;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.3);}",
      "#lr-pro-dialog .lr-chip-info{color:#bfdbfe;background:rgba(59,130,246,.14);border-color:rgba(59,130,246,.3);}",
    ].join("\n");
    document.documentElement.appendChild(style);
  }

  // ---------------------------------------------------------------- 自动采集
  function proCourseIndexPresent() {
    var sels = ["#course-index", "[data-region='courseindex']", "#theme_boost-drawers-courseindex",
      "[data-region*='courseindex']", ".courseindex", "[data-for='cm']"];
    for (var i = 0; i < sels.length; i++) {
      try { if (document.querySelector(sels[i])) return true; } catch (_) {}
    }
    return false;
  }

  function proAutoCollectList() {
    if (PRO.autoCollected) return;
    if (!proCourseIndexPresent()) return;
    PRO.autoCollected = true;
    log("检测到课程索引：开始自动采集视频列表");
    var delays = [600, 1500, 3000];
    for (var i = 0; i < delays.length; i++) {
      (function (d, last) {
        setTimeout(function () {
          try {
            var out = collectResourcesFromPageAdaptive
              ? collectResourcesFromPageAdaptive({ force: true }) : [];
            proRenderList(true);
            if (last) {
              log("自动采集结束：列表 " + (out ? out.length : 0) + " 条（来源 " +
                (ADAPTIVE && ADAPTIVE.source ? ADAPTIVE.source : "?") + "）");
            }
          } catch (e) {
            log("自动采集出错（可手动点「扫描」）：" + ((e && e.message) || e));
          }
        }, d);
      })(delays[i], i === delays.length - 1);
    }
  }

  // ---------------------------------------------------------------- 设置弹窗
  // 现场反馈："窗口太小会没办法显示日志甚至设置，点设置最好新弹出一个新的窗口"。
  //
  // 5.4 又修了一次逻辑（现场："默认设置会一开始在安全模式主窗口的中间位置，点了设置就到设置窗口，
  // 关闭设置就消失，在逻辑上是否有误？"）：
  //   **偏好设置（透明度/自动静音/弹窗拦截/完成后是否下一节/自定义达标进度）现在永久住在设置窗口里**，
  //   不再"点什么、搬什么"。主窗口的两个模式页只放**该模式自己的操作**：
  //     安全模式页 = 定时暂停 / 自动通过 / 自动重播 / 刷新列表 / 自动连播本页 / 只播这一节 / 事件体检 / 停止
  //     暴力模式页 = 风险告知 / 发包参数 / 批量 / 连播开关 / 诊断
  //   这样"打开设置→东西出现、关闭设置→东西消失"这件事就不存在了：设置窗口只是显示/隐藏它自己的内容。
  function proDialogEl() { return proEl("lr-pro-dialog"); }

  function proOpenDialog() {
    var dlg = proDialogEl();
    if (!dlg) return;
    dlg.style.display = "flex";
    proPlaceDialog(dlg);
    PRO.dialogOpen = true;
  }

  function proCloseDialog() {
    var dlg = proDialogEl();
    if (dlg) dlg.style.display = "none";
    PRO.dialogOpen = false;
  }

  // 弹窗位置：用户拖过就记住（现场："设置窗口的位置不会记忆吗？刷新页面之后就恢复初始了"）；
  // 没拖过就用默认位 —— **主面板左边**（现场："第一次打开的默认位置放到主窗口左边的适当位置"）。
  function proPlaceDialog(dlg) {
    var vw = 1280, vh = 900;
    try { vw = window.innerWidth || vw; vh = window.innerHeight || vh; } catch (_) {}
    var w = 0, h = 0;
    try { w = dlg.offsetWidth || 0; h = dlg.offsetHeight || 0; } catch (_) {}
    if (!w) w = Math.min(380, Math.round(vw * 0.46));
    if (!h) h = Math.round(vh * 0.5);
    var clampL = function (v) { return Math.max(8, Math.min(Math.max(8, vw - 60), v)); };
    var clampT = function (v) { return Math.max(8, Math.min(Math.max(8, vh - 80), v)); };
    if (PRO.dlgPos && isFinite(PRO.dlgPos.left) && isFinite(PRO.dlgPos.top)) {
      dlg.style.left = Math.round(clampL(PRO.dlgPos.left)) + "px";
      dlg.style.top = Math.round(clampT(PRO.dlgPos.top)) + "px";
      dlg.style.right = "auto";
      return;
    }
    var pr = null;
    try {
      var panel = proEl("scnu-liruyun-helper");
      if (panel && panel.getBoundingClientRect) pr = panel.getBoundingClientRect();
    } catch (_) {}
    var gap = 10, left = vw - w - 16, top = 12;
    if (pr && (pr.width || pr.height)) {
      left = pr.left - w - gap;              // 默认贴在面板左边
      top = pr.top;
      if (left < 8) left = pr.right + gap;   // 左边放不下（面板靠左）就退回右边
      if (left + w > vw - 8) left = Math.max(8, vw - w - 16);
    }
    dlg.style.left = Math.round(clampL(left)) + "px";
    dlg.style.top = Math.round(clampT(top)) + "px";
    dlg.style.right = "auto";
  }

  // 弹窗头部不再挂任何说明文字（现场："这种明显你的提示，不应该在正式版出现"）。
  // 这个函数保留为空壳，是为了不在别处留下"调用了不存在的东西"的隐患。
  function proDialogNote() { return ""; }

  // 弹窗只装**偏好设置**：日志、状态行、模式操作都留在主面板
  //（日志与状态每秒被基础脚本刷新，搬走就成快照；模式操作属于主窗口那两页）
  function proBuildDialog() {
    var dlg = proMk("div", null);
    dlg.id = "lr-pro-dialog";
    dlg.style.display = "none";
    var head = proMk("div", "lr-dlghead");
    var dot = proMk("span", "lr-dot lr-dot-unknown");
    var title = proMk("div", "lr-dlgtitle", "设置");
    var close = proMk("span", "lr-dlgclose", "✕");
    close.id = "lr-pro-dialog-close";
    close.title = "关闭（设置里的改动会立即生效）";
    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    var body = proMk("div", "lr-dlgbody");
    body.id = "lr-pro-dialog-body";
    dlg.appendChild(head);
    dlg.appendChild(body);
    document.documentElement.appendChild(dlg);

    // 偏好设置块搬进来**常驻**（不再开一次搬一次）。
    // 注意：它是在 proBuildInner 里建的，建完还没挂进文档 —— 必须用**引用**搬，
    // 不能靠 getElementById 去找（detached 节点在真实浏览器里查不到）。
    var prefsBlock = PRO.prefsEl || proEl("lr-pro-prefs");
    if (prefsBlock) proMove(prefsBlock, body, "偏好设置块→弹窗");

    // 弹窗里**不写任何"这是什么/为什么"的说明**：现场明确说"这种明显你的提示，
    // 不应该在正式版出现"。设置项本身 + 面板上的实时读数就够了。

    // 拖动（复用原版的拖动体验）+ 松手时**记住位置**（刷新后还在原地）
    head.addEventListener("mousedown", (function () {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, lastX = 0, lastY = 0;
      return function (ev) {
        if (ev.target && ev.target.id === "lr-pro-dialog-close") return;
        dragging = true;
        sx = ev.clientX; sy = ev.clientY;
        var r = dlg.getBoundingClientRect();
        ox = r.left; oy = r.top;
        lastX = ox; lastY = oy;
        var move = function (e) {
          if (!dragging) return;
          var nx = Math.max(0, Math.min(window.innerWidth - 80, ox + (e.clientX - sx)));
          var ny = Math.max(0, Math.min(window.innerHeight - 40, oy + (e.clientY - sy)));
          lastX = nx; lastY = ny;
          dlg.style.left = nx + "px";
          dlg.style.top = ny + "px";
          dlg.style.right = "auto";
        };
        var up = function () {
          if (dragging && (Math.abs(lastX - ox) > 1 || Math.abs(lastY - oy) > 1)) {
            PRO.dlgPos = { left: Math.round(lastX), top: Math.round(lastY) };
            proSave();                       // 位置进存储，刷新后照旧
          }
          dragging = false;
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      };
    })());
    return dlg;
  }

  // ---------------------------------------------------------------- 悬浮球（v5.2 恢复）
  // 现场："最小化和悬浮窗没了，这不好" —— 恢复成两个**用途不同**的东西：
  //   · 标题栏的「—」最小化：面板收成一条标题栏，进度/阈值还看得到
  //   · 这个「◎」悬浮球：整个面板收起来，只在页面上留一个可拖动的小圆球，
  //     球上显示当前进度，点它还原面板（真正"让开画面"的那一档）
  function proBuildPod() {
    var pod = proMk("div", "lr-propod");
    pod.id = "lr-pro-pod";
    pod.style.display = "none";
    pod.title = "点一下还原面板（可以拖到任意位置）";
    var txt = proMk("span", "lr-propodtxt", "0%");
    txt.id = "lr-pro-podtxt";
    pod.appendChild(txt);
    document.documentElement.appendChild(pod);
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0, moved = 0;
    pod.addEventListener("mousedown", function (ev) {
      dragging = true; moved = 0;
      sx = ev.clientX; sy = ev.clientY;
      var r = pod.getBoundingClientRect();
      ox = r.left; oy = r.top;
      var move = function (e) {
        if (!dragging) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        var nx = Math.max(0, Math.min(window.innerWidth - 40, ox + dx));
        var ny = Math.max(0, Math.min(window.innerHeight - 40, oy + dy));
        pod.style.left = nx + "px";
        pod.style.top = ny + "px";
      };
      var up = function () {
        dragging = false;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (moved > 4) {
          PRO.podPos = { left: Math.round(parseFloat(pod.style.left) || 0), top: Math.round(parseFloat(pod.style.top) || 0) };
          proSave();
        } else {
          PRO.pod = false;                   // 没拖动 = 点击 → 还原面板
          proApplyPod();
          proSave();
          log("已从悬浮球还原面板");
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    return pod;
  }

  function proApplyPod() {
    var pod = proEl("lr-pro-pod");
    var ui = proEl("scnu-liruyun-helper");
    if (pod) {
      var pos = PRO.podPos || { left: (function () {
        var vw = 1280; try { vw = window.innerWidth || vw; } catch (_) {}
        return vw - 70;
      })(), top: 220 };
      pod.style.left = Math.round(pos.left) + "px";
      pod.style.top = Math.round(pos.top) + "px";
      pod.style.display = PRO.pod ? "flex" : "none";
    }
    if (ui) ui.style.display = PRO.pod ? "none" : "";
  }

  function proPodText() {
    var txt = proEl("lr-pro-podtxt");
    if (!txt) return;
    var pct = 0;
    try { pct = Math.round(Number(readProgress()) || 0); } catch (_) { pct = 0; }
    txt.textContent = pct + "%";
    var pod = proEl("lr-pro-pod");
    if (pod) pod.className = "lr-propod" + (PRO.podDone ? " lr-pod-done" : "");
  }

  // 基础脚本那套「面板看不见就自救」的检查，要在 pro 布局下放过两种**有意**状态：
  //   · ◎ 悬浮球（面板被 display:none 收起来了）
  //   · — 最小化（只剩一条标题栏）
  // 否则用户一收起，1.5 秒后的自检就把面板拉回来（球还在、面板又冒出来）。
  function proPanelStateIntentional(info) {
    var panel = proEl("scnu-liruyun-helper");
    if (!panel || panel.getAttribute("data-pro") !== "1") return false;
    if (PRO.pod) return true;
    if (info && info.minimized) return true;
    return Boolean(panel.classList && panel.classList.contains("lr-min"));
  }

  // ---------------------------------------------------------------- 搭骨架
  function proFindBlocks() {
    var ui = proEl("scnu-liruyun-helper");
    if (!ui) return null;
    var q = function (sel) { return ui.querySelector(sel); };
    return {
      ui: ui,
      head: q(".lr-head"),
      listbox: proEl("lr-brute-listbox"),
      tools: q(".lr-tools"),
      advanced: q("details.lr-adv"),
      brutePanel: proEl("lr-brute-area"),
      chips: q(".lr-chips"),
      status: q(".lr-status"),
      log: q(".lr-log"),
      body: q(".lr-body"),
      warn: proEl("lr-brute-area") && proEl("lr-brute-area").querySelector(".lr-warn"),
      hints: proEl("lr-brute-area") ? proEl("lr-brute-area").querySelectorAll(".lr-hint") : [],
    };
  }

  // ---------------------------------------------------------------- 正式版收尾
  // 现场反馈："读我失败排查这些也要删了，之后发布正式版给别人看不好"。
  // 做法：把暴力面板里那些**开发者口吻的说明**（"把这个发我"、"失败排查"、请求/响应原文…）
  // 收进一个默认收起的 "⚠ 使用须知" 里；风险提示本身保留（这是给使用者看的必要告知，
  // 不是调试文字），但也不再占一屏。
  function proTidyBrutePanel(b) {
    try {
      var kids = [];
      for (var i = 0; i < b.hints.length; i++) kids.push(b.hints[i]);
      var box = null;
      if (kids.length || b.warn) {
        box = proMk("details", "lr-secbox lr-protips");
        box.id = "lr-pro-tips";
        box.appendChild(proMk("summary", "lr-secsummary", "▸ 使用须知与风险提示（点开）"));
        if (b.warn && b.warn.parentNode) {
          b.warn.parentNode.insertBefore(box, b.warn);
          box.appendChild(b.warn);
        }
        for (var k = 0; k < kids.length; k++) {
          // 只收走"开发者口吻"的说明；参数区的 hint（适配说明等）留着，它们是有用的
          var t = String(kids[k].textContent || "");
          if (/发我|失败排查|诊断读数|原文|数据库|复测|请求\/响应/.test(t)) box.appendChild(kids[k]);
        }
        if (!box.children.length || box.children.length === 1) {
          // 什么都没有就别留空块
          if (box.parentNode) box.parentNode.removeChild(box);
        }
      }
      // v5.2 现场反馈："读我排查那个虽然里面没东西了，但是 ui 还有它，应该删掉"。
      // 上面把说明文字搬走之后，「读我与失败排查」这个 <details> 外壳就空了 ——
      // 留下一个点开什么都没有的折叠块，正是用户看到的那一幕。这里把**空外壳**清掉。
      proDropEmptySections(b.brutePanel);
    } catch (e) {
      log("整理暴力面板说明失败（不影响功能）：" + ((e && e.message) || e));
    }
  }

  // 清掉"搬空之后什么都不剩"的可折叠分区（只认 details.lr-secbox，且有 data-advkey）
  function proDropEmptySections(root) {
    if (!root) return 0;
    var boxes = [];
    try { boxes = root.querySelectorAll("details.lr-secbox"); } catch (_) { return 0; }
    var dropped = 0;
    for (var i = 0; i < boxes.length; i++) {
      var d = boxes[i];
      if (!d.dataset || !d.dataset.advkey) continue;      // 只动"分区"，不动别的折叠块
      if (d.style && d.style.display === "none") continue;
      var hasContent = false;
      for (var j = 0; j < d.children.length; j++) {
        var c = d.children[j];
        if (c.tagName === "SUMMARY") continue;
        if (String(c.textContent || "").trim()) { hasContent = true; break; }
      }
      if (hasContent) continue;
      var label = (function () {
        try { var s = d.querySelector("summary"); return s ? String(s.textContent || "").trim() : "(无名分区)"; }
        catch (_) { return "(无名分区)"; }
      })();
      try {
        if (d.parentNode) d.parentNode.removeChild(d);
        dropped += 1;
        log("已清理空分区「" + label + "」");
      } catch (_) {}
    }
    return dropped;
  }

  function proBuild() {
    try {
      return proBuildInner();
    } catch (e) {
      proRollbackAll((e && e.message) || String(e));
      return false;
    }
  }

  function proBuildInner() {
    var b = proFindBlocks();
    if (!b || !b.ui || !b.head || !b.body) return false;
    if (b.ui.getAttribute("data-pro") === "1") { PRO.built = true; return true; }

    proInstallCss();
    b.ui.className = String(b.ui.className || "") + " lr-pro";
    b.ui.setAttribute("data-pro", "1");
    b.ui.removeAttribute("data-pro-moved");

    // ---- 模式按钮行（顶上两个按钮，独立分页）----
    var modeBox = proMk("div", "lr-promodes");
    modeBox.id = "lr-pro-modes";
    var modeSafe = proMk("span", "lr-promode", "🛡 安全模式");
    modeSafe.id = "lr-pro-mode-safe";
    modeSafe.dataset.proMode = "safe";
    modeSafe.title = "正常播放：自动连播本页 / 定时暂停 / 学习确认自动通过 / 自动重播";
    var modeBrute = proMk("span", "lr-promode", "⚡ 暴力模式");
    modeBrute.id = "lr-pro-mode-brute";
    modeBrute.dataset.proMode = "brute";
    modeBrute.title = "直接向接口发包（高风险、默认不发包）：发包参数 / 批量";
    modeBox.appendChild(modeSafe);
    modeBox.appendChild(modeBrute);

    // ---- 列表区 ----
    var listview = proMk("div", "lr-prolistwrap");
    listview.id = "lr-pro-listwrap";
    var bar = proMk("div", "lr-probar");
    var btnScan = proMk("button", null, "扫描");
    btnScan.dataset.action = "brute-scan";
    btnScan.title = "按当前页面重新采集视频列表";
    var btnRefresh = proMk("button", null, "刷新列表");
    btnRefresh.dataset.action = "brute-refresh";
    btnRefresh.title = "强制重扫：清缓存 + 展开折叠章节 + 服务端兜底";
    var btnTodo = proMk("button", null, "只看未完成");
    btnTodo.dataset.proAction = "todo";
    btnTodo.title = "只列出还没达标的视频";
    var btnFold = proMk("button", null, "▾ 列表");
    btnFold.id = "lr-pro-fold";
    btnFold.title = "收起/展开视频列表（条目多时可以收起来，给日志和设置让位）";
    // **只留一个设置按钮**（现场："设置按钮两个臃肿了"）
    var btnSet = proMk("button", null, "⚙ 设置");
    btnSet.id = "lr-pro-setbtn";
    btnSet.title = "打开设置窗口（透明度 / 自动静音 / 弹窗拦截 / 达标进度 / 完成后是否下一节）";
    // 急停（现场："顶部设置旁边可以加一个急停，紧急停止并暂停视频"）：
    // 一键停掉「队列 / 暴力发包 / 批量」并把视频暂停，之后不会再被保活自动点起来。
    var btnEmg = proMk("button", "lr-proemg", "⏹ 急停");
    btnEmg.id = "lr-pro-emg";
    btnEmg.title = "紧急停止：停掉队列/暴力/批量 + 暂停视频（之后不会再自动恢复播放；点「▶ 播放」才恢复）";
    var count = proMk("span", "lr-procount", "");
    count.id = "lr-pro-count";
    bar.appendChild(btnScan);
    bar.appendChild(btnRefresh);
    bar.appendChild(btnTodo);
    bar.appendChild(btnFold);
    bar.appendChild(btnSet);
    bar.appendChild(btnEmg);
    bar.appendChild(count);
    listview.appendChild(bar);
    var myList = proMk("div", "lr-prolist");
    myList.id = "lr-pro-list";
    listview.appendChild(myList);

    // ---- 模式页块 ----
    var setBlock = proMk("div", "lr-proset lr-proset-set");
    setBlock.id = "lr-pro-set";
    var bruteBlock = proMk("div", "lr-proset lr-proset-brute");
    bruteBlock.id = "lr-pro-brute";
    // v5.4：**偏好设置**单独一块，建好后由 proBuildDialog() 挂进设置窗口并常驻在那儿。
    // 这样"打开设置→东西出现 / 关闭设置→东西消失"就不存在了：主窗口那两页只放模式自己的操作。
    var prefsBlock = proMk("div", "lr-proprefs");
    prefsBlock.id = "lr-pro-prefs";
    PRO.prefsEl = prefsBlock;      // 挂在 PRO 上带着走（建的时候还没进文档，查不到）

    // ---- 面板底部的日志块（常驻；高度可用鼠标拖）----
    // 5.2：**日志永远留在面板里**（现场："日志还是不要跟着设置走吧，依旧保留在主窗口"）。
    // 原因不只是观感：基础脚本的 renderLog() 只往 `ui.querySelector(".lr-log")` 写，
    // 一旦被搬进弹窗，它就再也找不到这个元素 —— 用户看到的"像快照，不会更新"就是这么来的。
    // 5.4："日志根本看不全、也没有滚轮" → 写满（最多 80 行）+ 内部滚动 + 上面加一条拖动分隔条。
    var split = proMk("div", "lr-prosplit");
    split.id = "lr-pro-split";
    split.title = "上下拖动可以调整日志区高度（会记住）";
    // v5.5：列表与下面那一页之间也来一根（现场："播放列表和下面的参数设置之间不能自由调整大小"）
    var splitList = proMk("div", "lr-prosplit");
    splitList.id = "lr-pro-split-list";
    splitList.title = "上下拖动可以调整视频列表的高度（会记住）";
    var logBox = proMk("div", "lr-prologbox");
    logBox.id = "lr-pro-logbox";
    var logHead = proMk("div", "lr-prologhead");
    logHead.appendChild(proMk("span", null, "日志"));
    var logCount = proMk("span", "lr-prologcount", "");
    logCount.id = "lr-pro-logcount";
    logCount.title = "点一下跳到最新（往上翻看历史时不会被打断）";
    logHead.appendChild(logCount);
    logBox.appendChild(logHead);

    var logInPanel = proMk("div", null);
    logInPanel.id = "lr-pro-log";
    logBox.appendChild(logInPanel);

    // ---- 搬块 ----
    if (b.advanced) proMove(b.advanced, setBlock, "设置/诊断块");
    // 先把开发者口吻的说明收起来（正式版观感），再搬暴力面板
    proTidyBrutePanel(b);
    if (b.brutePanel) proMove(b.brutePanel, bruteBlock, "暴力面板");
    if (b.log) { proMove(b.log, logInPanel, "日志块"); PRO.logEl = b.log; }
    // 状态行也**不能跟着设置走**：setStatus() 同样是 `ui.querySelector(".lr-status")`，
    // 搬进弹窗后就会冻在最后一句话上。5.3 起它挂在日志标题行的右侧（单行省略号），
    // 这样固定高度的日志区能**整块**留给日志本身。
    if (b.status) proMove(b.status, logHead, "状态行");
    if (b.chips) {
      var chipWrap = proMk("div", "lr-prochips");
      chipWrap.appendChild(b.chips);
      setBlock.insertBefore(chipWrap, setBlock.firstChild);
    }

    // 透明度滑块 + 自动静音（都放在设置块最上面，弹窗里一眼看到）
    var opRow = proMk("div", "lr-row");
    opRow.id = "lr-pro-oprow";
    opRow.appendChild(proMk("span", "lr-lab", "面板透明度"));
    var opRange = document.createElement("input");
    opRange.type = "range";
    opRange.min = "35";
    opRange.max = "100";
    opRange.step = "5";
    opRange.value = String(Math.round(PRO.opacity * 100));
    opRange.id = "lr-pro-opacity";
    opRange.title = "调低就能看穿面板；鼠标移到面板上会自动变清晰";
    opRow.appendChild(opRange);
    var opVal = proMk("span", "lr-unit", Math.round(PRO.opacity * 100) + "%");
    opVal.id = "lr-pro-opval";
    opRow.appendChild(opVal);
    prefsBlock.appendChild(opRow);
    opRange.addEventListener("input", function () {
      PRO.opacity = Math.max(0.35, Math.min(1, Number(opRange.value) / 100));
      opVal.textContent = Math.round(PRO.opacity * 100) + "%";
      proApplyOpacity();
      proSave();
    });

    var muteRow = proMk("div", "lr-row");
    muteRow.id = "lr-pro-muterow";
    var muteBtn = proMk("button", "", "自动静音：关");
    muteBtn.type = "button";
    muteBtn.id = "lr-pro-mute";
    muteBtn.title = "打开后：只要在播放，就把视频静音（页面自己把它开回来也会被静音掉）";
    muteRow.appendChild(muteBtn);
    muteRow.appendChild(proMk("span", "lr-unit", "播放时保持静音"));
    prefsBlock.appendChild(muteRow);
    proApplyMute();

    // 站点弹窗拦截（v5.1）：现场"点太快了会弹窗"—— 那个框是浏览器原生 alert()，
    // 脚本点不到它，只能提前把页面的 alert 换掉（详见 _dialog-guard-module.js）。
    // 这里只做一个开关 + 一行统计，放在自动静音下面（两个都是"少打扰我"类设置）。
    var dlgRow = proMk("div", "lr-row");
    dlgRow.id = "lr-pro-dlgrow";
    var dlgBtn = proMk("button", "", "弹窗拦截：开");
    dlgBtn.type = "button";
    dlgBtn.id = "lr-pro-dialogguard";
    dlgBtn.title = "打开后：站点弹的「禁止同时观看多个视频…」这类框不再挡路（等于自动点了确定），" +
      "并顺手恢复被站点暂停的播放；不认识的询问照常弹出来让你自己选";
    dlgRow.appendChild(dlgBtn);
    var dlgNote = proMk("span", "lr-unit", "");
    dlgNote.id = "lr-pro-dlgnote";
    dlgRow.appendChild(dlgNote);
    prefsBlock.appendChild(dlgRow);
    proApplyDialogGuard();

    // ---- v5.2 播放偏好（现场要求）----
    // "完成视频之后是否下一个视频" —— **默认开**（就是原来的行为），关掉之后达标也停在本节
    var nextRow = proMk("div", "lr-row");
    nextRow.id = "lr-pro-nextrow";
    var nextBtn = proMk("button", "", "完成后自动播下一节：开");
    nextBtn.type = "button";
    nextBtn.id = "lr-pro-autonext";
    nextBtn.title = "开着：本节达标就自动切到列表里的下一节；" +
      "关掉：达标后停在本节（不跳走），等你手动点播放/下一节";
    nextRow.appendChild(nextBtn);
    nextRow.appendChild(proMk("span", "lr-unit", "达标后停在本节"));
    prefsBlock.appendChild(nextRow);

    // "自定义视频完成进度的标准（默认关闭，开启之后才用这个标准）"
    var thRow = proMk("div", "lr-row");
    thRow.id = "lr-pro-throw";
    var thBtn = proMk("button", "", "自定义达标进度：关");
    thBtn.type = "button";
    thBtn.id = "lr-pro-threshon";
    thBtn.title = "开着才用下面这个百分比当达标线；关着就用课程页面自己写的要求（默认 90%）";
    thRow.appendChild(thBtn);
    var thNum = document.createElement("input");
    thNum.type = "number";
    thNum.min = "1";
    thNum.max = "100";
    thNum.step = "1";
    thNum.value = String(prefThresholdValue());
    thNum.id = "lr-pro-threshval";
    thNum.title = "1–100，改完立刻生效（当前有效的达标线写在设置窗口顶上）";
    thRow.appendChild(thNum);
    thRow.appendChild(proMk("span", "lr-unit", "%"));
    var thNote = proMk("span", "lr-unit", "");
    thNote.id = "lr-pro-thnote";
    thRow.appendChild(thNote);
    prefsBlock.appendChild(thRow);
    proApplyPrefs();

    // 暴力外壳带内联 display:none 出生：搬进来后必须清掉
    if (b.brutePanel && b.brutePanel.style) {
      b.brutePanel.style.display = "";
      try { b.brutePanel.removeAttribute("style"); } catch (_) {}
    }

    // ---- v5.2：暴力页的播放行为（现场："暴力模式在列表的播放加一个可选项，
    //      是否继续按列表一键播放所有视频"）----
    // 放在暴力页最上面：点了「▶ 播放并开始暴力」之后，要不要顺着列表一节节刷完整门课。
    var blRow = proMk("div", "lr-row");
    blRow.id = "lr-pro-blrow";
    var blBtn = proMk("button", "", "点播放时按列表连播：关");
    blBtn.type = "button";
    blBtn.id = "lr-pro-brutelist";
    blBtn.title = "开着：暴力页的「▶ 播放并开始暴力」会把整个视频列表挨个刷完（跨页自动继续）；" +
      "关着：只处理当前这一节";
    blRow.appendChild(blBtn);
    blRow.appendChild(proMk("span", "lr-unit", "按列表顺序逐个处理"));
    bruteBlock.insertBefore(blRow, bruteBlock.firstChild);
    // 这一行是在设置区之后才建的，所以必须**再同步一次**偏好标签 ——
    // 否则刷新页面后它会一直显示建行时的默认文字（现场：明明开着，看着却是"关"）。
    proApplyPrefs();

    // ---- 按顺序挂进 body ----
    var anchor = b.body.firstChild;
    var order = [modeBox, listview, splitList, setBlock, bruteBlock, split, logBox];
    for (var oi = 0; oi < order.length; oi++) b.body.insertBefore(order[oi], anchor);
    if (b.tools) proMove(b.tools, listview, "播放工具行");
    if (b.listbox) {
      b.listbox.style.display = "none";
      b.listbox.setAttribute("data-pro-hidden", "1");
    }

    // ---- 必搬清单自检 ----
    var mustHave = [
      ["定时暂停输入框", setBlock, "[data-cfg='every']"],
      ["自动通过开关", setBlock, "[data-action='auto']"],
      ["自动重播开关", setBlock, "[data-action='replay']"],
      ["开始本页资源", setBlock, "[data-action='start']"],
      ["仅播当前页", setBlock, "[data-action='current']"],
      ["事件体检", setBlock, "[data-action='audit']"],
      ["停止按钮", setBlock, "[data-action='stop']"],
      ["刷新列表", setBlock, "[data-action='refresh-list']"],
      ["透明度滑块", prefsBlock, "#lr-pro-opacity"],
      ["自动静音开关", prefsBlock, "#lr-pro-mute"],
      ["弹窗拦截开关", prefsBlock, "#lr-pro-dialogguard"],
      ["完成后是否下一节", prefsBlock, "#lr-pro-autonext"],
      ["自定义达标进度开关", prefsBlock, "#lr-pro-threshon"],
      ["自定义达标进度数值", prefsBlock, "#lr-pro-threshval"],
      ["暴力页连播开关", bruteBlock, "#lr-pro-brutelist"],
      ["开始暴力", bruteBlock, "[data-action='brute-start']"],
      ["停止暴力", bruteBlock, "[data-action='brute-stop']"],
      ["诊断读数", bruteBlock, "[data-action='brute-diag']"],
      ["自动适配开关", bruteBlock, "#lr-brute-autofit"],
      ["适配目标", bruteBlock, "#lr-brute-fitpct"],
      ["队列预算", bruteBlock, "#lr-brute-maxqueue"],
      ["停滞判定", bruteBlock, "#lr-brute-stallpackets"],
      ["手填次数", bruteBlock, "#lr-brute-total"],
      ["间隔", bruteBlock, "#lr-brute-interval"],
      ["每次上报时长", bruteBlock, "#lr-brute-time"],
      ["时长上报方式", bruteBlock, "#lr-brute-timemode"],
      ["达标即停", bruteBlock, "#lr-brute-stopcomplete"],
      ["继续播放", bruteBlock, "#lr-brute-keepplaying"],
      ["确认框", bruteBlock, "#lr-brute-confirm"],
      ["失控保护", bruteBlock, "#lr-brute-safety"],
      ["发包进度行", bruteBlock, "#lr-brute-line"],
      ["适配说明行", bruteBlock, "#lr-brute-fitline"],
      ["批量状态行", bruteBlock, "#lr-brute-batchline"],
      ["日志块", logInPanel, ".lr-log"],
      ["日志分隔条", b.body, "#lr-pro-split"],
      ["列表分隔条", b.body, "#lr-pro-split-list"],
    ];
    var lost = [];
    for (var mi = 0; mi < mustHave.length; mi++) {
      var hit = null;
      try { hit = mustHave[mi][1].querySelector(mustHave[mi][2]); } catch (_) { hit = null; }
      if (!hit) lost.push(mustHave[mi][0]);
    }
    if (lost.length) throw new Error("有 " + lost.length + " 项没搬进来（会整块消失）：" + lost.join("、"));
    b.ui.setAttribute("data-pro-moved", "1");

    // ---- 设置弹窗（**只装偏好设置**：日志与模式操作都留在主窗口）----
    proBuildDialog();
    // 建完再确认一次"偏好设置确实在设置窗口里"（挪错地方 = 用户点开设置一片空白）
    if (!document.querySelector("#lr-pro-dialog #lr-pro-prefs")) {
      throw new Error("偏好设置块没进设置窗口（打开设置会一片空白）");
    }
    // ---- 悬浮球（v5.2 恢复）----
    proBuildPod();
    proApplyPod();
    // ---- 两根分隔条（v5.4/v5.5：拖它调区域高度）----
    //   · 列表 ↔ 模式页：往下拖列表变高
    //   · 模式页 ↔ 日志：往上拖日志变高
    proBindSplitter(split, logBox, "log");
    proBindSplitter(splitList, listview, "list");
    proApplyLogH();
    proApplyListH();

    // ---- 标题栏：⟲ 复位 + ◎ 悬浮球（5.2 恢复；「—」最小化是原版按钮，见 CSS 不再隐藏它）----
    var podBtn = proMk("span", "lr-minbtn lr-podbtn", "◎");
    podBtn.id = "lr-pro-podbtn";
    podBtn.title = "收成页面上的小圆球（点圆球还原面板）";
    b.head.appendChild(podBtn);
    var resetBox = proMk("span", "lr-minbtn", "⟲");
    resetBox.id = "lr-pro-reset";
    resetBox.title = "把面板复位到默认位置和大小";
    b.head.appendChild(resetBox);

    proRelabel(b.ui);

    // ---- 接线 ----
    b.ui.addEventListener("click", proOnPanelClick, true);
    // 数字框（达标进度）走 input 事件：它有时在面板里、有时在弹窗里，两边都挂同一个处理
    b.ui.addEventListener("input", proOnPanelInput);
    // 用户自己滚过列表之后，短期内别再自动把当前项拉回中间（否则等于抢滚动条）
    var listHost = proEl("lr-pro-list");
    if (listHost) {
      listHost.addEventListener("scroll", function () {
        PRO.userScrolledRecently = true;
        if (PRO.scrollTimer) clearTimeout(PRO.scrollTimer);
        PRO.scrollTimer = setTimeout(function () { PRO.userScrolledRecently = false; }, 4000);
      });
    }
    // 说明：「—」最小化是**原版**的按钮（.lr-minbtn 且没有 id），5.0 曾把它挡住，
    // 5.2 现场要求恢复 —— 现在由 proOnPanelClick 里那一支显式调用基础的 toggleMinimize()。
    var dlg = proDialogEl();
    if (dlg) {
      dlg.addEventListener("click", function (ev) {
        var t = ev.target;
        if (t && t.id === "lr-pro-dialog-close") { proCloseDialog(); return; }
        // 设置块是**搬进弹窗**的，所以它里面的按钮不会冒泡到面板那个监听器上 ——
        // 必须在这里接一手。这里刻意**不再重复实现**一遍各按钮的逻辑（以前
        // 「自动静音」就在两处各写了一份，等于每次加开关都要记得改两个地方，
        // 5.1 新增的「弹窗拦截」就是这么漏掉的：按钮点了没反应）。
        proOnPanelClick(ev);
      });
      dlg.addEventListener("input", proOnPanelInput);
    }

    // ⚠ 顺序：先置 built 再 proApply()，否则首屏列表画不出来（现场"刚打开是空的"）
    PRO.built = true;
    proApply();
    proRenderList(true);
    log("面板已就绪；搬动 " + PRO.moves.length + " 块");
    proAutoCollectList();
    return true;
  }

  // ---------------------------------------------------------------- 自动静音
  // 现场要求："视频播放同时自动静音"。
  // 每个刷新 tick 都压一次：播放器在切清晰度/重播/换节时会 setSource，那时 muted 会被重置。
  function proApplyMute() {
    var btn = proEl("lr-pro-mute");
    if (btn) {
      btn.textContent = PRO.autoMute ? "自动静音：开" : "自动静音：关";
      btn.className = PRO.autoMute ? "lr-on" : "";
    }
  }
  function proEnforceMute() {
    if (!PRO.autoMute) return;
    var vids = [];
    try { vids = document.querySelectorAll("video"); } catch (_) { return; }
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      try {
        if (!v.muted) v.muted = true;
        if (v.volume !== 0) v.volume = 0;
      } catch (_) {}
    }
  }

  // ---------------------------------------------------------------- 弹窗拦截
  // 逻辑全在 _dialog-guard-module.js（它换了页面自己的 window.alert）。
  // 这里只负责：开关按钮的文字/样式 + 一行"拦了多少条"的统计，
  // 以及把 v3pro 自己的设置键与那边的运行时开关对齐（跨刷新保持）。
  function proDialogGuardStats() {
    try { if (typeof dialogGuardDebugApi === "function") return dialogGuardDebugApi().stats || {}; } catch (_) {}
    return {};
  }
  function proApplyDialogGuard() {
    var on = true;
    try { if (typeof dialogGuardIsOn === "function") on = dialogGuardIsOn(); } catch (_) {}
    PRO.dialogGuard = on;
    var btn = proEl("lr-pro-dialogguard");
    if (btn) {
      btn.textContent = "弹窗拦截：" + (on ? "开" : "关");
      btn.className = on ? "lr-on" : "";
    }
    var note = proEl("lr-pro-dlgnote");
    if (note) {
      var st = proDialogGuardStats();
      var n = Number(st.intercepted) || 0;
      note.textContent = on ? ("已挡下 " + n + " 个") : "站点弹窗会照常出现";
    }
  }
  function proSetDialogGuard(on) {
    var next = Boolean(on);
    try { if (typeof dialogGuardSet === "function") next = dialogGuardSet(next); } catch (_) {}
    PRO.dialogGuard = next;
    proApplyDialogGuard();
    proSave();
    return next;
  }

  // ---------------------------------------------------------------- 播放偏好（v5.2）
  // 三个开关 + 一个数字框，值都存在 _prefs-module.js 的 liruyun_play_prefs 里
  // （面板这边只负责显示，绝不另存一份 —— 两个真相必然分叉）。
  function proApplyPrefs() {
    var autoNext = true, useTh = false, th = 85, blRun = false, eff = 90;
    try { autoNext = prefAutoNextOn(); } catch (_) {}
    try { useTh = prefUseThresholdOn(); } catch (_) {}
    try { th = prefThresholdValue(); } catch (_) {}
    try { blRun = prefBruteListRunOn(); } catch (_) {}
    try { eff = prefEffectiveThreshold(); } catch (_) {}
    // 只在**真的变了**才写 DOM：这个函数每秒都会被 proTick 调一次，
    // 每次都写 textContent 会让面板里的文字反复重排（观感上是"闪"）。
    var setText = function (el, text) {
      if (el && String(el.textContent) !== text) el.textContent = text;
    };
    var setCls = function (el, cls) { if (el && String(el.className) !== cls) el.className = cls; };
    var nextBtn = proEl("lr-pro-autonext");
    if (nextBtn) {
      setText(nextBtn, "完成后自动播下一节：" + (autoNext ? "开" : "关"));
      setCls(nextBtn, autoNext ? "lr-on" : "");
    }
    var thBtn = proEl("lr-pro-threshon");
    if (thBtn) {
      setText(thBtn, "自定义达标进度：" + (useTh ? "开" : "关"));
      setCls(thBtn, useTh ? "lr-on" : "");
    }
    var thNum = proEl("lr-pro-threshval");
    if (thNum) {
      if (String(thNum.value) !== String(th)) thNum.value = String(th);
      thNum.disabled = !useTh;
      thNum.style.opacity = useTh ? "1" : "0.45";
    }
    var thNote = proEl("lr-pro-thnote");
    if (thNote) setText(thNote, useTh ? ("生效 " + eff + "%") : ("站点要求 " + eff + "%"));
    var blBtn = proEl("lr-pro-brutelist");
    if (blBtn) {
      setText(blBtn, "点播放时按列表连播：" + (blRun ? "开" : "关"));
      setCls(blBtn, blRun ? "lr-on" : "");
    }
    // 播放按钮的文字跟着"连播"走，免得用户点了才发现会刷完整门课
    var nav = document.querySelector("#scnu-liruyun-helper [data-action='nav']");
    if (nav && PRO.tab === "brute") {
      setText(nav, blRun ? "▶ 播放并连播整个列表" : "▶ 播放并开始暴力");
    }
  }
  function proToggleAutoNext() {
    var on = true;
    try { on = prefAutoNext(); } catch (_) {}
    proApplyPrefs();
    log("完成后自动播下一节：" + (on ? "开" : "关"));
    return on;
  }
  function proToggleCustomThreshold() {
    var on = false;
    try { on = prefUseThreshold(); } catch (_) {}
    proApplyPrefs();
    proDialogNote();
    log("自定义达标进度：" + (on
      ? ("开 → 达标线 " + prefThresholdValue() + "%（不再用站点要求）")
      : "关 → 用课程页面自己写的要求"));
    return on;
  }
  function proSetThresholdValue(v) {
    var out = 85;
    try { out = prefThresholdValue(v); } catch (_) {}
    proApplyPrefs();
    proDialogNote();
    return out;
  }
  function proToggleBruteListRun() {
    var on = false;
    try { on = prefBruteListRun(); } catch (_) {}
    proApplyPrefs();
    log("点播放时按列表连播：" + (on ? "开" : "关"));
    return on;
  }

  // ---------------------------------------------------------------- 急停（v5.2）
  // 现场："顶部设置旁边可以加一个急停，紧急停止并暂停视频"。
  // 关键点：**停完不能又被自己的看护顶回去** —— 保活/停摆看护/自动起播/自动重播
  // 都会看 prefEmergencyOn()（见 _prefs-module.js 与 build-dual 里的几处插入）。
  function proEmergencyStop() {
    try { prefEmergency(true); } catch (_) {}
    var did = [];
    try { if (typeof bruteStop === "function" && bruteActive) { bruteStop(true); did.push("暴力发包"); } } catch (_) {}
    try { if (typeof bruteStopBatch === "function" && bruteBatchRunning) { bruteStopBatch(); did.push("批量"); } } catch (_) {}
    try { if (typeof stopRun === "function") { stopRun("急停：已停止"); did.push("队列"); } } catch (_) {}
    var paused = false;
    try {
      var v = videoEl();
      if (v && !v.paused) { v.pause(); paused = true; }
    } catch (_) {}
    var line = "⏹ 急停：已停掉" + (did.length ? did.join(" / ") : "（本来就没在跑）") +
      (paused ? "，并暂停了视频" : "（视频本来就没在播）") + "；不会再自动恢复，点「▶ 播放」才继续";
    log(line);
    try { setStatus("⏹ 急停已生效"); } catch (_) {}
    try { flashPanel("#ef4444"); } catch (_) {}
    proApplyPrefs();
    return { stopped: did, paused: paused };
  }
  function proEmergencyClear(why) {
    var was = false;
    try { was = prefEmergencyOn(); } catch (_) {}
    if (!was) return false;
    try { prefEmergency(false); } catch (_) {}
    log("已解除急停");
    return true;
  }

  // ---------------------------------------------------------------- 状态应用
  function proApplyOpacity() {
    var ui = proEl("scnu-liruyun-helper");
    var dlg = proDialogEl();
    var v = Math.max(0.35, Math.min(1, Number(PRO.opacity) || 1));
    if (ui) { try { ui.style.setProperty("--lr-pro-op", String(v)); } catch (_) {} }
    if (dlg) { try { dlg.style.setProperty("--lr-pro-op", String(v)); } catch (_) {} }
    var val = proEl("lr-pro-opval");
    if (val) val.textContent = Math.round(v * 100) + "%";
    var range = proEl("lr-pro-opacity");
    if (range) range.value = String(Math.round(v * 100));
  }

  // 面板底部日志：只显示最后 5 行（够看"在干什么"），完整历史在设置弹窗里
  function proTrimLog() {
    // 5.4 起**不再裁剪**：日志区现在是自己滚动的（内容由基础脚本写满，最多 400 行）。
    // 这里只更新标题行上的行数徽标，顺手把"跟到最新"的绑定补上。
    var logEl = document.querySelector("#lr-pro-log .lr-log");
    proBindLogFollow(logEl);
    var badge = proEl("lr-pro-logcount");
    if (!badge) return;
    if (!logEl) { badge.textContent = ""; return; }
    var lines = String(logEl.textContent || "").split("\n").filter(function (l) { return l.trim(); });
    var atTail = true;
    try {
      var h = Number(logEl.scrollHeight) || 0;
      var top = Number(logEl.scrollTop) || 0;
      var ch = Number(logEl.clientHeight) || 0;
      atTail = (h - (top + ch)) <= 8;
    } catch (_) {}
    var text = lines.length + " 行" + (atTail ? "" : " · ⤓ 最新");
    if (String(badge.textContent) !== text) badge.textContent = text;
  }

  // "默认跟到最新，往上翻就不抢"：滚动位置由 __lrStick 记住
  //（基础脚本的 renderLog 每次写完会看它决定要不要滚到底）。
  function proBindLogFollow(logEl) {
    if (!logEl || logEl.__lrFollowBound) return;
    logEl.__lrFollowBound = true;
    logEl.__lrStick = true;
    logEl.addEventListener("scroll", function () {
      try {
        var h = Number(logEl.scrollHeight) || 0;
        var top = Number(logEl.scrollTop) || 0;
        var ch = Number(logEl.clientHeight) || 0;
        logEl.__lrStick = (h - (top + ch)) <= 8;
      } catch (_) { logEl.__lrStick = true; }
      // 立刻把「⤓ 最新」提示刷新出来（只改后缀，不用等下一跳，也不会在滚动时做大计算）
      var badge = proEl("lr-pro-logcount");
      if (!badge) return;
      var base = String(badge.textContent).replace(/\s*· ⤓ 最新$/, "");
      var want = base + (logEl.__lrStick ? "" : " · ⤓ 最新");
      if (String(badge.textContent) !== want) badge.textContent = want;
    });
  }
  function proLogToBottom() {
    var logEl = document.querySelector("#lr-pro-log .lr-log");
    if (!logEl) return false;
    logEl.__lrStick = true;
    try { logEl.scrollTop = logEl.scrollHeight; } catch (_) {}
    proTrimLog();
    return true;
  }

  function proApply() {
    var ui = proEl("scnu-liruyun-helper");
    if (!ui) return;
    var cls = String(ui.className || "")
      .replace(/\s*lr-probruteopen/g, "")
      .replace(/\s*lr-promode-\w+/g, "")
      .replace(/\s*lr-prolistclosed/g, "")
      .replace(/\s*lr-min\b/g, "");
    cls += PRO.tab === "brute" ? " lr-promode-brute lr-probruteopen" : " lr-promode-safe";
    if (!PRO.listOpen) cls += " lr-prolistclosed";
    ui.className = cls;
    proApplyOpacity();
    proApplyMute();

    var fold = proEl("lr-pro-fold");
    if (fold) fold.textContent = PRO.listOpen ? "▾ 列表" : "▸ 列表";
    var todoBtn = document.querySelector("#scnu-liruyun-helper [data-pro-action='todo']");
    if (todoBtn) {
      todoBtn.className = PRO.onlyTodo ? "lr-on" : "";
      todoBtn.textContent = PRO.onlyTodo ? "只看未完成 ●" : "只看未完成";
    }
    // 播放按钮跟着模式变（现场："点播放应该自动根据模式自动开始"）
    var nav = document.querySelector("#scnu-liruyun-helper [data-action='nav']");
    if (nav) {
      nav.textContent = PRO.tab === "brute" ? "▶ 播放并开始暴力" : "▶ 播放 / 重播";
      nav.title = PRO.tab === "brute"
        ? "先让页面播起来，同时按当前参数开始发包（高风险）"
        : "播放或从头重播当前视频";
    }
    // 切页签时立刻把偏好标签同步一次（proApplyPrefs 会把"连播"反映到播放按钮上，
    // 否则切过去要等下一跳才显示对）
    proApplyPrefs();
    proTrimLog();
    proRenderList(true);
  }

  // ---------------------------------------------------------------- 列表渲染
  function proRenderList(force) {
    if (!PRO.built) return;
    var host = proEl("lr-pro-list");
    if (!host) return;
    var queue, required, live, db, curId;
    try {
      queue = normalizedQueue();
      required = readRequiredProgress();
      live = readProgress();
      db = progressDb();
      curId = currentResourceId();
    } catch (_) { return; }

    var rows = [];
    var done = 0;
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i];
      var id = item.id || "";
      var isCur = Boolean(curId && id === curId);
      var raw = isCur ? (live === null ? db[id] : live) : db[id];
      var has = (raw !== undefined && raw !== null);
      var pct = has ? Math.max(0, Math.min(100, Number(raw))) : 0;
      var isDone = has && pct >= required;
      if (isDone) done++;
      rows.push({ item: item, i: i, id: id, isCur: isCur, has: has, pct: pct, isDone: isDone });
    }
    var total = rows.length;

    // 空队列兜底：**只在资源页**列当前这一节（课程页的 ?id= 是课程 ID，不能当视频）
    if (!total && !PRO.onlyTodo) {
      var curIdNow = currentResourceId();
      var onResource = RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; });
      if (curIdNow && onResource) {
        rows.push({
          item: {
            name: (document.title || "当前视频").replace(/\s*[|｜].*$/, "").trim() || ("id=" + curIdNow),
            url: location.href, id: curIdNow,
          },
          i: 0, id: curIdNow, isCur: true,
          has: live !== null, pct: live === null ? 0 : live, isDone: false,
        });
        total = 1;
        if (!PRO.selfPatched) {
          PRO.selfPatched = true;
          log("列表为空：先放入当前这一节（id=" + curIdNow + "）");
        }
      }
    }

    var shown = PRO.onlyTodo ? rows.filter(function (r) { return !r.isDone; }) : rows;
    var sig = total + "|" + done + "|" + required + "|" + (PRO.onlyTodo ? 1 : 0) + "|" + curId + "|" +
      (live === null ? "-" : live.toFixed(1)) + "|" +
      shown.map(function (r) { return r.id + ":" + r.pct.toFixed(0) + (r.isCur ? "*" : ""); }).join(",");
    if (!force && sig === PRO.lastSig) return;
    PRO.lastSig = sig;

    var countEl = proEl("lr-pro-count");
    if (countEl) {
      countEl.textContent = total
        ? ("共 " + total + " 节 · 已完成 " + done + (ADAPTIVE && ADAPTIVE.source ? " · " + ADAPTIVE.source : ""))
        : "还没扫到视频";
    }

    proClear(host);
    var curRowEl = null;
    if (!shown.length) {
      var hasIndex = proCourseIndexPresent();
      host.appendChild(proMk("div", "lr-proempty", total
        ? "🎉 这一门课全部达标了（" + total + " 节）"
        : (hasIndex
          ? "正在自动采集视频列表…（没反应就点上面的「扫描」或「刷新列表」）"
          : "没扫到视频列表：回到课程页会自动采集；也可以点「扫描」或「刷新列表」")));
    } else {
      for (var k = 0; k < shown.length; k++) {
        var r = shown[k];
        var rowEl = proMk("div", "lr-prorow" + (r.isCur ? " lr-procur" : "") + (r.isDone ? " lr-prodone" : ""));
        rowEl.dataset.url = r.item.url;
        rowEl.title = r.item.name;
        rowEl.appendChild(proMk("span", "lr-pronum", r.i + 1));
        rowEl.appendChild(proMk("span", "lr-proname", r.item.name));
        var gauge = proMk("span", "lr-progauge");
        var fillEl = proMk("i");
        fillEl.style.width = (r.has ? r.pct.toFixed(0) : 0) + "%";
        gauge.appendChild(fillEl);
        rowEl.appendChild(gauge);
        // 取色（现场定死）：已完成→绿；**在看→黄百分比**；其余→百分比
        if (r.isDone) {
          rowEl.appendChild(proMk("span", "lr-protag", "已完成"));
        } else if (r.isCur) {
          rowEl.appendChild(proMk("span", "lr-protag lr-protag-cur", r.has ? r.pct.toFixed(0) + "%" : "在看"));
        } else {
          rowEl.appendChild(proMk("span", "lr-protag lr-protag-todo", r.has ? r.pct.toFixed(0) + "%" : "未看"));
        }
        host.appendChild(rowEl);
        if (r.isCur) curRowEl = rowEl;
      }
      // 现场要求："列表刷新之后把当前播放的视频滚动到居中"。
      // 为什么不能每次都滚：面板每秒都会渲染一次，无条件 scrollIntoView 会把用户
      // 正在翻的列表抢回来。所以只在**用户 4 秒内没自己滚过**、且当前项变化时才居中。
      if (curRowEl && !PRO.userScrolledRecently) {
        try { curRowEl.scrollIntoView({ block: "center" }); } catch (_) {}
      }
    }
  }

  // ---------------------------------------------------------------- 事件
  // ---------------------------------------------------------------- 弹窗里的输入
  // 面板与弹窗共用同一个处理（设置块会在两者之间搬来搬去，写两份必然漏一处）
  function proOnPanelInput(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.id === "lr-pro-opacity") {
      PRO.opacity = Math.max(0.35, Math.min(1, Number(t.value) / 100));
      var val = proEl("lr-pro-opval");
      if (val) val.textContent = Math.round(PRO.opacity * 100) + "%";
      proApplyOpacity();
      proSave();
      return;
    }
    if (t.id === "lr-pro-threshval") {
      proSetThresholdValue(t.value);          // 越界会被 _prefs-module 忽略，显示值再回写
    }
  }

  function proOnPanelClick(ev) {
    var t = ev.target;
    if (!t) return;
    var id = t.id || (t.closest ? (t.closest("[id]") || {}).id : "");
    var stop = function () { ev.stopPropagation(); ev.stopImmediatePropagation(); };

    // 原版「—」最小化（.lr-minbtn 但没有 id）：5.0 被我挡住了，5.2 恢复。
    // 必须在这里拦下来并显式调用基础的 toggleMinimize()，否则基础脚本那个监听器
    // 会被 5.0 留下的 stopImmediatePropagation 挡住（现场表现就是"点了没反应"）。
    if (t.classList && t.classList.contains("lr-minbtn") && !t.id) {
      stop();
      try { toggleMinimize(); } catch (_) {}
      return;
    }
    if (id === "lr-pro-mode-safe" || id === "lr-pro-mode-brute") {
      stop();
      PRO.tab = id === "lr-pro-mode-brute" ? "brute" : "list";
      proApply();
      proSave();
      log("切到「" + (PRO.tab === "brute" ? "⚡ 暴力模式" : "🛡 安全模式") + "」页");
      return;
    }
    if (id === "lr-pro-fold") {
      stop();
      PRO.listOpen = !PRO.listOpen;
      proApply();
      proSave();
      return;
    }
    if (id === "lr-pro-setbtn") {
      stop();
      if (PRO.dialogOpen) proCloseDialog(); else proOpenDialog();
      return;
    }
    if (id === "lr-pro-mute") {
      stop();
      PRO.autoMute = !PRO.autoMute;
      proApplyMute();
      proEnforceMute();
      proSave();
      log("自动静音：" + (PRO.autoMute ? "开" : "关"));
      return;
    }
    if (id === "lr-pro-dialogguard") {
      stop();
      proSetDialogGuard(!PRO.dialogGuard);      // dialogGuardSet 里已经写了日志
      return;
    }
    if (id === "lr-pro-autonext") { stop(); proToggleAutoNext(); return; }
    if (id === "lr-pro-threshon") { stop(); proToggleCustomThreshold(); return; }
    if (id === "lr-pro-brutelist") { stop(); proToggleBruteListRun(); return; }
    if (id === "lr-pro-logcount") { stop(); proLogToBottom(); return; }   // 点行数 = 跳到最新
    if (id === "lr-pro-emg") { stop(); proEmergencyStop(); return; }
    if (id === "lr-pro-podbtn") {
      stop();
      PRO.pod = true;
      proApplyPod();
      proPodText();
      proSave();
      log("面板已收起（点悬浮球还原）");
      return;
    }
    if (id === "lr-pro-reset") {
      stop();
      var ui = proEl("scnu-liruyun-helper");
      try {
        ui.style.left = ""; ui.style.top = ""; ui.style.right = ""; ui.style.bottom = "";
        ui.style.width = ""; ui.style.height = "";
        gmSet("scnu_liruyun_panel", null);
      } catch (_) {}
      log("面板已复位到默认位置/大小");
      return;
    }
    var proAct = t.dataset && t.dataset.proAction ? t.dataset.proAction
      : (t.closest && t.closest("[data-pro-action]") ? t.closest("[data-pro-action]").dataset.proAction : "");
    if (proAct === "todo") {
      stop();
      PRO.onlyTodo = !PRO.onlyTodo;
      proApply();
      proSave();
      return;
    }
    var row = t.closest ? t.closest(".lr-prorow") : null;
    if (row && row.dataset.url) {
      stop();
      try { goToResource(row.dataset.url); } catch (e) { log("跳转失败：" + ((e && e.message) || e)); }
      return;
    }
    // 播放按钮：暴力模式下先播放再开始发包（现场："点播放应该自动根据模式自动开始"）
    var action = t.dataset && t.dataset.action ? t.dataset.action
      : (t.closest && t.closest("[data-action]") ? t.closest("[data-action]").dataset.action : "");
    if (action === "nav" && PRO.tab === "brute") {
      stop();
      proEmergencyClear("点了播放");            // 急停之后点播放 = 明确要继续
      var wholeList = false;
      try { wholeList = prefBruteListRunOn(); } catch (_) {}
      try {
        if (typeof playOrReplay === "function") playOrReplay(true);
        setTimeout(function () {
          try {
            if (wholeList) {
              // v5.2 现场要求："是否继续按列表一键播放所有视频" —— 开着就一次刷完整门课
              if (typeof bruteStartBatch === "function" && !bruteBatchRunning) {
                log("开始按列表连播");
                bruteStartBatch();
              }
            } else if (!bruteActive) {
              bruteStart();
            }
          } catch (e) { log("自动开始暴力失败：" + ((e && e.message) || e)); }
        }, 800);
      } catch (e) { log("播放并开始暴力失败：" + ((e && e.message) || e)); }
      return;
    }
  }

  function proTick() {
    if (!PRO.built) { proBuild(); return; }
    proTrimLog();
    proEnforceMute();
    proApplyDialogGuard();     // 顺手刷一下"已挡下 N 个弹窗"的计数
    proApplyPrefs();           // 标签与存储对齐（只在真变了时才写 DOM）
    proApplyPod();             // 悬浮球的位置/显隐（用户可能刚拖过或刚收起来）
    proPodText();
    proRenderList();
  }

  // ---------------------------------------------------------------- 日志区高度（v5.4）
  // 现场："现在日志根本看不全，也没有滚轮了" + "主窗口的几大区域用户都应该能用鼠标调整才对"。
  // 事实是：日志框以前被固定成 110px，而内容又被裁到 5 行 —— 连滚动条都撑不出来。
  // 现在：内容写满（基础脚本侧改成最多 80 行）、框内滚动、**上面加一条可拖的分隔条**，
  // 拖出来的高度记在 PRO.logH 里（跨刷新保持）。
  // 分隔条：一条往上拖变大（日志）、一条往下拖变大（列表）—— 方向/上下限/落库都由 kind 决定。
  // 现场："播放列表和下面的参数设置之间不能用户自由调整大小，之前加入失败了吗"：
  // 是的，上一版只加了**日志**那一根，列表和模式页之间没有。现在两根都在。
  function proBindSplitter(split, target, kind) {
    if (!split || !target) return;
    var isLog = kind !== "list";
    var minPx = isLog ? 56 : 48;
    split.addEventListener("mousedown", function (ev) {
      try { ev.preventDefault(); } catch (_) {}
      var startY = ev.clientY;
      var startH = 150;
      try { startH = target.getBoundingClientRect().height || (isLog ? 150 : 240); } catch (_) {}
      var last = startH;
      var move = function (e) {
        var maxH = 600;
        try { maxH = Math.max(minPx + 40, Math.round((window.innerHeight || 900) * 0.7)); } catch (_) {}
        // 日志：往上拖变大；列表：往下拖变大
        var delta = isLog ? (startY - e.clientY) : (e.clientY - startY);
        var next = Math.round(Math.max(minPx, Math.min(maxH, startH + delta)));
        last = next;
        target.style.height = next + "px";
        target.style.minHeight = next + "px";
        target.style.maxHeight = next + "px";
        if (!isLog) target.style.flex = "0 0 auto";     // 列表要被固定住，否则 flex 会把它拉回去
      };
      var up = function () {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (isLog) {
          proSetLogH(last);
          log("日志区高度已设为 " + PRO.logH + "px（已记住）");
        } else {
          proSetListH(last);
          log("视频列表高度已设为 " + PRO.listH + "px（已记住）");
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  function proApplyLogH() {
    var logBox = proEl("lr-pro-logbox");
    if (!logBox) return;
    var h = Number(PRO.logH);
    if (!isFinite(h) || h <= 0) { logBox.style.height = ""; logBox.style.minHeight = ""; logBox.style.maxHeight = ""; return; }
    h = Math.round(Math.max(56, Math.min(600, h)));
    logBox.style.height = h + "px";
    logBox.style.minHeight = h + "px";
    logBox.style.maxHeight = h + "px";
  }
  function proSetLogH(px) {
    PRO.logH = Math.round(px);
    proApplyLogH();
    proSave();
    return PRO.logH;
  }

  // 列表区高度（v5.5）：>0 表示用户拖过，固定成这个高度；=0 表示跟着面板自动分配。
  function proApplyListH() {
    var listview = proEl("lr-pro-listwrap");
    if (!listview) return;
    var h = Number(PRO.listH);
    if (!isFinite(h) || h <= 0) {
      listview.style.height = "";
      listview.style.minHeight = "";
      listview.style.maxHeight = "";
      listview.style.flex = "";
      return;
    }
    h = Math.round(Math.max(48, Math.min(900, h)));
    listview.style.flex = "0 0 auto";
    listview.style.height = h + "px";
    listview.style.minHeight = h + "px";
    listview.style.maxHeight = h + "px";
  }
  function proSetListH(px) {
    PRO.listH = Math.round(px);
    proApplyListH();
    proSave();
    return PRO.listH;
  }

  // ---------------------------------------------------------------- 控制台 / 测试入口
  function proWhereLines() {
    var items = [
      ["定时暂停", "#lr-pro-set input[data-cfg='every']"],
      ["自动通过", "#lr-pro-set [data-action='auto']"],
      ["自动重播", "#lr-pro-set [data-action='replay']"],
      ["自动连播本页", "#lr-pro-set [data-action='start']"],
      ["只播这一节", "#lr-pro-set [data-action='current']"],
      ["透明度", "#lr-pro-prefs #lr-pro-opacity"],
      ["自动静音", "#lr-pro-prefs #lr-pro-mute"],
      ["弹窗拦截", "#lr-pro-prefs #lr-pro-dialogguard"],
      ["完成后是否下一节", "#lr-pro-prefs #lr-pro-autonext"],
      ["自定义达标进度", "#lr-pro-prefs #lr-pro-threshon"],
      ["暴力页连播", "#lr-pro-brutelist"],
      ["急停", "#lr-pro-emg"],
      ["悬浮球", "#lr-pro-pod"],
      ["模式按钮-安全", "#lr-pro-mode-safe"],
      ["模式按钮-暴力", "#lr-pro-mode-brute"],
      ["开始暴力", "#lr-pro-brute [data-action='brute-start']"],
      ["间隔", "#lr-pro-brute #lr-brute-interval"],
      ["发包进度", "#lr-pro-brute #lr-brute-line"],
      ["日志（面板内）", "#lr-pro-log .lr-log"],
      ["设置弹窗", "#lr-pro-dialog"],
      ["播放按钮", "#scnu-liruyun-helper [data-action='nav']"],
      ["列表", "#lr-pro-list"],
    ];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var label = items[i][0], sel = items[i][1], el = null;
      try { el = document.querySelector(sel); } catch (_) {}
      if (!el) { out.push("✘ " + label + "：找不到元素"); continue; }
      var where = "(常驻区)", n = el, hidden = "";
      while (n && n.nodeType === 1) {
        if (n.id === "lr-pro-dialog") where = "设置弹窗";
        else if (n.className && String(n.className).indexOf("lr-proset") >= 0) where = n.id || "(模式页)";
        var cs = null;
        try { cs = window.getComputedStyle ? window.getComputedStyle(n) : null; } catch (_) {}
        if (cs && cs.display === "none" && !hidden) hidden = (n.id || n.className || n.tagName);
        n = n.parentNode;
      }
      out.push((hidden ? "⚠ " : "✔ ") + label + " → " + where +
        (hidden ? "  被 " + hidden + " 藏住" : ""));
    }
    out.push("状态：" + (PRO.tab === "brute" ? "⚡暴力模式页" : "🛡安全模式页") +
      "，列表" + (PRO.listOpen ? "展开" : "收起") +
      "，设置弹窗" + (PRO.dialogOpen ? "打开" : "关闭") +
      "，自动静音" + (PRO.autoMute ? "开" : "关") +
      "，弹窗拦截" + (PRO.dialogGuard ? "开" : "关") +
      "，透明度" + Math.round(PRO.opacity * 100) + "%");
    var ui = proEl("scnu-liruyun-helper");
    out.push("面板 class：" + (ui ? ui.className : "(无)"));
    return out;
  }

  function proLayoutAudit() {
    var panel = proEl("scnu-liruyun-helper");
    var list = proEl("lr-pro-listwrap");
    var logBox = proEl("lr-pro-logbox");
    var dlg = proDialogEl();
    var rect = function (el) {
      try { var r = el.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); }
      catch (_) { return "?"; }
    };
    var out = [];
    out.push("面板 " + (panel ? rect(panel) : "(无)") +
      "，列表区 " + (list ? rect(list) : "(无)") +
      "，日志区 " + (logBox ? rect(logBox) : "(无)") +
      "，设置弹窗 " + (dlg ? (PRO.dialogOpen ? rect(dlg) : "已关闭") : "(无)"));
    out.push("列表行数 " + document.querySelectorAll("#scnu-liruyun-helper .lr-prorow").length +
      "，列表" + (PRO.listOpen ? "展开" : "收起"));
    return out;
  }

  function proDebugApi() {
    return {
      version: "1.0.1",
      state: function () {
        var ui = proEl("scnu-liruyun-helper");
        var logEl = document.querySelector("#lr-pro-log .lr-log");
        return {
          built: PRO.built, tab: PRO.tab, onlyTodo: PRO.onlyTodo,
          listOpen: PRO.listOpen, dialogOpen: PRO.dialogOpen,
          pod: PRO.pod, dlgPos: PRO.dlgPos, podPos: PRO.podPos, minimized: (function () {
            var u = proEl("scnu-liruyun-helper");
            return Boolean(u && String(u.className || "").indexOf("lr-min") >= 0);
          })(),
          prefs: (function () { try { return prefsDebugApi(); } catch (_) { return null; } })(),
          opacity: PRO.opacity, autoMute: PRO.autoMute, dialogGuard: PRO.dialogGuard,
          dialogStats: proDialogGuardStats(),
          muted: (function () {
            try { var v = document.querySelector("video"); return v ? Boolean(v.muted) : null; }
            catch (_) { return null; }
          })(),
          rows: document.querySelectorAll("#scnu-liruyun-helper .lr-prorow").length,
          logLines: logEl ? String(logEl.textContent).split("\n").filter(function (l) { return l.trim(); }).length : 0,
          count: (proEl("lr-pro-count") || {}).textContent || "",
          navLabel: (document.querySelector("#scnu-liruyun-helper [data-action='nav']") || {}).textContent || "",
          moves: PRO.moves.slice(),
          uiClass: ui ? ui.className : "",
        };
      },
      build: function () { return proBuild(); },
      brute: function (on) { PRO.tab = (on === undefined ? PRO.tab !== "brute" : Boolean(on)) ? "brute" : "list"; proApply(); proSave(); return PRO.tab; },
      list: function (on) { PRO.listOpen = on === undefined ? !PRO.listOpen : Boolean(on); proApply(); proSave(); return PRO.listOpen; },
      dialog: function (on) { if (on === undefined ? !PRO.dialogOpen : Boolean(on)) proOpenDialog(); else proCloseDialog(); return PRO.dialogOpen; },
      onlyTodo: function (on) { PRO.onlyTodo = on === undefined ? !PRO.onlyTodo : Boolean(on); proApply(); proSave(); return PRO.onlyTodo; },
      autoMute: function (on) {
        PRO.autoMute = on === undefined ? !PRO.autoMute : Boolean(on);
        proApplyMute();
        proEnforceMute();
        proSave();
        return PRO.autoMute;
      },
      opacity: function (v) {
        if (v === undefined) return PRO.opacity;
        PRO.opacity = Math.max(0.35, Math.min(1, Number(v) || 1));
        proApplyOpacity();
        proSave();
        return PRO.opacity;
      },
      // 弹窗拦截开关（真正的实现是 __liruyun.dialogGuard，这里只是面板那一颗按钮）
      dialogGuard: function (on) { return on === undefined ? PRO.dialogGuard : proSetDialogGuard(on); },
      // 区域高度（v5.4/v5.5）：logH()/listH() 读，传数字即设（等价于拖分隔条）
      logH: function (px) {
        if (px === undefined) return PRO.logH;
        return proSetLogH(Number(px));
      },
      listH: function (px) {
        if (px === undefined) return PRO.listH;
        return proSetListH(Number(px));
      },
      // ---- v5.2 ----
      // 悬浮球：pod(true) 收起面板只留圆球；pod(false) 还原
      pod: function (on) {
        PRO.pod = on === undefined ? !PRO.pod : Boolean(on);
        proApplyPod();
        proPodText();
        proSave();
        return PRO.pod;
      },
      // 最小化（原版那条标题栏）：min(true) 收成一条
      min: function (on) {
        try { toggleMinimize(on); } catch (_) {}
        return (proEl("scnu-liruyun-helper") || {}).className || "";
      },
      // 播放偏好：autoNext / threshold / useThreshold / bruteListRun / emergency
      prefs: function (next) {
        var out = null;
        try { out = prefsDebugApi(next); } catch (_) {}
        proApplyPrefs();
        proDialogNote();
        return out;
      },
      autoNext: function (on) { return on === undefined ? proToggleAutoNext() : (proToggleAutoNext(), prefAutoNextOn()); },
      threshold: function (v) {
        if (v === undefined) { try { return prefThresholdValue(); } catch (_) { return 85; } }
        return proSetThresholdValue(v);
      },
      useThreshold: function (on) {
        if (on !== undefined && Boolean(on) !== prefUseThreshold()) proToggleCustomThreshold();
        try { return prefUseThreshold(); } catch (_) { return false; }
      },
      bruteListRun: function (on) {
        if (on !== undefined && Boolean(on) !== prefBruteListRunOn()) proToggleBruteListRun();
        try { return prefBruteListRunOn(); } catch (_) { return false; }
      },
      // 急停：和面板上那颗按钮同一条路径（急停/解除都走它）
      emergency: function (on) {
        if (on === undefined) { try { return prefEmergencyOn(); } catch (_) { return false; } }
        if (Boolean(on)) { proEmergencyStop(); return true; }
        proEmergencyClear("控制台调用");
        return false;
      },
      // 设置弹窗的位置（调试用：dlgPos() 读，dlgPos({left,top}) 设）
      dlgPos: function (pos) {
        if (pos && isFinite(pos.left) && isFinite(pos.top)) {
          PRO.dlgPos = { left: Number(pos.left), top: Number(pos.top) };
          proSave();
        }
        var dlg = proDialogEl();
        if (dlg && PRO.dialogOpen) proPlaceDialog(dlg);
        return PRO.dlgPos;
      },
      rows: function () {
        return Array.prototype.map.call(document.querySelectorAll("#scnu-liruyun-helper .lr-prorow"),
          function (r) { return r.textContent; });
      },
      where: function () { return proWhereLines().join("\n"); },
      layout: function () { return proLayoutAudit().join("\n"); },
    };
  }


  // ==========================================================================
  //  暴力模式（新增模块，完全独立于安全模式）
  // ----------------------------------------------------------------------------
  //  设计约束：安全模式那套（队列连播 / 视频列表 / 定时暂停 / 学习确认自动通过 /
  //  停摆看护 / 冻帧看护 / 自动重播 / 进度落库）**一行都不改**。
  //  本模块只做三件事：
  //    1. 面板上多一个「⚡ 暴力模式」页签，点进去是独立的发包界面；
  //    2. 提供另一条"把进度做上去"的路径：直接 POST mod_fsresource_set_time；
  //    3. 与安全模式**互斥**：只有当前页签对应的模式会动作，另一个彻底不插手。
  //  两模式共用同一套读数（readProgress / readRequiredProgress / readCompletionStatus），
  //  因此"达标即停"对两边是同一判断，不会出现两套口径。
  // ==========================================================================

  // ---------------------------------------------------------- 暴力模式：配置
  var BRUTE_DEFAULTS = {
    // 与第三方原版一致：1000 次 / 10ms
    totalRequests: 1000,       // 手动模式的发包次数（开着自动适配时由时长反推，忽略此值）
    autoFit: true,             // 自动适配：按视频总时长反推发包次数（仅作起点估计）
    maxQueue: 5000,            // 单次点击最多发多少（队列预算，可按需调大；见"停滞即停"才是真刹车）
    stallPackets: 150,         // 连续这么多发进度一点没涨 → 判定卡住，停止
    // 适配目标默认 100%（刷满整段时长）：
    // 目标 <100 时只够把进度推到阈值附近，活动不一定被判完成 —— 那就得点第二次，
    // 与「一次点击就完成」的要求冲突。想省流量可以把它调小。
    fitTargetPercent: 100,
    intervalMs: 10,
    timePerRequest: 4,
    timeMode: "fixed",        // fixed=每次固定原版行为；cumulative=第 n 次上报 n×秒
    stopOnComplete: true,     // 达标/已完成即停（强烈建议保持）
    safetyLimit: 100000,       // 失控保护：只在明显异常时兜底，正常流程碰不到
                               // （真正决定何时停的是"进度到位"和"进度停滞"，不是这个数）
    keepPlaying: true,        // 发包同时让页面继续正常播放
    listMode: "queue",        // queue=课程页资源列表；range=ID 区间（不校验类型）
    startId: 0,
    endId: 0,
    step: 1,
    confirm: true,            // 启动前弹确认框
    batchDelayMs: 1500,
  };
  function mergeBrute(raw) {
    var out = {};
    for (var k in BRUTE_DEFAULTS) out[k] = BRUTE_DEFAULTS[k];
    if (raw && typeof raw === "object") for (var j in out) if (raw[j] !== undefined) out[j] = raw[j];
    return out;
  }

  // ---------------------------------------------------------- 暴力模式：状态
  var BRUTE = mergeBrute(gmGet("liruyun_brute_cfg", null));
  var bruteActive = false;
  var bruteTimer = 0;
  var bruteSent = 0;
  var bruteOk = 0;
  var bruteFail = 0;
  var bruteConsecutiveFails = 0;
  var bruteLastError = "";
  var bruteWarnedAt = 0;
  var bruteBatchRunning = false;
  var bruteBatchQueue = [];
  var bruteBatchIndex = 0;
  var bruteBatchDone = 0;
  var bruteBatchMode = "queue";
  var bruteAutoActive = false;     // 批量调度期间，别的动作不许把队列标志清掉
  // "暴力批量已启动"这个事实必须落到存储里：换页会重载脚本，内存标志会归零，
  // 只靠内存判断会导致跨页后不再接管（批量卡死在第一项）。
  var BRUTE_BATCH_KEY = "liruyun_brute_batch_armed";
  function bruteBatchArmed() { return gmGet(BRUTE_BATCH_KEY, false) === true; }
  function bruteSetBatchArmed(on) { gmSet(BRUTE_BATCH_KEY, Boolean(on)); }

  // ---------------------------------------------------------- 风险确认（v3.3）
  // 现场问题：按列表连播（或刷新页面）时，**每换一页都要再点一次**「确认启动暴力模式？」
  //（截图里那个框）。它本身必须留着 —— 这是唯一拦住"手滑点到暴力模式"的闸门；
  // 但重复问同一个问题只会让人闭眼点确定，反而更危险。
  //
  // 现场定的尺度（原话："确认记住变成当次会话内可以吗"）：**只记到本次会话**。
  //   · 同一次会话里（刷新页面、批量连播换页）不再重复问 —— 这些都在同一个标签页里；
  //   · 关掉标签页 / 重开浏览器 → 失效，下次启动重新问一遍。
  // 实现用 sessionStorage（它的生命周期正好是"这个标签页"），并留一个内存兜底：
  // 万一某些注入器不给 sessionStorage，最坏情况就是"换页后重新问一次" —— 偏安全的失败方向。
  var BRUTE_ACK_KEY = "liruyun_brute_ack";
  var BRUTE_ACKMODE_KEY = "liruyun_brute_ack_mode";
  var bruteAckMem = {};            // sessionStorage 不可用时的兜底（换页会丢，安全方向）

  function bruteSessionGet(key) {
    try {
      var w = PAGE || window;
      if (w && w.sessionStorage) return w.sessionStorage.getItem(key);
    } catch (_) {}
    try { if (typeof sessionStorage !== "undefined" && sessionStorage) return sessionStorage.getItem(key); } catch (_) {}
    return Object.prototype.hasOwnProperty.call(bruteAckMem, key) ? bruteAckMem[key] : null;
  }
  function bruteSessionSet(key, value) {
    bruteAckMem[key] = String(value);
    var wrote = false;
    try {
      var w = PAGE || window;
      if (w && w.sessionStorage) { w.sessionStorage.setItem(key, String(value)); wrote = true; }
    } catch (_) {}
    if (!wrote) {
      try { if (typeof sessionStorage !== "undefined" && sessionStorage) { sessionStorage.setItem(key, String(value)); wrote = true; } } catch (_) {}
    }
    return wrote;
  }

  // 本次会话是否已经确认过风险（sessionStorage 里有没有这条记录）
  function bruteAckFresh() { return bruteSessionGet(BRUTE_ACK_KEY) === "1"; }
  function bruteRememberAck() { bruteSessionSet(BRUTE_ACK_KEY, "1"); return true; }
  function bruteForgetAck() { bruteSessionSet(BRUTE_ACK_KEY, "0"); return true; }
  // "remember"（默认）= 确认一次，本次会话内不再问；"ask" = 每次都问
  function bruteAckMode() {
    var m = null;
    try { m = gmGet(BRUTE_ACKMODE_KEY, null); } catch (_) {}
    if (m === "ask" || m === "remember") return m;
    try { m = bruteSessionGet(BRUTE_ACKMODE_KEY); } catch (_) {}
    return m === "ask" ? "ask" : "remember";
  }
  function bruteSetAckMode(mode) {
    var m = mode === "ask" ? "ask" : "remember";
    try { gmSet(BRUTE_ACKMODE_KEY, m); } catch (_) {}
    bruteSessionSet(BRUTE_ACKMODE_KEY, m);
    if (m === "ask") bruteForgetAck();
    return m;
  }
  // 需要弹确认框吗：模式是"每次都问"，或者本次会话还没确认过
  function bruteShouldAskAck() {
    if (!BRUTE.confirm) return false;
    if (bruteAckMode() === "ask") return true;
    return !bruteAckFresh();
  }

  // 把"风险确认"那一行的文字刷成当前真实状态
  function bruteApplyAckRow() {
    var btn = bruteEls.ackmode;
    if (btn) {
      btn.textContent = "风险确认：" + (bruteAckMode() === "ask" ? "每次都问" : "本次会话内不再问");
      btn.className = bruteAckMode() === "ask" ? "" : "lr-on";
    }
    var hint = bruteEls.ackhint;
    if (hint) {
      if (!BRUTE.confirm) hint.textContent = "确认框已关闭";
      else if (bruteAckMode() === "ask") hint.textContent = "每次启动都会询问";
      else if (bruteAckFresh()) hint.textContent = "本次会话已确认（关掉标签页即失效）";
      else hint.textContent = "尚未确认（下次启动会问）";
    }
  }

  function bruteToggleAckMode() {
    var next = bruteAckMode() === "ask" ? "remember" : "ask";
    bruteSetAckMode(next);
    bruteApplyAckRow();
    if (next === "ask") log("风险确认：改回每次都问（已清除本次会话的确认）");
    else log("风险确认：确认一次后，本次会话内不再重复询问");
    return next;
  }
  var brutePayloadLogged = false;
  var bruteNativeFetch = null;
  var bruteHooksInstalled = false;
  var bruteServerState = null;     // 从接口响应里解析出的服务器确认进度
  var bruteProgressBase = null;    // 开工那一刻的进度基线，用于判断"进度到底动没动"
  var bruteStartupCompleted = false;  // 开工前页面是否就已经标着"已完成"
  var bruteStopWhy = "";           // 最近一次停止的原因（面板与诊断都要显示）
  var bruteExtraGranted = 0;       // 兼容旧字段
  var bruteStallFromSent = 0;      // 停滞检测：当前窗口从第几发开始
  var bruteStallPrevPct = null;    // 停滞检测：窗口起点时的进度
  var bruteStallBaselineChecked = false;
  var bruteCapNudged = false;      // 撞硬上限前是否已经"催"过一次页面读数（v3.3，只催一次）
  var BRUTE_EXTRA_MAX = 20000;     // 兼容旧字段
  var BRUTE_QUEUE_MAX = 200000;    // 队列预算的绝对上限（界面可调，但不许超过它）
  var bruteExchanges = [];         // 最近若干次"我们发了什么 / 服务器回了什么"原文（诊断用）
  var bruteLastBody = "";          // 最近一次实际发出的请求体
  var BRUTE_EXCHANGE_KEEP = 3;
  var bruteLineLastAt = 0;
  var MODE_KEY = "liruyun_ui_mode";
  var uiMode = gmGet(MODE_KEY, "safe");   // "safe" | "brute"
  var BRUTE_SAFETY_MAX = 200000;
  // 连续失败几次就停：接口一直报错时，再刷 1000 次也只会得到 1000 个同样的错误，
  // 既没用又容易被判成异常流量。现场实测 3 次足够判断"这条路当前走不通"。
  var BRUTE_MAX_CONSECUTIVE_FAILS = 3;
  var BRUTE_SERVICE_PATH = "/lib/ajax/service.php";
  // 必须在这里定义：这个常量是从上一版脚本改名带过来的，原版脚本里并没有它。
  // 漏定义时每一次发送都在最外层抛 ReferenceError（被 .catch 吞掉），
  // 表现就是"点了开始、进度一动不动、却还报已完成"。
  var SET_TIME_METHOD = "mod_fsresource_set_time";
  // 版本号：防重入判定用它区分"同一实例重复注入"和"更新后重新注入"。
  // v3 与已发布的 v2.0.12 同页共存时，靠它判定"谁接管"（见 bruteShouldYieldToExisting）。
  //
  // 这个模块同时被 v3（纯逻辑版）和正式版（带面板）使用，两条版本线现在分开了：
  //   · 纯逻辑版 LiRuYun-v3.user.js ：沿用逻辑迭代线，当前 3.4.0 —— 就是下面写的这个值。
  //   · 正式版 LiRuYun-CoursePlayer.user.js：走发布线 1.0.1，由 tools/create-v3pro.mjs 在生成时
  //     把下面这一行替换掉（两处必须一起改，否则防重入会认错版本）。
  // 历次逻辑线版本：
  // 3.1.0：新增「站点原生弹窗自动确定」（tools/_dialog-guard-module.js）。
  // 3.2.0：新增「播放偏好 + 急停」（tools/_prefs-module.js）。
  // 3.3.0：日志防刷屏（同内容折叠）+ 关不掉的站点提示条不再重复清理。
  // 3.4.0：日志写满（最多 80 行、框内滚动）；偏好设置常驻设置窗口；主面板加可拖分隔条。
  // 1.0.0：正式版定版（原 v3pro 5.5.0）。逻辑与 3.4.0 完全一致，只是从此有正式名字与版本号。
  // 1.0.1：界面文案清理（发包参数标题不再提"比原版保守"）；仓库只保留这一个安装文件。
  var SCRIPT_VERSION = "1.0.1";
  // 本份构建带不带面板重排层（pro）？
  //   · 纯逻辑版 LiRuYun-v3.user.js       → false（这个模块里的原值）
  //   · 正式版   LiRuYun-CoursePlayer.user.js     → 由 tools/create-v3pro.mjs 在生成时改成 true
  // 用途只有一个：同页共存时判定"谁该让位"（见 bruteShouldYieldToExisting 的 A/B 两条）。
  var IS_PANEL_BUILD = true;

  function saveBrute() { gmSet("liruyun_brute_cfg", BRUTE); }
  // 和别的版本同页共存时把话说清楚。
  // 为什么放在这里（模块最前面）：后面马上就会调 bruteShouldYieldToExisting()，
  // 一旦让位就 return 了 —— 放在"注入横幅"那一段的话，最需要这条提示的场景
  // （旧版还在跑）恰好永远打不出来。
  function bruteAnnounceCoexistence() {
    try {
      var other = PAGE.__liruyunBruteLoaded;
      if (!other || !other.version || other.version === SCRIPT_VERSION) return;
      var myMajor = String(SCRIPT_VERSION).split(".")[0];
      var otherMajor = String(other.version).split(".")[0];
      // 先把"谁让位"说清楚：带面板的正式版 > 纯逻辑版 > （两者之上再看版本号大小）。
      // 这一段以前只按版本号的主版本号猜，而发布线（1.0.0）与逻辑线（3.4.0）主版本号天然不同，
      // 于是"纯逻辑版 vs 正式版"会被错报成"两者会各自建一个面板"（实际是让位关系）。
      var willYield = Boolean(other.panel) && !IS_PANEL_BUILD;
      var willTakeOver = IS_PANEL_BUILD && !other.panel;
      console.warn(TAG, "检测到另一个版本的脚本也在本页运行（v" + other.version +
        (other.panel ? " · 面板版" : " · 纯逻辑版") + "）；" +
        (willYield
          ? "本版本会让位，避免两个面板互相抢播放器。"
          : (willTakeOver || myMajor === otherMajor)
            ? "本版本会接管本页，建议在 Tampermonkey 里只留一个。"
            : "两者会各自建一个面板、互相抢播放器 —— 请到 Tampermonkey 里停用它，只留 v" + SCRIPT_VERSION + "。"));
      console.warn(TAG, "停用旧版：Tampermonkey 管理面板 → 找到旧版脚本 → 关掉开关（不用删除，随时能开回来）");
    } catch (_) {}
  }
  bruteAnnounceCoexistence();
  function isResourcePage() {
    return RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; });
  }
  function isFsresourcePage() { return location.href.indexOf("/mod/fsresource/view.php") >= 0; }
  function bruteClamp(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) n = fallback;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }
  function bruteSafeJson(value) {
    try {
      var text = typeof value === "string" ? value : JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (_) { return "(无法序列化)"; }
  }

  // ---------------------------------------------------------- 暴力模式：读数
  // 服务器确认的进度优先（比页面 DOM 早），拿不到再用页面读数
  function bruteProgress() {
    var s = bruteServerState && (Date.now() - bruteServerState.at < 30000) ? bruteServerState.percent : null;
    var d = readProgress();
    if (s !== null && s !== undefined) return s;
    return d;
  }
  // 只看**接口**确认的完成，不看页面文本。
  // 页面文本另有用途（判断"这节本来就已经完成"），但那是"提示"，不是"我们刷成功了"。
  function bruteCompleted() {
    return Boolean(bruteServerState && (Date.now() - bruteServerState.at < 60000) && bruteServerState.completed);
  }

  // 判"页面完成标记"时只认**肯定**的措辞。
  // 为什么不沿用 readCompletionStatus()：它把 compact 里出现"完成"这种宽泛匹配也算完成，
  // 而 Moodle 的 [data-region='completion-info'] 区块经常整段带上"已完成/完成此活动以满足"
  // 之类的字样 —— 结果**一发包都没发就宣布"已达标"并自停**（线上实测就是这个症状）。
  function brutePageSaysCompleted() {
    var positive = ["已完成", "已达成", "完成状态：完成", "完成状态:完成"];
    for (var i = 0; i < COMPLETION_STATUS_SELECTORS.length; i++) {
      var nodes = document.querySelectorAll(COMPLETION_STATUS_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var text = (nodes[j].textContent || "").replace(/\s+/g, "");
        if (!text) continue;
        if (text.indexOf("未完成") >= 0 || text.indexOf("未达到") >= 0 || text.indexOf("notcompleted") >= 0) continue;
        for (var k = 0; k < positive.length; k++) if (text.indexOf(positive[k]) >= 0) return true;
        if (text.toLowerCase().indexOf("completed") >= 0 && text.toLowerCase().indexOf("notcompleted") < 0) return true;
      }
    }
    return false;
  }

  // 进度是否**真的动了**（相对开工时的基线）。
  // 为什么需要它：只有当进度确实往前走，才谈得上"是我们刷上去的"；
  // 否则一个本来就完成的页面会让暴力模式白刷几百发，还报告"✓ 已达标"。
  function bruteProgressMoved() {
    var p = bruteProgress();
    if (p === null) return false;
    if (bruteProgressBase === null) return false;
    return p > bruteProgressBase + 0.05;
  }

  // 停止判定。
  // 设计取向（按现场反馈：要像原版一样直接刷）：
  //   · 主要目标是把配置的发包次数发完 —— 次数上限是节奏控制，不是「够了就省着点」；
  //   · 只有两件事值得提前收手：接口明确说已完成、或进度已远超阈值；
  //   · 不再用「页面开工前就标着完成」这种猜测提前退出 —— 实测它会误判成已刷完，
  //     导致发 9 包就停、几乎没效果。
  // 多发几包不会刷爆进度：服务器按视频总时长封顶（现场响应里的 progress/totaltime 都是它算的），
  // 所以「发满次数」本身是安全的。
  // 单次点击的"队列预算"。
  // 为什么不再是"按时长推算 ×4"那种硬上限：
  //   · 推算依赖服务器的 totaltime，而它和真实时长并不一致（实测 741/1029s vs 2298s），
  //     算出来的上限可能正好卡在"差一点就到位"的位置 —— 那反而要用户再点一次；
  //   · 真正该刹车的信号不是"发了多少发"，而是"发了这么多，进度一点没动"。
  //     → 停滞检测见 bruteTick 里的 stall 判断。
  // 所以这里只留一个足够宽松的预算（默认 5000 发 ≈ 5.5 小时视频量），可按需调大。
  function bruteHardCap() {
    var budget = Math.max(1, Math.min(BRUTE_QUEUE_MAX, BRUTE.maxQueue || BRUTE_QUEUE_MAX));
    // 手填次数若比预算大，也要尊重（有人就想发更多）
    if (!BRUTE.autoFit) budget = Math.max(budget, BRUTE.totalRequests);
    return budget;
  }

  function bruteOvershootLimit() {
    var required = readRequiredProgress();
    return Math.min(100, required + 5);   // 超出阈值 5 个百分点就不再发
  }
  // 统一的"该停了吗"判定：tick 里调，**响应回来后也立刻调**。
  // 为什么必须在响应回调里也调：停止判断原本只在发包 tick 里做，而 tick 间隔只有 10ms、
  // 服务器响应更慢 —— 于是"进度已经到位"这个事实要等下一个 tick 才被看到，
  // 现场表现为"达标之后还继续发一会儿才停"。
  function bruteStopReason() {
    var required = readRequiredProgress();
    var p = bruteProgress();
    if (bruteOk >= 1 && p !== null && p >= bruteOvershootLimit()) {
      return { stop: true, ok: true, why: "进度 " + p.toFixed(1) + "% 已超过阈值 " + required + "%（+5% 余量）" };
    }
    if (bruteOk >= 1 && bruteCompleted()) {
      return { stop: true, ok: true, why: "接口明确返回已完成" };
    }
    return { stop: false, ok: false, why: "" };
  }
  function bruteSourceName() {
    var s = bruteServerState && (Date.now() - bruteServerState.at < 30000) ? bruteServerState.percent : null;
    if (s !== null && s !== undefined) return "接口";
    if (readProgress() !== null) return "页面";
    return "无";
  }

  // ---------------------------------------------------------- 接口响应嗅探
  // 为什么必须做：只知道自己"发了多少包"，就永远不知道"够了没有"，只能盲刷到次数上限。
  // 注意两个实测坑：
  //   1. 方法名在**请求体**里，URL 上只有 timestamp/sesskey —— 只按 URL 匹配钩子永不触发；
  //   2. res.clone() 在某些响应包装上不存在 —— 只写 clone() 会静默失败，同样读不到进度。
  function bruteExtractState(payload) {
    var out = { percent: null, completed: false, percentKey: "", totaltime: null, raw: payload };
    var percentKeys = ["progress", "percentage", "bfjd", "percent", "viewed", "watched", "progresspercent"];
    // 视频总时长（秒）：服务器自己记的观看时长，用来反推"要发多少包"最准
    var totalKeys = ["totaltime", "total_time", "duration", "videotime", "totalsecs"];
    // 这些键是"状态/标志位"，里面的数字（0/1/2/-1）绝不能被当成百分比
    // 只认"完成"语义的字段。**不要**把 status / state 放进来 ——
    // 服务器返回里的 status:true 只是"请求成功"，把它当完成会误判成已刷完。
    // 现场实测的响应结构：
    //   {"status":true,"warnings":[...],"progress":"75.2","totaltime":"785","completion":"未完成"}
    var flagKeys = ["completed", "complete", "finish", "finished", "completionstate",
      "completionstatus", "iscompleted", "completion", "done"];
    // "完成"这件事只认这个字段
    var completionKeys = ["completion", "completionstatus", "completionstate"];

    function toPercent(value) {
      if (typeof value === "number" && isFinite(value)) {
        if (value === -1) return null;
        return value >= 0 && value <= 100 ? value : null;
      }
      if (typeof value === "string") {
        // 接口返回的 progress 是字符串形式（"75.2"），不带百分号 —— 必须认
        var t = value.trim();
        if (/^\d+(?:\.\d+)?$/.test(t)) {
          var n0 = parseFloat(t);
          return n0 >= 0 && n0 <= 100 ? n0 : null;
        }
        var m = t.match(/(\d+(?:\.\d+)?)\s*%/);
        if (m) {
          var n = parseFloat(m[1]);
          return n >= 0 && n <= 100 ? n : null;
        }
      }
      return null;
    }
    function flagOf(value) {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value === 1 || value === 2;
      if (typeof value === "string") {
        var low = value.toLowerCase().trim();
        if (low === "true" || low === "1" || low === "completed" || low === "complete" || low === "finished") return true;
        if (low.indexOf("已完成") >= 0) return true;
      }
      return false;
    }
    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 6) return;
      for (var key in node) {
        var lower = String(key).toLowerCase();
        var value = node[key];
        if (value && typeof value === "object") { visit(value, depth + 1); continue; }
        if (completionKeys.indexOf(lower) >= 0) {
          // 只在真正的完成字段上判断；"未完成"/"进行中"/空 都算未完成
          if (!out.completed && flagOf(value)) out.completed = true;
          out.completionRaw = typeof value === "string" ? value : (value ? String(value) : "");
          continue;
        }
        if (lower === "completed" || lower === "iscompleted") {
          if (!out.completed && flagOf(value)) out.completed = true;
          continue;
        }
        if (out.percent === null && percentKeys.indexOf(lower) >= 0) {
          var p = toPercent(value);
          if (p !== null) { out.percent = p; out.percentKey = String(key); }
          continue;
        }
        if (out.totaltime === null && totalKeys.indexOf(lower) >= 0) {
          var secs = parseFloat(String(value));
          if (isFinite(secs) && secs > 0) out.totaltime = secs;
        }
      }
    }
    visit(payload, 0);

    // 兜底：小对象里除标志位外只有一个 0~100 的数，多半就是进度
    if (out.percent === null && payload && typeof payload === "object" && !Array.isArray(payload)) {
      var keys = Object.keys(payload).filter(function (k) { return flagKeys.indexOf(String(k).toLowerCase()) < 0; });
      if (keys.length > 0 && keys.length <= 4) {
        for (var i = 0; i < keys.length; i++) {
          if (percentKeys.indexOf(String(keys[i]).toLowerCase()) >= 0) continue;
          var raw = payload[keys[i]];
          if (typeof raw === "number" && raw >= 0 && raw <= 100) { out.percent = raw; out.percentKey = String(keys[i]) + "(兜底)"; break; }
        }
      }
    }
    return out;
  }

  function bruteApplyPayload(payload, note) {
    var parsed = bruteExtractState(payload);
    parsed.at = Date.now();
    bruteServerState = parsed;
    log("服务器返回（" + note + "）：" + (parsed.percent === null ? "未识别到进度字段" : parsed.percent.toFixed(1) + "%") +
      (parsed.completed ? " · 已完成" : "") +
      (parsed.percent === null && !brutePayloadLogged ? " ｜ 样本：" + bruteSafeJson(payload).slice(0, 200) : ""));
    if (parsed.percent === null) brutePayloadLogged = true;
  }

  // 记下"请求体 + 响应原文"，供诊断输出。
  // 现场排查"接口一直报错"时，光有错误文案不够 —— 必须看到我们发出去的原样，
  // 才能判断是哪个参数不对。
  function bruteRemember(url, body, text) {
    try {
      bruteExchanges.push({
        at: new Date().toLocaleTimeString(),
        url: String(url).replace(/sesskey=[^&]*/i, "sesskey=***"),
        body: String(body || "").slice(0, 400),
        text: String(text || "").slice(0, 600),
      });
      if (bruteExchanges.length > BRUTE_EXCHANGE_KEEP) bruteExchanges.shift();
    } catch (_) {}
  }

  function bruteCapture(url, text, body) {
    // 只认"进度上报"这条接口：页面自己的 ajax（例如 course 状态轮询）也走 service.php，
    // 把它的响应当成进度来读会污染读数（现场日志里就看到过 course 状态被当样本打印）。
    if (String(body || "").indexOf(SET_TIME_METHOD) < 0) return;
    if (!url && !text) return;
    var payload = null;
    try { payload = JSON.parse(text); } catch (_) { return; }
    if (Array.isArray(payload) && payload.length && payload[0] && typeof payload[0] === "object") {
      if (payload[0].error) {
        var msg = (payload[0].exception && payload[0].exception.message) || "未知错误";
        log("接口返回错误：" + msg);
        bruteLastError = msg;
        return;
      }
      if (payload[0].data !== undefined) payload = payload[0].data;
    }
    if (payload && !Array.isArray(payload) && payload.data && typeof payload.data === "object") payload = payload.data;
    bruteApplyPayload(payload, "set_time");
  }

  function bruteInstallHooks() {
    if (bruteHooksInstalled) return;
    bruteHooksInstalled = true;
    var page = PAGE;

    if (typeof page.fetch === "function" && !page.fetch.__liruyunBrute) {
      var nativeFetch = page.fetch;
      bruteNativeFetch = nativeFetch;
      var wrapped = function (input, init) {
        var url = "";
        try { url = typeof input === "string" ? input : (input && input.url) || ""; } catch (_) {}
        var promise = nativeFetch.apply(this, arguments);
        var bodyText = "";
        try { bodyText = (init && typeof init.body === "string") ? init.body : ""; } catch (_) {}
        var interesting = url.indexOf(BRUTE_SERVICE_PATH) >= 0 || bodyText.indexOf(SET_TIME_METHOD) >= 0;
        if (interesting) {
          try {
            promise.then(function (res) {
              var source = res;
              var cloned = false;
              try {
                if (res && typeof res.clone === "function") { source = res.clone(); cloned = true; }
              } catch (_) {}
              if (source && typeof source.text === "function") {
                try {
                  var read = source.text();
                  if (read && typeof read.then === "function") {
                    read.then(function (text) {
                      bruteRemember(url, bodyText, text);
                      bruteCapture(url, text, bodyText);
                    })["catch"](function () {});
                  } else if (typeof read === "string") {
                    bruteRemember(url, bodyText, read);
                    bruteCapture(url, read, bodyText);
                  }
                } catch (e) {
                  if (!cloned) log("响应读取失败（该响应不支持重读）：" + ((e && e.message) || e));
                }
              }
              return res;
            })["catch"](function () {});
          } catch (_) {}
        }
        return promise;
      };
      wrapped.__liruyunBrute = true;
      try { page.fetch = wrapped; } catch (_) {}
    }

    try {
      var proto = page.XMLHttpRequest && page.XMLHttpRequest.prototype;
      if (proto && !proto.__liruyunBrute) {
        var nativeSend = proto.send;
        var nativeOpen = proto.open;
        proto.open = function (method, url) {
          try { this.__liruyunUrl = url; } catch (_) {}
          return nativeOpen.apply(this, arguments);
        };
        proto.send = function (body) {
          try {
            var self = this;
            var url = self.__liruyunUrl || "";
            var bodyText = typeof body === "string" ? body : "";
            if (url.indexOf(BRUTE_SERVICE_PATH) >= 0 || bodyText.indexOf(SET_TIME_METHOD) >= 0) {
              self.addEventListener("load", function () {
                try {
                  var text = self.responseText;
                  if (typeof text === "string" && text) bruteCapture(url, text, bodyText);
                } catch (_) {}
              });
            }
          } catch (_) {}
          return nativeSend.apply(this, arguments);
        };
        proto.__liruyunBrute = true;
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------- 发包本体
  function brutePlayerData() { try { return PAGE.playerdata || null; } catch (_) { return null; } }

  function bruteServiceUrl() {
    var pd = brutePlayerData();
    var siteUrl = (pd && pd.siteUrl) || "";
    var sesskey = (pd && pd.sesskey) || "";
    if (!siteUrl) {
      try { siteUrl = (PAGE.M && PAGE.M.cfg && PAGE.M.cfg.wwwroot) || location.origin; } catch (_) { siteUrl = location.origin; }
    }
    if (!sesskey) {
      try { sesskey = (PAGE.M && PAGE.M.cfg && PAGE.M.cfg.sesskey) || ""; } catch (_) {}
    }
    // 方法名同时写进 URL 和 body：service.php 两种都能路由，多写一份便于排查
    return siteUrl.replace(/\/$/, "") + BRUTE_SERVICE_PATH +
      "?timestamp=" + Date.now() +
      "&sesskey=" + encodeURIComponent(sesskey) +
      "&methodname=" + encodeURIComponent(SET_TIME_METHOD);
  }

  function bruteTimeValue() {
    if (BRUTE.timeMode === "cumulative") return Math.max(1, BRUTE.timePerRequest * Math.max(1, bruteSent + 1));
    return BRUTE.timePerRequest;
  }
  function bruteWatchedSeconds() {
    var per = BRUTE.timePerRequest;
    var n = bruteSent;
    if (BRUTE.timeMode === "cumulative") return (per * n * (n + 1)) / 2;
    return per * n;
  }

  function bruteSend() {
    var pd = brutePlayerData();
    var urlId = currentResourceId();
    // fsresourceid 必须优先取 playerdata.fsresourceid —— 这是原始脚本的做法，也是接口要的那个编号。
    // URL 里的 id 是"活动在课程里的位置编号"，两者不是一回事：
    // 我先前把 URL 的 id 放在前面，服务器每次都回「在数据库中找不到数据记录」，
    // 就是这个优先级搞反导致的。
    var fsid = (pd && pd.fsresourceid !== undefined && pd.fsresourceid !== null && pd.fsresourceid !== "")
      ? pd.fsresourceid
      : (urlId ? Number(urlId) : "");
    if (fsid === "" || fsid === undefined || fsid === null) {
      return Promise.resolve({ ok: false, reason: "拿不到 fsresourceid（playerdata 与 URL 都没有）" });
    }
    var args = {
      fsresourceid: Number(fsid),
      time: bruteTimeValue(),
      finish: 0,
      progress: 0,
      unique: Date.now() + "_" + Math.random(),
    };
    var body = JSON.stringify([{ index: 0, methodname: SET_TIME_METHOD, args: args }]);
    bruteLastBody = body;
    var url = bruteServiceUrl();

    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (result) { if (!settled) { settled = true; resolve(result); } };
      try {
        PAGE.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          credentials: "same-origin",
        }).then(function (res) {
          return res.text().then(function (text) {
            var payload = null;
            try { payload = JSON.parse(text); } catch (_) {}
            var err = payload && payload[0] && payload[0].error ? payload[0] : null;
            if (err) {
              var msg = (err.exception && err.exception.message) || "接口错误";
              bruteLastError = msg;
              bruteRemember(url, body, text);      // 失败也留证据
              finish({ ok: false, reason: msg });
              return;
            }
            if (!bruteExchanges.length) bruteRemember(url, body, text);
            finish({ ok: true });
          });
        })["catch"](function (e) {
          finish({ ok: false, reason: (e && e.message) || "网络错误" });
        });
      } catch (e) {
        finish({ ok: false, reason: (e && e.message) || "发送异常" });
      }
    });
  }

  // ---------------------------------------------------------- 安全模式的"能不能跳到下一节"
  // 这是安全模式与暴力模式**共用**的判定，放在这里是为了保证两个模式口径一致。
  //
  // 原版的推进条件是 `current >= required || readCompletionStatus()`，第二个条件太宽：
  // readCompletionStatus 只要在完成区域文本里看到"已完成"就返回 true，而 Moodle 的
  // [data-region='completion-info'] 经常整段包含"完成此活动以满足以下条件…"这类字样
  // —— 于是"没看完就跳到下一个"。现场反馈的正是这个症状。
  //
  // 现在的规则（宁可多看一会儿，也不许跳课）：
  //   1. 进度读数到了阈值 → 推进（这是唯一"确定看完了"的证据）；
  //   2. 进度**完全读不到**时才退回用完成标记，而且只认严格措辞；
  //   3. 其它情况一律不动，把"进度 X% / 阈值 Y%"摆在状态行上，让人看得到在等什么。
  function safeProgressTargetMet(current, required) {
    return current !== null && current !== undefined && current >= required;
  }

  function safeCanAdvance(current, required) {
    if (safeProgressTargetMet(current, required)) {
      return { advance: true, why: "进度 " + current.toFixed(1) + "% ≥ 阈值 " + required + "%" };
    }
    if (current === null) {
      if (brutePageSaysCompleted()) return { advance: true, why: "读不到进度，但页面明确标记为已完成" };
      return { advance: false, why: "读不到进度且未确认完成" };
    }
    return { advance: false, why: "进度 " + current.toFixed(1) + "% < 阈值 " + required + "%" };
  }

  // ---------------------------------------------------------- 防重入（严格版）
  // 同页被注入两次时要避免"两个实例互相覆盖钩子"，但**不能**因为一个残留标记就静默退出
  // —— 那会让用户看到"脚本装了、界面没了"。
  // 规则（按优先级）：
  //   1. 页面上活着一个**比我新**的同族实例（3.1.0 对 3.0.0）→ 让位。
  //      以前这里只比"版本是否相等"，于是装了新版又忘了关旧版时，两边都判定
  //      "版本不同，我接管"，结果**各建一个面板、互相抢播放器**（现场真的这样）。
  //   2. 版本相同 → 看它自己报的面板健不健康：健康就让位，异常才接管并自救。
  //   3. 比我旧 → 接管（这是升级路径，必须走）。
  //
  // 例外（1.0.0 引入，见下面 B）：**同一份源码的两种构建**版本号已经不在同一条线上 ——
  //   带面板的正式版走发布线（1.0.0），纯逻辑版走逻辑线（3.4.0）。
  //   按上面第 3 条，纯逻辑版会把"发布线版本号更小"读成"对方是旧版"，于是接管、各建一个面板。
  //   所以同页共存判定不能只看版本号大小，还要看"谁带面板"（marker.panel）。
  function bruteVersionOf(v) {
    var m = String(v || "").match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? (Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3])) : -1;
  }
  function bruteShouldYieldToExisting() {
    var marker = null;
    try { marker = PAGE.__liruyunBruteLoaded; } catch (_) { return false; }
    if (!marker) return false;
    // A. 对方带面板（正式版），本份不带 → 让位。
    //    两种情况都走这里：对方是更新版本（旧版忘了关），或对方是同号但更完整的构建。
    if (marker.panel && !IS_PANEL_BUILD) {
      try {
        console.warn(TAG, "检测到带面板的版本（v" + marker.version +
          "）在本页运行，本版本（无面板构建 v" + SCRIPT_VERSION + "）让位。");
      } catch (_) {}
      return true;
    }
    // B. 本份带面板、对方不带 → 接管。
    //    v3 是 3.4.0 而发布线是 1.0.x，按版本大小会被判成"对方更新"而错误让位 —— 显式挡掉。
    if (IS_PANEL_BUILD && !marker.panel) {
      try {
        console.warn(TAG, "检测到同一脚本的无面板构建（v" + marker.version +
          "）在本页运行，本版本接管（带面板的优先）。");
      } catch (_) {}
      return false;
    }
    var mine = bruteVersionOf(SCRIPT_VERSION);
    var theirs = bruteVersionOf(marker.version);
    if (theirs >= 0 && mine >= 0 && theirs > mine) {
      try {
        console.warn(TAG, "检测到更新的实例（v" + marker.version + " ≥ 本版本 v" + SCRIPT_VERSION +
          "），本版本让位，避免两个面板互相抢播放器");
      } catch (_) {}
      return true;
    }
    if (!marker.version || marker.version !== SCRIPT_VERSION) {
      // 版本更旧（或读不到版本）→ 本版本接管（升级路径）
      try { console.warn(TAG, "检测到旧实例（" + (marker.version || "未知版本") + "），本版本接管"); } catch (_) {}
      return false;
    }
    var alive = PAGE.__liruyun && typeof PAGE.__liruyun.snapshot === "function";
    if (!alive) return false;
    try {
      var panel = PAGE.__liruyun.bruteApi && PAGE.__liruyun.bruteApi().panel
        ? PAGE.__liruyun.bruteApi().panel() : null;
      if (panel && panel.exists && !panel.problems.length) {
        try { console.warn(TAG, "同版本实例已在本页正常运行，忽略这次重复注入"); } catch (_) {}
        return true;
      }
    } catch (_) {}
    try { console.warn(TAG, "上一个实例存在但面板异常，本版本接管并自救"); } catch (_) {}
    return false;
  }

  // ---------------------------------------------------------- 面板可见性自检与自救
  // 现场出现过"脚本装了但界面没了"。真实原因可能是：面板被存到了屏幕外、
  // 被别的元素/样式盖住、CSS 没生效（display/flex 失效会把面板压成 0 高度）。
  // 这里做一次体检，并把能自动修的都修掉；修不了的（比如被别的脚本的面板压着）
  // 就打印出可复制的诊断，让人一眼看到问题在哪。
  function brutePanelDiag() {
    var panel = document.getElementById("scnu-liruyun-helper");
    if (!panel) {
      return { exists: false, text: "面板不存在：脚本可能没注入、或 installUi 抛错了" };
    }
    var rect = panel.getBoundingClientRect();
    var style = window.getComputedStyle ? window.getComputedStyle(panel) : {};
    var info = {
      exists: true,
      position: style.position || "(读不到)",
      display: style.display || "(读不到)",
      visibility: style.visibility || "(读不到)",
      zIndex: style.zIndex || "(读不到)",
      inlineLeft: panel.style.left || "(无)",
      inlineTop: panel.style.top || "(无)",
      inlineRight: panel.style.right || "(无)",
      inlineBottom: panel.style.bottom || "(无)",
      size: Math.round(rect.width) + "x" + Math.round(rect.height),
      at: Math.round(rect.left) + "," + Math.round(rect.top),
      viewport: window.innerWidth + "x" + window.innerHeight,
      minimized: panel.classList.contains("lr-min"),
      buttons: panel.querySelectorAll("button").length,
      styles: document.querySelectorAll("style[data-liruyun]").length,
    };
    var problems = [];
    // v5.2：pro 层主动收起时（悬浮球 / 最小化）面板本来就是 0x0、就是 0,0，
    // 这几条全都不是故障 —— 一起放过，否则自检会把用户刚收起的面板又拉出来。
    var proIntentional = false;
    try { proIntentional = proPanelStateIntentional(info); } catch (_) { proIntentional = false; }
    if (!proIntentional) {
      if (rect.width < 40 || rect.height < 10) problems.push("尺寸塌陷（CSS 可能没生效）");
      if (style.display === "none") problems.push("display:none");
      if (style.visibility === "hidden") problems.push("visibility:hidden");
      if (rect.left < -rect.width + 20 || rect.left > window.innerWidth - 20) problems.push("被存到了屏幕外（水平）");
      if (rect.top < -rect.height + 20 || rect.top > window.innerHeight - 20) problems.push("被存到了屏幕外（垂直）");
    }
    // 最小化只剩一条标题栏，用户看到的就是"界面没了"——一并纳入可自救范围
    // v5.2：最小化现在是用户点「—」的主动行为（pro 布局下不再当故障）
    if (!proIntentional && info.minimized) problems.push("处于最小化状态（只剩标题栏）");
    info.problems = problems;
    info.text = "面板 " + info.size + " @ " + info.at + "，视口 " + info.viewport +
      "，position=" + info.position + "，z-index=" + info.zIndex +
      "，最小化=" + info.minimized + "，按钮 " + info.buttons + " 个，style " + info.styles + " 个" +
      (problems.length ? " ｜ ⚠ " + problems.join("、") : " ｜ 看起来正常");
    return info;
  }

  // 自救：把面板拉回屏幕内，并清掉可能把它压没的最小化状态。
  function brutePanelRescue() {
    var panel = document.getElementById("scnu-liruyun-helper");
    if (!panel) return false;
    var info = brutePanelDiag();
    if (!info.problems.length) return false;
    log("⚠ 面板异常：" + info.text);
    log("⚠ 已执行自救：恢复位置与最小化状态");
    try {
      panel.classList.remove("lr-min");
      // 位置改回 CSS 默认的右下角，并清掉可能越界的行内定位
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "16px";
      panel.style.bottom = "16px";
      if (!panel.style.width) panel.style.width = "360px";
      if (!panel.style.height) panel.style.height = "480px";
      // 位置记录也一并清掉，避免下次刷新又被恢复成坏值
      gmSet("scnu_liruyun_panel", null);
      gmSet("scnu_liruyun_panel_min", false);
      var after = brutePanelDiag();
      log("自救后面板：" + after.text);
      return true;
    } catch (e) {
      log("自救失败：" + ((e && e.message) || e));
      return false;
    }
  }

  // 安装完成后延迟自检一次：CSS 生效需要一帧，太早检测会误报。
  function bruteSchedulePanelCheck(delayMs) {
    setTimeout(function () {
      try {
        var info = brutePanelDiag();
        if (!info.exists) {
          log("⚠ 面板不存在：请把这条消息连同 Tampermonkey 的报错一起反馈");
          return;
        }
        if (info.problems.length) brutePanelRescue();
      } catch (_) {}
    }, delayMs === undefined ? 1500 : delayMs);
  }

  // ---------------------------------------------------------- 自动适配发包次数
  // 为什么要按时长反推：要"看完"的视频是 N 秒，而每次上报 timePerRequest 秒，
  // 那需要的次数就是 N / timePerRequest —— 手动填一个固定数字，短片段会刷过量、
  // 长视频又不够，怎么填都不对。
  //
  // 时长优先取**服务器返回的 totaltime**（现场响应里的 "totaltime":"785"），
  // 因为那是服务器自己记的、我们要对齐的目标；拿不到才退回 video.duration。
  function bruteServerTotalTime() {
    if (!bruteServerState || !bruteServerState.totaltime) return null;
    var t = parseFloat(String(bruteServerState.totaltime));
    return isFinite(t) && t > 0 ? t : null;
  }
  function bruteVideoDuration() {
    var v = videoEl();
    var d = v ? Number(v.duration) : 0;
    return isFinite(d) && d > 0 ? d : null;
  }
  // 返回 { packets, source, seconds, target, cap } —— 诊断与界面都要显示这套推算
  function bruteFitPackets() {
    var serverTotal = bruteServerTotalTime();
    var duration = bruteVideoDuration();
    var seconds = serverTotal !== null ? serverTotal : duration;
    var source = serverTotal !== null ? "服务器 totaltime" : (duration !== null ? "播放器时长" : "未知");
    var per = Math.max(1, BRUTE.timePerRequest);
    if (seconds === null) return { packets: null, source: source, seconds: null, target: null, cap: false };
    var pct = Math.max(1, Math.min(100, BRUTE.fitTargetPercent || 95)) / 100;
    var target = seconds * pct;
    // 递增模式第 n 次上报 n×每发秒数，累计是平方级增长，反推要开方
    var packets = BRUTE.timeMode === "cumulative"
      ? Math.ceil((Math.sqrt(1 + 8 * (target / per)) - 1) / 2)
      : Math.ceil(target / per);
    return { packets: Math.max(1, packets), source: source, seconds: seconds, target: target, cap: false };
  }
  // 本次实际要发多少：自动适配开着就用推算值，否则用手填的
  function bruteEffectiveTotal() {
    if (!BRUTE.autoFit) return BRUTE.totalRequests;
    var fit = bruteFitPackets();
    if (fit.packets === null) return BRUTE.totalRequests;   // 时长还未知，先按手填的走
    return fit.packets;
  }

  // ---------------------------------------------------------- 暴力模式：UI
  var bruteEls = {};
  function bruteSetText(key, text) {
    var el = bruteEls[key];
    if (el) el.textContent = text == null ? "" : String(text);
  }

  function bruteUpdateLine(force) {
    var now = Date.now();
    if (!force && now - bruteLineLastAt < 400) return;   // 面板每秒刷 + 响应回调都会调这里
    bruteLineLastAt = now;
    // 风险确认那一行的提示跟着会话状态走（确认过 / 失效 / 关掉标签页）
    try { bruteApplyAckRow(); } catch (_) {}
    var pct = bruteProgress();
    var parts = [
      bruteSent + " / " + bruteEffectiveTotal() + " 发",
      "成功 " + bruteOk + " · 失败 " + bruteFail,
      "间隔 " + BRUTE.intervalMs + "ms",
      "折算 " + Math.round(bruteWatchedSeconds() / 60) + " 分钟",
    ];
    parts.push(pct === null ? "服务器进度：暂不可用" : "进度 " + pct.toFixed(1) + "%（" + bruteSourceName() + "）");
    if (bruteLastError) parts.push("最近错误：" + bruteLastError);
    bruteSetText("line", parts.join("  |  "));
  }

  function bruteModeUi() {
    var safeTab = document.getElementById("lr-mode-safe");
    var bruteTab = document.getElementById("lr-mode-brute");
    if (safeTab) safeTab.className = "lr-modetab" + (uiMode === "safe" ? " lr-modetab-on" : "");
    if (bruteTab) {
      bruteTab.className = "lr-modetab" + (uiMode === "brute" ? " lr-modetab-on" : "");
      var aggressive = BRUTE.intervalMs <= 50 || BRUTE.totalRequests >= 2000;
      bruteTab.textContent = (aggressive ? "🔥" : "⚡") + " 暴力模式";
      bruteTab.title = aggressive ? "参数偏激进（间隔≤50ms 或次数≥2000）" : "直接向接口发包（高风险）";
    }
    var safeBox = document.getElementById("lr-safe-area");
    var bruteBox = document.getElementById("lr-brute-area");
    var bruteList = document.getElementById("lr-brute-listbox");
    var helper = document.getElementById("scnu-liruyun-helper");
    var proMoved = Boolean(helper && helper.getAttribute("data-pro-moved") === "1");
    if (safeBox && !proMoved) safeBox.style.display = uiMode === "safe" ? "" : "none";
    // v3pro：两个原外壳由 CSS 接管显隐（模式页签决定），这里**不写**内联 display ——
    // 原来这一行会把搬进「⚡ 暴力」页签的整块面板压成 display:none，
    // 现场表现就是"暴力页签是空的"。回归位见 tools/test-ui-panel.mjs 用例 1。
    if (bruteBox && !proMoved) bruteBox.style.display = uiMode === "brute" ? "" : "none";
    // 视频列表在两种模式下都要看得见：切到暴力模式时从安全区移到暴力面板。
    // v3pro 例外（proMoved=true）：列表由重排层统一显示，这里既不搬也不改它的显隐。
    if (bruteList && !proMoved) {
      bruteList.style.display = "";
      var want = uiMode === "brute";
      var host = want ? bruteBox : safeBox;
      if (host && bruteList.parentNode !== host) host.appendChild(bruteList);
    }
    var startBtn = bruteEls.start;
    if (startBtn) {
      startBtn.textContent = bruteActive ? "⏹ 停止暴力" : "⚠ 开始暴力";
      startBtn.className = "lr-btn" + (bruteActive ? " lr-danger-on" : " lr-danger");
    }
    var batchLine = bruteEls.batchline;
    if (batchLine) {
      if (bruteAutoActive || bruteBatchRunning) {
        batchLine.textContent = "批量：运行中 " + (bruteBatchIndex + 1) + "/" + bruteBatchQueue.length +
          (bruteBatchDone ? "（本次已完成 " + bruteBatchDone + "）" : "");
      } else if (bruteBatchQueue.length) {
        batchLine.textContent = "批量：已暂停（队列 " + bruteBatchQueue.length + " 个）";
      } else {
        batchLine.textContent = "批量：未准备";
      }
    }
    var fit = bruteFitPackets();
    if (bruteEls.fitline) {
      bruteEls.fitline.textContent = BRUTE.autoFit
        ? (fit.packets === null
          ? "自动适配：视频时长还未知（等服务器返回 totaltime 或播放器就绪）；暂按手填的 " + BRUTE.totalRequests + " 发"
          : "自动适配：按「" + fit.source + "」" + Math.round(fit.seconds) + "s × " + BRUTE.fitTargetPercent +
            "% ÷ " + BRUTE.timePerRequest + "s ≈ " + fit.packets + " 发（起点估计；上限 " + bruteHardCap() +
            " 发，靠进度到位或停滞来停）")
        : "自动适配已关闭：按手填的 " + BRUTE.totalRequests + " 发";
    }
    if (bruteEls.total) bruteEls.total.disabled = Boolean(BRUTE.autoFit);
    if (bruteEls.fitpct) bruteEls.fitpct.disabled = !BRUTE.autoFit;
    var listRows = document.querySelectorAll(".lr-range-only");
    for (var i = 0; i < listRows.length; i++) {
      listRows[i].style.display = BRUTE.listMode === "range" ? "" : "none";
    }
    // 视频列表跟着模式刷新（同一份数据，切模式时容器已经被搬到可见的那一侧）
    bruteRenderList();
  }

  function setUiMode(mode, silent) {
    if (mode !== "safe" && mode !== "brute") return;
    if (uiMode === mode) { bruteModeUi(); return; }
    uiMode = mode;
    gmSet(MODE_KEY, mode);
    if (mode === "safe") {
      // 切回安全模式：暴力立刻停手，队列/监控交还给安全模式那套
      bruteStop();
      if (!silent) setStatus("已切回安全模式（正常播放，不伪造进度）");
      if (isResourcePage()) { try { ensureMonitor(); } catch (_) {} }
    } else {
      // 切到暴力模式：不动队列标志，只停"发包"；安全模式的保活/定时暂停会因此让位
      bruteStop();
      if (!silent) setStatus("已切到暴力模式：核对参数后点「⚠ 开始暴力」");
    }
    bruteModeUi();
  }

  function bruteReadInputs() {
    var get = function (key) { return bruteEls[key]; };
    var total = get("total"), interval = get("interval"), time = get("time");
    var mode = get("timemode"), safety = get("safety"), listmode = get("listmode");
    var startId = get("startId"), endId = get("endId"), step = get("step");
    if (total) BRUTE.totalRequests = bruteClamp(total.value, 1, 100000, BRUTE_DEFAULTS.totalRequests);
    if (interval) BRUTE.intervalMs = bruteClamp(interval.value, 10, 60000, BRUTE_DEFAULTS.intervalMs);
    if (time) BRUTE.timePerRequest = bruteClamp(time.value, 1, 3600, BRUTE_DEFAULTS.timePerRequest);
    if (mode) BRUTE.timeMode = mode.value === "cumulative" ? "cumulative" : "fixed";
    if (safety) BRUTE.safetyLimit = bruteClamp(safety.value, 1, BRUTE_SAFETY_MAX, BRUTE_DEFAULTS.safetyLimit);
    if (listmode) BRUTE.listMode = listmode.value === "range" ? "range" : "queue";
    if (startId) BRUTE.startId = bruteClamp(startId.value, 0, 99999999, 0);
    if (endId) BRUTE.endId = bruteClamp(endId.value, 0, 99999999, 0);
    if (step) BRUTE.step = bruteClamp(step.value, 1, 1000, 1);
    if (get("maxqueue")) BRUTE.maxQueue = bruteClamp(get("maxqueue").value, 1, BRUTE_QUEUE_MAX, 5000);
    if (get("stallpackets")) BRUTE.stallPackets = bruteClamp(get("stallpackets").value, 20, 2000, 150);
    if (get("autofit")) BRUTE.autoFit = Boolean(get("autofit").checked);
    if (get("fitpct")) BRUTE.fitTargetPercent = bruteClamp(get("fitpct").value, 1, 100, 95);
    if (get("stopcomplete")) BRUTE.stopOnComplete = Boolean(get("stopcomplete").checked);
    if (get("keepplaying")) BRUTE.keepPlaying = Boolean(get("keepplaying").checked);
    if (get("confirm")) BRUTE.confirm = Boolean(get("confirm").checked);
    // 硬上限必须 ≥ 次数上限，否则一启动就撞硬刹车
    if (BRUTE.safetyLimit < BRUTE.totalRequests) BRUTE.safetyLimit = BRUTE.totalRequests;
    // 回写：让用户看到被夹紧后的真实值
    if (total) total.value = BRUTE.totalRequests;
    if (interval) interval.value = BRUTE.intervalMs;
    if (time) time.value = BRUTE.timePerRequest;
    if (safety) safety.value = BRUTE.safetyLimit;
    if (get("maxqueue")) get("maxqueue").value = BRUTE.maxQueue;
    if (get("stallpackets")) get("stallpackets").value = BRUTE.stallPackets;
    if (get("fitpct")) get("fitpct").value = BRUTE.fitTargetPercent;
    if (get("total")) get("total").disabled = Boolean(BRUTE.autoFit);
    if (get("fitpct")) get("fitpct").disabled = !BRUTE.autoFit;
    saveBrute();
    bruteModeUi();
  }

  function bruteSyncInputs() {
    var set = function (key, value) { if (bruteEls[key]) bruteEls[key].value = String(value); };
    var chk = function (key, value) { if (bruteEls[key]) bruteEls[key].checked = Boolean(value); };
    set("total", BRUTE.totalRequests);
    set("interval", BRUTE.intervalMs);
    set("time", BRUTE.timePerRequest);
    set("safety", BRUTE.safetyLimit);
    set("startId", BRUTE.startId || 0);
    set("endId", BRUTE.endId || 0);
    set("step", BRUTE.step);
    if (bruteEls.timemode) bruteEls.timemode.value = BRUTE.timeMode;
    if (bruteEls.listmode) bruteEls.listmode.value = BRUTE.listMode;
    set("fitpct", BRUTE.fitTargetPercent);
    set("maxqueue", BRUTE.maxQueue);
    set("stallpackets", BRUTE.stallPackets);
    chk("autofit", BRUTE.autoFit);
    chk("stopcomplete", BRUTE.stopOnComplete);
    chk("keepplaying", BRUTE.keepPlaying);
    chk("confirm", BRUTE.confirm);
  }

  function bruteStart() {
    if (bruteActive) return;
    if (!isResourcePage()) { setStatus("暴力模式只能在视频资源页使用：请先打开某个视频页"); return; }
    if (!isFsresourcePage()) {
      setStatus("当前是 H5P 资源页：接口 mod_fsresource_set_time 不适用，暴力模式拒绝启动");
      log("暴力模式拒绝启动：H5P 不是 fsresource 模块");
      return;
    }
    if (!brutePlayerData() && !currentResourceId()) {
      setStatus("页面还没注入 playerdata，请稍等或刷新页面后重试");
      return;
    }
    bruteReadInputs();

    if (bruteShouldAskAck()) {
      var minutes = Math.round((BRUTE.totalRequests * BRUTE.timePerRequest) / 60);
      var ok = window.confirm("确认启动暴力模式？\n\n" +
        "· 将对当前视频连续 POST " + SET_TIME_METHOD + "\n" +
        "· 次数上限 " + BRUTE.totalRequests + " 次，间隔 " + BRUTE.intervalMs + "ms\n" +
        "· 折算观看时长约 " + minutes + " 分钟（仅为换算参考，不是真实观看）\n" +
        "· 达到完成阈值（" + readRequiredProgress() + "%）或读到「已完成」即自动停止\n\n" +
        "这会让学校服务器收到异常请求，可能被风控记录。是否继续？\n" +
        (bruteAckMode() === "remember"
          ? "（确认后本次会话内不再重复询问；关掉标签页即失效，暴力页也可改回每次都问）"
          : "（当前设置：每次都问）"));
      if (!ok) { setStatus("已取消暴力模式"); return; }
      if (bruteAckMode() === "remember") {
        bruteRememberAck();
        bruteApplyAckRow();          // 那一行的提示要立刻变成"本次会话已确认"
        log("已记录风险确认：本次会话内不再弹确认框（关掉标签页即失效；暴力页可改回每次都问）");
      }
    } else if (BRUTE.confirm) {
      // 绝不静默跳过：每次自动跳过都留一行（"确认过"这件事必须有痕迹）
      log("启动暴力模式（本次会话已确认过风险，不再弹窗）");
    }

    bruteActive = true;
    bruteSent = 0; bruteOk = 0; bruteFail = 0; bruteConsecutiveFails = 0; bruteLastError = "";
    bruteStopWhy = "";
    bruteExtraGranted = 0;
    bruteStallFromSent = 0;
    bruteStallPrevPct = null;
    bruteInstallHooks();
    // 基线：开工时的进度 + 页面是否已经标着完成。
    // 这两个值决定后面"进度有没有真的动"和"能不能把达标算在我们头上"。
    bruteProgressBase = bruteProgress();
    // 停滞窗口必须彻底清零：起点进度设为 null，等真正发过包之后再记录基准，
    // 否则上一轮的残留值会让"刚启动"就被判成停滞（实测发了 0 发就报停滞）。
    bruteStallPrevPct = null;
    bruteStallFromSent = 0;
    bruteStallBaselineChecked = false;
    bruteCapNudged = false;      // 每一轮都重新给一次"催读数"的机会
    bruteStartupCompleted = brutePageSaysCompleted();
    var effTotal = bruteEffectiveTotal();
    var fitAtStart = bruteFitPackets();
    log("暴力模式启动：上限 " + effTotal + " 次 / 间隔 " + BRUTE.intervalMs + "ms / 每次 " +
      BRUTE.timePerRequest + " 秒（" + (BRUTE.timeMode === "cumulative" ? "递增" : "固定") + "）");
    log(BRUTE.autoFit
      ? (fitAtStart.packets === null
        ? "自动适配：视频时长未知（服务器还没返回 totaltime、播放器也没 duration），暂按手填的 " + BRUTE.totalRequests + " 发"
        : "自动适配：按" + fitAtStart.source + " " + Math.round(fitAtStart.seconds) + "s，刷到 " +
          BRUTE.fitTargetPercent + "% → " + effTotal + " 发")
      : "自动适配已关闭：按手填的 " + BRUTE.totalRequests + " 发");
    log("开工基线：进度 " + (bruteProgressBase === null ? "读不到" : bruteProgressBase.toFixed(1) + "%") +
      "；页面完成标记=" + (bruteStartupCompleted ? "已标记「已完成」" : "未完成") +
      (bruteStartupCompleted ? "（这时只做探针式发包，不会假装是刷成功的）" : ""));
    setStatus("暴力模式运行中…（达标或接口确认完成会自动停）");
    // 开工前先看一眼：进度已经到位的话，根本没有发的必要。
    // 现场实测过「开工基线 100.0%，却又发了 6 包才停」—— 白刷且让人困惑。
    var prePct = bruteProgress();
    var preTarget = Math.max(1, Math.min(100, BRUTE.fitTargetPercent || 100));
    if (BRUTE.stopOnComplete && prePct !== null &&
        (prePct >= preTarget || bruteCompleted())) {
      bruteStopWhy = "开工前进度就已经是 " + prePct.toFixed(1) + "%（目标 " + preTarget + "%）";
      log("无需发包：" + bruteStopWhy + (brutePageSaysCompleted() ? "，页面也标记为已完成" : ""));
      setStatus("无需发包：这一节已经是 " + prePct.toFixed(1) + "%（目标 " + preTarget + "%）");
      bruteActive = false;
      bruteModeUi();
      return;
    }

    if (BRUTE.keepPlaying) { try { tryStartPlayback("暴力模式"); } catch (_) {} }
    bruteModeUi();
    bruteScheduleNext();
  }

  // 用递归 setTimeout 而不是 setInterval：
  // 10ms 的 setInterval 在后台标签页会被浏览器按秒级节流，而递归链的节流行为不同，
  // 更接近"一直在发"的观感；同时它天然不会堆积（上一发回来才排下一发）。
  function bruteScheduleNext() {
    if (bruteTimer) { clearTimeout(bruteTimer); bruteTimer = 0; }
    if (!bruteActive) return;
    bruteTimer = setTimeout(function () {
      bruteTimer = 0;
      try { bruteTick(); } catch (e) { log("发包循环异常：" + ((e && e.message) || e)); }
      if (bruteActive) bruteScheduleNext();
    }, Math.max(10, BRUTE.intervalMs));
  }

  function bruteStop(silent) {
    var was = bruteActive;
    bruteActive = false;
    if (bruteTimer) { clearTimeout(bruteTimer); bruteTimer = 0; }
    if (was && !silent) log("暴力模式已停止（共发送 " + bruteSent + " 次，成功 " + bruteOk + "，失败 " + bruteFail + "）");
    bruteUpdateLine(true);
    bruteModeUi();
  }

  function bruteTick() {
    if (!bruteActive) return;

    // 学习确认遮罩在的时候页面自己正在暂停计时，此刻硬刷最容易撞风控 → 等它过去
    if (hasHumanChallenge()) {
      if (Date.now() - bruteWarnedAt > 5000) {
        bruteWarnedAt = Date.now();
        log("检测到学习确认遮罩：暴力模式暂停发包，等遮罩消失后自动继续");
      }
      setStatus("检测到学习确认：已暂停发包（请本人完成，或等它自行消失）");
      return;
    }

    if (BRUTE.stopOnComplete) {
      var verdict = bruteStopReason();
      if (verdict.stop) {
        bruteStopWhy = verdict.why;
        log((verdict.ok ? "达标自停：" : "停止发包：") + verdict.why +
          "（本次已发 " + bruteSent + " 次，成功 " + bruteOk + "）");
        bruteStop();
        setStatus((verdict.ok ? "✓ 达标" : "已停止") + "：" + verdict.why);
        flashPanel(verdict.ok ? "#22c55e" : "#f59e0b");
        if (verdict.ok) bruteFinishOk("暴力模式达标");
        return;
      }
    }
    // 停止条件只有一个：进度真的到位。
    // 按时长推算的包数只是**起点估计**，不是终点 —— 服务器的 totaltime 与视频真实时长并不一致
    // （现场实测 741/1029s vs 2298s），拿它算出来的包数必然偏少。
    // 所以推算值只用来预置一个安全上限；只要进度没到目标就继续发，直到：
    //   1) 进度 ≥ 目标（或接口明确说已完成）→ 成功停止；
    //   2) 达到安全硬上限 → 停下来说明情况，避免无限刷。
    var targetPct = Math.max(1, Math.min(100, BRUTE.fitTargetPercent || 100));
    var pctNow = bruteProgress();
    var cap = bruteHardCap();
    if (bruteSent >= cap) {
      // v3.3：撞上限之前先"催"一次页面读数 —— 现场实测接口早就到 100% 了、
      // 页面数字还停在旧值，直接判"没到位"会白刷一整轮。
      if (!bruteCapNudged && Date.now() - bruteNudgeAt > 3000) {
        bruteCapNudged = true;
        log("已发 " + cap + " 发（进度 " + brutePctText(pctNow) + "，目标 " + targetPct + "%）→ 先催一次页面读数再决定");
        bruteNudgePlayer(1, function (after) {
          var v2 = bruteStopReason();
          if (v2.stop && v2.ok) {
            bruteStopWhy = v2.why;
            log("催完确认：" + v2.why);
            bruteStop();
            setStatus("✓ 达标：" + v2.why);
            flashPanel("#22c55e");
            bruteFinishOk("暴力模式达标");
            return;
          }
          log("催完仍未达标（页面 " + brutePctText(after) + "）→ 停止，避免无限刷");
          bruteStop();
          setStatus("已发 " + cap + " 发仍未到位（进度 " + brutePctText(after) + "）：请点「诊断读数」把结果发我");
        });
        return;
      }
      log("已达安全硬上限 " + cap + " 发（进度 " + (pctNow === null ? "读不到" : pctNow.toFixed(1) + "%") +
        "，目标 " + targetPct + "%）→ 停止，避免无限刷");
      bruteStop();
      setStatus("已发 " + cap + " 发仍未到位（进度 " + (pctNow === null ? "读不到" : pctNow.toFixed(1) + "%") +
        "）：请点「诊断读数」把结果发我");
      return;
    }
    // ---- 真正的刹车：进度停滞 ----
    // 发了很多发、进度却一点没涨 → 这条路当前无效（接口被限、id 不对、服务器有额外限制），
    // 继续刷没有意义。这比"固定发多少发"更准确地判断该不该停。
    var stallEvery = Math.max(20, Math.min(500, BRUTE.stallPackets || 150));
    if (pctNow !== null) {
      if (bruteStallPrevPct === null) {
        bruteStallPrevPct = pctNow;      // 第一次拿到进度：建立基准，不算停滞
        bruteStallFromSent = bruteSent;
      } else if (bruteSent - bruteStallFromSent >= stallEvery) {
        if (pctNow <= bruteStallPrevPct + 0.05) {
          log("进度停滞：连续 " + stallEvery + " 发进度一直是 " + pctNow.toFixed(1) +
            "%（目标 " + targetPct + "%）→ 停止。这条请求当前对进度无效，继续刷没有意义");
          bruteStop();
          setStatus("进度停滞在 " + pctNow.toFixed(1) + "%：已停止（点「诊断读数」可看接口原文）");
          flashPanel("#ef4444");
          return;
        }
        bruteStallPrevPct = pctNow;
        bruteStallFromSent = bruteSent;
      }
    }

    // 每 25 发报一次进度，让人看到确实在推进
    if (bruteSent > 0 && bruteSent % 25 === 0) {
      log("进度 " + (pctNow === null ? "读不到" : pctNow.toFixed(1) + "% / 目标 " + targetPct + "%") +
        "（已发 " + bruteSent + " / 上限 " + cap + "）");
      setStatus("发包中：" + (pctNow === null ? "" : pctNow.toFixed(1) + "% → ") + "目标 " + targetPct +
        "%（已发 " + bruteSent + "/" + cap + "）");
    }
    if (bruteSent >= BRUTE.safetyLimit) {
      log("已达失控保护上限 " + BRUTE.safetyLimit + " 次（正常不该走到这里）：强制停止，请把诊断结果发我");
      bruteStop();
      setStatus("已达安全硬上限，强制停止");
      return;
    }

    bruteSent += 1;
    bruteSend().then(function (result) {
      if (result.ok) {
        bruteOk += 1;
        bruteConsecutiveFails = 0;
      } else {
        bruteFail += 1;
        bruteConsecutiveFails += 1;
        if (result.reason) bruteLastError = result.reason;
        if (bruteConsecutiveFails >= BRUTE_MAX_CONSECUTIVE_FAILS) {
          // 连续同样失败 = 这条路当前走不通，继续刷没有意义（还容易被判异常流量）
          log("连续 " + bruteConsecutiveFails + " 次请求失败，已停止发包（不再重复同一条请求）");
          log("最近一次服务器返回：" + (bruteLastError || "(无文案)"));
          log("失败时我们发出的请求体：" + bruteLastBody);
          log("排查建议：点「诊断读数」，里面带着完整请求与响应原文");
          bruteStop();
          setStatus("接口连续报错，已停止：请点「诊断读数」把结果发我");
          flashPanel("#ef4444");
          return;
        }
      }
      bruteUpdateLine();
      // 关键：响应刚回来时立刻复检一次，别等下一个 tick
      bruteCheckStopAfterResponse();
    });
  }

  // ---------------------------------------------------------- 催页面读数（v3.3）
  // 现场要求（原话）："暴力模式刷到 100% 之后页面的播放进度有延迟，
  //                    这时候暂停视频再播放可以很好地刷新，以此加快判断。"
  // 机理：接口一旦确认达标，**页面上那个进度数字是服务端再渲染一遍才更新的**，
  //      常常还停在旧值（列表里的「已完成」也一起滞后）。把播放器暂停再播放一下，
  //      它会重新向服务端拉一次状态，读数当场跟上 —— 于是"能不能进下一节"不用再等下一轮轮询。
  // 边界：只动**播放器的 paused**，不动进度、不发包；本轮最多催两次，避免和站点抢播放器。
  var bruteNudgeAt = 0;
  var bruteNudgeCount = 0;

  function brutePctText(p) {
    return p === null || p === undefined ? "读不到" : Number(p).toFixed(1) + "%";
  }

  function bruteNudgePlayer(round, cb) {
    var v = null;
    try { v = videoEl(); } catch (_) {}
    if (!v) { if (cb) cb(null); return false; }
    var before = null;
    try { before = readProgress(); } catch (_) {}
    try { if (!v.paused) v.pause(); } catch (_) {}
    setTimeout(function () {
      try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
      setTimeout(function () {
        var after = null;
        try { after = readProgress(); } catch (_) {}
        bruteNudgeAt = Date.now();
        bruteNudgeCount += 1;
        log("催页面读数（暂停/播放一次，第 " + (round || 1) + " 次）：" +
          brutePctText(before) + " → " + brutePctText(after));
        if (cb) cb(after);
      }, 700);
    }, 350);
    return true;
  }

  function brutePageUpToDate() {
    var target = Math.max(1, Math.min(100, BRUTE.fitTargetPercent || 100));
    var pagePct = null;
    try { pagePct = readProgress(); } catch (_) {}
    if (pagePct !== null && pagePct >= target) return true;
    try { return brutePageSaysCompleted(); } catch (_) { return false; }
  }

  // 达标后的统一出口：页面读数还滞后就先催一次（最多两次），再往下走。
  // 判定本身始终以**接口/进度**为准 —— 催只是为了页面显示与后续节流判断能立刻跟上。
  function bruteFinishOk(why) {
    if (brutePageUpToDate()) { bruteAfterResourceDone(why); return; }
    var t = Math.max(1, Math.min(100, BRUTE.fitTargetPercent || 100));
    log("接口已达标，页面读数还滞后 → 暂停/播放一次催它刷新（目标 " + t + "%）");
    bruteNudgePlayer(1, function (after) {
      if (after !== null && after >= t) { bruteAfterResourceDone(why); return; }
      bruteNudgePlayer(2, function (after2) {
        if (after2 === null || after2 < t) {
          log("催了两次页面读数仍是 " + brutePctText(after2) + "（判定以接口为准，继续往下走）");
        }
        bruteAfterResourceDone(why);
      });
    });
  }

  // 响应到达后的即时复检：进度到位 / 接口说完成 → 立刻停手。
  // 同时提醒安全模式的监控立刻重读页面读数（DOM 通常在这一刻刚被页面刷新）。
  function bruteCheckStopAfterResponse() {
    if (!bruteActive) return;
    if (!BRUTE.stopOnComplete) return;
    var verdict = bruteStopReason();
    if (!verdict.stop) return;
    bruteStopWhy = verdict.why;
    log("收到响应后立即停止：" + verdict.why + "（本次已发 " + bruteSent + " 次，成功 " + bruteOk + "）");
    bruteStop();
    setStatus((verdict.ok ? "✓ 达标" : "已停止") + "：" + verdict.why);
    flashPanel(verdict.ok ? "#22c55e" : "#f59e0b");
    if (verdict.ok) bruteFinishOk("暴力模式达标");
  }

  // ---------------------------------------------------------- 暴力模式：批量
  // 刻意复用安全模式那套队列状态（STORAGE_KEY），这样列表、进度落库、
  // "当前项"高亮全都是同一份数据，两个模式看到的课程进度是一致的。
  function bruteNextUrl(id) {
    try {
      var u = new URL(location.href);
      u.hash = "";
      u.searchParams.set("id", String(id));
      return u.toString();
    } catch (_) { return location.pathname + "?id=" + id; }
  }

  function bruteStartBatch() {
    bruteReadInputs();
    if (bruteBatchQueue.length === 0 && BRUTE.listMode === "queue") {
      // 没扫过就先扫一次（课程页上很自然）
      ensureViewQueue();
      bruteBatchQueue = normalizedQueue();
    }
    var queue = null;
    if (BRUTE.listMode === "queue") {
      bruteBatchQueue = normalizedQueue();
      queue = bruteBatchQueue;
      if (!queue.length) {
        setStatus("课程页里没扫到资源列表：请先回到课程页，或改用「ID 区间」");
        return;
      }
    } else {
      if (!BRUTE.startId || !BRUTE.endId) { setStatus("区间模式需要填写起始 ID 和结束 ID"); return; }
      if (BRUTE.startId > BRUTE.endId) { setStatus("起始 ID 不能大于结束 ID"); return; }
      queue = [];
      for (var id = BRUTE.startId; id <= BRUTE.endId; id += BRUTE.step) {
        queue.push({ name: "ID " + id, url: bruteNextUrl(id), id: String(id) });
        if (queue.length > 2000) break;
      }
      log("区间模式：id " + BRUTE.startId + " → " + BRUTE.endId + "，共 " + queue.length +
        " 个（⚠ 不校验类型，可能打开 404）");
      bruteBatchQueue = queue;
    }

    var idx = findCurrentResourceIndex(queue);
    if (idx < 0) idx = 0;
    bruteBatchRunning = true;
    bruteAutoActive = true;
    bruteSetBatchArmed(true);      // 持久化：换页后靠它决定要不要继续接管
    bruteBatchIndex = idx;
    bruteBatchDone = 0;
    // 同步给安全模式的队列状态：列表高亮、进度落库、"当前项"判断都靠它
    saveState({
      running: true, queue: queue, index: idx, lastIndex: -1,
      sourceUrl: location.href, sourceTitle: document.title,
    });
    log("暴力批量开始：" + queue.length + " 个资源，从第 " + (idx + 1) + " 个开始");
    bruteModeUi();
    setStatus("暴力批量运行中：" + (idx + 1) + "/" + queue.length);

    if (normalizeUrl(location.href) !== normalizeUrl(queue[idx].url)) {
      setTimeout(function () { location.href = queue[idx].url; }, BRUTE.batchDelayMs);
      return;
    }
    bruteStart();
  }

  function bruteStopBatch(message) {
    bruteBatchRunning = false;
    bruteAutoActive = false;
    bruteSetBatchArmed(false);
    var s = loadState();
    s.running = false;
    saveState(s);
    if (message) { log(message); setStatus(message); }
    bruteModeUi();
  }

  // 当前资源做完后的统一出口：批量在跑就跳下一个。
  // 判断依据是**持久化队列状态**，不是内存变量 —— 换页会重新加载脚本，内存变量归零。
  function bruteAfterResourceDone(message) {
    var s = loadState();
    if (!bruteBatchRunning && !bruteAutoActive && !bruteBatchArmed()) {
      if (message) log(message + "（未开启批量，停在当前页）");
      return;
    }
    var queue = (s.queue && s.queue.length ? s.queue : bruteBatchQueue) || [];
    if (!queue.length) { bruteStopBatch("队列为空，批量结束"); return; }
    bruteBatchQueue = queue;
    bruteBatchRunning = true;

    var doneAt = findCurrentResourceIndex(queue);
    if (doneAt < 0) doneAt = bruteBatchIndex;
    var next = doneAt + 1;
    bruteBatchIndex = next;
    bruteBatchDone = Math.max(bruteBatchDone, doneAt + 1);

    if (next >= queue.length) {
      bruteStopBatch("");
      log("暴力批量完成，共处理 " + queue.length + " 个资源");
      setStatus("✓ 暴力批量完成（" + queue.length + " 个）");
      flashPanel("#22c55e");
      return;
    }
    s.index = next;
    s.running = true;
    saveState(s);
    log("暴力批量 " + (next + 1) + "/" + queue.length + " → " + queue[next].name);
    setStatus("暴力批量跳转中：" + (next + 1) + "/" + queue.length);
    setTimeout(function () { location.href = queue[next].url; }, BRUTE.batchDelayMs);
  }

  // 跨页接管：新页面加载后，如果"暴力批量"还在跑且当前就是队列里的这一项，就自动续上。
  //
  // 判断依据必须是**持久化状态**（batchArmed），不能是内存变量：
  // 换页会重新加载脚本，所有内存变量归零。之前就是用 bruteAutoActive 判断的，
  // 结果批量跳完第一个视频、到第二个页面时永远不接管 —— 整批卡死在第一项。
  function bruteResumeIfNeeded() {
    if (uiMode !== "brute") return false;
    if (!isResourcePage()) return false;
    if (!bruteBatchArmed()) return false;
    var s = loadState();
    if (!s.running || !(s.queue && s.queue.length)) return false;
    var item = s.queue[s.index];
    if (!item) return false;
    if (normalizeUrl(location.href) !== normalizeUrl(item.url)) return false;
    bruteBatchRunning = true;
    bruteAutoActive = true;
    log("检测到暴力批量仍在进行：自动接管第 " + (s.index + 1) + "/" + s.queue.length + " 项");
    setTimeout(function () {
      if (uiMode === "brute" && !bruteActive) bruteStart();
    }, 800);
    return true;
  }

  function bruteScanNow() {
    ensureViewQueue();
    var list = normalizedQueue();
    if (!list.length) {
      setStatus("没扫到资源：请在课程页（course/view.php）点这个按钮");
      return;
    }
    bruteBatchQueue = list;
    bruteBatchIndex = Math.max(0, findCurrentResourceIndex(list));
    bruteBatchDone = 0;
    log("扫描到 " + list.length + " 个资源");
    for (var i = 0; i < Math.min(list.length, 8); i++) log("  " + (i + 1) + ". " + list[i].name);
    if (list.length > 8) log("  …其余 " + (list.length - 8) + " 个略");
    setStatus("已扫描到 " + list.length + " 个资源：可点「开始批量」逐个处理");
    setUiMode("brute");
    bruteModeUi();
    brutePrepareList(list, true);
  }

  // ---------------------------------------------------------- 暴力模式：视频列表
  // 现场要求：暴力模式也要能看到视频列表（不然在暴力页签下根本不知道这门课有几节、
  // 自己刷到第几节了、哪些还没刷）。这里渲染的是**同一份队列**
  // （normalizedQueue() → 模块顶部的自适应采集），和安全模式的列表口径完全一致。
  var bruteListSig = "";
  function bruteRenderList(force) {
    var box = document.getElementById("lr-brute-list");
    if (!box) return 0;
    var list;
    try { list = normalizedQueue(); } catch (_) { list = []; }
    var required = readRequiredProgress();
    var live = readProgress();
    var db = progressDb();
    var curId = currentResourceId();
    var sig = curId + "|" + required + "|" + list.length + "|" + (live === null ? "-" : live.toFixed(1)) + "|" +
      String(ADAPTIVE.source || "");
    if (!force && sig === bruteListSig) return list.length;
    bruteListSig = sig;

    var head = document.getElementById("lr-brute-listline");
    if (head) {
      head.textContent = list.length
        ? "共 " + list.length + " 条 · 来源 " + ADAPTIVE.source +
          (ADAPTIVE.server.ok ? " · 服务器兜底 " + ADAPTIVE.server.count + " 条" : "")
        : "没扫到视频：请在课程页点「重新扫描」，或点下面的「刷新列表」";
    }
    if (!list.length) {
      box.innerHTML = '<div style="color:#f87171;padding:4px 6px">没扫到视频列表：' +
        "请回到课程页，或点「刷新列表」强制重扫</div>";
      return 0;
    }
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var id = item.id || "";
      var isCur = Boolean(curId && id === curId);
      var raw = isCur ? (live === null ? db[id] : live) : db[id];
      var hasData = (raw !== undefined && raw !== null);
      var pct = hasData ? Number(raw) : 0;
      var done = hasData && pct >= required;
      html += '<div class="lr-item' + (isCur ? " lr-cur" : "") +
        '" data-brute-url="' + String(item.url).replace(/"/g, "&quot;") + '" title="' + escapeHtml(item.name) + '">' +
        '<span class="lr-pct" style="width:14px;text-align:right">' + (i + 1) + "</span>" +
        '<span class="lr-name">' + escapeHtml(item.name) + "</span>" +
        (done
          ? '<span class="lr-pct">' + pct.toFixed(0) + '%</span><span class="lr-badge">已完成</span>'
          : '<span class="lr-pct"' + (hasData ? "" : ' style="opacity:.45" title="还没记录到这一节的进度"') + '>' +
            (hasData ? pct.toFixed(0) + "%" : "—") + "</span>") +
        "</div>";
    }
    box.innerHTML = html;
    return list.length;
  }

  // 兼容包装：老调用点传进来的是"已经算好的列表"，这里忽略它、统一走同一份队列，
  // 避免出现"两个列表不一致"。force=true 时强制重渲染（扫描/刷新后要立刻看到变化）。
  function brutePrepareList(list, force) { return bruteRenderList(force); }

  // ---------------------------------------------------------- 暴力模式：面板
  function bruteMkEl(tag, cls, text, id) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    if (id) el.id = id;
    return el;
  }
  function bruteMkRow(label, input) {
    var row = bruteMkEl("div", "lr-row");
    row.appendChild(bruteMkEl("span", "lr-lab", label));
    row.appendChild(input);
    return row;
  }
  function bruteMkNum(key, label, value, min, max, unit) {
    var input = bruteMkEl("input", "lr-num");
    input.type = "number";
    input.id = "lr-brute-" + key;
    input.min = String(min);
    if (max) input.max = String(max);
    input.value = String(value);
    bruteEls[key] = input;
    var row = bruteMkRow(label, input);
    if (unit) row.appendChild(bruteMkEl("span", "lr-unit", unit));
    return row;
  }
  function bruteMkToggle(key, label, checked, title) {
    var input = bruteMkEl("input", "lr-chk");
    input.type = "checkbox";
    input.id = "lr-brute-" + key;
    input.checked = Boolean(checked);
    if (title) input.title = title;
    bruteEls[key] = input;
    return bruteMkRow(label, input);
  }

  // ---------------------------------------------------------- 「设置 / 诊断」的展开状态
  // 面板刷新后要恢复成上次的样子：默认**展开**（收起后设置项全看不见，很难用），
  // 用户手动收起过就尊重他的选择。状态存在 GM 存储里，跨刷新有效。
  var ADV_KEY = "scnu_liruyun_adv_open";
  // 每个折叠分区的展开状态分别记：键名 = ADV_KEY + ":" + data-advkey。
  // 没带 key 的（原版「设置 / 诊断」）仍然用老键名，老用户的选择不会丢。
  function bruteAdvStoreKey(key) { return key ? ADV_KEY + ":" + key : ADV_KEY; }
  function bruteApplyAdvState(advanced) {
    if (!advanced) return;
    var key = advanced.dataset && advanced.dataset.advkey ? advanced.dataset.advkey : "";
    var saved = gmGet(bruteAdvStoreKey(key), undefined);
    var fallback = advanced.dataset && advanced.dataset.advopen === "0" ? false : true;
    advanced.open = saved === undefined ? fallback : Boolean(saved);
  }
  function bruteSaveAdvState(advanced, key) {
    if (!advanced) return;
    try { gmSet(bruteAdvStoreKey(key || (advanced.dataset && advanced.dataset.advkey) || ""), Boolean(advanced.open)); } catch (_) {}
  }
  // 折叠分区工厂：暴力模式里的"参数 / 批量 / 诊断"用它，安全模式的「设置 / 诊断」也复用它。
  function bruteMkDetails(label, key, open) {
    var d = bruteMkEl("details", "lr-secbox");
    d.dataset.advkey = key;
    if (open === false) d.dataset.advopen = "0";
    d.appendChild(bruteMkEl("summary", "lr-secsummary", (open === false ? "▸ " : "▾ ") + label));
    // 立刻应用记住的展开状态（存过就以存的为准）——
    // 漏了这一步会出现"收起后刷新，状态没恢复"，而保存那段代码却看起来是好的。
    bruteApplyAdvState(d);
    return d;
  }

  function installBruteUi(body, advanced) {
    // 先恢复「设置 / 诊断」的展开状态，再动 DOM
    bruteApplyAdvState(advanced);

    // 暴力模块自己的样式：单独一个 <style>，不去动原面板那段样式字符串
    var style = document.createElement("style");
    style.setAttribute("data-liruyun", "brute-style");
    style.textContent = [
      "#scnu-liruyun-helper .lr-modeswitch{display:flex;gap:6px;padding:7px 10px 0;flex:0 0 auto;}",
      "#scnu-liruyun-helper .lr-modetab{flex:1;padding:5px 6px;border-radius:6px;cursor:pointer;",
      "border:1px solid #334155;background:#0b1220;color:#94a3b8;font:inherit;font-size:11.5px;}",
      "#scnu-liruyun-helper .lr-modetab:hover{color:#e2e8f0;border-color:#475569;}",
      "#scnu-liruyun-helper .lr-modetab-on{background:#1d4ed8;border-color:#3b82f6;color:#fff;font-weight:700;}",
      "#scnu-liruyun-helper .lr-modetab[data-action='mode-brute'].lr-modetab-on{background:#b45309;border-color:#f59e0b;}",
      "#scnu-liruyun-helper .lr-brute{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;}",
      "#scnu-liruyun-helper .lr-brutesec{border-top:1px dashed #1e293b;margin-top:8px;padding-top:6px;}",
      "#scnu-liruyun-helper .lr-warn{background:rgba(180,83,9,.16);border:1px solid #b45309;color:#fed7aa;",
      "border-radius:6px;padding:6px 8px;font-size:11px;line-height:1.45;}",
      "#scnu-liruyun-helper .lr-sec{color:#93a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:6px 0 2px;}",
      "#scnu-liruyun-helper .lr-chk{width:auto;}",
      "#scnu-liruyun-helper .lr-btn.lr-danger{background:#7c2d12;border:1px solid #b45309;color:#fed7aa;font-weight:700;}",
      "#scnu-liruyun-helper .lr-btn.lr-danger:hover{background:#9a3412;}",
      "#scnu-liruyun-helper .lr-btn.lr-danger-on{background:#166534;border:1px solid #22c55e;color:#dcfce7;font-weight:700;}",
      "#scnu-liruyun-helper .lr-brute .lr-num{width:74px;}",
      // 可折叠分区（暴力模式的参数/诊断、安全模式的设置/诊断都用这套）
      "#scnu-liruyun-helper .lr-secbox{border-top:1px dashed #1e293b;margin-top:8px;padding-top:2px;}",
      "#scnu-liruyun-helper .lr-secsummary{cursor:pointer;list-style:none;color:#93a3b8;font-size:10.5px;",
      "text-transform:uppercase;letter-spacing:.5px;padding:5px 2px;user-select:none;}",
      "#scnu-liruyun-helper .lr-secsummary::-webkit-details-marker{display:none;}",
      "#scnu-liruyun-helper .lr-secsummary:hover{color:#e2e8f0;}",
      "#scnu-liruyun-helper details[data-advkey][open]>.lr-secsummary{color:#cbd5e1;}",
      "#scnu-liruyun-helper .lr-brutelist{max-height:150px;overflow:auto;padding:2px;border:1px solid #1e293b;",
      "border-radius:6px;background:#0b1220;margin:2px 0 6px;}",
      "#scnu-liruyun-helper .lr-brutelist .lr-item{padding:4px 6px;}",
      // 视频列表容器：切模式时整块搬走，所以它自己不能带模式相关的显隐
      "#scnu-liruyun-helper .lr-brute-listbox{flex:0 0 auto;padding:6px 10px;border-bottom:1px solid #1e293b;",
      "background:#0b1220;}",
      "#scnu-liruyun-helper .lr-brute-listbox .lr-brutelist{max-height:170px;margin:4px 0 0;}",
      "#scnu-liruyun-helper .lr-brute-listbox .lr-listlabel{color:#93a3b8;font-size:10.5px;text-transform:uppercase;",
      "letter-spacing:.5px;}",
    ].join("\n");
    document.documentElement.appendChild(style);

    // ---- 模式切换：放在列表上方，一眼能看到现在哪个模式在生效 ----
    var switchBox = bruteMkEl("div", "lr-modeswitch");
    var safeTab = bruteMkEl("button", "lr-modetab lr-modetab-on", "🛡 安全模式");
    safeTab.type = "button";
    safeTab.id = "lr-mode-safe";
    safeTab.dataset.action = "mode-safe";
    safeTab.title = "正常播放：队列连播 / 视频列表 / 定时暂停 / 学习确认自动通过";
    var bruteTab = bruteMkEl("button", "lr-modetab", "⚡ 暴力模式");
    bruteTab.type = "button";
    bruteTab.id = "lr-mode-brute";
    bruteTab.dataset.action = "mode-brute";
    bruteTab.title = "直接向接口发包（高风险，默认关闭）";
    switchBox.appendChild(safeTab);
    switchBox.appendChild(bruteTab);
    body.insertBefore(switchBox, body.firstChild);

    // ---- 暴力面板（隐藏区，切到暴力模式才显示）----
    var box = bruteMkEl("div", "lr-brute");
    box.id = "lr-brute-area";
    box.style.display = "none";

    box.appendChild(bruteMkEl("div", "lr-warn",
      "⚠ 高风险：绕过正常观看，直接向学校服务器 POST 进度。可能被风控记录，接口也可能随时失效。" +
      "已加刹车：达标即停 / 次数上限 / 连续 3 次失败即停（不再盲刷）。"));

    // ---- 视频列表（暴力模式也要有：不然不知道这门课有几节、刷到哪了）----
    // 这块放在安全区与暴力面板**之间**：切换模式时由 bruteModeUi() 把它搬到当前
    // 可见的那一侧，所以两种模式下都能看到同一份列表（口径完全一致）。
    var listBox = document.createElement("div");
    listBox.className = "lr-brute-listbox";
    listBox.id = "lr-brute-listbox";
    var listOps = bruteMkEl("div", "lr-row");
    listOps.appendChild(bruteMkEl("span", "lr-listlabel", "视频列表"));
    listOps.appendChild(mkBtn("brute-scan", "扫描", "按当前页面重新采集视频列表"));
    listOps.appendChild(mkBtn("brute-refresh", "刷新列表", "强制重扫（多容器择优 + 自动展开 + 服务端兜底）"));
    listBox.appendChild(listOps);
    var listLine = bruteMkEl("div", "lr-hint", "视频列表：还没扫");
    listLine.id = "lr-brute-listline";
    bruteEls.listline = listLine;
    listBox.appendChild(listLine);
    var listHost = bruteMkEl("div", "lr-brutelist");
    listHost.id = "lr-brute-list";
    listBox.appendChild(listHost);
    // 插在模式切换条下面（此刻 advanced 还没挂进 body，所以用 switchBox 做参照）
    if (switchBox.parentNode === body) body.insertBefore(listBox, switchBox.nextSibling);
    else body.appendChild(listBox);

    // ---- 诊断说明：默认收起，别一进暴力页签就顶一屏警告文字 ----
    var diagBox = bruteMkDetails("读我与失败排查", "brutediag", false);
    diagBox.appendChild(bruteMkEl("div", "lr-hint",
      "如果每次发包都失败（例如「在数据库中找不到数据记录」），说明这条请求被服务器拒绝了 —— " +
      "点「诊断读数」把「请求 / 响应原文」发我，我按真实参数修正；在那之前不要反复重试。"));
    box.appendChild(diagBox);

    // ---- 发包参数（可折叠，默认展开；收起后状态存 liruyun 存储里，刷新后保持）----
    var basic = bruteMkDetails("发包参数", "bruteparams", true);
    basic.className = "lr-secbox lr-brutesec";
    // 自动适配：按视频总时长反推发包次数（这是"该发多少"的正确算法）
    basic.appendChild(bruteMkToggle("autofit", "自动适配发包次数（按视频总时长）", BRUTE.autoFit,
      "按「视频总时长 × 目标百分比 ÷ 每次上报秒数」算出需要发多少，短片段不会过量、长视频不会不够"));
    basic.appendChild(bruteMkNum("fitpct", "适配目标（视频时长的 %）", BRUTE.fitTargetPercent, 1, 100, "%"));
    basic.appendChild(bruteMkNum("maxqueue", "队列预算（单次最多发多少）", BRUTE.maxQueue, 1, BRUTE_QUEUE_MAX));
    basic.appendChild(bruteMkNum("stallpackets", "停滞判定（连续多少发没涨就停）", BRUTE.stallPackets, 20, 2000));
    basic.appendChild(bruteMkNum("total", "手填次数（自动适配关闭时使用）", BRUTE.totalRequests, 1, 100000));
    var fitLine = bruteMkEl("div", "lr-hint", "自动适配：等视频时长出来后再算");
    fitLine.id = "lr-brute-fitline";
    bruteEls.fitline = fitLine;
    basic.appendChild(fitLine);
    basic.appendChild(bruteMkNum("interval", "间隔", BRUTE.intervalMs, 10, 60000, "ms"));
    basic.appendChild(bruteMkNum("time", "每次上报时长", BRUTE.timePerRequest, 1, 3600, "秒"));
    var tm = bruteMkEl("select", null);
    tm.id = "lr-brute-timemode";
    var optFixed = bruteMkEl("option", null, "每次固定（原版）"); optFixed.value = "fixed";
    var optCum = bruteMkEl("option", null, "递增累计"); optCum.value = "cumulative";
    tm.appendChild(optFixed); tm.appendChild(optCum);
    bruteEls.timemode = tm;
    basic.appendChild(bruteMkRow("时长上报方式", tm));
    basic.appendChild(bruteMkToggle("stopcomplete", "达标即自动停（建议保持开）", BRUTE.stopOnComplete));
    basic.appendChild(bruteMkToggle("keepplaying", "同时让页面继续播放", BRUTE.keepPlaying));
    basic.appendChild(bruteMkToggle("confirm", "启动前弹确认框", BRUTE.confirm));

    // v3.3：确认过之后**记 30 分钟**（批量连播时每换一页都要再点一次，谁也不看内容了）。
    // 这一行把"当前是哪种模式/还剩多久"摆在明面上，随时可以改回每次都问。
    var ackRow = bruteMkEl("div", "lr-row");
    var ackBtn = bruteMkEl("button", "", "");
    ackBtn.type = "button";
    ackBtn.id = "lr-brute-ackmode";
    ackBtn.dataset.action = "brute-ackmode";
    ackBtn.title = "「本次会话内不再问」= 确认一次后，这次浏览（含刷新与批量换页）不再弹确认框，" +
      "关掉标签页就失效；「每次都问」= 每次启动都问一遍。点一下切换。";
    ackRow.appendChild(ackBtn);
    var ackHint = bruteMkEl("span", "lr-unit", "");
    ackHint.id = "lr-brute-ackhint";
    ackRow.appendChild(ackHint);
    bruteEls.ackmode = ackBtn;
    bruteEls.ackhint = ackHint;
    basic.appendChild(ackRow);
    bruteApplyAckRow();
    basic.appendChild(bruteMkNum("safety", "失控保护上限（正常碰不到）", BRUTE.safetyLimit, 1, BRUTE_SAFETY_MAX));
    box.appendChild(basic);

    var ops = bruteMkEl("div", "lr-row");
    ops.appendChild(mkBtn("brute-start", "⚠ 开始暴力", "对当前视频连续发包"));
    ops.appendChild(mkBtn("brute-stop", "停止暴力", "立刻停止发包"));
    ops.appendChild(mkBtn("brute-diag", "诊断读数", "把页面真实进度/完成/接口响应摊开输出到日志"));
    box.appendChild(ops);
    var line = bruteMkEl("div", "lr-hint", "未运行");
    line.id = "lr-brute-line";
    bruteEls.line = line;
    box.appendChild(line);

    // ---- 批量（可折叠：和列表分开，避免和上面的「重新扫描」按钮意义重叠）----
    var batch = bruteMkDetails("批量（整门课挨个刷）", "brutebatch", true);
    batch.className = "lr-secbox lr-brutesec";
    // 说明：原来这里也有一个「扫描本页资源」，和上面视频列表区的「重新扫描」是同一件事；
    // 两个按钮共用一个 data-action 会让"到底点了哪个"变得不可查，所以收成一个。
    var lm = bruteMkEl("select", null);
    lm.id = "lr-brute-listmode";
    var oq = bruteMkEl("option", null, "课程页资源列表"); oq.value = "queue";
    var or_ = bruteMkEl("option", null, "ID 区间（不校验类型）"); or_.value = "range";
    lm.appendChild(oq); lm.appendChild(or_);
    bruteEls.listmode = lm;
    batch.appendChild(bruteMkRow("批量方式", lm));
    var startRow = bruteMkNum("startId", "起始 ID", BRUTE.startId || 0, 0, 99999999);
    startRow.className = "lr-row lr-range-only";
    batch.appendChild(startRow);
    var endRow = bruteMkNum("endId", "结束 ID", BRUTE.endId || 0, 0, 99999999);
    endRow.className = "lr-row lr-range-only";
    batch.appendChild(endRow);
    var stepRow = bruteMkNum("step", "步长", BRUTE.step, 1, 1000);
    stepRow.className = "lr-row lr-range-only";
    batch.appendChild(stepRow);
    var bops = bruteMkEl("div", "lr-row");
    bops.appendChild(mkBtn("brute-batch", "开始批量", "按列表/区间逐个发包"));
    bops.appendChild(mkBtn("brute-batch-stop", "停止批量", "停止批量调度"));
    batch.appendChild(bops);
    var bline = bruteMkEl("div", "lr-hint", "批量：未准备");
    bline.id = "lr-brute-batchline";
    bruteEls.batchline = bline;
    batch.appendChild(bline);
    box.appendChild(batch);

    // 插到「设置 / 诊断」前面：暴力参数自成一块，不去搅安全模式的设置区。
    // 必须容忍 advanced 还没挂进 body 的情况 —— 真实 DOM 在"参照节点不是子节点"时
    // 会抛 NotFoundError，一抛整个面板就装不出来（现场就是这么炸的）。
    if (advanced && advanced.parentNode === body) {
      body.insertBefore(box, advanced);
    } else {
      body.appendChild(box);
      if (advanced) log("提示：暴力面板已追加到末尾（设置区当时尚未挂载，已自动降级）");
    }

    // 安全模式那套 UI 包一层，切模式时整块隐藏
    var safeArea = document.createElement("div");
    safeArea.id = "lr-safe-area";
    var kids = [];
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      if (child !== switchBox && child !== box) kids.push(child);
    }
    for (var j = 0; j < kids.length; j++) safeArea.appendChild(kids[j]);
    if (box.parentNode === body) body.insertBefore(safeArea, box);
    else body.appendChild(safeArea);
  }

  // 暴力面板里除了模式页签之外，还有自己的按钮（开始/停止/诊断/批量…）
  function bruteHandleAction(action) {
    if (action === "mode-safe") { setUiMode("safe"); return true; }
    if (action === "mode-brute") { setUiMode("brute"); return true; }
    if (action === "brute-start") { if (bruteActive) bruteStop(); else bruteStart(); return true; }
    if (action === "brute-stop") { bruteStop(); setStatus("暴力模式已手动停止"); return true; }
    if (action === "brute-diag") { bruteDiagnose(); return true; }
    if (action === "brute-scan") { bruteScanNow(); return true; }
    // 「刷新列表」：清掉自适应缓存，重扫 + 服务端兜底，然后立刻重渲染
    if (action === "brute-refresh" || action === "refresh-list") {
      setStatus("正在刷新视频列表…（会依次展开折叠章节，并把服务端结果合并进来）");
      var got = adaptiveRefreshNow();
      setStatus("正在刷新视频列表…（已先扫到 " + ((got && got.length) || 0) + " 条，稍后自动更新为最终结果）");
      return true;
    }
    if (action === "brute-batch") { bruteStartBatch(); return true; }
    if (action === "brute-batch-stop") { bruteStopBatch("暴力批量已手动停止"); bruteStop(); return true; }
    if (action === "brute-ackmode") { bruteToggleAckMode(); return true; }
    return false;
  }

  // 面板上的点击：先看是不是暴力模块的按钮，是就自己处理掉。
  // 不然会落到原版那个"点不动就当作播放/重播"的分支上 —— 点"开始暴力"会顺带动播放器。
  function bruteOnPanelClick(event) {
    var target = event.target;
    // 视频列表的每一行：点一下直接跳到那一节（不会顺带开始发包）
    var row = target && target.closest ? target.closest("[data-brute-url]") : null;
    if (row) {
      event.stopImmediatePropagation();
      goToResource(row.dataset.bruteUrl);
      return;
    }
    var action = target && target.dataset ? target.dataset.action : "";
    if (!action && target && target.closest) {
      var btn = target.closest("[data-action]");
      action = btn && btn.dataset ? btn.dataset.action : "";
    }
    if (!action) return;
    if (action.indexOf("brute-") === 0 || action.indexOf("mode-") === 0 ||
        action === "refresh-list") {
      event.stopImmediatePropagation();   // 别让原版的兜底点击逻辑再处理一次
      bruteHandleAction(action);
    }
  }

  // ---------------------------------------------------------- 暴力模式：诊断
  // "发包了但进度不动"这类问题，光看脚本猜不出来 —— 必须知道页面到底显示了什么。
  // 这个按钮把关键读数一次性摊开，用户直接把日志复制给我就能定位。
  function bruteShortNode(node) {
    if (!node) return "(无)";
    var clone = node.cloneNode(true);
    var kids = clone.querySelectorAll("*");
    for (var i = 0; i < kids.length; i++) if (kids[i].parentNode) kids[i].parentNode.removeChild(kids[i]);
    return ((clone.textContent || "").replace(/\s+/g, " ").trim() || "(空)").slice(0, 90) +
      "  <" + node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") +
      (node.className ? "." + String(node.className).split(/\s+/).slice(0, 2).join(".") : "") + ">";
  }

  function bruteDiagnose() {
    var lines = [];
    lines.push("=== 环境诊断 ===");
    lines.push("URL: " + location.href.replace(/([?&](sesskey|token)=)[^&]*/gi, "$1***"));
    lines.push("页签模式: " + uiMode + " | 发包中: " + bruteActive + " | 已发 " + bruteSent +
      " 成功 " + bruteOk + " 失败 " + bruteFail);
    var fitInfo = bruteFitPackets();
    lines.push("阈值 readRequiredProgress(): " + readRequiredProgress() + "%");
    lines.push("视频总时长: 服务器 totaltime=" + (bruteServerTotalTime() === null ? "未知" : bruteServerTotalTime() + "s") +
      " | 播放器 duration=" + (bruteVideoDuration() === null ? "未知" : bruteVideoDuration() + "s") +
      " | 采用: " + fitInfo.source);
    lines.push("自动适配发包次数: " + (BRUTE.autoFit
      ? (fitInfo.packets === null ? "时长未知，暂用手填的 " + BRUTE.totalRequests
        : fitInfo.packets + " 发（" + Math.round(fitInfo.seconds) + "s × " + BRUTE.fitTargetPercent + "% ÷ " +
          BRUTE.timePerRequest + "s" + (BRUTE.timeMode === "cumulative" ? "，递增模式按平方反推" : "") + "）")
      : "关闭（用手填的 " + BRUTE.totalRequests + " 发）"));
    lines.push("进度 readProgress(): " + (readProgress() === null ? "读不到(null)" : readProgress() + "%"));
    lines.push("完成判定 readCompletionStatus(): " + readCompletionStatus() +
      " | 暴力严格判定: " + brutePageSaysCompleted() +
      " | 开工前就完成: " + bruteStartupCompleted);
    lines.push("进度基线: " + (bruteProgressBase === null ? "读不到" : bruteProgressBase + "%") +
      " | 现在: " + (bruteProgress() === null ? "读不到" : bruteProgress() + "%") +
      " | 是否上涨: " + bruteProgressMoved());
    lines.push("本次队列预算: " + bruteHardCap() + " 发 | 失控保护上限: " + BRUTE.safetyLimit +
      " 发 | 停滞判定: 连续 " + BRUTE.stallPackets + " 发没涨就停");
    lines.push("说明：正常停止靠「进度到位」；失控保护只在异常时兜底");
    lines.push("停止原因: " + (bruteStopWhy || "(还没停过)"));
    // 视频列表是从哪来的：换课程后"列表不全"就先看这几行
    try {
      var listLines = adaptiveListLines();
      for (var L = 0; L < listLines.length; L++) lines.push(listLines[L]);
    } catch (e) {
      lines.push("列表诊断读取失败：" + ((e && e.message) || e));
    }
    lines.push("接口进度: " + (bruteServerState ?
      (bruteServerState.percent === null ? "未识别" : bruteServerState.percent + "%") +
      " completed=" + bruteServerState.completed : "还没收到响应") +
      " | 解析字段: " + (bruteServerState && bruteServerState.percentKey ? bruteServerState.percentKey : "无"));

    for (var i = 0; i < PROGRESS_SELECTORS.length; i++) {
      lines.push("进度选择器 " + PROGRESS_SELECTORS[i] + " → " + bruteShortNode(document.querySelector(PROGRESS_SELECTORS[i])));
    }
    for (var j = 0; j < COMPLETION_STATUS_SELECTORS.length; j++) {
      lines.push("完成选择器 " + COMPLETION_STATUS_SELECTORS[j] + " → " + bruteShortNode(document.querySelector(COMPLETION_STATUS_SELECTORS[j])));
    }
    for (var k = 0; k < REQUIREMENT_SELECTORS.length; k++) {
      lines.push("要求选择器 " + REQUIREMENT_SELECTORS[k] + " → " + bruteShortNode(document.querySelector(REQUIREMENT_SELECTORS[k])));
    }

    var pd = brutePlayerData();
    lines.push("playerdata: " + (pd ? "有（fsresourceid=" + (pd.fsresourceid === undefined ? "无" : pd.fsresourceid) +
      ", siteUrl=" + (pd.siteUrl ? "有" : "无") + ", sesskey=" + (pd.sesskey ? "有" : "无") + "）" : "没有"));
    lines.push("playerdata.fsresourceid（接口要的就是这个）: " +
      (pd && pd.fsresourceid !== undefined ? pd.fsresourceid : "无"));
    lines.push("URL 里的 id（活动位置编号，不等于上面那个）: " + (currentResourceId() || "无"));
    var v = videoEl();
    lines.push("video: " + (v ? "currentTime=" + Number(v.currentTime).toFixed(1) + "s duration=" +
      (isFinite(Number(v.duration)) ? Number(v.duration).toFixed(1) + "s" : "未知") + (v.paused ? " 暂停中" : " 播放中") : "没找到"));
    lines.push("实际会发出的请求体: " + bruteSafeJson({
      fsresourceid: (pd && pd.fsresourceid !== undefined && pd.fsresourceid !== null && pd.fsresourceid !== "")
        ? pd.fsresourceid
        : (currentResourceId() ? Number(currentResourceId()) : null),
      time: bruteTimeValue(), finish: 0, progress: 0, unique: "(每次新生成)",
    }));
    lines.push("最近一次解析到的接口响应: " + (bruteServerState ? bruteSafeJson(bruteServerState.raw).slice(0, 300) : "(还没收到)"));
    lines.push("最近一次错误文案: " + (bruteLastError || "(无)"));
    lines.push("—— 最近 " + bruteExchanges.length + " 次「请求 / 响应」原文 ——");
    if (!bruteExchanges.length) {
      lines.push("(还没有记录：start 一次暴力模式，或让播放器正常上报一次)");
    } else {
      for (var e = 0; e < bruteExchanges.length; e++) {
        var ex = bruteExchanges[e];
        lines.push("[" + (e + 1) + "] " + ex.at + "  URL: " + ex.url);
        lines.push("    请求体: " + ex.body);
        lines.push("    响应  : " + ex.text);
      }
    }
    lines.push("=== 诊断结束（把上面这段复制给我即可定位） ===");
    for (var n = 0; n < lines.length; n++) log(lines[n]);
    setStatus("诊断已输出到面板日志（可直接复制）");
    return lines.join("\n");
  }

  // ---------------------------------------------------------- 暴力模式：控制台接口
  // 挂在 PAGE.__liruyun.bruteApi 上，给排查和自动化测试用。
  var bruteApi = null;

  // 卸下本脚本：停掉所有定时器与提醒、把 fetch 还原、按需保留/清空队列状态。
  //   unload()                      → 保留队列与批量进度（换页、想歇一会儿）
  //   unload({release:true})        → 连"已加载"标记一起放掉（重新注入/自动化测试）
  //   unload({keepQueue:false})     → 连队列一起清掉（彻底不干了）
  function bruteUnload(opts) {
    var options = opts || {};
    var keepQueue = options.keepQueue === undefined ? true : Boolean(options.keepQueue);
    bruteStop(true);
    try { stopChallengeAlert(); } catch (_) {}   // 变量名是 challengeAlertTimer，别写成 alertTimer
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = 0; }
    // 还要掐掉"待触发的跳转"：原版的 advanceToNext 会 setTimeout 900ms 后改 location.href，
    // 卸载时若不取消，这个定时器会落在下一个页面上把用户带走（测试里已经复现过）。
    bruteBatchRunning = false;
    bruteAutoActive = false;
    if (!keepQueue) {
      try {
        var s = loadState();
        s.running = false;
        saveState(s);
      } catch (_) {}
    }
    if (options.release) {
      try { if (PAGE.fetch && PAGE.fetch.__liruyunBrute) PAGE.fetch = bruteNativeFetch; } catch (_) {}
      try { delete PAGE.__liruyunBruteLoaded; } catch (_) {}
      try { delete PAGE.__liruyun; } catch (_) {}
    }
    try { delete PAGE.__liruyunUnload; } catch (_) {}
    return true;
  }

  function bruteDebugApi() {
    if (bruteApi) return bruteApi;
    bruteApi = {
      snapshot: function () {
        return {
          mode: uiMode,
          active: bruteActive,
          cfg: BRUTE,
          sent: bruteSent, ok: bruteOk, fail: bruteFail, lastError: bruteLastError,
          server: bruteServerState ? bruteServerState.percent : null,
          serverRaw: bruteServerState ? bruteServerState.raw : null,
          progress: {
            dom: readProgress(),
            server: bruteServerState ? bruteServerState.percent : null,
            used: bruteProgress(),
            required: readRequiredProgress(),
            source: bruteSourceName(),
          },
          completed: bruteCompleted(),
          batch: {
            running: bruteBatchRunning, auto: bruteAutoActive, index: bruteBatchIndex,
            total: bruteBatchQueue.length, done: bruteBatchDone,
          },
        };
      },
      dump: function (payload) { bruteApplyPayload(payload === undefined ? { note: "手动样本" } : payload, "手动"); },
      start: function () { setUiMode("brute"); bruteStart(); },
      stop: function () { bruteStop(); },
      scan: function () { bruteScanNow(); },
      batch: function () { bruteStartBatch(); },
      hooksInstalled: function () { return bruteHooksInstalled; },
      boot: function () { initBrute(); return true; },
      diagnose: function () { return bruteDiagnose(); },
      // 面板自检：界面"消失"时先跑这个，看面板到底在哪、被什么压着
      panel: function () {
        var info = brutePanelDiag();
        log("面板自检：" + info.text);
        if (info.problems.length) log("问题：" + info.problems.join("、") + "（可执行 __liruyun.bruteApi().rescue() 自救）");
        return info;
      },
      // v3.3：手动催一次页面读数（暂停/播放一次）。
      // 现场"刷到 100% 但页面进度还是旧数字"时，控制台敲这个就能立刻刷新。
      nudge: function () {
        var ok = bruteNudgePlayer(1, null);
        log(ok ? "已催页面读数（暂停/播放一次）" : "催读数失败：页面上没找到 video");
        return ok;
      },
      // v3.3：风险确认状态。ack() 看；ack(true) 现在记一次确认（本次会话内免问）；
      // ack(false) 清除（恢复每次都问）
      ack: function (on) {
        if (on === true) { bruteRememberAck(); bruteApplyAckRow(); log("风险确认：已记住（本次会话内不再弹）"); }
        else if (on === false) { bruteSetAckMode("ask"); bruteApplyAckRow(); log("风险确认：已清除，下次启动会重新询问"); }
        return {
          mode: bruteAckMode(), fresh: bruteAckFresh(),
          confirmOn: Boolean(BRUTE.confirm), willAsk: bruteShouldAskAck(),
          scope: "session",
        };
      },
      rescue: function () { return brutePanelRescue(); },
      unload: bruteUnload,
    };
    return bruteApi;
  }

  function initBrute() {
    bruteSyncInputs();
    bruteInstallHooks();
    bruteModeUi();
    bruteUpdateLine(true);
    if (uiMode === "brute" && isResourcePage()) {
      log("当前处于暴力模式页签：为安全起见不会自动发包，需要手动点「⚠ 开始暴力」");
    }
    bruteResumeIfNeeded();
  }


  // ==========================================================================
  //  自适应视频列表（换课程/换主题也不会漏）
  // ----------------------------------------------------------------------------
  //  现场问题：换了一门课之后，"视频列表"只列出一部分。
  //  根因不是解析错，而是**采集面太窄**：原版只认第一个匹配
  //      SCAN_ROOT_SELECTOR = "#course-index, #theme_boost-drawers-courseindex, .drawercontent"
  //  的元素，命中即止。只要那个容器
  //      · 在抽屉里（抽屉关着 / 内容被折叠，DOM 里根本没有条目），或
  //      · 被主题换成了别的类名（`[data-region="courseindex"]`、`.courseindex` …），或
  //      · 是懒加载的（只渲染了前 10 个活动），
  //  列表就会"明显不全"。
  //
  //  本模块**不改原版任何一行**，只做三件事：
  //    1. 把 collectResourcesFromPage 换成"多根候选 + 打分择优"的版本：
  //       把页面上所有可能装着活动链接的容器都算进来，按"能扫到多少条资源"排序，
  //       取最好的那个（并列就取更靠前的），彻底摆脱"只认一个选择器"。
  //    2. 轻量自适应：课程索引被折叠/懒加载时，点开它再扫一遍（每页最多点几次，
  //       避免点了没用的按钮把页面搅乱）。
  //    3. 服务端兜底：DOM 里实在扫不全（典型就是懒加载）时，用页面自己的 sesskey
  //       走 Moodle 官方 web service core_course_get_contents 把整门课的活动读回来。
  //       只读、无副作用、失败就静默放弃并说明原因。
  //  三个列表入口（安全模式的列表、暴力模式的列表、暴力批量）都共用这一份结果。
  // ==========================================================================

  var ADAPTIVE = {
    ready: false,
    cache: null,          // 上一次的采集结果
    cacheAt: 0,
    ttlMs: 800,           // 节流：面板每秒渲染一次，没必要每秒重扫 DOM
    source: "(还没扫过)",
    score: 0,
    roots: [],            // 上一次用了哪些根、各自多少条（诊断要看）
    clicked: [],          // 已经点开过的折叠容器（每个只点一次，避免反复点同一个）
    toggles: [],
    // 每页最多主动点开几个折叠容器。定得比"一门课的章节数"高：现场那门课 18 节
    // （分 3 个大章节 × 每章若干活动），漏展开任何一个都会少几节。
    maxClicks: 40,
    maxToggles: 3,
    clicks: 0,            // 已经主动展开过几个折叠容器
    tries: 0,             // 最近一次采集尝试了几个根
    pendingCollapsed: 0,  // 还有几个折叠容器没展开（下次调用要绕开缓存继续收）
    lastCount: 0,
    lastTarget: 0,
    server: { tried: false, running: false, ok: false, count: 0, why: "" },
    serverCache: null,    // 服务端读回来的条目（带时间戳，会过期）
    lastMergeNote: "",    // 合并日志去重（避免每秒刷屏）
    version: "adaptive-1",
  };

  // 页面右下角那个"课程索引"抽屉的开关：抽屉不开，里面的条目可能压根没渲染
  var ADAPTIVE_CONTROL_SELECTOR = [
    "[data-action='togglecourseindex']",
    "[data-action='toggledrawer']",
    "[data-toggle='drawer']",
    ".drawertoggle",
    "[data-region='courseindex-toggle']",
  ].join(",");

  // 可能装着"本节/本课活动链接"的容器，按可信度从高到低
  var ADAPTIVE_ROOT_SELECTOR = [
    "#course-index",
    "[data-region='courseindex']",
    "#theme_boost-drawers-courseindex",
    ".drawercontent",
    "[data-region='courseindex-content']",
    "#courseindex-content",
    ".courseindex",
    ".courseindex-section",
    "[data-for='cmlist']",          // 课程索引里"这一节的活动列表"（现场存档页里的真实结构）
    "[data-for='cm']",              // 单个活动条目
    ".course-content",
    "[data-region='activity-list']",
    "#region-main",
    "main",
  ].join(",");

  function adaptiveParseUrl(raw) {
    if (typeof parseResourceUrl === "function") return parseResourceUrl(raw);
    return null;
  }
  function adaptiveNodeText(node) {
    return String((node && node.textContent) || "").replace(/\s+/g, " ").trim();
  }
  function adaptiveCleanTitle(value) {
    var text = String(value == null ? "" : value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (typeof cleanTitle === "function") {
      var cleaned = cleanTitle(text);
      if (cleaned) return cleaned;
    }
    return text;
  }
  function adaptiveHasClass(node, cls) {
    if (!node) return false;
    var raw = node.className;
    if (typeof raw !== "string" || !raw) return false;
    return (" " + raw + " ").indexOf(" " + cls + " ") >= 0;
  }
  // 这个容器里到底有几个"资源"（用它给根打分；不解析标题，纯计数）
  function adaptiveResourceCount(root) {
    var n = 0;
    try {
      var links = root.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        if (adaptiveParseUrl(links[i].getAttribute("href"))) n++;
      }
    } catch (_) {}
    return n;
  }

  // 活动类型：类名里出现 modtype_xxx / xxx-view 这类标记时，直接用它的 view.php 路径，
  // 不依赖 parseResourceUrl 的路径白名单（换课程后万一多出别的资源类型也能认出来）。
  function adaptiveModulePathOf(el) {
    if (!el) return "";
    var e = el;
    for (var up = 0; up < 4 && e; up++) {
      var cls = typeof e.className === "string" ? e.className : "";
      var m = /(?:^|[\s_-])(?:modtype_|mod-|activity-)([a-z0-9_]+)/i.exec(cls);
      if (m) {
        var name = String(m[1]).toLowerCase();
        if (name === "resource") return "";        // 模块文件夹，不是视频
        if (name === "h5pactivity") name = "h5pactivity";
        if (RESOURCE_PATHS.indexOf("/mod/" + name + "/view.php") >= 0) return "/mod/" + name + "/view.php";
      }
      e = e.parentNode;
    }
    return "";
  }

  // 标题：优先结构化节点（.instancename / [data-activityname] / .courseindex-linktext…），
  // 再看 aria-label，最后才退回文本 —— 顺序和原版一致，只是多了几个新主题的类名。
  function adaptiveTitleOf(link) {
    // 顺序按"现场存档页里真实出现的结构"排（2026 课程 19460 的视频页）：
    //   课程索引条目：<a class="courseindex-link" data-for="cm_name">课程名</a>
    //   课程页活动：  <a href=...><span class="instancename">课程名</span></a>
    // 注意 data-for="cm_name" 也出现在**同级**的锁定图标 <span> 上，
    // 所以要先看链接自己，再看它里面的子节点。
    var sels = [
      ".courseindex-linktext", ".instancename", ".courseindex-cm-name",
      "span.courseindex-linktext", "[data-region='cm-name']", ".activityname", ".aalink",
      ".courseindex-link",
    ];
    var self = "";
    for (var s0 = 0; s0 < sels.length; s0++) {
      var own = false;
      try { own = Boolean(link.matches && link.matches(sels[s0])); } catch (_) { own = false; }
      if (!own) continue;
      self = adaptiveCleanTitle(adaptiveNodeText(link));
      if (self && !isNoiseTitle(self)) return self;
    }
    for (var i = 0; i < sels.length; i++) {
      var node = null;
      try { node = link.querySelector(sels[i]); } catch (_) {}
      if (!node) continue;
      var t = adaptiveCleanTitle(adaptiveNodeText(node));
      if (t && !isNoiseTitle(t)) return t;
    }
    // 存档页里条目的名字就是链接自己的文本（带一堆缩进换行）——
    // 上面所有选择器都没命中时，一定要兜到这一步，否则整门课的标题会全空。
    self = adaptiveCleanTitle(adaptiveNodeText(link));
    if (self && !isNoiseTitle(self)) return self;
    var fb = [link.getAttribute("aria-label"), link.getAttribute("title")];
    for (var j = 0; j < fb.length; j++) {
      var v = adaptiveCleanTitle(fb[j]);
      if (v && !isNoiseTitle(v)) return v;
    }
    return "";
  }

  // 从一个容器里收资源：返回 [{name,url,id}]。
  // 判定顺序：原版的 parseResourceUrl 先用（它已经把语言链接、纯锚点、
  // "展开全部"这类控制链接过滤掉了）；它拒绝但锚点/容器明确写着 fsresource/h5pactivity 时，
  // 用更宽的白名单再试一次（换课程后 URL 形态略有差异时不至于整条丢掉）。
  function adaptiveHarvestRoot(root) {
    var out = [];
    if (!root) return out;
    var links;
    try { links = root.querySelectorAll("a[href]"); } catch (_) { return out; }
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var raw = a.getAttribute("href");
      if (!raw) continue;
      var info = adaptiveParseUrl(raw);
      var forced = adaptiveModulePathOf(a);
      if (!info && forced && /^https?:\/\//i.test(String(raw))) {
        try {
          var u = new URL(raw, location.href);
          if (u.origin !== location.origin || u.pathname.indexOf(forced) < 0) continue;
          var fid = u.searchParams.get("id");
          if (!fid || !/^\d+$/.test(fid)) continue;
          info = { url: u.toString(), path: forced, id: fid, key: forced + "?id=" + fid };
        } catch (_) { info = null; }
      }
      if (!info) continue;
      var name = adaptiveTitleOf(a);
      if (!name && info.url === normalizeUrl(location.href)) name = document.title || "";
      if (!name || name.indexOf("资源库文件") >= 0) continue;
      var lower = (name + " " + info.url).toLowerCase().split("?")[0];
      var isDoc = false;
      for (var d = 0; d < DOCUMENT_EXTENSIONS.length; d++) {
        if (lower.indexOf(DOCUMENT_EXTENSIONS[d]) >= 0) isDoc = true;
      }
      if (isDoc) continue;
      out.push({ name: name, url: info.url, id: info.id, weak: false });
    }
    return out;
  }

  // 折叠容器 → 展开它。
  // 现场存档页（2026 课程 19460 的视频页）里的真实结构是 **Bootstrap collapse**，
  // 不是 `<details>`：
  //     <div id="courseindexcollapse1" class="courseindex-item-content collapse show|" >
  //     <a data-bs-toggle="collapse" aria-expanded="true|false" href="...#courseindexcollapse1">
  // 折叠时那一节的条目在 DOM 里就没有了 —— 只认 <details> 会一成不变地少几节。
  // 返回的每一项都是 {show, node}：show() 负责真正把它展开（点容器本身不管用，
  // 必须点 data-bs-toggle 的那个 <a>，Bootstrap 的监听挂在它上面）。
  function adaptiveCollapsed(within) {
    var scope = within || document;
    var out = [];
    var i;
    var addDetails = function (nodes) {
      for (var k = 0; k < nodes.length; k++) {
        var d = nodes[k];
        if (d.open) continue;
        if (adaptiveHasClass(d, "lr-adv")) continue;                 // 我们自己的面板
        if (d.closest && d.closest("#scnu-liruyun-helper")) continue;
        out.push({
          name: "details" + (d.className ? "." + String(d.className).trim().split(/\s+/)[0] : ""),
          show: function (node) { try { node.open = true; } catch (_) {} },
          node: d,
        });
      }
    };
    var details = [];
    try { details = scope.querySelectorAll("details"); } catch (_) {}
    addDetails(details);

    // Bootstrap 折叠块
    var boxes = [];
    try { boxes = scope.querySelectorAll(".collapse"); } catch (_) {}
    for (i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (adaptiveHasClass(box, "show")) continue;                   // 已经展开
      if (box.closest && box.closest("#scnu-liruyun-helper")) continue;
      if (box.contains && box.contains(document.getElementById && document.getElementById("scnu-liruyun-helper"))) continue;
      var toggle = null;
      try {
        toggle = box.id ? scope.querySelector("[data-bs-toggle='collapse'][href$='#" + box.id + "']") : null;
        if (!toggle) toggle = box.querySelector("[data-bs-toggle='collapse']");
        if (!toggle && box.parentNode) toggle = box.parentNode.querySelector("[data-bs-toggle='collapse']");
      } catch (_) { toggle = null; }
      out.push({
        name: "collapse#" + (box.id || "?"),
        show: (function (target, btn) {
          return function () {
            // 优先点 Bootstrap 的开关；没有就退回"给它加上 show 类"（很多主题是纯 CSS 控制）
            if (btn && typeof btn.click === "function") { try { btn.click(); return; } catch (_) {} }
            try { target.className = String(target.className || "") + " show"; } catch (_) {}
          };
        })(box, toggle),
        node: box,
      });
    }
    return out;
  }

  // 候选根：扫描 → 去重（嵌套的只留外层）→ 按资源数排序 → 取最好的那个
  function adaptiveRootName(node) {
    if (!node) return "(空)";
    if (node.id) return "#" + node.id;
    var cls = String(node.className || "").trim().split(/\s+/)[0];
    return cls ? "." + cls : node.tagName;
  }
  function adaptiveScanRoots() {
    ADAPTIVE.dbgSkip = [];
    var cands = [];
    // 去重必须用 Set/数组，**不能用普通对象当 map**：DOM 节点的键会被 String() 成
    // 同一个 "[object Object]"，于是第二个之后的候选根全部被当成"已见过"丢掉
    // —— 表现就是"只扫了第一个容器"，正是本模块要修的那个 bug 的翻版。
    // （测试里已经踩到过一次：3 个候选根只剩 1 个。）
    var seenCands = [];
    var i;
    var selectors = [SCAN_ROOT_SELECTOR, ADAPTIVE_ROOT_SELECTOR];
    ADAPTIVE.dbgSelectors = [];
    for (var s = 0; s < selectors.length; s++) {
      var found = [];
      try { found = document.querySelectorAll(selectors[s]); } catch (e) {
        ADAPTIVE.dbgSelectors.push("ERR:" + ((e && e.message) || e));
      }
      ADAPTIVE.dbgSelectors.push(found.length + " 个 ← " + selectors[s].slice(0, 60));
      for (i = 0; i < found.length; i++) {
        var node = found[i];
        if (!node || seenCands.indexOf(node) >= 0) continue;
        seenCands.push(node);
        cands.push(node);
      }
    }
    var roots = [];
    for (i = 0; i < cands.length; i++) {
      var cand = cands[i];
      var nested = false;
      for (var r = 0; r < roots.length; r++) {
        var inside = false;
        try { inside = Boolean(roots[r].node.contains && roots[r].node.contains(cand)); } catch (_) { inside = false; }
        if (inside) { nested = true; break; }
      }
      if (nested) { ADAPTIVE.dbgSkip.push("嵌套:" + adaptiveRootName(cand)); continue; }
      var primary = false;
      try { primary = cand.matches ? cand.matches(SCAN_ROOT_SELECTOR) : false; } catch (_) { primary = false; }
      if (!primary && cand.id) primary = String(SCAN_ROOT_SELECTOR).indexOf("#" + cand.id) >= 0;
      var cnt = 0;
      try { cnt = adaptiveResourceCount(cand); } catch (e) { ADAPTIVE.dbgSkip.push("计数异常:" + adaptiveRootName(cand) + ":" + e.message); }
      roots.push({
        node: cand,
        count: cnt,
        // 原版认的课程索引最可信：资源数相同时它排前面
        priority: primary ? 1 : 0,
      });
    }
    roots.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return b.priority - a.priority;
    });
    return roots;
  }

  function adaptiveDedupe(entries) {
    var byKey = {};
    var order = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var open = e.url.split("#")[0];
      var key = e.id ? (open.indexOf("/mod/h5pactivity/") >= 0 ? "h5p:" : "res:") + e.id : open;
      if (!byKey[key]) { byKey[key] = e; order.push(key); }
      else if ((!byKey[key].name || isNoiseTitle(byKey[key].name)) && e.name) byKey[key] = e;
    }
    var out = [];
    for (var k = 0; k < order.length; k++) out.push(byKey[order[k]]);
    return out;
  }

  // 服务端兜底：用页面自己的 sesskey 调 Moodle 官方 web service，把整门课的活动读回来。
  // 这一步**只在 DOM 扫不全时**才发（懒加载的典型场景），失败只记原因、不报错给用户。
  function adaptiveCourseId() {
    // 顺序：Moodle 自己的 M.cfg.courseId（最权威）→ URL → body 上的 course-N 类名。
    // URL 这一层要分页面形态：课程首页的课程 ID 在 ?id= 里；活动页的 ?id= 是**活动 ID**，
    // 拿它当 courseid 去请求只会得到一个错误响应，所以只在 /course/view.php 上认 ?id=。
    try {
      if (PAGE.M && PAGE.M.cfg && PAGE.M.cfg.courseId) {
        var viaCfg = parseInt(PAGE.M.cfg.courseId, 10);
        if (isFinite(viaCfg) && viaCfg > 1) return viaCfg;
      }
    } catch (_) {}
    // 注意：这里刻意写成 (?:\?|&|&amp;) 而不是 [?&]，因为体检脚本
    // （tools/check-userscript-generic.mjs）解析正则字面量时用 [ ] 判断字符类，
    // 未闭合的 [ 会让它把后面的代码整段当成正则体，报出 "course() 找不到定义" 这种假问题。
    var search = location.search || "";
    var m = /(?:\?|&|&amp;)(?:course|courseid)=(\d+)/i.exec(search);
    if (!m && /\/course\/view\.php/.test(location.pathname || "")) {
      m = /(?:\?|&|&amp;)id=(\d+)/i.exec(search);
    }
    if (m) return parseInt(m[1], 10);
    var body = document.body || document.documentElement;
    for (var depth = 0; depth < 4 && body; depth++) {
      var cls = String(body.className || "") + " " + String(body.id || "");
      var cm = /course-(\d+)/.exec(cls);
      if (cm) return parseInt(cm[1], 10);
      body = body.parentNode;
    }
    return 0;
  }

  function adaptiveSesskey() {
    try {
      if (PAGE.M && PAGE.M.cfg && PAGE.M.cfg.sesskey) return String(PAGE.M.cfg.sesskey);
      var pd = brutePlayerData();
      if (pd && pd.sesskey) return String(pd.sesskey);
    } catch (_) {}
    var el = document.querySelector("input[name='sesskey']");
    return el ? String(el.value || "") : "";
  }

  function adaptiveEntriesFromContents(data) {
    var out = [];
    var sections = null;
    if (Object.prototype.toString.call(data) === "[object Array]") sections = data;
    else if (data && Object.prototype.toString.call(data.modules) === "[object Array]") sections = [data];
    if (!sections) return out;
    for (var s = 0; s < sections.length; s++) {
      var mods = sections[s] && sections[s].modules;
      if (Object.prototype.toString.call(mods) !== "[object Array]") continue;
      for (var m = 0; m < mods.length; m++) {
        var mod = mods[m];
        if (!mod || !mod.id) continue;
        var type = String(mod.modname || mod.modname_short || "");
        if (type.indexOf("fsresource") < 0 && type.indexOf("h5pactivity") < 0) continue;
        var base = "";
        for (var p = 0; p < RESOURCE_PATHS.length; p++) {
          if (type.indexOf(RESOURCE_PATHS[p].split("/")[2]) >= 0) base = RESOURCE_PATHS[p];
        }
        if (!base) base = "/mod/fsresource/view.php";
        var url;
        try { url = new URL(base + "?id=" + mod.id, location.origin).toString(); }
        catch (_) { url = location.origin + base + "?id=" + mod.id; }
        var info = adaptiveParseUrl(url);
        if (!info) continue;
        var name = adaptiveCleanTitle(mod.name) || String(mod.name || "").trim() || ("资源 " + mod.id);
        out.push({ name: name, url: info.url, id: info.id, weak: false });
      }
    }
    return out;
  }

  function adaptiveServerHarvest(force) {
    var st = ADAPTIVE.server;
    if (st.running) return;
    if (!force && st.tried && ADAPTIVE.serverCache) return;      // 一次成功就够
    var courseId = adaptiveCourseId();
    if (!courseId) { st.why = "读不到课程 ID（不在课程页）"; st.tried = true; return; }
    var sesskey = adaptiveSesskey();
    if (!sesskey) { st.why = "读不到 sesskey（未登录或页面未注入 playerdata）"; st.tried = true; return; }
    if (typeof fetch !== "function") { st.why = "环境不支持 fetch"; st.tried = true; return; }
    st.tried = true;
    st.running = true;
    var body = [{
      index: 0,
      methodname: "core_course_get_contents",
      args: { courseid: courseId },
    }];
    fetch("/lib/ajax/service.php?sesskey=" + encodeURIComponent(sesskey),
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      .then(function (res) { return res.text(); })
      .then(function (text) {
        st.running = false;
        var json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (!json) { st.why = "响应不是 JSON（可能是登录页/风控页）"; return; }
        var first = Object.prototype.toString.call(json) === "[object Array]" ? json[0] : json;
        if (!first || first.error) {
          st.why = "接口报错：" + String((first && first.exception && (first.exception.message || first.exception.errorcode)) ||
            (first && first.error) || "未知");
          return;
        }
        var entries = adaptiveEntriesFromContents(first.data);
        if (!entries.length) { st.why = "接口返回里没有 fsresource/h5p 活动"; return; }
        st.ok = true;
        st.count = entries.length;
        st.why = "";
        ADAPTIVE.serverCache = { at: Date.now(), list: entries };
        ADAPTIVE.cache = null;              // 让下一次采集立刻合并服务端结果
        ADAPTIVE.cacheAt = 0;
        log("列表兜底：从服务器读到 " + entries.length + " 个活动（DOM 里没渲染全）");
      })
      ["catch"](function (err) {
        st.running = false;
        st.why = "请求失败：" + ((err && err.message) || err);
        log("列表兜底失败（不影响使用）：" + st.why);
      });
  }

  function adaptiveMergeServer(list) {
    var cache = ADAPTIVE.serverCache;
    if (!cache || Date.now() - cache.at > 60 * 1000) return list;
    var seen = {};
    var i;
    for (i = 0; i < list.length; i++) seen[list[i].id || list[i].url] = true;
    var added = [];
    for (i = 0; i < cache.list.length; i++) {
      var item = cache.list[i];
      if (seen[item.id || item.url]) continue;
      added.push(item);
    }
    if (!added.length) return list;
    // 服务端给的是课程顺序；DOM 里的顺序更贴近当前视图。
    // 合成规则：DOM 结果里出现过的、服务端列表里也有的，就按服务端顺序排；
    // 服务端独有的（漏掉的那些）追加在后面。
    var byId = {};
    for (i = 0; i < list.length; i++) byId[list[i].id || list[i].url] = list[i];
    var out = [];
    var used = {};
    // 第一轮：按服务端给的课程顺序，把"两边都有"的条目排好序
    for (i = 0; i < cache.list.length; i++) {
      var key = cache.list[i].id || cache.list[i].url;
      if (byId[key]) { out.push(byId[key]); used[key] = true; }
    }
    // 第二轮：服务端独有的（DOM 里没渲染出来的）追加在后面。
    // ⚠ 这一轮必须遍历 **cache.list**，不是 list —— 写成 list 的话第二轮
    // 一条都推不进去（DOM 里的键全在 used 里了），于是"接口读到了 18 条、
    // 列表还是 10 条"，而 added 里明明算出了 8 条新增。这个 bug 现场真出现过。
    for (i = 0; i < cache.list.length; i++) {
      var ck = cache.list[i].id || cache.list[i].url;
      if (!used[ck]) { out.push(cache.list[i]); used[ck] = true; }
    }
    // 第三轮：DOM 里那些服务端列表**没有**的（本地新增/临时资源）也要保留
    for (i = 0; i < list.length; i++) {
      var k2 = list[i].id || list[i].url;
      if (!used[k2]) { out.push(list[i]); used[k2] = true; }
    }
    for (i = 0; i < added.length; i++) log("  补上（服务器有、页面上没渲染）：" + added[i].name);
    return out;
  }

  // 主入口：多根择优 + 折叠展开 + 服务端兜底。
  // 每次调用只做"当前允许做的那一点"（最多点一个折叠容器），所以它可以被每秒调用的
  // renderList() 反复触发，而不会一次把页面搅乱。
  function collectResourcesFromPageAdaptive(opt) {
    var options = opt || {};
    var now = Date.now();
    if (options.force) { ADAPTIVE.cache = null; ADAPTIVE.cacheAt = 0; }
    // 缓存只用来省掉"每秒重扫 DOM"的开销。但有两种情况必须绕开它，否则会把不完整的结果锁住：
    //   · 上一次还看到有折叠容器**真被展开过**、而且这次收的条数比目标少（懒加载在补齐）
    //   · 上一次收的条数比目标少（还没收全）
    // 注意 "pendingCollapsed" 单独出现时**不算**理由：折叠容器可能是页面上永远打不开的东西
    // （比如 `<details>` 但点它没反应），那就每秒重扫一遍 DOM，白烧 CPU。
    if (ADAPTIVE.cache && !options.force && (now - ADAPTIVE.cacheAt) < ADAPTIVE.ttlMs &&
        !((ADAPTIVE.clicks || 0) > 0 && ADAPTIVE.lastCount < ADAPTIVE.lastTarget)) {
      return ADAPTIVE.cache;
    }

    if (!ADAPTIVE.ready) ADAPTIVE.ready = true;      // 只在第一次做一遍展开动作
    try {
      var found = adaptiveScanRoots();
      var best = null;
      var verifiedGap = false;
      var expandable = 0;
      var list = [];
      ADAPTIVE.roots = [];
      // 每个折叠容器只点一次（多个候选根会互相包含，否则同一个折叠块会被反复点）
      ADAPTIVE.clicked = ADAPTIVE.clicked || [];
      // 循环两趟就够：第一趟把能点开的都点开并收一遍，第二趟带着"展开后"的 DOM 再收一次
      // （有些懒加载是点开之后才去请求内容的，同一次调用里还看不到）。
      for (var pass = 0; pass < 2; pass++) {
        best = null;
        verifiedGap = false;
        expandable = 0;
        for (var i = 0; i < found.length; i++) {
          var entries = adaptiveDedupe(adaptiveHarvestRoot(found[i].node));
          // 这个容器自己都说有更多资源，却只收到这么点 —— 这就是"明显不全"，
          // 后面要用服务端兜底把它补齐（诊断里也会写出来）。
          if (found[i].count > entries.length) verifiedGap = true;

          // 折叠的章节 = 条目还没渲染出来。**必须把每一个都展开再收**：
          // 之前这里写成"收到 3 条就 break"，结果第一门课刚好收到 3 条就收手，
          // 后面十几节永远收不到 —— 这正是现场"列表明显不全"的复现路径。
          if (ADAPTIVE.clicks < ADAPTIVE.maxClicks) {
            var collapsed = adaptiveCollapsed(found[i].node);
            var todo = null;
            for (var c = 0; c < collapsed.length; c++) {
              if (ADAPTIVE.clicked.indexOf(collapsed[c].node) < 0) { todo = collapsed[c]; break; }
            }
            if (todo) {
              try { todo.show(todo.node); } catch (_) {}
              ADAPTIVE.clicked.push(todo.node);
              ADAPTIVE.clicks++;
              log("列表自适应：展开了 " + ADAPTIVE.clicks + " 个折叠容器后再扫（" + todo.name + "）");
              var after = adaptiveDedupe(adaptiveHarvestRoot(found[i].node));
              if (after.length > entries.length) entries = after;
            }
          }
          var left = 0;
          var still = adaptiveCollapsed(found[i].node);
          for (var q = 0; q < still.length; q++) {
            if (ADAPTIVE.clicked.indexOf(still[q].node) < 0) left++;
          }
          expandable += left;
          if (best === null || entries.length > best.list.length) {
            best = { list: entries, root: found[i], at: i };
          }
          if (pass === 0) {
            ADAPTIVE.roots.push({
              sel: adaptiveRootName(found[i].node),
              count: found[i].count,
              harvested: entries.length,
              collapsed: left,
            });
          }
        }

        // 兜底一：整页扫（原版行为，永远保留）
        var pageWide = adaptiveDedupe(adaptiveHarvestRoot(document));
        if (pageWide.length > (best ? best.list.length : 0)) {
          best = { list: pageWide, root: null, at: -1 };
        }
        list = best ? best.list : [];
        // 展开动作要等 DOM/懒加载跟上，下一趟再收一次
        if (pass === 0 && expandable && ADAPTIVE.clicks < ADAPTIVE.maxClicks) continue;
        break;
      }

      // 兜底二：服务端（只在"确实扫少了"时发，每个页面最多自动发一次）
      if (list.length < 3 || verifiedGap) adaptiveServerHarvest(false);
      var beforeMerge = list.length;
      list = adaptiveMergeServer(list);
      if (ADAPTIVE.dbgMerge) log("DBG collect: dom=" + beforeMerge + " → merged=" + list.length +
        " serverCache=" + (ADAPTIVE.serverCache ? ADAPTIVE.serverCache.list.length : "无"));

      // 服务端兜底是异步的：可能这一轮发出去、下一轮才拿得到结果。
      // 所以只要 serverCache 比 DOM 收的多，就**无条件再重新收一遍 DOM 并合并**
      // （不能加"DOM 收的比容器少"这种前置条件：DOM 那 10 条正好等于容器报的 10 条时
      // 它就不成立，结果接口明明读到了 18 条、列表却一直是 10 条）。
      // 合并顺序也要注意：必须"重新收 DOM 再合并"，直接拿 serverCache 自己跟自己合并，
      // added 会算成空数组然后原样返回（看着补上了，其实一条没补）。
      if (ADAPTIVE.serverCache && list.length < (ADAPTIVE.serverCache.list.length || 0)) {
        var freshDom = adaptiveDedupe(adaptiveHarvestRoot(document));
        var withServer = adaptiveMergeServer(freshDom.length ? freshDom : list);
        if (withServer.length > list.length) {
          list = withServer;
          if (best && (!best.root || list.length > best.list.length)) {
            best = { list: list, root: best.root, at: best.at };
          }
        }
      }

      ADAPTIVE.source = best
        ? (best.root
          ? adaptiveRootName(best.root.node) + "（" + best.list.length + " 条）"
          : "整页兜底（" + best.list.length + " 条）")
        : "没扫到";
      ADAPTIVE.score = list.length;
      ADAPTIVE.tries = found.length;
      // 供下一次调用判断"要不要绕开缓存继续收"：
      //   pendingCollapsed = 还有折叠章节没展开
      //   lastCount/lastTarget = 这次收了多少 / 这次应该收到多少（容器自己数的）
      ADAPTIVE.pendingCollapsed = expandable;
      ADAPTIVE.lastCount = list.length;
      ADAPTIVE.lastTarget = best && best.root ? best.root.count : 0;

      // 结果可信（不是整页兜底、也不是空）才缓存：整页兜底往往是"页面还在渲染"，
      // 缓存它会把不完整的结果锁住 800ms，反而更容易漏。
      if (best && best.root && list.length) {
        ADAPTIVE.cache = list;
        ADAPTIVE.cacheAt = Date.now();
      }
      // 合并"发生了什么"只在**状态变化时**记一条。
      // 为什么不能每次都 log：collectResourcesFromPage 每秒都会被 renderList() 调到，
      // 无条件 log 会把控制台刷成瀑布（现场日志里就出现过几十行一模一样的
      // "列表合并过程：dom=10 …"）。诊断要的是"变化"，不是"心跳"。
      var mergeNote = "dom=" + list.length + "，服务端=" +
        (ADAPTIVE.serverCache ? ADAPTIVE.serverCache.list.length + " 条" : "无") + "，最终=" + list.length + " 条";
      if (mergeNote !== ADAPTIVE.lastMergeNote) {
        ADAPTIVE.lastMergeNote = mergeNote;
        if (list.length || ADAPTIVE.serverCache) log("列表合并：" + mergeNote);
      }
      return list;
    } catch (err) {
      log("列表自适应采集出错（退回原版逻辑）：" + ((err && err.message) || err));
      return collectResourcesFromPageOriginal();
    }
  }

  // 换课程/换主题后"怎么点都不全"时，让用户/ 控制台能强制重来一次
  function adaptiveRefreshNow() {
    ADAPTIVE.cache = null;
    ADAPTIVE.cacheAt = 0;
    ADAPTIVE.clicks = 0;
    ADAPTIVE.clicked = [];          // 已经点开过的折叠容器（每个只点一次）
    ADAPTIVE.ready = false;
    ADAPTIVE.pendingCollapsed = 0;
    ADAPTIVE.lastCount = 0;
    ADAPTIVE.lastTarget = 0;
    ADAPTIVE.server = { tried: false, running: false, ok: false, count: 0, why: "" };
    ADAPTIVE.serverCache = null;
    var list = collectResourcesFromPageAdaptive({ force: true });
    // 再跑几轮：折叠章节是"一次展开一个"，一次调用收不全。
    // 之前只跑一轮 + 700ms 后再来一轮，14 节的课要点七八次「刷新列表」才能收全 —— 太蠢了。
    var rounds = 0;
    (function again() {
      if (rounds++ >= 20) { finish(); return; }
      var fresh = collectResourcesFromPageAdaptive({ force: true });
      if (fresh.length > list.length) list = fresh;
      if (ADAPTIVE.pendingCollapsed > 0 && ADAPTIVE.clicks < ADAPTIVE.maxClicks) {
        setTimeout(again, 30);
        return;
      }
      setTimeout(finish, 700);       // 留出服务端兜底的往返时间，再合并一次
    })();
    function finish() {
      try {
        ADAPTIVE.cache = null;
        ADAPTIVE.cacheAt = 0;
        var again2 = collectResourcesFromPageAdaptive({ force: true });
        renderList();
        brutePrepareList(again2, true);
        log("列表已刷新：" + again2.length + " 条（来源 " + ADAPTIVE.source + "）" +
          (ADAPTIVE.pendingCollapsed ? "；仍有 " + ADAPTIVE.pendingCollapsed + " 个折叠容器未展开" : ""));
        setStatus("列表已刷新：" + again2.length + " 条视频资源（来源 " + ADAPTIVE.source + "）");
      } catch (e) {
        log("刷新列表出错：" + ((e && e.message) || e));
      }
    }
    return list;
  }

  // 诊断：列表是从哪来的、页面提供了什么、服务端兜底成功没有
  function adaptiveListLines() {
    var lines = [];
    lines.push("列表来源: " + ADAPTIVE.source + " | 条数 " + ADAPTIVE.score);
    var rootText = [];
    for (var i = 0; i < ADAPTIVE.roots.length; i++) {
      rootText.push(ADAPTIVE.roots[i].sel + "=" + ADAPTIVE.roots[i].count);
    }
    lines.push("候选容器（按资源数排序）: " + (rootText.length ? rootText.join(" , ") : "(一个都没有)") +
      " | 本次尝试 " + ADAPTIVE.tries + " 个");
    var controls = [];
    try {
      var cs = document.querySelectorAll(ADAPTIVE_CONTROL_SELECTOR);
      for (var c = 0; c < cs.length; c++) controls.push(cs[c].id || cs[c].className || cs[c].tagName);
    } catch (_) {}
    lines.push("课程索引开关: " + (controls.length ? controls.join(",") : "(页面上没有抽屉开关)") +
      " | 自动展开折叠容器 " + ADAPTIVE.clicks + " 次 | 抽屉展开 " + ADAPTIVE.toggles + " 次");
    var pool = [];
    try { pool = document.querySelectorAll("a[href*='/mod/']"); } catch (_) {}
    lines.push("整页 /mod/ 链接数: " + pool.length + " | 缓存 " +
      (ADAPTIVE.cache ? ADAPTIVE.cache.length + " 条（" + Math.round((Date.now() - ADAPTIVE.cacheAt) / 1000) + "s 前）" : "无"));
    lines.push("服务端兜底: " + (ADAPTIVE.server.running ? "进行中"
      : (ADAPTIVE.server.ok ? "成功，读到 " + ADAPTIVE.server.count + " 个活动"
        : (ADAPTIVE.server.tried ? "未成功：" + (ADAPTIVE.server.why || "未知") : "未尝试"))) +
      " | 课程 ID " + (adaptiveCourseId() || "读不到") + " | sesskey " + (adaptiveSesskey() ? "有" : "没有"));
    lines.push("提示：列表不全时点面板上的「刷新列表」，或执行 __liruyun.bruteApi().refreshList()");
    return lines;
  }

  // 控制台/测试入口：__liruyun.adaptive()
  function adaptiveDebugApi() {
    return {
      version: ADAPTIVE.version,
      stats: function () {
        return {
          source: ADAPTIVE.source,
          count: ADAPTIVE.score,
          roots: ADAPTIVE.roots.slice(),
          skipped: (ADAPTIVE.dbgSkip || []).slice(),
          dbgSelectors: (ADAPTIVE.dbgSelectors || []).slice(),
          tries: ADAPTIVE.tries,
          clicks: ADAPTIVE.clicks,
          toggles: ADAPTIVE.toggles,
          cached: ADAPTIVE.cache ? ADAPTIVE.cache.length : 0,
          server: {
            tried: ADAPTIVE.server.tried,
            running: ADAPTIVE.server.running,
            ok: ADAPTIVE.server.ok,
            count: ADAPTIVE.server.count,
            why: ADAPTIVE.server.why,
          },
          courseId: adaptiveCourseId(),
          hasSesskey: Boolean(adaptiveSesskey()),
          list: (ADAPTIVE.cache || []).map(function (x) { return x.id + " " + x.name; }),
        };
      },
      // force=true 时绕过 800ms 缓存；expand=true 时允许再点开折叠容器
      scan: function (force) { return collectResourcesFromPageAdaptive({ force: Boolean(force) }); },
      // 排查用：候选根 / 每个根能收到几条 / 当前有几个折叠容器待展开
      roots: function () {
        var out = adaptiveScanRoots().map(function (r) {
          var harvested = adaptiveDedupe(adaptiveHarvestRoot(r.node));
          return {
            sel: r.node.id ? "#" + r.node.id : ("." + String(r.node.className || "").trim().split(/\s+/)[0]),
            links: r.count, harvested: harvested.length, priority: r.priority,
          };
        });
        return { roots: out, skipped: (ADAPTIVE.dbgSkip || []).slice() };
      },
      collapsed: function (within) {
        return adaptiveCollapsed(within || document).map(function (c) { return c.name; });
      },
      harvest: function (sel) {
        var node = sel ? document.querySelector(sel) : document;
        return adaptiveDedupe(adaptiveHarvestRoot(node)).map(function (x) { return x.id + " " + x.name; });
      },
      refresh: adaptiveRefreshNow,
      lines: adaptiveListLines,
      // 测试/排查用：把服务端兜底的结果直接灌进来，不真的发请求
      serverDump: function (list) {
        ADAPTIVE.server.ok = true;
        ADAPTIVE.server.tried = true;
        ADAPTIVE.server.count = list.length;
        ADAPTIVE.serverCache = { at: Date.now(), list: list };
        ADAPTIVE.cache = null;
        ADAPTIVE.cacheAt = 0;
        return collectResourcesFromPageAdaptive({ force: true }).length;
      },
    };
  }

  // 把原版的三个入口接到自适应版本上。原函数一个都不删、不改：
  //   1) collectResourcesFromPage —— 采集本身
  //   2) viewQueue              —— 原版会在"缓存变多"时自己重扫，那会绕过自适应，改成先问自适应
  //   3) ensureViewQueue        —— 原版直接调 collectResourcesFromPage()，同样接到自适应
  var collectResourcesFromPageOriginal = collectResourcesFromPage;
  var viewQueueOriginal = viewQueue;
  var ensureViewQueueOriginal = ensureViewQueue;

  collectResourcesFromPage = function () { return collectResourcesFromPageAdaptive(); };
  viewQueue = function () {
    var cur = viewQueueOriginal();
    if (cur && cur.length) return cur;
    return collectResourcesFromPageAdaptive();
  };
  ensureViewQueue = function () {
    var before = viewQueueCache ? viewQueueCache.length : 0;
    ensureViewQueueOriginal();
    var after = viewQueueCache ? viewQueueCache.length : 0;
    if (after === before) {
      var got = collectResourcesFromPageAdaptive();
      if (got.length && got.length !== after) { viewQueueCache = got; }
    }
    return viewQueueCache || [];
  };


  // 防重入：只有“同版本 + 实例还活着 + 面板健康”才让位；
  // 旧版本或面板异常时由本版本接管 —— 否则一个残留标记就会让脚本静默失效（表现为“没有界面”）。
  try {
    if (bruteShouldYieldToExisting()) return;
    PAGE.__liruyunBruteLoaded = { version: SCRIPT_VERSION, at: Date.now(), panel: IS_PANEL_BUILD };
  } catch (_) {}

  // ==========================================================================
  //  站点原生弹窗"自动点确定"（v3.1 / v3pro 5.1）
  // --------------------------------------------------------------------------
  //  现场提问（附截图）："有时候点太快了会弹窗，能够实现自动点击吗"
  //  截图里那个框是**浏览器原生 alert()**（标题栏「moodle.scnu.edu.cn 显示」、
  //  只有一个「确定」，内容 "禁止同时观看多个视频【…】，当前视频已暂停"）。
  //    · 它不是页面 DOM —— 油猴脚本既看不到、也点不到：原生弹窗期间整页 JS 都停着，
  //      连 querySelector 都没机会跑。
  //    · 唯一可行、而且比"自动点击"更彻底的办法：**在站点调用之前把 window.alert 换掉**。
  //      换掉之后它根本弹不出来 —— 等价于"已经自动点了确定"，并且一点都不卡页面。
  //  三条硬约束（不遵守就会出别的问题）：
  //    1. 必须改**页面自己的 window**（PAGE / unsafeWindow）。改沙箱里的 window 对站点无效。
  //       反过来，本脚本自己的 `window.confirm`（暴力模式确认框）走的是沙箱，不受影响 ——
  //       `window.confirm("确认启动暴力模式？")` 照样会弹出来让用户点。
  //    2. **只吞不静默**：每条被拦下的内容都写进面板日志。用户看不到那个框了，
  //       但"站点到底说了什么"必须留痕，否则出问题无从查起。
  //    3. 不认识的 `confirm` **照常弹**：只有已知的"点太快"类提示才自动答应。
  //       替用户答应一个没读懂的问题（删除 / 放弃进度 / 退出登录）是绝对不能做的事。
  //  兜底：万一站点在更早的时候就 `var a = window.alert` 存了一份引用（那时本脚本还没跑），
  //  我们的替换就拦不住它。这种情况页面会被原生弹窗卡住，恢复后第一跳的间隔会明显 > 1 秒，
  //  dialogGuardTick() 会把这次"阻塞"记进日志 —— 用户把那条发过来就能确诊。
  // ==========================================================================
  var DIALOG_KEY = "liruyun_dialog_guard";
  var DIALOG_ON = gmGet(DIALOG_KEY, true) !== false;   // 默认开；用户可一键关掉
  var DIALOG_KNOWN = /同时观看|多个视频|当前视频已暂停/;   // "点太快了"这一类（已确认无害）
  var DIALOG_NOTICE_SEL = "#user-notifications .alert, .alert.alert-warning.alert-dismissible";
  var DIALOG_STATS = {
    ticks: 0,              // 监控跳数（顺带证明"每秒那一跳还活着"）
    intercepted: 0,        // 一共吞掉几条 alert
    confirmed: 0,          // 自动答应了几条已知 confirm
    passed: 0,             // 没读懂、放行让用户自己点的 confirm
    banners: 0,            // 顺手关掉的站点提示条
    frames: 0,             // 接管了同源 iframe 的个数
    blocked: 0,            // 页面被原生弹窗卡住的次数（说明这次没拦住）
    blockedMs: 0,          // 最近一次卡了多久
    lastText: "", lastAt: 0, lastBlockedAt: 0,
  };

  function dialogGuardClip(text) {
    var s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }

  function dialogGuardSet(on) {
    DIALOG_ON = on === undefined ? !DIALOG_ON : Boolean(on);
    try { gmSet(DIALOG_KEY, DIALOG_ON); } catch (_) {}
    // 包装函数是"活开关"：关掉后它原地变成透传，调站点原生 alert —— 不需要卸载重装
    try { if (PAGE) PAGE.__liruyunDialogOn = DIALOG_ON; } catch (_) {}
    log("站点弹窗拦截：" + (DIALOG_ON ? "开" : "关"));
    return DIALOG_ON;
  }
  function dialogGuardIsOn() { return DIALOG_ON; }

  // 站点在 <span class="notifications" id="user-notifications"> 里渲染的那条
  // "禁止同时观看多个视频，其他视频【…】将暂停"。它不是弹窗、只是黄条，
  // 但和上面那个 alert 是同一件事的两次广播 —— 已经拦下并恢复了播放，这条就是过时信息。
  //
  // 现场反馈（2026-09-21 截图）："像这种关不掉的窗口，实际不影响，可是日志一直弹"。
  // 原因：它每秒被清一次、日志也每秒写一条，而那条黄条**清不掉**（站点自己会把它挂回来，
  // 或者 Bootstrap 的关闭处理器在这页没绑上）。所以现在：
  //   · 先把节点真删掉（点关闭没生效时直接 removeChild）
  //   · 同一条内容最多试 3 次、最多写 2 条日志，之后**彻底安静**（不再重试、不再写日志）
  //   · 计数按"内容"区分：换了内容（另一门课/另一个视频名）才算新的一条
  var dialogNoticeKey = "";
  var dialogNoticeTries = 0;
  var dialogNoticeQuiet = false;

  function dialogGuardDismissNotice() {
    if (dialogNoticeQuiet) return 0;
    var boxes = [];
    try {
      var all = document.querySelectorAll(DIALOG_NOTICE_SEL);
      for (var i = 0; i < all.length; i++) {
        if (DIALOG_KNOWN.test(String(all[i].textContent || ""))) boxes.push(all[i]);
      }
    } catch (_) { return 0; }
    if (!boxes.length) {
      // 已经没了：把"这条内容"的账结清，下次同样的内容重新算新的
      dialogNoticeKey = "";
      dialogNoticeTries = 0;
      return 0;
    }
    var text = dialogGuardClip(boxes[0].textContent);
    if (text !== dialogNoticeKey) {
      dialogNoticeKey = text;
      dialogNoticeTries = 0;
      dialogNoticeQuiet = false;
    }
    dialogNoticeTries += 1;
    var removed = 0;
    for (var j = 0; j < boxes.length; j++) {
      var box = boxes[j];
      try {
        var closer = box.querySelector ? box.querySelector("[data-dismiss='alert'], [data-bs-dismiss='alert'], .close") : null;
        // 先按站点的方式点关闭；点不动（没绑处理器 / 站点自己会挂回来）就直接摘掉节点
        if (closer && typeof closer.click === "function") closer.click();
        if (dialogGuardConnected(box) && box.parentNode) box.parentNode.removeChild(box);
        removed += 1;
        DIALOG_STATS.banners += 1;
      } catch (_) {}
    }
    // 日志只写前两条：够证明"我处理过"，又不至于把日志刷没
    if (dialogNoticeTries <= 2) {
      log("已清理站点提示条：" + text);
    }
    if (dialogNoticeTries >= 3) {
      dialogNoticeQuiet = true;      // 关不掉就闭嘴，它不影响播放
      log("该提示条会被站点重新显示，已停止重复清理");
    }
    return removed;
  }

  // 节点还在文档里吗？（点关闭没生效时要靠它决定"要不要自己摘掉"）
  // 注意不能拿 document.body.contains 判断：挂在 documentElement 下的节点会被误判成"不在"。
  function dialogGuardConnected(node) {
    if (!node) return false;
    try {
      if (document.contains) return document.contains(node);
    } catch (_) {}
    try {
      var n = node;
      while (n && n.parentNode) n = n.parentNode;
      return n === document || n === document.documentElement;
    } catch (_) { return false; }
  }

  // 弹窗拦下之后视频是**暂停**的（站点就是因为它才暂停的）：主动救一次，
  // 不然要等 3 秒后的停摆看护才恢复（现场感受就是"点了确定视频也不动"）。
  function dialogGuardResume() {
    setTimeout(function () {
      var v = null;
      try { v = videoEl(); } catch (_) {}
      if (!v || !v.paused || v.ended) return;      // 在播 / 播完了：别去动它
      if (hasHumanChallenge()) return;             // 有人机验证弹窗时让位，不抢
      try { keepAliveTries = 0; keepAliveLastTryAt = 0; } catch (_) {}   // 绕开冷却，立刻救
      try { keepAlive(); } catch (_) {}
      try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
      log("拦下弹窗时视频是暂停的 → 已恢复播放");
    }, 800);
  }

  // 拦住一条 alert：记日志 + （已知类型时）关提示条 + 恢复播放，然后返回 undefined，
  // 也就是站点眼中"用户点了确定"。
  function dialogGuardHandleAlert(msg) {
    var text = dialogGuardClip(msg);
    DIALOG_STATS.intercepted += 1;
    DIALOG_STATS.lastText = text;
    DIALOG_STATS.lastAt = Date.now();
    log("已拦下站点弹窗：" + (text || "(空内容)"));
    if (DIALOG_KNOWN.test(text)) {
      dialogGuardDismissNotice();
      dialogGuardResume();
    }
    return undefined;
  }

  function dialogGuardHandleConfirm(msg) {
    var text = dialogGuardClip(msg);
    if (DIALOG_KNOWN.test(text)) {
      DIALOG_STATS.confirmed += 1;
      DIALOG_STATS.lastText = text;
      DIALOG_STATS.lastAt = Date.now();
      log("站点在询问（已知类型，已自动选「确定」）：" + (text || "(空内容)"));      dialogGuardDismissNotice();
      dialogGuardResume();
      return true;
    }
    // 没读懂就不替用户做主：记一条，然后照常弹出来
    DIALOG_STATS.passed += 1;
    log("站点询问（未自动应答，需手动选）：" + (text || "(空内容)"));
    return null;    // null = 交给包装函数去调原生 confirm
  }

  function installDialogGuard() {
    if (!PAGE) return false;
    try {
      if (PAGE.__liruyunDialogGuard) {
        PAGE.__liruyunDialogOn = DIALOG_ON;      // 已经有包装（同族多版本同页）：只同步开关
        return true;
      }
    } catch (_) { return false; }
    var nativeAlert = null, nativeConfirm = null;
    try { nativeAlert = PAGE.alert; nativeConfirm = PAGE.confirm; } catch (_) {}
    if (!dialogGuardPatchFrame(PAGE)) return false;
    try { PAGE.__liruyunDialogNative = { alert: nativeAlert, confirm: nativeConfirm }; } catch (_) {}
    dialogGuardPatchFrames();     // 装的时候就把已经在页面上的同源 iframe 一起接管
    return true;
  }

  // 把一个 window 上的 alert / confirm 换成我们的（主页面和同源 iframe 共用这一段）。
  // 幂等：同一个 window 只会被换一次（标记在 window 自己身上）。
  function dialogGuardPatchFrame(win) {
    if (!win) return false;
    try {
      if (win.__liruyunDialogGuard) { win.__liruyunDialogOn = DIALOG_ON; return true; }
      var nativeAlert = win.alert, nativeConfirm = win.confirm;
      win.alert = function (msg) {
        if (!win.__liruyunDialogOn) {
          return nativeAlert ? nativeAlert.call(win, msg) : undefined;   // 用户关了拦截：照原样弹
        }
        return dialogGuardHandleAlert(msg);
      };
      win.confirm = function (msg) {
        var verdict = win.__liruyunDialogOn ? dialogGuardHandleConfirm(msg) : null;
        if (verdict !== null) return verdict;
        return nativeConfirm ? nativeConfirm.call(win, msg) : true;
      };
      win.__liruyunDialogGuard = true;
      win.__liruyunDialogOn = DIALOG_ON;
      return true;
    } catch (_) { return false; }
  }

  // 站点的播放器不保证在主文档里（fsresource 通常是内嵌，但别的活动类型可能是同源 iframe）。
  // `@noframes` 让本脚本不在 iframe 里运行（否则每个 iframe 都会长出一个面板），
  // 所以这里主动去把**同源**子窗口的 alert 也换掉；跨源的访问会抛异常，跳过就是。
  function dialogGuardPatchFrames() {
    var patched = 0;
    try {
      var frames = document.querySelectorAll("iframe, frame");
      for (var i = 0; i < frames.length; i++) {
        var w = null;
        try { w = frames[i].contentWindow; } catch (_) { w = null; }
        if (w && dialogGuardPatchFrame(w)) patched += 1;
      }
    } catch (_) {}
    if (patched && patched !== DIALOG_STATS.frames) {
      DIALOG_STATS.frames = patched;
      // 注意：这里**不能直接 log()** —— 本模块是在 IIFE 很靠前的位置装上去的，
      // 那时 `var logs = []` 还没执行（var 提升只提升声明，值是 undefined），
      // 直接写日志会 "Cannot read properties of undefined (reading 'push')"，
      // 而且抛出点在装载路径上，整个脚本会连界面一起废掉。
      // 所以只记个数，等监控那一跳（那时一切都就绪了）再补一条日志。
      dialogFramesPending = patched;
    }
    return patched;
  }

  // 每秒一跳；被原生弹窗卡住的证据就是"这一跳晚了很久"。
  // 注意只在明显超过 1 秒时才记（页面切后台时 setInterval 也会被节流，
  // 所以阈值取 2.5 秒，并且限频 60 秒一条，避免刷屏）。
  var dialogLastTickAt = 0;
  var dialogFramesPending = 0;      // 装载阶段接管了几个 iframe：等这一跳再写日志（那时 log 才可用）
  function dialogGuardTick() {
    var now = Date.now();
    DIALOG_STATS.ticks += 1;
    if (dialogFramesPending) {
      var newly = dialogFramesPending;
      dialogFramesPending = 0;
      log("已接管 " + newly + " 个同源 iframe 的弹窗拦截");
    }
    if (dialogLastTickAt) {
      var gap = now - dialogLastTickAt;
      if (gap > 2500) {
        DIALOG_STATS.blocked += 1;
        DIALOG_STATS.blockedMs = gap;
        if (now - DIALOG_STATS.lastBlockedAt > 60000) {
          DIALOG_STATS.lastBlockedAt = now;
          log("页面被原生弹窗卡住 " + (gap / 1000).toFixed(1) + "s（这次没能拦截）");
        }
      }
    }
    dialogLastTickAt = now;
    dialogGuardPatchFrames();                    // 后出现的 iframe 也要接管上
    if (DIALOG_ON) dialogGuardDismissNotice();   // 过时的黄条顺手清掉（同样写日志）
  }

  function dialogGuardLines() {
    return [
      "弹窗拦截: " + (DIALOG_ON ? "开" : "关") +
        " | 已吞 alert " + DIALOG_STATS.intercepted + " 条" +
        " | 自动确定 " + DIALOG_STATS.confirmed + " 条" +
        " | 放行询问 " + DIALOG_STATS.passed + " 条" +
        " | 清提示条 " + DIALOG_STATS.banners + " 条" +
        " | 接管 iframe " + DIALOG_STATS.frames + " 个" +
        " | 被卡住 " + DIALOG_STATS.blocked + " 次" +
        (DIALOG_STATS.blockedMs ? "（最近 " + (DIALOG_STATS.blockedMs / 1000).toFixed(1) + "s）" : "") +
        " | 监控跳数 " + DIALOG_STATS.ticks,
      "最近一条: " + (DIALOG_STATS.lastText || "(还没有)") +
        (DIALOG_STATS.lastAt ? "（" + new Date(DIALOG_STATS.lastAt).toLocaleTimeString() + "）" : ""),
      "提示：__liruyun.dialogGuard(false) 关掉拦截；__liruyun.dialogGuard() 看上面这行统计",
    ];
  }

  function dialogGuardDebugApi(on) {
    if (on !== undefined) dialogGuardSet(Boolean(on));
    return {
      on: DIALOG_ON, installed: Boolean(PAGE && PAGE.__liruyunDialogGuard),
      stats: {
        ticks: DIALOG_STATS.ticks,
        intercepted: DIALOG_STATS.intercepted, confirmed: DIALOG_STATS.confirmed,
        passed: DIALOG_STATS.passed, banners: DIALOG_STATS.banners,
        frames: DIALOG_STATS.frames,
        blocked: DIALOG_STATS.blocked, blockedMs: DIALOG_STATS.blockedMs,
        lastText: DIALOG_STATS.lastText, lastAt: DIALOG_STATS.lastAt,
      },
    };
  }

  // 尽早装（模块注入点就在 PAGE 定义之后）：站点随时可能弹，晚一步就白装。
  installDialogGuard();


  // ==========================================================================
  //  播放偏好 + 急停（v3 3.2 / v3pro 5.2）
  // --------------------------------------------------------------------------
  //  现场要求（这一版逐条对应）：
  //    1. "设置应该新加一个选项？完成视频之后是否下一个视频"
  //       → PREFS.autoNext（**默认开**，也就是原来的行为；关掉就停在本节不动）
  //    2. "自定义视频完成进度的标准（默认关闭，开启之后才用这个标准）"
  //       → PREFS.useThreshold + PREFS.threshold（默认 85%）
  //    3. "顶部设置旁边可以加一个急停，紧急停止并暂停视频"
  //       → PREFS.emergency（**不持久化**：急停是当次动作，刷新页面即恢复自动播放）
  //    4. 暴力模式："是否继续按列表一键播放所有视频" → PREFS.bruteListRun
  //  为什么单独一个模块：1 和 3 都要接进**基础脚本**里现场验证过的判定点
  //  （阈值读取 / 推进下一节 / 保活 / 起播 / 自动重播）。做法是在那些函数的**开头加一行判断**，
  //  绝不重写原逻辑 —— 那 2100 行是踩出来的，重写必然带新 bug。
  // ==========================================================================
  var PREFS_KEY = "liruyun_play_prefs";
  var PREFS = (function () {
    var fallback = { autoNext: true, useThreshold: false, threshold: 85, bruteListRun: false };
    var saved = null;
    try { saved = gmGet(PREFS_KEY, null); } catch (_) { saved = null; }
    if (!saved || typeof saved !== "object") return fallback;
    return {
      autoNext: saved.autoNext === false ? false : true,
      useThreshold: saved.useThreshold === true,
      threshold: (function () {
        var v = Number(saved.threshold);
        return v >= 1 && v <= 100 ? Math.round(v) : 85;
      })(),
      bruteListRun: saved.bruteListRun === true,
    };
  })();

  // 急停：只活在当前页面里。刻意不持久化 —— 否则用户刷新页面后脚本"什么都不做"，
  // 那种"昨天点了急停、今天播不动"的问题最难查。
  var PREFS_EMERGENCY = false;
  var PREFS_EMERGENCY_AT = 0;

  function prefSave() {
    try { gmSet(PREFS_KEY, { autoNext: PREFS.autoNext, useThreshold: PREFS.useThreshold, threshold: PREFS.threshold, bruteListRun: PREFS.bruteListRun }); } catch (_) {}
  }

  function prefAutoNext(on) {
    PREFS.autoNext = on === undefined ? !PREFS.autoNext : Boolean(on);
    prefSave();
    return PREFS.autoNext;
  }
  function prefAutoNextOn() { return PREFS.autoNext !== false; }

  // 自定义达标进度：返回 0 表示"用站点自己的要求"（默认）。所有读阈值的地方都走这里。
  function prefCustomThreshold() {
    if (!PREFS.useThreshold) return 0;
    var v = Number(PREFS.threshold);
    if (!(v >= 1 && v <= 100)) return 0;
    return Math.round(v);
  }
  function prefUseThreshold(on) {
    PREFS.useThreshold = on === undefined ? !PREFS.useThreshold : Boolean(on);
    prefSave();
    return PREFS.useThreshold;
  }
  // 纯读（不改状态）：面板每秒刷新一次，如果那里调的是上面那个"无参即取反"的函数，
  // 开关会被自己每秒翻一次 —— 这个坑 5.2 第一版真踩了，所以读取一律走 On() 结尾的纯函数。
  function prefUseThresholdOn() { return PREFS.useThreshold === true; }
  function prefThresholdValue(v) {
    if (v === undefined) return PREFS.threshold;
    var n = Number(v);
    if (n >= 1 && n <= 100) PREFS.threshold = Math.round(n);
    prefSave();
    return PREFS.threshold;
  }
  // 界面上显示"当前有效的达标线"：自定义开启时是自定义值，否则是站点读数
  function prefEffectiveThreshold() {
    var custom = prefCustomThreshold();
    if (custom) return custom;
    try { return readRequiredProgress(); } catch (_) { return 90; }
  }

  function prefBruteListRun(on) {
    PREFS.bruteListRun = on === undefined ? !PREFS.bruteListRun : Boolean(on);
    prefSave();
    return PREFS.bruteListRun;
  }
  function prefBruteListRunOn() { return PREFS.bruteListRun === true; }

  // ---- 急停 ----
  function prefEmergency(on) {
    PREFS_EMERGENCY = on === undefined ? !PREFS_EMERGENCY : Boolean(on);
    PREFS_EMERGENCY_AT = PREFS_EMERGENCY ? Date.now() : 0;
    return PREFS_EMERGENCY;
  }
  function prefEmergencyOn() { return PREFS_EMERGENCY === true; }

  function prefLines() {
    return [
      "播放偏好: 完成后自动下一节=" + (prefAutoNextOn() ? "开" : "关") +
        " | 达标进度=" + (prefCustomThreshold() ? ("自定义 " + prefCustomThreshold() + "%") : ("站点读数 " + prefEffectiveThreshold() + "%")) +
        " | 暴力页按列表连播=" + (prefBruteListRunOn() ? "开" : "关"),
      "急停: " + (prefEmergencyOn()
        ? ("已按下（" + new Date(PREFS_EMERGENCY_AT).toLocaleTimeString() + "）：不会自动起播/恢复播放，点「▶ 播放」即恢复")
        : "未按下"),
      "改这些：__liruyun.prefs({autoNext:false}) / .prefs({threshold:70, useThreshold:true}) / .prefs({emergency:true})",
    ];
  }

  // 调试/现场入口：__liruyun.prefs() 看状态；传对象改设置（对象里的字段名和上面一一对应）
  function prefsDebugApi(next) {
    if (next && typeof next === "object") {
      if ("autoNext" in next) prefAutoNext(next.autoNext);
      if ("useThreshold" in next) prefUseThreshold(next.useThreshold);
      if ("threshold" in next) prefThresholdValue(next.threshold);
      if ("bruteListRun" in next) prefBruteListRun(next.bruteListRun);
      if ("emergency" in next) prefEmergency(next.emergency);
    }
    return {
      autoNext: prefAutoNextOn(),
      useThreshold: PREFS.useThreshold === true,
      threshold: PREFS.threshold,
      effectiveThreshold: prefEffectiveThreshold(),
      bruteListRun: prefBruteListRunOn(),
      emergency: prefEmergencyOn(),
      emergencyAt: PREFS_EMERGENCY_AT,
    };
  }


  // 只要被注入就一定要在控制台留痕：没有它，用户根本无法区分
  // 「脚本没被注入」和「注入了但中途出错」。
  try {
    console.log(TAG, "脚本已注入 v" + SCRIPT_VERSION + "：" + location.pathname + location.search);
    console.log(TAG, "若稍后没有面板，请看本页是否有 [liruyun] 开头的报错");
  } catch (_) {}

  var STORAGE_KEY = "scnu_liruyun_helper_state";
  var PLAYER_CONTAINER = "#player-con";
  var PLAYER_SELECTORS = [
    "#player-con .vjs-big-play-button",
    "#player-con .tcp-big-play-button",
    "#player-con .prism-big-play-btn",
    "#player-con button[title*='播放']",
    "#player-con video",
  ];
  var KEEP_ALIVE_SELECTORS = [
    "#player-con .vjs-big-play-button",
    "#player-con .tcp-big-play-button",
    "#player-con .prism-big-play-btn",
    "#player-con button[title*='播放']",
  ];
  var PAUSE_SIGNAL_SELECTORS = [
    "#player-con .vjs-big-play-button",
    "#player-con .tcp-big-play-button",
    "#player-con .prism-big-play-btn",
  ];
  var H5P_PLAY_SELECTOR = [
    ".h5p-control.h5p-play",
    ".h5p-video .h5p-play",
    "button[aria-label*='Play']",
    "button[title*='播放']",
  ].join(",");
  var PROGRESS_SELECTORS = [".num-bfjd > span", ".num-bfjd", ".number.num-bfjd"];
  var COMPLETION_STATUS_SELECTORS = [".tips-completion", "[data-region='completion-info']"];
  var REQUIREMENT_SELECTORS = [
    "[data-region='completionrequirements']",
    ".activity-completion-list",
    ".fsresource-info .tips",
  ];
  var RESOURCE_PATHS = ["/mod/fsresource/view.php", "/mod/h5pactivity/view.php"];
  var COURSE_INDEX_SELECTOR = "#course-index";
  // 扫描课程资源的根：课程索引优先，退回抽屉容器，最后才是整页。
  // 注意别把整页当默认根 —— 页面上其它地方的 fsresource 链接会混进列表。
  var SCAN_ROOT_SELECTOR = "#course-index, #theme_boost-drawers-courseindex, .drawercontent";
  var DOCUMENT_EXTENSIONS = [".ppt", ".pptx", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".zip", ".rar"];

  // ------------------------------------------------------------------ 配置
  var OPTS = {
    // 学习确认：上游 holdMs = randMs(1200, 2200)，必须按住 > 2200 才有把握
    challengeHoldMs: 2600,
    challengeStepMs: 300,      // 每次加密的步长
    challengeMaxRounds: 4,
    settleTimeoutMs: 5000,     // 等遮罩消失的上限
    challengeCooldownMs: 1500,
    keepAliveCooldownMs: 15000,
    keepAliveMaxTries: 3,
    autoPass: true,            // 是否自动完成学习确认（面板可切换）
    // 注意：这几个之前漏定义了，导致"自动重播：开"按钮只是摆设（第一行就 return）
    autoReplay: true,          // 播完但未达标时自动重播
    pauseEveryMin: 0,          // 定时暂停：每 N 分钟（0 = 关闭）
    pauseForSec: 5,            // 定时暂停：暂停 M 秒后自动继续
  };

  var state = {
    running: false,
    queue: [],
    index: 0,
    lastIndex: -1,
    sourceUrl: "",
    sourceTitle: "",
    autoPass: OPTS.autoPass,
    challengeSeen: 0,
    challengePassed: 0,
    challengeFailed: 0,
    lastResult: "-",
    busy: false,
  };

  var logs = [];
  var lastWaitNote = "";     // "暂不推进"的原因去重（避免每秒重复写日志）
  var monitorTimer = 0;
  var monitorTickAt = 0;      // 监控循环最后一次心跳，用来判断"在跑"还是"卡死"
  var missingProgressSince = 0;
  var challengeAlertTimer = 0;
  var challengeWarned = false;
  var noticeWarned = false;
  var keepAliveLastTryAt = 0;
  var keepAliveTries = 0;
  var originalTitle = document.title;
  var titleFlip = false;
  var ui = null;
  // 暴力模块的运行时变量在下面「暴力模式」段落里集中声明

  // ------------------------------------------------------------ 存储与工具
  function gmGet(key, fallback) {
    try { if (typeof GM_getValue === "function") return GM_getValue(key, fallback); } catch (_) {}
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
  }
  function gmSet(key, value) {
    try { if (typeof GM_setValue === "function") { GM_setValue(key, value); return; } } catch (_) {}
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function loadState() {
    return gmGet(STORAGE_KEY, {
      running: false, queue: [], index: 0,
      sourceUrl: "", sourceTitle: "", lastIndex: -1,
    });
  }
  function saveState(next) {
    gmSet(STORAGE_KEY, next);
    state.running = Boolean(next.running);
    state.queue = next.queue || [];
    state.index = next.index || 0;
    renderStatus();
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // v3.3 日志防刷屏：只认「完全相同的整句」，带 60 秒时间窗，
  // 前两条照写（保留「确实发生了」的证据），第 3 条起折叠。
  var logFoldKey = "", logFoldAt = 0, logFoldCount = 0;
  function logFold(msg) {
    var s = String(msg == null ? "" : msg);
    var now = Date.now();
    if (s === logFoldKey && now - logFoldAt < 60000) {
      logFoldAt = now;
      logFoldCount += 1;
      return { skip: logFoldCount > 2, note: "" };
    }
    var folded = logFoldCount > 2 ? logFoldCount - 2 : 0;
    logFoldKey = s; logFoldAt = now; logFoldCount = 1;
    return { skip: false, note: folded ? ("上一条相同内容又重复了 " + folded + " 次（已折叠，不再刷屏）") : "" };
  }
  // v3.4：pro 面板的日志框可以往回翻，所以缓冲区给大一点；原布局保持 80 行不变。
  function logBufferMax() {
    try {
      var logHost = document.getElementById("scnu-liruyun-helper");
      if (logHost && logHost.getAttribute("data-pro") === "1") return 400;
    } catch (_) {}
    return 80;
  }
  function log(msg) {
    var logPlan = logFold(msg);
    if (logPlan.skip) return;
    if (logPlan.note) {
      logs.push(new Date().toLocaleTimeString() + "  " + logPlan.note);
      if (logs.length > logBufferMax()) logs.shift();
      // 汇总行也要进控制台：面板日志只留 10 行，排查时看的是控制台
      try { console.log(TAG, logPlan.note); } catch (_) {}
    }
    var line = new Date().toLocaleTimeString() + "  " + msg;
    logs.push(line);
    if (logs.length > logBufferMax()) logs.shift();
    try { console.log(TAG, msg); } catch (_) {}
    renderLog();
  }
  function waitFor(fn, timeoutMs, stepMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      var done = false;
      var guard = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs + 250);
      (function tick() {
        if (done) return;
        var v = null;
        try { v = fn(); } catch (_) { v = null; }
        if (v) { done = true; clearTimeout(guard); return resolve(v); }
        if (Date.now() >= deadline) { done = true; clearTimeout(guard); return resolve(null); }
        setTimeout(tick, stepMs || 300);
      })();
    });
  }
  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var nodes = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        var rect = node.getBoundingClientRect();
        var style = window.getComputedStyle(node);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") return node;
      }
    }
    return null;
  }
  function textOf(selector) {
    return Array.prototype.map.call(document.querySelectorAll(selector), function (n) {
      return (n.textContent || "").trim();
    }).filter(Boolean).join("\n");
  }
  function parsePercentage(text) {
    var m = String(text || "").match(/(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)\s*%?/);
    if (!m) return null;
    var v = Number.parseFloat(m[0].replace("%", "").trim());
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  }
  function readProgress() {
    for (var i = 0; i < PROGRESS_SELECTORS.length; i++) {
      var node = document.querySelector(PROGRESS_SELECTORS[i]);
      if (!node) continue;
      var v = parsePercentage(node.textContent || "");
      if (v !== null) return v;
    }
    return null;
  }
  // 完成阈值从页面读，不写死（不同活动要求不一样）
  function readRequiredProgress() {
    // v3.2：设置里开了「自定义达标进度」时，所有读阈值的地方都用它（默认关，用站点自己的要求）
    var customThreshold = prefCustomThreshold();
    if (customThreshold) return customThreshold;
    var patterns = [
      /观看进度\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/,
      /观看进度.*?(\d+(?:\.\d+)?)\s*%/,
      /需要达到\s*(\d+(?:\.\d+)?)\s*%/,
    ];
    for (var i = 0; i < REQUIREMENT_SELECTORS.length; i++) {
      var text = textOf(REQUIREMENT_SELECTORS[i]);
      for (var j = 0; j < patterns.length; j++) {
        var m = text.match(patterns[j]);
        if (m) return Number.parseFloat(m[1]);
      }
    }
    return 90;
  }
  function readCompletionStatus() {
    for (var i = 0; i < COMPLETION_STATUS_SELECTORS.length; i++) {
      var nodes = document.querySelectorAll(COMPLETION_STATUS_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var text = (nodes[j].textContent || "").trim();
        var compact = text.replace(/\s+/g, "");
        var lower = text.toLowerCase();
        if (!text || text.indexOf("未完成") >= 0 || text.indexOf("未达到") >= 0) continue;
        if (text.indexOf("已完成") >= 0 || lower.indexOf("completed") >= 0 ||
            ["完成", "已达成", "达成"].indexOf(compact) >= 0 ||
            compact.indexOf("完成状态:完成") >= 0 || compact.indexOf("完成状态：完成") >= 0) {
          return true;
        }
      }
    }
    return false;
  }
  function normalizeUrl(url) {
    try { var u = new URL(url); u.hash = ""; return u.toString(); } catch (_) { return url; }
  }

  // ==========================================================================
  //  学习确认：识别 + 多事件类型自适应通过
  // ==========================================================================
  var HOLD_TEXT = ["按住通过", "按住", "请按住", "学习确认", "确认你在观看"];
  function nodeText(node) { return String((node && node.textContent) || "").replace(/\s+/g, ""); }
  function isOwnNode(node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.hasAttribute && el.hasAttribute("data-liruyun")) return true;
    }
    return false;
  }
  function looksLikeHoldButton(node) {
    if (!node || String(node.tagName).toLowerCase() !== "button") return false;
    if (isOwnNode(node)) return false;
    if (node.id && node.id.indexOf("ab-btn-") === 0) return true;
    var t = nodeText(node);
    if (!t) return false;
    for (var i = 0; i < HOLD_TEXT.length; i++) if (t.indexOf(HOLD_TEXT[i]) >= 0) return true;
    return false;
  }
  function findHoldButton(scope) {
    var root = scope || document;
    var byId = root.querySelector ? root.querySelector("button[id^='ab-btn-']") : null;
    if (byId && !isOwnNode(byId)) return byId;
    var btns = root.querySelectorAll ? root.querySelectorAll("button") : [];
    for (var i = 0; i < btns.length; i++) if (looksLikeHoldButton(btns[i])) return btns[i];
    return null;
  }
  function findChallengeMask() {
    var masks = document.querySelectorAll("div[id^='anti-bot-']");
    for (var i = 0; i < masks.length; i++) {
      if (isOwnNode(masks[i])) continue;
      if (!document.documentElement.contains(masks[i])) continue;
      if (findHoldButton(masks[i])) return masks[i];
    }
    // 退路：id 被改名时按"文案 + 固定层"识别
    var btns = document.querySelectorAll("button");
    for (var k = 0; k < btns.length; k++) {
      var b = btns[k];
      if (!looksLikeHoldButton(b)) continue;
      var host = b.parentElement;
      for (var up = 0; host && up < 5; up++, host = host.parentElement) {
        if (isOwnNode(host)) break;
        var pos = "";
        try { pos = window.getComputedStyle(host).position; } catch (_) {}
        if ((pos === "fixed" || pos === "absolute") && /学习确认|按住|确认你在观看/.test(nodeText(host))) return host;
      }
    }
    return null;
  }
  function hasHumanChallenge() { return Boolean(findChallengeMask()); }
  function progressBarOf(btn) {
    for (var node = btn.parentElement; node; node = node.parentElement) {
      var bars = node.querySelectorAll("div[id^='ab-bar-']");
      if (bars.length) return bars[0];
    }
    // 退路：只有行内样式的小高度 div
    for (var up = btn.parentElement, hops = 0; up && hops < 4; up = up.parentElement, hops++) {
      var divs = up.querySelectorAll("div");
      for (var i = 0; i < divs.length; i++) {
        var d = divs[i];
        if (d.contains(btn) || isOwnNode(d)) continue;
        var h = parseFloat(d.style.height) || 0;
        if (!h) { try { h = parseFloat(window.getComputedStyle(d).height) || 0; } catch (_) {} }
        if (h > 0 && h <= 20) return d;
      }
    }
    return null;
  }

  // 三套事件的下发函数
  function pointOf(el) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  function pointerEvent(target, type, pt, buttons) {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: PAGE,
      clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
      button: 0, buttons: buttons, pointerId: 1, pointerType: "mouse",
      isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
    }));
  }
  function mouseEvent(target, type, pt, buttons) {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: PAGE,
      clientX: pt.x, clientY: pt.y, screenX: pt.x, screenY: pt.y,
      button: 0, buttons: buttons, detail: buttons ? 1 : 0,
    }));
  }
  function touchEvent(target, type, pt) {
    if (typeof Touch !== "function" || typeof TouchEvent !== "function") return;
    var touch = new Touch({ identifier: 1, target: target, clientX: pt.x, clientY: pt.y, pageX: pt.x, pageY: pt.y });
    var isEnd = type === "touchend" || type === "touchcancel";
    target.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: PAGE,
      touches: isEnd ? [] : [touch], targetTouches: isEnd ? [] : [touch],
      changedTouches: [touch],
    }));
  }
  // 事件体检结论：'pointer' | 'mouse' | 'touch'（默认先试 pointer）
  var eventFlavor = "pointer";
  var flavorProven = false;

  function pressWith(flavor, btn, pt) {
    if (flavor === "pointer") {
      pointerEvent(btn, "pointerover", pt, 0);
      pointerEvent(btn, "pointerenter", pt, 0);
      pointerEvent(btn, "pointermove", pt, 0);
      pointerEvent(btn, "pointerdown", pt, 1);
    } else if (flavor === "mouse") {
      mouseEvent(btn, "mouseover", pt, 0);
      mouseEvent(btn, "mousemove", pt, 0);
      mouseEvent(btn, "mousedown", pt, 1);
    } else {
      touchEvent(btn, "touchstart", pt);
    }
  }
  function releaseWith(flavor, btn, pt) {
    // 上游把 pointerup/mouseup 挂在 window 上；document 上的事件能冒泡到 window
    var upTarget = (typeof document.dispatchEvent === "function") ? document : PAGE;
    if (flavor === "pointer") {
      pointerEvent(upTarget, "pointerup", pt, 0);
      if (document.documentElement.contains(btn)) { pointerEvent(btn, "pointerout", pt, 0); }
    } else if (flavor === "mouse") {
      mouseEvent(upTarget, "mouseup", pt, 0);
      if (document.documentElement.contains(btn)) { mouseEvent(btn, "mouseout", pt, 0); mouseEvent(btn, "click", pt, 0); }
    } else {
      touchEvent(upTarget, "touchend", pt);
    }
  }

  // 见证页面自己判定通过：遮罩被移除 = cleanup(true) 跑过了
  function watchMaskGone(mask, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; try { obs.disconnect(); } catch (_) {} clearTimeout(t); resolve(v); } };
      var obs = new MutationObserver(function () {
        if (!document.documentElement.contains(mask)) finish(true);
      });
      try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
      var t = setTimeout(function () { finish(!document.documentElement.contains(mask)); }, timeoutMs);
      if (!document.documentElement.contains(mask)) finish(true);
    });
  }

  // 单个事件类型：按住 holdMs 再释放，看遮罩是否消失（附带进度条是否在长）
  async function tryFlavor(flavor, holdMs) {
    var btn = findHoldButton();
    if (!btn) return { ok: false, reason: "no-button" };
    var mask = findChallengeMask();
    if (!mask) return { ok: true, reason: "already-gone", flavor: flavor };

    var pt = pointOf(btn);
    var top = null;
    try { top = document.elementFromPoint(pt.x, pt.y); } catch (_) {}
    var hit = Boolean(top && (top === btn || btn.contains(top) || (top.contains && top.contains(btn))));

    pressWith(flavor, btn, pt);
    await sleep(150);
    var bar = progressBarOf(btn);
    var w0 = bar ? (parseFloat(bar.style.width) || 0) : -1;
    await sleep(200);
    var w1 = bar ? (parseFloat(bar.style.width) || 0) : -1;
    var growing = bar ? (w1 > w0) : null;

    if (!document.documentElement.contains(mask)) {
      return { ok: true, reason: "gone-on-press", flavor: flavor, hit: hit, growing: growing };
    }

    var waited = await waitFor(function () { return !document.documentElement.contains(mask); }, holdMs, 60);
    if (waited) {
      return { ok: true, reason: "gone-while-held", flavor: flavor, hit: hit, growing: growing };
    }
    if (!document.documentElement.contains(btn)) {
      return { ok: false, reason: "button-removed", flavor: flavor, hit: hit, growing: growing };
    }

    releaseWith(flavor, btn, pt);
    var gone = await watchMaskGone(mask, OPTS.settleTimeoutMs);
    return {
      ok: Boolean(gone),
      reason: gone ? "gone-after-release" : "timeout",
      flavor: flavor, hit: hit, growing: growing,
    };
  }

  // 完整流程：先按已证明有效的类型试；没证明过就 pointer → mouse → touch 逐个试
  async function passChallenge() {
    if (state.busy) return false;
    var mask = findChallengeMask();
    if (!mask) return true;
    state.busy = true;
    state.challengeSeen += 1;
    renderStatus();

    var order = flavorProven ? [eventFlavor] : ["pointer", "mouse", "touch"];
    var hold = OPTS.challengeHoldMs;
    var attempt = 0;
    try {
      for (var round = 0; round < OPTS.challengeMaxRounds; round++) {
        for (var i = 0; i < order.length; i++) {
          if (!findChallengeMask()) break;
          attempt += 1;
          var r = await tryFlavor(order[i], hold);
          log("确认尝试#" + attempt + " " + r.flavor + " 按住" + hold + "ms → " + r.reason +
            (r.hit === false ? "（⚠ 按钮中心被别的元素挡住）" : "") +
            (r.growing === false ? "（进度条没动=页面没进入计时）" : r.growing ? "（进度条在长）" : ""));
          if (r.ok) {
            if (!flavorProven) {
              flavorProven = true;
              eventFlavor = r.flavor;
              log("★ 事件体检结论：本页认 " + r.flavor + " 事件，后续只用这一种");
            }
            state.challengePassed += 1;
            state.lastResult = "通过(" + r.flavor + "/" + r.reason + ")";
            renderStatus();
            return true;
          }
          await sleep(250);
        }
        hold += OPTS.challengeStepMs;   // 没成功就加长按住时间再来一轮
        log("本轮未通过，按住时间提高到 " + hold + "ms");
      }
      state.challengeFailed += 1;
      state.lastResult = "失败(已试 " + attempt + " 次)";
      log("自动通过失败：请手动按住一次。若手动可行，说明是合成事件被拦，请把面板日志发我。");
      return false;
    } finally {
      state.busy = false;
      renderStatus();
    }
  }

  // ==========================================================================
  //  播放器：启动 / 保活
  // ==========================================================================
  // 起播快慢的关键就在这里：用**短间隔**轮询控件，而不是等一个固定时长。
  // 原实现是 500ms 一次（继承自旧脚本），起播平均要慢半秒到一秒。
  function startFsresourcePlayer() {
    return waitFor(function () { return firstVisible(PLAYER_SELECTORS); }, 30000, 120)
      .then(function (control) {
        control.scrollIntoView({ block: "center" });
        if (String(control.tagName).toLowerCase() === "video") {
          try { control.play(); } catch (_) {}
        } else {
          control.click();
        }
        return true;
      })
      .catch(function () { return false; });
  }
  function clickH5pInDocument(doc, depth) {
    var play = Array.prototype.filter.call(doc.querySelectorAll(H5P_PLAY_SELECTOR), function (n) {
      var r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })[0];
    if (play) { play.scrollIntoView({ block: "center" }); play.click(); return true; }
    if (depth <= 0) return false;
    var frames = doc.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      try { if (frames[i].contentDocument && clickH5pInDocument(frames[i].contentDocument, depth - 1)) return true; } catch (_) {}
    }
    return false;
  }
  async function startH5pPlayer() {
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (clickH5pInDocument(document, 2)) return true;
      await sleep(1000);
    }
    return false;
  }
  // 播放停滞判断：这里只管"该不该救"，不管"是不是从没起播过"。
  // 之前写成 `if (paused && currentTime < 0.5) return false`（认为"还没起播"），
  // 结果是：被学习确认弹窗打断、进度回退到 0 秒的视频，被判成"没起播"→不救；
  // 而起播重试那条路又因为 playbackStarted=true 不再触发 —— 两边互相抵消，
  // 视频就永远停着且毫无日志。
  function isPlaybackStalled() {
    var v = videoEl();
    if (v) {
      if (v.ended) return false;          // 播完是正常终态，交给自动重播处理
      return Boolean(v.paused);
    }
    return Boolean(firstVisible(PAUSE_SIGNAL_SELECTORS));
  }
  function keepAlive() {
    if (Date.now() - keepAliveLastTryAt < OPTS.keepAliveCooldownMs) return;
    if (hasHumanChallenge()) return;
    // v3.2 急停：停下之后不许保活/停摆看护把视频又点起来（用户点「▶ 播放」才恢复）
    if (prefEmergencyOn()) return;
    // 注意：**不看"已完成"**。实测存在"页面标记已完成、但视频只播到 25% 就卡住"
    // 的情况；此时若因"已完成"就不管，播放会永久停在那里没人救。
    // 真正该停的条件是"视频本身播到结尾"（由 ended / 接近 duration 判断）。
    var v0 = videoEl();
    if (v0 && v0.ended) return;
    if (!isPlaybackStalled()) return;
    var control = firstVisible(KEEP_ALIVE_SELECTORS);
    if (!control) return;
    keepAliveLastTryAt = Date.now();
    keepAliveTries += 1;
    try {
      control.scrollIntoView({ block: "center" });
      control.click();
      setStatus("检测到播放暂停，已尝试恢复播放（第 " + keepAliveTries + " 次）");
    } catch (_) {}
  }

  // ==========================================================================
  //  队列与监控
  // ==========================================================================
  // 资源链接严格判定：
  //   · 必须是绝对 URL（相对路径/纯 #锚点一律不是资源）
  //   · 必须命中 /mod/fsresource/view.php 或 /mod/h5pactivity/view.php
  //   · 必须能解析出数字 id —— 语言切换链接（当前页 + &lang=xx）虽然路径相同，
  //     但它只是同一资源的另一种语言视图，不属于新条目；用 id+path 去重更稳
  //   · 带 lang= 的链接直接排除
  function parseResourceUrl(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    // 关键：**相对链接必须拒绝**。`new URL("#", location.href)` 会解析成当前页 URL，
    // 于是页面上所有 href="#" 的菜单按钮（展开全部/语言/我的课程…）都会被判成
    // "合法资源"，而且 id 被解析成当前页 id —— 这就是列表里冒出
    // "展开全部 [当前]" 的原因。
    if (!/^https?:\/\//i.test(s) && !/^\/[^/]/.test(s)) return null;
    var abs;
    try { abs = new URL(s, location.href); } catch (_) { return null; }
    if (!/^https?:$/.test(abs.protocol)) return null;
    if (abs.hash && !abs.search) return null;          // 纯锚点
    if (abs.origin !== location.origin) return null;   // 站外链接
    // 课程索引控制按钮
    if (/expandall|collapseall|courseindex/i.test(s)) return null;
    var matched = null;
    for (var i = 0; i < RESOURCE_PATHS.length; i++) {
      if (abs.pathname.indexOf(RESOURCE_PATHS[i]) >= 0) matched = RESOURCE_PATHS[i];
    }
    if (!matched) return null;
    // 语言切换链接形如 <当前页>?id=NNN&lang=xx：路径和 id 都合法，只是同一资源的
    // 另一种语言视图。用"原始 href 里是否出现 lang"判定，不依赖 searchParams 解析。
    if (/(?:[?&]|&amp;)lang=/i.test(String(raw))) return null;
    if (abs.searchParams.has("lang")) return null;
    var id = abs.searchParams.get("id");
    if (!id || !/^\d+$/.test(id)) return null;
    return { url: abs.toString(), path: matched, id: id, key: matched + "?id=" + id };
  }

  function collectResourcesFromPage() {
    var byKey = {};        // path?id=数字 -> 条目（天然把语言切换链接合并掉）
    var order = [];
    var roots = document.querySelector(SCAN_ROOT_SELECTOR) ? [document.querySelector(SCAN_ROOT_SELECTOR)] : [document];
    for (var r = 0; r < roots.length; r++) {
      var links = roots[r].querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var info = parseResourceUrl(a.getAttribute("href"));
        if (!info) continue;

        var name = titleOfLink(a);
        // 标题是噪声（"展开 折叠"之类）时不要直接丢：同一 URL 后面若出现更完整的
        // 标题会被替换；当前页则用 document.title 兜底。
        var weak = !name;
        if (weak && info.url === normalizeUrl(location.href)) name = document.title || "";
        if (!name || name.indexOf("资源库文件") >= 0) continue;

        var lower = (name + " " + info.url).toLowerCase().split("?")[0];
        var isDoc = false;
        for (var d = 0; d < DOCUMENT_EXTENSIONS.length; d++) if (lower.indexOf(DOCUMENT_EXTENSIONS[d]) >= 0) isDoc = true;
        if (isDoc) continue;

        var entry = { name: name, url: info.url, id: info.id, weak: weak };
        if (!byKey[info.key]) { byKey[info.key] = entry; order.push(info.key); }
        else if (byKey[info.key].weak && !weak) { byKey[info.key] = entry; }
      }
    }
    var resources = [];
    for (var k = 0; k < order.length; k++) {
      var e = byKey[order[k]];
      delete e.weak;
      resources.push(e);
    }
    return resources;
  }
  // 资源标题提取：锚点里往往**混着"展开/折叠"按钮**（课程索引每个条目都带一个），
  // 直接取 textContent 会拿到按钮文字 —— 这是之前列表显示"展开 折叠"的原因。
  // 依次尝试：专用标题节点 → aria-label → title → 去掉按钮文字的 textContent。
  // 菜单/导航类文字：即使 URL 侥幸通过了判定，标题是这些词也一律丢掉
  var TITLE_NOISE = [
    "展开", "折叠", "展开全部", "全部折叠", "资源库文件", "跳到主要内容",
    "语言", "我的课程", "更多", "分类课程", "申请课程", "使用介绍",
    "expand", "collapse", "skip to main content",
  ];
  function isNoiseTitle(t) {
    if (!t) return true;
    var low = String(t).toLowerCase().trim();
    if (!low) return true;
    for (var i = 0; i < TITLE_NOISE.length; i++) {
      var n = TITLE_NOISE[i].toLowerCase();
      if (low === n) return true;
      if (n.length > 2 && low.indexOf(n) >= 0) return true;   // "跳到主要内容" 这类
    }
    // 剩下这些是站点级导航，不可能是视频名
    if (/^(简体中文|正體中文|english|日本語|français|русский)/i.test(low)) return true;
    if (/\d{8,}/.test(low) && low.length < 24) return true;   // 学号/用户名
    return false;
  }
  function cleanTitle(value) {
    var text = String(value == null ? "" : value)
      .replace(/<[^>]*>/g, " ")        // 去掉 <br> 之类的标签残留
      .replace(/\s+/g, " ");
    var parts = text.split(/\s{2,}|\r?\n/).map(function (t) { return t.trim(); }).filter(Boolean);
    if (parts.length <= 1) parts = [text.trim()];
    parts = parts.filter(function (t) { return !isNoiseTitle(t); });
    return parts.join(" ").trim();
  }
  function titleOfLink(a) {
    // 只认结构化的标题节点：aria-label / title / textContent 都可能拿到
    // "展开 折叠"或整节名称（同一锚点里混着折叠按钮），所以优先级要压低。
    var nodeSelectors = [
      ".courseindex-linktext", ".instancename", ".courseindex-cm-name",
      "span.courseindex-linktext", "[data-region='cm-name']",
    ];
    for (var s = 0; s < nodeSelectors.length; s++) {
      var node = a.querySelector(nodeSelectors[s]);
      if (!node) continue;
      var t = cleanTitle(node.textContent);
      if (t && !isNoiseTitle(t)) return t;
    }
    var fallbacks = [a.getAttribute("aria-label"), a.title, a.textContent];
    for (var i = 0; i < fallbacks.length; i++) {
      var v = cleanTitle(fallbacks[i]);
      if (!isNoiseTitle(v)) return v;
    }
    return "";
  }

  function findCurrentResourceIndex(queue) {
    // 先按 id 匹配（URL 可能带章节参数/语言参数，字符串比较不可靠），
    // 再退回 URL 比较作为兜底。
    var curId = currentResourceId();
    if (curId) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].id && queue[i].id === curId) return i;
        try {
          if (new URL(queue[i].url, location.href).searchParams.get("id") === curId) return i;
        } catch (_) {}
      }
      return -1;   // 当前页不在队列里，不要瞎猜成第 0 条
    }
    var current = normalizeUrl(location.href);
    for (var j = 0; j < queue.length; j++) if (normalizeUrl(queue[j].url) === current) return j;
    return -1;
  }
  function advanceToNext(message) {
    stopChallengeAlert();
    var s = loadState();
    var idx = findCurrentResourceIndex(s.queue || []);
    s.index = idx + 1;
    s.lastIndex = idx;
    saveState(s);
    setStatus(message || "切换到下一项");
    setTimeout(function () {
      var cur = loadState();
      if (!cur.running) return;
      var target = (cur.queue || [])[cur.index];
      if (!target) { cur.running = false; saveState(cur); setStatus("队列已完成"); return; }
      location.href = target.url;
    }, 900);
  }

  // 监控循环：**只要在资源页就一直跑**，不再依赖"点过开始"。
  //  · 进页面就自动起播 / 学习确认自动通过 / 暂停保活 / 播完未达标重播 → 始终生效
  //  · 「达标后自动跳下一节」→ 只在 running（点过"开始本页资源"）时生效
  //  注意：自动起播**不能**绑在 running 上。之前为了"避免误播"加了这个条件，
  //  结果变成必须先手点一下才开始播（回归）。现在起播与队列解耦：
  //  打开页面就尝试播，队列只决定"要不要自动跳下一节"。
  var playbackStarted = false;
  var playbackAttempts = 0;
  var lastPlaybackTryAt = 0;
  var autoplayBlockWarned = false;
  var lastStallGuardAt = 0;      // 停摆看护的节流
  var stallGuardCount = 0;
  var forcePlayback = false;     // 停摆看护期间无视"已完成"限制，强制救一次
  // 冻帧看护：paused=false 但 currentTime 不推进（缓冲/加载卡死）时的状态
  var lastClockAt = 0;           // 上一次观察到的 currentTime
  var lastClockChangeAt = 0;     // currentTime 最后一次变化的时间
  var frozeNudgedAt = 0;
  var frozeCount = 0;
  var playbackProgressAt = 0;

  // 起播：多点几处 + 直接调 video.play()，因为浏览器自动播放策略会静默忽略
  // 程序触发的播放（页面加载后没有"用户手势"时），点一个按钮不保证生效。
  function forcePlay() {
    var acted = false;
    var control = firstVisible(KEEP_ALIVE_SELECTORS);
    if (control) {
      try { control.scrollIntoView({ block: "center" }); control.click(); acted = true; } catch (_) {}
    }
    var v = videoEl();
    if (v) {
      try {
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
        acted = true;
      } catch (_) {}
    }
    return acted;
  }

  // 起播只负责"把第一下点到位"。点到控件即视为完成本次起播 ——
  // 之后"有没有真的在走"交给下面的停摆/冻帧看护持续负责。
  // 之前把"currentTime 真的推进"也当成这里的成功条件，于是没走起来就每 1.5 秒
  // 重来一次（日志里"第 1 次/第 2 次"），既刷屏又抢不到点上。
  function tryStartPlayback(reason) {
    if (playbackStarted) return;
    if (prefEmergencyOn()) return;        // 急停：不自动起播（用户点播放时才恢复）
    playbackAttempts += 1;
    lastPlaybackTryAt = Date.now();
    var isH5p = location.href.indexOf("/mod/h5pactivity/view.php") >= 0;
    var vs = videoState();
    if (vs.found && !vs.paused && !vs.ended) {
      playbackStarted = true;
      log("视频已在播放，无需起播");
      return;
    }
    log("起播（" + reason + "，第 " + playbackAttempts + " 次）");
    var done = function (ok) {
      if (!ok) {
        log("未找到播放器控件，稍后重试");
        return;
      }
      playbackStarted = true;                 // 点到位即算起播完成
      var control = firstVisible(KEEP_ALIVE_SELECTORS);
      if (control) { try { control.click(); } catch (_) {} }
      var v = videoEl();
      if (v) { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {} }
      setTimeout(function () {
        var now = videoState();
        log(now.found && !now.paused ? "已开始播放 ✅（" + now.currentTime + "s）"
          : "控件已点，但视频仍暂停 —— 交给停摆看护持续恢复");
      }, 500);
    };
    if (isH5p) startH5pPlayer().then(done);
    else startFsresourcePlayer().then(done);
  }

  // 卡在开头没动：给浏览器一个明确的提示（自动播放策略下这只能靠用户点一下）
  function checkAutoplayBlock() {
    if (playbackStarted) return;
    if (autoplayBlockWarned) return;
    var v = videoEl();
    if (!v) return;
    if (!v.paused) return;
    if (Number(v.currentTime) > 5) return;      // 已经播过一段，不是起播问题
    if (Date.now() - playbackAttemptsStartAt < 6000) return;
    autoplayBlockWarned = true;
    log("起播未生效：浏览器自动播放策略要求先有一次用户操作。请点一下页面任意处，或点面板「▶ 播放/重播」");
    setStatus("⚠ 视频停在开头：浏览器拦截了自动播放，请点一下页面或点「▶ 播放/重播」");
    flashPanel("#f59e0b");
  }
  var playbackAttemptsStartAt = Date.now();

  function ensureMonitor() {
    if (monitorTimer) return;
    var isH5p = location.href.indexOf("/mod/h5pactivity/view.php") >= 0;
    var required = readRequiredProgress();
    log("监控已启动：阈值 " + required + "%；" + (isH5p ? "H5P" : "fsresource") +
      "；自动通过=" + (state.autoPass ? "开" : "关"));
    log("弹窗规律（读自站点策略）：" + (function () {
      var v = videoEl();
      var policy = challengePolicyOf(v ? Number(v.duration) : 0);
      return policy ? policy.text : "时长未知，视频起播后判断";
    })());
    // 进页面就起播，不等用户点任何按钮
    tryStartPlayback("页面加载");

    // 列表初始化：课程索引是异步渲染的，**第一次扫描往往还是空的**。
    // 这里不等 5 秒周期，而是每 400ms 盯着，一出现条目就立刻收集并渲染，
    // 这样"打开页面就有完整列表"，而不是先空着、过几秒才冒出来。
    var listWaitStart = Date.now();
    (function waitListReady() {
      var got = collectResourcesFromPage();
      if (got.length) {
        viewQueueCache = got;
        log("列表就绪：" + got.length + " 个资源（等 " + (Date.now() - listWaitStart) + "ms）");
        renderList();
        return;
      }
      if (Date.now() - listWaitStart > 20000) {
        log("列表等待超时：课程索引里没扫到资源，稍后按周期重试");
        return;
      }
      setTimeout(waitListReady, 400);
    })();

    monitorTimer = setInterval(function () {
      // v3.1：原生弹窗会**整页停摆**，恢复后这一跳的间隔就是被卡的时长。
      // 拦住了就什么都不会发生；没拦住（站点提前存了 alert 引用）就会在日志里留证据。
      dialogGuardTick();
      var latest = loadState();
      var running = Boolean(latest.running);

      // 0) 起播重试：播放器是 JS 异步建的，第一次可能还没就绪。
      //    每 1.5 秒重试一次，最多 20 次；成功后不再打扰。
      if (!playbackStarted && playbackAttempts < 20 && Date.now() - lastPlaybackTryAt > 1500) {
        tryStartPlayback("重试");
      }
      checkAutoplayBlock();

      // 0b) 停摆看护：视频停着且**没播到结尾**时恢复播放。
      //     刻意不看"页面是否标记已完成"—— 已完成 ≠ 视频播完了。
      (function stallGuard() {
        var v = videoEl();
        if (!v) return;
        if (!v.paused || v.ended) return;
        if (hasHumanChallenge()) return;
        var d = Number(v.duration) || 0;
        if (d > 0 && Number(v.currentTime) >= d - 1) return;      // 真到结尾了，交给自动重播
        if (Date.now() - lastStallGuardAt < 3000) return;
        lastStallGuardAt = Date.now();
        stallGuardCount += 1;
        log("播放停摆（" + Math.round(Number(v.currentTime)) + "/" + Math.round(d) + "s，第 " +
          stallGuardCount + " 次）→ 恢复播放");
        keepAliveTries = 0;
        keepAliveLastTryAt = 0;                                    // 绕开冷却，立刻救一次
        keepAlive();
      })();

      // 0c) 冻帧看护：paused=false 但 currentTime 长时间不推进（缓冲/加载卡死）。
      //     上一版只判断 paused，所以对这种"看起来在播、其实冻住"完全无效。
      (function freezeGuard() {
        var v = videoEl();
        if (!v) return;
        if (v.ended) return;
        var now = Number(v.currentTime) || 0;
        if (now !== lastClockAt) {
          lastClockAt = now;
          lastClockChangeAt = Date.now();
          return;
        }
        if (!lastClockChangeAt) { lastClockChangeAt = Date.now(); return; }
        if (v.paused) return;                       // 暂停交给上面的停摆看护
        if (hasHumanChallenge()) return;
        var frozenFor = Date.now() - lastClockChangeAt;
        if (frozenFor < 5000) return;
        if (Date.now() - frozeNudgedAt < 8000) return;
        frozeNudgedAt = Date.now();
        frozeCount += 1;
        if (frozeCount <= 6) {
          log("画面冻住 " + Math.round(frozenFor / 1000) + "s（" + Math.round(now) +
            "s 处不动，第 " + frozeCount + " 次）→ 重新 play + 微调进度唤醒");
          // 常见有效做法：重新 play 一次；若仍不动，轻微 seek 触发重新加载
          try { v.play(); } catch (_) {}
          setTimeout(function () {
            var v2 = videoEl();
            if (!v2) return;
            if (Math.abs(Number(v2.currentTime) - now) < 0.2) {
              try { v2.currentTime = now + 0.5; } catch (_) {}
              var ctl = firstVisible(KEEP_ALIVE_SELECTORS);
              if (ctl) { try { ctl.click(); } catch (_) {} }
            }
          }, 1200);
        } else if (frozeCount === 7) {
          log("连续 " + frozeCount + " 次冻帧，自动恢复未成功：这通常是**网络/视频源本身卡住**，" +
            "不像是脚本能解决的（建议手动刷新页面或换清晰度）");
          setStatus("⚠ 视频源卡住（多次自动恢复无效），建议刷新页面");
          flashPanel("#ef4444");
        }
      })();

      // 1) 学习确认：出现就自动通过（同一脚本内协调，不需要跨脚本避让）
      if (!isH5p && hasHumanChallenge()) {
        if (state.autoPass && !state.busy) {
          if (!challengeWarned) {
            challengeWarned = true;
            setStatus("检测到学习确认，正在自动通过…");
          }
          passChallenge();
        }
        startChallengeAlert();
        return;
      } else if (challengeWarned) {
        stopChallengeAlert();
        setStatus("学习确认已处理，继续读取页面进度");
      }

      // 2) 并发观看提示
      var notice = readConcurrentNotice();
      if (notice && !noticeWarned) {
        noticeWarned = true;
        setStatus("检测到「禁止同时观看多个视频」：请关闭其他播放页面");
        flashPanel("#ef4444");
      }

      // 3) 进度读取 + 保活 + 定时暂停 + 播完未达标自动重播
      var current = readProgress();
      var challengeUp = hasHumanChallenge();
      var vsNow = videoState();
      if (current !== null && !readCompletionStatus()) {
        pauseCycle(vsNow.found ? vsNow.paused : false, challengeUp);
        if (!pauseInProgress) keepAlive();
        maybeAutoReplay(current, required);
      }
      renderList();
      // v3pro：把面板上的新列表与当前数据对齐（自己做了变化检测，不会每秒重画）
      try { proTick(); } catch (e) { /* 布局问题绝不影响播放逻辑 */ }
      // 暴力模式页签下，安全模式的保活/定时暂停/自动重播让位（避免两个模式同时动播放器）
      // 视频列表两种模式都要刷：它渲染的是同一份队列（自适应采集结果）
      bruteRenderList();
      if (uiMode === "brute") {
        bruteUpdateLine();
        bruteModeUi();
      }
      // 每秒把当前资源的进度落库（按 id），保证离开本页后列表仍能显示它的进度
      var curIdNow = currentResourceId();
      if (curIdNow && current !== null) recordProgress(curIdNow, current);
      // 课程索引是异步渲染的：每 5 秒重扫一次，列表会自己长出来
      if (Date.now() - lastListScanAt > 5000) {
        lastListScanAt = Date.now();
        scanCourseResources();
      }

      if (current === null) {
        if (!missingProgressSince) missingProgressSince = Date.now();
        if (running && Date.now() - missingProgressSince > 60000) {
          clearInterval(monitorTimer);
          monitorTimer = 0;
          advanceToNext("连续 60 秒读不到进度，已跳过当前资源");
        }
        return;
      }
      missingProgressSince = 0;
      if (current !== null) keepAliveTries = 0;
      // 心跳：把 video 实时状态摆在状态行里，用于判断"监控在跑"和"视频到底停在哪"
      var vs = videoState();
      monitorTickAt = Date.now();
      currentTitle = (vs.found && !vs.paused) ? document.title.replace(/\s*[|｜].*$/, "") : currentTitle;
      lastPercent = current;
      var policy = challengePolicyOf(vs.found ? vs.duration : 0);
      renderHeader({
        title: currentTitle || document.title.replace(/\s*[|｜].*$/, ""),
        percent: current,
        required: required,
        playing: vs.found ? !vs.paused : null,
        policyMin: policy && policy.required ? policy.intervalMin : 0,
      });
      // 状态摘要用标签呈现：每条信息独立成块，窄面板也会换行而不是被截断
      renderChips([
        vs.found ? { text: vs.currentTime + " / " + vs.duration + "s",
                     tone: vs.paused ? "warn" : "on" } : { text: "未找到视频", tone: "warn" },
        vs.paused ? { text: "已暂停", tone: "warn" } : { text: "播放中", tone: "on" },
        vs.nearEnd ? { text: "已到结尾", tone: "warn" } : null,
        pauseEnabled() ? { text: pauseCountdownText(), tone: "info" } : { text: "定时暂停关" },
        policy && policy.required ? { text: "弹窗每 " + policy.intervalMin + " 分钟" } : null,
        state.challengePassed ? { text: "已自动通过 " + state.challengePassed + " 次", tone: "on" } : null,
        autoReplayCount ? { text: "重播 " + autoReplayCount + " 次" } : null,
        { text: running ? "队列运行中" : "仅监控", tone: running ? "info" : null },
      ]);
      syncToggleLabels();
      // 只有「进度真的到阈值」才推进；读不到进度时才退回严格完成标记。
      // 别再退回宽松的 readCompletionStatus() —— 它会把页面上的「已完成」字样直接当成看完。
      var verdict = safeCanAdvance(current, required);
      if (running && verdict.advance && (prefEmergencyOn() || !prefAutoNextOn())) {
        // 已达标但**不该自己跳走**的两种情形：按了急停 / 用户关了「完成后自动播下一节」
        if (lastWaitNote !== "no-autonext") {
          lastWaitNote = "no-autonext";
          log("已达达标线（" + verdict.why + "），但" +
            (prefEmergencyOn() ? "已按「急停」" : "「完成后自动播下一节」是关的") + " → 停在本节");
          setStatus("本节已达标（不自动跳下一节）");
        }
      } else if (running && verdict.advance) {
        log("推进下一节：" + verdict.why);
        clearInterval(monitorTimer);
        monitorTimer = 0;
        advanceToNext("当前资源达到完成要求（" + verdict.why + "）");
      } else if (running && !verdict.advance && lastWaitNote !== verdict.why) {
        lastWaitNote = verdict.why;   // 只在于原因变化时写一次日志，避免每秒刷屏
        log("暂不推进：" + verdict.why);
      }
    }, 1000);
  }

  async function monitorCurrentResource() {
    var s = loadState();
    var item = (s.queue || [])[s.index] || (s.queue || [])[0];
    var required = readRequiredProgress();
    setStatus("正在处理：" + (item ? item.name : document.title) + "；完成阈值 " + required + "%");

    var progress0 = readProgress();
    if (s.running && ((progress0 !== null && progress0 >= required) || readCompletionStatus())) {
      advanceToNext("当前资源已完成");
      return;
    }
    ensureMonitor();
  }

  function readConcurrentNotice() {
    var selectors = [".alert", ".alert-warning", ".toast", ".notification", "[role='alert']"];
    for (var i = 0; i < selectors.length; i++) {
      var text = textOf(selectors[i]);
      if (text.indexOf("禁止同时观看多个视频") >= 0 && text.indexOf("其他视频") >= 0) return text;
    }
    return "";
  }

  // ==========================================================================
  //  面板 UI：可拖动 / 可缩放 / 可最小化 + 视频列表 + 上一节下一节重播
  // ==========================================================================
  var PANEL_KEY = "scnu_liruyun_panel";
  var PROGRESS_KEY = "scnu_liruyun_progress";
  var panelPos = gmGet(PANEL_KEY, null);
  var minimized = gmGet("scnu_liruyun_panel_min", false);
  var autoReplayCount = 0;
  var lastReplayAt = 0;

  function flashPanel(color) {
    if (!ui) return;
    ui.style.setProperty("--lr-flash", color);
    ui.classList.add("lr-flash");
    setTimeout(function () { if (ui) ui.classList.remove("lr-flash"); }, 1500);
  }
  var currentTitle = "";
  var lastPercent = null;

  // 标题栏：把"正在看什么、到哪了、播没在播"放在最显眼处。
  // 布局要求：标题最多 2 行、**不做单行省略**（否则长视频名会看不出是哪一节），
  // 百分比独占一列不参与挤压；完整标题仍挂在 title 属性上供悬停查看。
  function renderHeader(info) {
    if (!ui) return;
    info = info || {};
    var t = ui.querySelector(".lr-title");
    if (t) {
      t.textContent = info.title || "砺儒云播放助手";
      t.title = info.title || "";
    }
    var pct = ui.querySelector(".lr-headpct");
    if (pct) {
      pct.textContent = (info.percent === null || info.percent === undefined)
        ? "--%" : info.percent.toFixed(1) + "%";
      pct.style.color = (info.percent !== null && info.percent !== undefined &&
        info.required && info.percent >= info.required) ? "#4ade80" : "#bfdbfe";
    }
    var dot = ui.querySelector(".lr-dot");
    if (dot) {
      var cls = "lr-dot";
      if (info.playing === true) cls += " lr-dot-on";
      else if (info.playing === false) cls += " lr-dot-off";
      else cls += " lr-dot-unknown";
      dot.className = cls;
      dot.title = info.playing === true ? "播放中" : (info.playing === false ? "已暂停" : "未找到视频");
    }
    var req = ui.querySelector(".lr-headreq");
    if (req) req.textContent = info.required ? "/ " + info.required + "%" : "";
  }
  // 状态摘要：拆成多个小标签，一行放不下就换行显示完整内容，
  // 而不是挤成 "…未开队…" 这种看不出所以然的省略号。
  function renderChips(chips) {
    if (!ui) return;
    var box = ui.querySelector(".lr-chips");
    if (!box) return;
    var html = "";
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      if (!c) continue;
      html += '<span class="lr-chip' + (c.tone ? " lr-chip-" + c.tone : "") + '">' + escapeHtml(c.text) + "</span>";
    }
    box.innerHTML = html;
  }
  function setDetail(text) {
    if (!ui) return;
    var el = ui.querySelector(".lr-detail");
    if (el) el.textContent = text;
  }
  function setStatus(msg) {
    if (!ui) return;
    var el = ui.querySelector(".lr-status");
    if (el) el.textContent = msg;
  }
  // 开关类按钮：明确写出当前状态（开/关），而不是让用户猜
  function syncToggleLabels() {
    if (!ui) return;
    var m = {
      auto: "自动通过",
      replay: "自动重播",
    };
    for (var key in m) {
      var btn = ui.querySelector("button[data-action='" + key + "']");
      if (!btn) continue;
      var on = key === "auto" ? Boolean(state.autoPass) : Boolean(OPTS.autoReplay);
      btn.dataset.on = on ? "1" : "0";
      btn.textContent = m[key] + " " + (on ? "开" : "关");
      btn.classList.toggle("lr-on", on);
    }
  }
  function renderLog() {
    if (!ui) return;
    var box = ui.querySelector(".lr-log");
    // v3.4：pro 面板要能往回翻历史，所以把缓冲区整段写进去；原布局仍旧只留 10 行。
    var keepLines = 10;
    try {
      var host = document.getElementById("scnu-liruyun-helper");
      if (host && host.getAttribute("data-pro") === "1") keepLines = logBufferMax();
    } catch (_) {}
    if (box) {
      box.textContent = logs.slice(-keepLines).join("\n");
      // 默认跟到最新；用户往上翻看历史时不抢（UI 层的 scroll 监听会把它置 false）
      try { if (box.__lrStick !== false) box.scrollTop = box.scrollHeight; } catch (_) {}
    }
  }
  function toggleMinimize(force) {
    minimized = typeof force === "boolean" ? force : !minimized;
    if (!ui) return;
    ui.classList.toggle("lr-min", minimized);
    var box = ui.querySelector(".lr-minbtn");
    if (box) box.textContent = minimized ? "▢" : "—";
    gmSet("scnu_liruyun_panel_min", minimized);
  }

  // 面板位置按视口比例存，换分辨率也不会跑到屏幕外
  function restorePanelPos() {
    if (!ui) return;
    if (!panelPos) return;
    // 最小宽度/高度必须和 CSS 里的 min-width/min-height 一致，
    // 否则会恢复出"上上个版本存下来的过窄尺寸"，把标题和状态全挤掉。
    var w = Math.max(320, Math.min(panelPos.w || 360, window.innerWidth - 20));
    var h = Math.max(200, Math.min(panelPos.h || 480, window.innerHeight - 20));
    ui.style.width = w + "px";
    ui.style.height = h + "px";
    var left = Math.min(Math.max(0, (panelPos.rx || 0) * window.innerWidth), window.innerWidth - 60);
    var top = Math.min(Math.max(0, (panelPos.ry || 0) * window.innerHeight), window.innerHeight - 40);
    ui.style.left = left + "px";
    ui.style.top = top + "px";
    ui.style.right = "auto";
    ui.style.bottom = "auto";
  }
  function savePanelPos() {
    if (!ui) return;
    var r = ui.getBoundingClientRect();
    panelPos = {
      rx: r.left / window.innerWidth,
      ry: r.top / window.innerHeight,
      w: r.width,
      h: r.height,
    };
    gmSet(PANEL_KEY, panelPos);
  }

  function setupDrag() {
    var handle = ui.querySelector(".lr-head");
    if (!handle) return;
    var dragging = false, offX = 0, offY = 0;
    handle.addEventListener("mousedown", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("lr-minbtn")) return;
      dragging = true;
      var r = ui.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var r = ui.getBoundingClientRect();
      var left = Math.min(Math.max(0, e.clientX - offX), window.innerWidth - 60);
      var top = Math.min(Math.max(0, e.clientY - offY), window.innerHeight - 30);
      ui.style.left = left + "px";
      ui.style.top = top + "px";
      ui.style.right = "auto";
      ui.style.bottom = "auto";
      void r;
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      savePanelPos();
    });
    // 缩放结束后也记住尺寸（CSS resize 不触发事件，用 mouseup + 轮询兜住）
    window.addEventListener("mouseup", function () { setTimeout(savePanelPos, 80); });
  }

  // 标签构造小工具：一律走 DOM API + textContent，不再用 innerHTML 拼字符串。
  // 原因：innerHTML 里带 style="..." 的双引号套在模板/字符串里，会让静态分析工具
  // 无法正确配对引号，从而看不见后半段代码（"函数未定义"的假阳性就是这么来的）。
  function mkEl(tag, cls, text, dataset) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    if (dataset) for (var k in dataset) el.dataset[k] = dataset[k];
    return el;
  }
  function mkBtn(action, label, title) {
    var b = mkEl("button", null, label, { action: action });
    if (title) b.title = title;
    return b;
  }

  function installUi() {
    ui = document.createElement("div");
    ui.id = "scnu-liruyun-helper";
    ui.setAttribute("data-liruyun", "panel");

    // ---- 标题栏：正在看什么 + 到哪了 + 播没在播（最高频信息放最上面）----
    var head = mkEl("div", "lr-head");
    var dot = mkEl("span", "lr-dot lr-dot-unknown");
    dot.title = "视频状态";
    head.appendChild(dot);
    var titleBox = mkEl("div", "lr-headmain");
    var titleEl = mkEl("div", "lr-title", "砺儒云播放助手");
    titleBox.appendChild(titleEl);
    // 状态摘要改成"标签组"：放在标题下面、允许换行，信息完整可读
    titleBox.appendChild(mkEl("div", "lr-chips"));
    head.appendChild(titleBox);
    var pctWrap = mkEl("div", "lr-headpctwrap");
    var pctEl = mkEl("span", "lr-headpct", "--%");
    var reqEl = mkEl("span", "lr-headreq", "");
    pctWrap.appendChild(pctEl);
    pctWrap.appendChild(reqEl);
    head.appendChild(pctWrap);
    var minBtn = mkEl("span", "lr-minbtn", "—");
    minBtn.title = "最小化 / 展开";
    head.appendChild(minBtn);
    ui.appendChild(head);

    var body = mkEl("div", "lr-body");

    // ---- 列表（占满剩余空间，这是面板的主体）----
    body.appendChild(mkEl("div", "lr-list"));

    // ---- 一行式操作（上一节 / 播放 / 下一节）----
    var tools = mkEl("div", "lr-tools");
    tools.appendChild(mkBtn("prev", "⏮", "上一个视频"));
    tools.appendChild(mkBtn("nav", "▶ 播放 / 重播", "播放或从头重播当前视频"));
    tools.appendChild(mkBtn("next", "⏭", "下一个视频"));
    body.appendChild(tools);

    // ---- 折叠区：设置与运维（默认收起，需要时展开，避免干扰）----
    var advanced = mkEl("details", "lr-adv");
    advanced.appendChild(mkEl("summary", null, "设置 / 诊断"));

    var pauseRow = mkEl("div", "lr-row");
    pauseRow.appendChild(mkEl("span", "lr-lab", "定时暂停"));
    var everyInput = mkEl("input", "lr-num");
    everyInput.type = "number"; everyInput.min = "0"; everyInput.step = "1";
    everyInput.dataset.cfg = "every";
    everyInput.title = "每多少分钟暂停一次（0 = 关闭）";
    pauseRow.appendChild(everyInput);
    pauseRow.appendChild(mkEl("span", "lr-unit", "分"));
    var forInput = mkEl("input", "lr-num");
    forInput.type = "number"; forInput.min = "0"; forInput.step = "1";
    forInput.dataset.cfg = "dur";
    forInput.title = "每次暂停多少秒";
    pauseRow.appendChild(forInput);
    pauseRow.appendChild(mkEl("span", "lr-unit", "秒"));
    pauseRow.appendChild(mkBtn("pausecfg", "应用"));
    advanced.appendChild(pauseRow);
    advanced.appendChild(mkEl("div", "lr-hint", policyHintText()));

    var swRow = mkEl("div", "lr-row");
    swRow.appendChild(mkBtn("auto", "自动通过 开", "学习确认弹窗出现时自动完成"));
    swRow.appendChild(mkBtn("replay", "自动重播 开", "播完但未达标时自动从头重播"));
    advanced.appendChild(swRow);

    // 「刷新列表」单独一行，放在「开始本页资源」上面：
    // 列表不对时，用户第一眼要看到的就是「重扫一次」，而不是先启动队列。
    var refreshRow = mkEl("div", "lr-row");
    refreshRow.appendChild(mkBtn("refresh-list", "刷新列表", "强制重扫视频列表（多容器择优 + 自动展开 + 服务端兜底）"));
    advanced.appendChild(refreshRow);
    var opRow = mkEl("div", "lr-row");
    opRow.appendChild(mkBtn("start", "开始本页资源", "收集本节视频并开始队列"));
    opRow.appendChild(mkBtn("current", "仅播当前页", "只处理当前这一节"));
    opRow.appendChild(mkBtn("audit", "事件体检", "诊断学习确认按钮能收到哪些事件"));
    opRow.appendChild(mkBtn("stop", "停止", "停止队列（监控继续）"));
    advanced.appendChild(opRow);

    advanced.appendChild(mkEl("div", "lr-status", ""));
    var logBox = mkEl("div", "lr-log");
    advanced.appendChild(logBox);
    // ---- 暴力模式模块插入点 ----
    // 先把「设置 / 诊断」挂进 body，**再**调 installBruteUi：
    // 后者要 insertBefore(box, advanced)，参照节点必须先真的是 body 的子节点，
    // 否则真实 DOM 会抛 NotFoundError 导致整个面板装不出来。
    body.appendChild(advanced);

    // 把模式切换放到列表上方，把暴力面板插在「设置 / 诊断」前面，
    // 再把原本的安全模式内容整体包进 #lr-safe-area（便于按模式整块显隐）。
    installBruteUi(body, advanced);

    ui.appendChild(body);

    // 自定义缩放手柄（比浏览器默认的 resize 角标好看，也好点）
    var grip = mkEl("div", "lr-grip");
    grip.title = "拖动改变大小";
    ui.appendChild(grip);

    var style = document.createElement("style");
    style.setAttribute("data-liruyun", "style");
    style.textContent =
      "#scnu-liruyun-helper{--bg:#0f172a;--bg2:#111c33;--line:#1e293b;--fg:#e2e8f0;--dim:#94a3b8;" +
      "--accent:#3b82f6;position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
      "width:360px;height:480px;min-width:320px;min-height:200px;display:flex;flex-direction:column;" +
      "box-sizing:border-box;border-radius:12px;overflow:hidden;color:var(--fg);background:var(--bg);" +
      "border:1px solid var(--line);box-shadow:0 12px 34px rgba(0,0,0,.45);" +
      "font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;}" +
      "#scnu-liruyun-helper.lr-flash{box-shadow:0 0 0 3px var(--lr-flash,#f97316),0 12px 34px rgba(0,0,0,.45);}" +
      // 标题栏：标题最多两行、不做单行省略；百分比独占一列
      "#scnu-liruyun-helper .lr-head{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;flex:0 0 auto;" +
      "background:var(--bg2);border-bottom:1px solid var(--line);cursor:move;user-select:none;}" +
      "#scnu-liruyun-helper .lr-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#64748b;margin-top:6px;}" +
      "#scnu-liruyun-helper .lr-dot-on{background:#22c55e;box-shadow:0 0 6px #22c55e;}" +
      "#scnu-liruyun-helper .lr-dot-off{background:#f59e0b;}" +
      "#scnu-liruyun-helper .lr-headmain{flex:1 1 auto;min-width:0;}" +
      "#scnu-liruyun-helper .lr-title{font-weight:600;font-size:12.5px;color:#e2e8f0;line-height:1.35;" +
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}" +
      "#scnu-liruyun-helper .lr-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}" +
      "#scnu-liruyun-helper .lr-chip{font-size:10px;color:var(--dim);background:rgba(148,163,184,.12);" +
      "border:1px solid rgba(148,163,184,.18);border-radius:999px;padding:1px 7px;white-space:nowrap;}" +
      "#scnu-liruyun-helper .lr-chip-on{color:#86efac;background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.3);}" +
      "#scnu-liruyun-helper .lr-chip-warn{color:#fcd34d;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.3);}" +
      "#scnu-liruyun-helper .lr-chip-info{color:#bfdbfe;background:rgba(59,130,246,.14);border-color:rgba(59,130,246,.3);}" +
      "#scnu-liruyun-helper .lr-headpctwrap{display:flex;align-items:baseline;gap:2px;flex:0 0 auto;}" +
      "#scnu-liruyun-helper .lr-headpct{font-weight:700;font-size:15px;color:#bfdbfe;font-variant-numeric:tabular-nums;}" +
      "#scnu-liruyun-helper .lr-headreq{font-size:10px;color:var(--dim);}" +
      "#scnu-liruyun-helper .lr-minbtn{cursor:pointer;color:var(--dim);font-weight:700;padding:0 2px 0 6px;flex:0 0 auto;}" +
      "#scnu-liruyun-helper .lr-minbtn:hover{color:#fff;}" +
      // 主体
      "#scnu-liruyun-helper .lr-body{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;}" +
      "#scnu-liruyun-helper.lr-min{height:auto !important;width:230px !important;}" +
      "#scnu-liruyun-helper.lr-min .lr-body,#scnu-liruyun-helper.lr-min .lr-grip{display:none;}" +
      // 列表
      "#scnu-liruyun-helper .lr-list{flex:1 1 auto;min-height:44px;overflow:auto;padding:4px 6px;}" +
      "#scnu-liruyun-helper .lr-list::-webkit-scrollbar{width:8px;}" +
      "#scnu-liruyun-helper .lr-list::-webkit-scrollbar-thumb{background:#334155;border-radius:4px;}" +
      "#scnu-liruyun-helper .lr-item{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;" +
      "cursor:pointer;transition:background .12s;}" +
      "#scnu-liruyun-helper .lr-item:hover{background:rgba(148,163,184,.14);}" +
      "#scnu-liruyun-helper .lr-item.lr-cur{background:rgba(59,130,246,.2);}" +
      "#scnu-liruyun-helper .lr-item.lr-cur .lr-name{color:#dbeafe;font-weight:600;}" +
      "#scnu-liruyun-helper .lr-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;color:#cbd5e1;}" +
      "#scnu-liruyun-helper .lr-pct{flex:0 0 auto;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;}" +
      "#scnu-liruyun-helper .lr-badge{flex:0 0 auto;font-size:9px;padding:1px 5px;border-radius:999px;" +
      "background:rgba(34,197,94,.18);color:#4ade80;border:1px solid rgba(34,197,94,.35);}" +
      // 按钮
      "#scnu-liruyun-helper button{cursor:pointer;border:1px solid var(--line);border-radius:7px;" +
      "padding:6px 9px;background:#1e293b;color:#e2e8f0;font-size:11px;white-space:nowrap;" +
      "transition:background .12s,border-color .12s,transform .06s;}" +
      "#scnu-liruyun-helper button:hover{background:#26364d;border-color:#334155;}" +
      "#scnu-liruyun-helper button:active{transform:translateY(1px);}" +
      "#scnu-liruyun-helper button.lr-on{background:rgba(59,130,246,.22);border-color:#3b82f6;color:#bfdbfe;}" +
      "#scnu-liruyun-helper button[data-action='nav']{flex:1 1 auto;background:var(--accent);border-color:var(--accent);" +
      "color:#fff;font-weight:600;}" +
      "#scnu-liruyun-helper button[data-action='nav']:hover{background:#2f74e0;}" +
      "#scnu-liruyun-helper button[data-action='stop']{color:#fca5a5;}" +
      "#scnu-liruyun-helper button[data-action='pausecfg']{background:rgba(34,197,94,.18);border-color:#166534;color:#86efac;}" +
      "#scnu-liruyun-helper .lr-adv button[data-action='start']{background:rgba(34,197,94,.18);" +
      "border-color:#166534;color:#86efac;}" +
      // 工具行 / 折叠区
      "#scnu-liruyun-helper .lr-tools{display:flex;gap:6px;padding:7px 8px;flex:0 0 auto;" +
      "border-top:1px solid var(--line);background:var(--bg2);}" +
      "#scnu-liruyun-helper .lr-adv{flex:0 0 auto;border-top:1px solid var(--line);background:var(--bg2);}" +
      "#scnu-liruyun-helper .lr-adv>summary{cursor:pointer;padding:6px 10px;color:var(--dim);font-size:11px;" +
      "list-style:none;user-select:none;}" +
      "#scnu-liruyun-helper .lr-adv>summary::-webkit-details-marker{display:none;}" +
      "#scnu-liruyun-helper .lr-adv>summary:before{content:'▸ ';}" +
      "#scnu-liruyun-helper .lr-adv[open]>summary:before{content:'▾ ';}" +
      "#scnu-liruyun-helper .lr-adv>summary:hover{color:#e2e8f0;}" +
      "#scnu-liruyun-helper .lr-row{display:flex;align-items:center;gap:6px;padding:6px 10px;flex-wrap:wrap;}" +
      "#scnu-liruyun-helper .lr-lab{color:var(--dim);font-size:11px;}" +
      "#scnu-liruyun-helper .lr-unit{color:var(--dim);font-size:11px;}" +
      "#scnu-liruyun-helper .lr-num{width:52px;background:#0b1220;color:#e2e8f0;border:1px solid var(--line);" +
      "border-radius:6px;padding:4px 6px;font-size:11px;text-align:center;}" +
      "#scnu-liruyun-helper .lr-num:focus{outline:none;border-color:var(--accent);}" +
      "#scnu-liruyun-helper .lr-hint{color:var(--dim);font-size:10px;line-height:1.45;padding:0 10px 6px;" +
      "word-break:break-word;}" +
      "#scnu-liruyun-helper .lr-status{color:#cbd5e1;font-size:11px;padding:2px 10px 6px;word-break:break-word;}" +
      "#scnu-liruyun-helper .lr-log{max-height:92px;overflow:auto;color:#7c8aa0;white-space:pre-wrap;" +
      "font-family:ui-monospace,Consolas,monospace;font-size:10px;padding:6px 10px 8px;" +
      "border-top:1px dashed var(--line);}" +
      // 缩放手柄
      "#scnu-liruyun-helper .lr-grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;" +
      "background:linear-gradient(135deg,transparent 45%,#475569 45%,#475569 55%,transparent 55%,transparent 70%," +
      "#475569 70%,#475569 80%,transparent 80%);}" +
      "#scnu-liruyun-helper .lr-grip:hover{background:linear-gradient(135deg,transparent 45%,#94a3b8 45%," +
      "#94a3b8 55%,transparent 55%,transparent 70%,#94a3b8 70%,#94a3b8 80%,transparent 80%);}";

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(ui);
    // 暴力模块自己的事件：模式页签切换 + 它的输入项变更回写
    ui.addEventListener("click", bruteOnPanelClick);
    ui.addEventListener("change", function (ev) {
      if (ev.target && ev.target.id && ev.target.id.indexOf("lr-brute-") === 0) bruteReadInputs();
    });
    // 折叠分区的展开状态：toggle 事件会冒泡到 ui，在这里统一记录。
    // v3 之后不止「设置 / 诊断」一个折叠块（暴力模式还有参数/诊断/批量），
    // 所以按 data-advkey 分别记：没带 key 的仍用老存储键，老用户的选择不丢。
    ui.addEventListener("toggle", function (ev) {
      if (ev.target && ev.target.tagName === "DETAILS") {
        var box = (ev.target.classList && ev.target.classList.contains("lr-adv")) ||
          (ev.target.dataset && ev.target.dataset.advkey) ? ev.target : null;
        if (box) bruteSaveAdvState(box);
      }
    }, true);
    initBrute();
    // v3pro：面板建好后立刻重排（proTick 每次都会检查，没建好就下次再来）
    try { proTick(); } catch (e) { log("面板重排启动失败（退回原布局）：" + ((e && e.message) || e)); }
    // 安装完延迟做一次面板自检：CSS 生效要一帧，太早检测会误报；
    // 万一面板被存到屏幕外/CSS 没生效，这里会自救并把结果写进日志。
    bruteSchedulePanelCheck(1500);

    ui.addEventListener("click", function (ev) {
      var t = ev.target;
      if (t.classList && t.classList.contains("lr-minbtn")) { toggleMinimize(); return; }
      var item = t.closest ? t.closest(".lr-item") : null;
      if (item && item.dataset.url) { goToResource(item.dataset.url); return; }
      var action = t.getAttribute && t.getAttribute("data-action");
      if (!action) return;
      // v3：刷新列表由自适应列表模块处理（点数、缓存、服务端兜底都在那边）
      if (action === "refresh-list") {
        try { setStatus("正在刷新视频列表…"); adaptiveRefreshNow(); } catch (e) { log("刷新列表出错：" + ((e && e.message) || e)); }
        return;
      }
      log("面板点击：" + action);
      try {
        if (action === "start") startFromCurrentPage();
        if (action === "current") startCurrentResourceOnly();
        if (action === "stop") stopRun("已停止");
        if (action === "audit") auditEvents();
        if (action === "prev") stepResource(-1);
        if (action === "next") stepResource(1);
        if (action === "nav") playOrReplay(true);
        if (action === "pausecfg") applyPauseConfig();
        if (action === "auto") {
          state.autoPass = !state.autoPass;
          log("自动通过已" + (state.autoPass ? "开启" : "关闭"));
        }
        if (action === "replay") {
          OPTS.autoReplay = !OPTS.autoReplay;
          t.textContent = "自动重播：" + (OPTS.autoReplay ? "开" : "关");
          log("播完但未达标自动重播已" + (OPTS.autoReplay ? "开启" : "关闭"));
        }
      } catch (err) {
        // 以前这里异常是静默的：点了没反应，也看不到原因。
        log("面板动作 " + action + " 抛错：" + (err && err.message ? err.message : err));
        setStatus("操作失败：" + (err && err.message ? err.message : err));
        try { console.error(TAG, err); } catch (_) {}
      }
    });

    restorePanelPos();
    setupDrag();
    setupResizeGrip();
    // 定时暂停配置：读回上次设置并填进输入框
    pauseEveryEl = ui.querySelector("input[data-cfg='every']");
    pauseForEl = ui.querySelector("input[data-cfg='dur']");
    var pauseCfg = gmGet("scnu_liruyun_pause_cfg", null);
    if (pauseCfg && typeof pauseCfg.every === "number") {
      OPTS.pauseEveryMin = pauseCfg.every;
      OPTS.pauseForSec = pauseCfg.dur;
    }
    if (pauseEveryEl) pauseEveryEl.value = String(OPTS.pauseEveryMin);
    if (pauseForEl) pauseForEl.value = String(OPTS.pauseForSec);
    if (OPTS.pauseEveryMin > 0 && OPTS.pauseForSec > 0) lastPauseCycleAt = Date.now();
    log("定时暂停当前设置：" + (pauseEnabled() ? "已启用，每 " + OPTS.pauseEveryMin + " 分钟暂停 " +
      OPTS.pauseForSec + " 秒" : "未启用（间隔填 0 即关闭）"));
    toggleMinimize(minimized);
    syncToggleLabels();
    renderStatus();
    renderHeader({ title: document.title.replace(/\s*[|｜].*$/, ""), percent: lastPercent, required: readRequiredProgress() });
    renderList();
    renderLog();

    // 输入框回车 = 点"应用"
    ui.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && ev.target && ev.target.classList &&
          ev.target.classList.contains("lr-num")) {
        applyPauseConfig();
      }
    });
  }

  // 自定义缩放手柄（比浏览器默认 resize 角标更明确）
  function setupResizeGrip() {
    var grip = ui.querySelector(".lr-grip");
    if (!grip) return;
    var resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
    grip.addEventListener("mousedown", function (e) {
      resizing = true;
      var r = ui.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startW = r.width; startH = r.height;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener("mousemove", function (e) {
      if (!resizing) return;
      var w = Math.max(270, Math.min(startW + (e.clientX - startX), window.innerWidth - 20));
      var h = Math.max(170, Math.min(startH + (e.clientY - startY), window.innerHeight - 20));
      ui.style.width = w + "px";
      ui.style.height = h + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!resizing) return;
      resizing = false;
      savePanelPos();
    });
  }

  // ----------------------------------------------------------- 队列与导航
  function stepResource(offset) {
    var s = loadState();
    var queue = s.queue || [];
    if (!queue.length) {
      var collected = collectResourcesFromPage();
      if (!collected.length) { setStatus("没有可用队列：请先点「开始本页资源」。"); return; }
      queue = collected;
      s.queue = collected;
      s.index = findCurrentResourceIndex(collected);
    }
    var idx = findCurrentResourceIndex(queue);
    var target = idx + offset;
    if (target < 0) { setStatus("已经是第一节"); return; }
    if (target >= queue.length) { setStatus("已经是最后一节"); return; }
    s.index = target;
    s.running = true;
    saveState(s);
    setStatus((offset > 0 ? "下一节" : "上一节") + "：" + queue[target].name);
    location.href = queue[target].url;
  }
  function goToResource(url) {
    var s = loadState();
    var queue = s.queue || [];
    for (var i = 0; i < queue.length; i++) {
      if (normalizeUrl(queue[i].url) === normalizeUrl(url)) {
        s.index = i;
        s.running = true;
        saveState(s);
        break;
      }
    }
    setStatus("切换到：" + (queue[s.index] ? queue[s.index].name : url));
    location.href = url;
  }
  // 播放器元素：TCPlayer 有时把 <video> 放在别的容器里，逐层兜底找
  // 播放器元素：页面里可能同时存在多个 <video>（预览/广告/隐藏的），
  // 取"第一个匹配"会盯错对象（实测出现 currentTime 倒退、paused=false 的怪现象）。
  // 判据：优先 #player-con 内、可见、面积最大、时长最长的那一个。
  function pickVideo(list) {
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var r = { width: 0, height: 0 };
      try { r = v.getBoundingClientRect(); } catch (_) {}
      var visible = r.width > 80 && r.height > 60;
      var inPlayer = false;
      try { inPlayer = Boolean(v.closest && v.closest("#player-con")); } catch (_) {}
      var dur = Number(v.duration) || 0;
      var score = (inPlayer ? 1000000 : 0) + (visible ? 500000 : 0) + Math.round(r.width * r.height) + dur;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }
  function videoEl() {
    var preferred = document.querySelectorAll("#player-con video");
    if (preferred.length) return pickVideo(preferred);
    var all = document.querySelectorAll("video");
    return all.length ? pickVideo(all) : null;
  }
  // 诊断：把页面上所有 <video> 摊开，用于确认"到底盯的是哪一个"
  function listVideos() {
    return Array.prototype.map.call(document.querySelectorAll("video"), function (v, i) {
      var r = { width: 0, height: 0 };
      try { r = v.getBoundingClientRect(); } catch (_) {}
      return {
        i: i,
        inPlayer: Boolean(v.closest && v.closest("#player-con")),
        size: Math.round(r.width) + "x" + Math.round(r.height),
        visible: r.width > 80 && r.height > 60,
        duration: Math.round(Number(v.duration) || 0),
        currentTime: Math.round(Number(v.currentTime) || 0),
        paused: Boolean(v.paused),
        ended: Boolean(v.ended),
        isPicked: v === videoEl(),
        src: String(v.currentSrc || v.src || "").slice(0, 50),
      };
    });
  }
  function videoState() {
    var v = videoEl();
    if (!v) return { found: false };
    var d = Number(v.duration) || 0;
    var c = Number(v.currentTime) || 0;
    return {
      found: true,
      duration: Math.round(d),
      currentTime: Math.round(c),
      paused: Boolean(v.paused),
      ended: Boolean(v.ended),
      nearEnd: d > 0 && c >= d - 0.4,
      src: String(v.currentSrc || v.src || "").slice(0, 60),
    };
  }
  // 播放 / 重播：优先用播放器自身的 API（播放结束后 currentTime 归零才会真正重播）
  function playOrReplay(fromButton) {
    var v = videoEl();
    if (v) {
      try {
        if (v.ended || (v.duration && v.currentTime >= v.duration - 0.3)) {
          v.currentTime = 0;
          if (fromButton) log("手动重播：currentTime 已归零");
        }
        var p = v.play();
        if (p && p.catch) p.catch(function (err) {
          log("video.play() 被拒：" + (err && err.name ? err.name : err) + "，改用点击播放控件");
          var ctl = firstVisible(KEEP_ALIVE_SELECTORS);
          if (ctl) ctl.click();
        });
        return true;
      } catch (err) {
        log("重播异常：" + (err && err.message ? err.message : err));
      }
    }
    var control = firstVisible(KEEP_ALIVE_SELECTORS);
    if (control) { control.click(); return true; }
    log("找不到 <video> 也找不到播放控件，无法重播");
    return false;
  }

  // 播完但未达标 → 自动重播。每一次拒绝都记日志（限流），否则出问题时完全看不到原因。
  var lastReplayRejectLog = 0;
  function rejectReplay(reason) {
    if (Date.now() - lastReplayRejectLog < 10000) return;
    lastReplayRejectLog = Date.now();
    log("自动重播未触发：" + reason);
  }
  function maybeAutoReplay(progress, required) {
    if (prefEmergencyOn()) return;        // 急停：不自动重播
    if (!OPTS.autoReplay) return rejectReplay("开关关闭");
    if (progress === null) return rejectReplay("读不到进度");
    if (progress >= required) return rejectReplay("进度已达标");
    if (Date.now() - lastReplayAt < 20000) return;
    var v = videoEl();
    if (!v) return rejectReplay("找不到 <video> 元素");
    var d = Number(v.duration) || 0;
    var c = Number(v.currentTime) || 0;
    // 结束判据要宽：ended 不一定会置位，停在结尾且处于暂停同样算播完
    var ended = Boolean(v.ended) || (d > 0 && c >= d - 1.5);
    if (!ended) return rejectReplay("视频未在结尾（" + Math.round(c) + "/" + Math.round(d) + "s，paused=" + v.paused + "）");
    lastReplayAt = Date.now();
    var ok = playOrReplay(false);
    if (ok) {
      autoReplayCount += 1;
      log("视频已播完但进度 " + progress.toFixed(1) + "% < " + required + "%，已自动重播（第 " + autoReplayCount + " 次）");
      setStatus("已播完但未达标（" + progress.toFixed(1) + "% / " + required + "%），自动重播中");
      flashPanel("#8b5cf6");
    } else {
      rejectReplay("重播动作失败");
    }
  }

  // 视频列表：当前项实时进度，其它项用本地记录；是否"完成"按页面阈值判断
  function progressDb() { return gmGet(PROGRESS_KEY, {}); }
  // 兼容旧调用：统一转到 recordProgress（带首次写入日志）
  function saveVideoProgress(id, value) { recordProgress(id, value); }
  // 看板用队列：进页面就自动收集一次，不要求先点「开始本页资源」。
  // 收集结果只用于"显示 + 导航"，不会自动开播、也不会自动跳转 ——
  // 只有点过开始（state.running）才会有自动跳转行为。
  var viewQueueCache = null;
  var lastListScanAt = 0;
  var lastScanReport = null;
  var lastScrolledRow = -1;
  function scanCourseResources() {
    var fresh = collectResourcesFromPage();
    // 诊断：把原始锚点摊开，便于确认"哪个锚点被当成了资源、标题取的哪一段"
    lastScanReport = {
      root: document.querySelector(SCAN_ROOT_SELECTOR) ? SCAN_ROOT_SELECTOR : "(整页兜底)",
      hasCourseIndex: Boolean(document.querySelector("#course-index")),
      anchors: Array.prototype.map.call(document.querySelectorAll("a[href]"), function (a) {
        var raw = a.getAttribute("href");
        var parsed = parseResourceUrl(raw);
        var txt = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36);
        if (!parsed && txt.indexOf("fsresource") < 0) return null;   // 只关心像资源的
        return {
          raw: String(raw).slice(0, 60),
          ok: Boolean(parsed),
          reason: parsed ? "" : "路径/id/lang 不合规",
          id: parsed ? parsed.id : "",
          text: txt,
        };
      }).filter(Boolean).slice(0, 40),
      kept: fresh.length,
    };
    if (!fresh.length) return;
    var before = viewQueueCache ? viewQueueCache.length : 0;
    if (fresh.length !== before) {
      viewQueueCache = fresh;
      if (before) log("列表已更新：" + before + " → " + fresh.length + " 个资源");
    } else {
      viewQueueCache = fresh;
    }
  }
  function viewQueue() {
    if (viewQueueCache && viewQueueCache.length) {
      // 页面索引是异步渲染的，条目变多就刷新缓存
      var fresh = collectResourcesFromPage();
      if (fresh.length > viewQueueCache.length) viewQueueCache = fresh;
      return viewQueueCache;
    }
    viewQueueCache = collectResourcesFromPage();
    return viewQueueCache;
  }
  // 当前页的资源 id：同一资源在课程索引里的 URL 会带章节参数
  // （&section=xxx&sectionid=yyy），与地址栏的 view.php?id=NNN 不相等，
  // 所以**必须按 id 判断"当前页是否已在列表里"**，比 URL 一定会误判成两条。
  function currentResourceId() {
    var m = location.href.match(/[?&]id=(\d+)/);
    return m ? m[1] : "";
  }
  function isCurrentEntry(item) {
    var cur = currentResourceId();
    if (!cur) return false;
    if (item.id && item.id === cur) return true;
    try {
      var u = new URL(item.url, location.href);
      return u.searchParams.get("id") === cur;
    } catch (_) { return false; }
  }
  function ensureViewQueue() {
    if (!viewQueueCache || !viewQueueCache.length) {
      var got = collectResourcesFromPage();
      if (got.length) {
        viewQueueCache = got;
        log("列表已收集 " + got.length + " 个视频资源");
      }
    }
    // 当前页不在列表里时才补一条；已存在（哪怕 URL 带章节参数）就绝不再插，
    // 否则同一资源会出现两条 —— 一条标题正确、一条是噪声标题。
    if (!RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; })) return;
    var exists = (viewQueueCache || []).some(isCurrentEntry);
    if (exists) return;
    var curId = currentResourceId();
    viewQueueCache = [{
      name: (document.title || "当前视频").replace(/\s*[|｜].*$/, "").trim() || "当前视频",
      url: location.href,
      id: curId,
    }].concat(viewQueueCache || []);
    log("当前页不在课程索引里，已单独加入列表（id=" + (curId || "无") + "）");
  }

  // 渲染前把队列按 id 归一化：即使上游某处漏了去重，同一资源也只会显示一条。
  // 标题优先取"更完整"的那条（噪声标题短且含"展开/折叠"这类词）。
  function normalizedQueue() {
    var out = [];
    var byId = {};
    var src = viewQueue();
    for (var i = 0; i < src.length; i++) {
      var it = src[i];
      var key = it.id || normalizeUrl(it.url);
      if (!byId[key]) { byId[key] = it; out.push(it); continue; }
      var prev = byId[key];
      var prevBad = !prev.name || isNoiseTitle(prev.name);
      var curBad = !it.name || isNoiseTitle(it.name);
      if (prevBad && !curBad) {
        var at = out.indexOf(prev);
        if (at >= 0) out[at] = it;
        byId[key] = it;
      }
    }
    return out;
  }

  function renderList() {
    if (!ui) return;
    var box = ui.querySelector(".lr-list");
    if (!box) return;
    ensureViewQueue();
    var queue = normalizedQueue();
    var required = readRequiredProgress();
    var live = readProgress();
    var db = progressDb();
    var curId = currentResourceId();
    // 当前资源实时读数优先落库，保证列表显示的 percent 与库里的值一致
    // （之前只在渲染尾部写库，导致"当前项要等离开页面才更新"）
    if (curId && live !== null) recordProgress(curId, live);

    if (!queue.length) {
      box.innerHTML = '<div class="lr-item"><span class="lr-name" style="color:#f87171">' +
        "没找到视频列表：进入课程页或点「开始本页资源」</span></div>";
      return;
    }
    var html = "";
    var curRow = -1;
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i];
      var id = item.id || "";
      // 当前项按 id 判断，不依赖下标（下标一旦算错就会标错行）
      var isCur = Boolean(curId && id === curId) || (!curId && isCurrentEntry(item));
      if (isCur) curRow = i;
      // 当前项用页面实时读数（更准），其它项用本地记录；
      // 两者都可能为空 —— 用 hasData 区分"真的是 0%"和"没有数据"。
      var raw = isCur ? (live === null ? db[id] : live) : db[id];
      var hasData = (raw !== undefined && raw !== null);
      var pct = hasData ? Number(raw) : 0;
      // 完成判断只看百分比，**不再排除当前项**：
      // 之前写成 !isCur && pct >= required，导致"正在看的这节即使完成了也不变绿"。
      var done = hasData && pct >= required;
      // 布局：[序号] 标题 …… [已完成徽章 / 百分比]
      html += '<div class="lr-item' + (isCur ? " lr-cur" : "") +
        '" data-url="' + String(item.url).replace(/"/g, "&quot;") + '" title="' + escapeHtml(item.name) + '">' +
        '<span class="lr-pct" style="width:14px;text-align:right">' + (i + 1) + "</span>" +
        '<span class="lr-name">' + escapeHtml(item.name) + "</span>" +
        (done
          ? '<span class="lr-pct">' + pct.toFixed(0) + '%</span><span class="lr-badge">已完成</span>'
          : '<span class="lr-pct"' + (hasData ? "" : ' style="opacity:.45" title="尚未记录到这一节的进度"') + '>' +
            (hasData ? pct.toFixed(0) + "%" : "—") + "</span>") +
        "</div>";
    }
    box.innerHTML = html;

    // 把当前项滚进可视区（只在"当前项变了"时滚，避免每秒抢滚动条）
    if (curRow >= 0 && curRow !== lastScrolledRow) {
      lastScrolledRow = curRow;
      var el = box.children[curRow];
      if (el && el.scrollIntoView) {
        try { el.scrollIntoView({ block: "nearest" }); } catch (_) {}
      }
    }
  }

  // 统一的进度落库入口：写入 + 首次写入时打日志（让"有没有在记录"可见）
  function recordProgress(id, value) {
    if (!id || value === null || value === undefined) return;
    var db = progressDb();
    var prev = db[id];
    if (prev === value) return;
    db[id] = value;
    gmSet(PROGRESS_KEY, db);
    if (prev === undefined) log("记录进度：id=" + id + " → " + value.toFixed(1) + "%");
  }
  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ==========================================================================
  //  状态显示 / 运行控制 / 提醒（这一组曾被误删，补回）
  // ==========================================================================
  var beepCtx = null;
  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      // 复用同一个 AudioContext：每 1.2 秒 new 一个会很快撞上浏览器实例上限，
      // 之后 beep() 就永久静音（表现为"提醒突然不响了"）。
      if (!beepCtx) beepCtx = new Ctx();
      if (beepCtx.state === "suspended" && beepCtx.resume) beepCtx.resume();
      var osc = beepCtx.createOscillator();
      var gain = beepCtx.createGain();
      osc.type = "sine"; osc.frequency.value = 880; gain.gain.value = 0.04;
      osc.connect(gain); gain.connect(beepCtx.destination);
      osc.start();
      setTimeout(function () { try { osc.stop(); osc.disconnect(); gain.disconnect(); } catch (_) {} }, 180);
    } catch (_) {}
  }
  function startChallengeAlert() {
    if (challengeAlertTimer) return;
    originalTitle = document.title;
    challengeAlertTimer = setInterval(function () {
      titleFlip = !titleFlip;
      document.title = titleFlip ? "【正在自动通过学习确认】" : originalTitle;
      beep();
      var node = findChallengeMask();
      if (node) node.scrollIntoView({ block: "center", inline: "center" });
    }, 1200);
  }
  function stopChallengeAlert() {
    if (challengeAlertTimer) { clearInterval(challengeAlertTimer); challengeAlertTimer = 0; }
    document.title = originalTitle;
  }

  function renderStatus() {
    if (!ui) return;
    var s = loadState();
    var queueLen = (s.queue || []).length || (viewQueueCache || []).length;
    var prefix = (s.running ? "运行中" : "仅监控");
    setStatus(prefix + "：" + (s.index + 1) + "/" + queueLen +
      " · 确认 " + state.challengeSeen + " 次（通过 " + state.challengePassed + " / 失败 " + state.challengeFailed + "）" +
      (autoReplayCount ? " · 重播 " + autoReplayCount + " 次" : "") +
      " · 最近 " + state.lastResult);
  }

  function stopRun(message) {
    var s = loadState();
    s.running = false;
    saveState(s);
    stopChallengeAlert();
    log("已停止队列（监控仍在运行）");
    setStatus(message || "已停止");
  }

  function startFromCurrentPage() {
    log("开始本页资源：收集队列…");
    var queue = collectResourcesFromPage();
    log("收集到 " + queue.length + " 个资源");
    if (!queue.length) {
      setStatus("本页没找到 fsresource/H5P 资源：先点「仅播当前页」也能用");
      renderStatus();
      return;
    }
    viewQueueCache = queue;
    var s = {
      running: true, queue: queue,
      index: findCurrentResourceIndex(queue), lastIndex: -1,
      sourceUrl: location.href, sourceTitle: document.title,
    };
    saveState(s);
    renderList();
    var target = queue[s.index];
    if (target && normalizeUrl(location.href) !== normalizeUrl(target.url)) {
      setStatus("打开第 " + (s.index + 1) + "/" + queue.length + " 个：" + target.name);
      location.href = target.url;
      return;
    }
    setStatus("已收集 " + queue.length + " 个资源，从当前页开始监控");
    monitorCurrentResource();
  }

  function startCurrentResourceOnly() {
    var okPath = RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; });
    if (!okPath) { setStatus("当前页不是 fsresource/H5P 资源页。"); return; }
    var idMatch = location.href.match(/[?&]id=(\d+)/);
    var queue = [{ name: document.title || "当前视频", url: location.href, id: idMatch ? idMatch[1] : "" }];
    viewQueueCache = queue;
    saveState({ running: true, queue: queue, index: 0, lastIndex: -1,
      sourceUrl: location.href, sourceTitle: document.title });
    renderList();
    log("仅播当前页：开始监控并尝试起播");
    monitorCurrentResource();
  }

  // ==========================================================================
  //  定时暂停 / 续播（可自定义）：每 N 分钟暂停 M 秒再继续
  // ==========================================================================
  var pauseEveryEl = null;
  var pauseForEl = null;
  var lastPauseCycleAt = 0;
  var pauseCycleArmed = false;
  var pauseCycleCount = 0;
  var pauseInProgress = false;
  var pauseResumeTimer = 0;
  var pauseUntilAt = 0;

  // --------------------------------------------------------------------------
  //  本页「学习确认」弹窗的触发规律（依据站点前端 main.js 的
  //  updateChallengePolicyByDuration / isChallengePassed 逻辑）：
  //    · 视频总时长 ≤ 10 分钟 → requiresChallenge = false，整段**不弹窗**
  //    · 10~15 分钟 → 间隔 10 分钟；15~30 分钟 → 15 分钟；> 30 分钟 → 20 分钟
  //    · 首次触发点 = 播放开始时刻 + 间隔；之后每次"通过"再顺延一个间隔
  //    · 判定用的是 Date.now()（墙钟），**不是累计播放时长**
  //  由此得到两个必须讲清楚的结论：
  //    ① 定时暂停**不能规避弹窗** —— 暂停只是"暂停期间不触发"，
  //       恢复后剩余时间接着走，弹窗照样会来（它那个时钟没被重置）。
  //    ② 真正的规避只有一条：让视频总时长 ≤ 10 分钟。
  //  那定时暂停还有什么用：模拟"真人间断观看"的播放行为特征（平台的反挂机
  //  模型常看"是否长时间连续播放"），以及给需要人工介入的场景留出窗口。
  // --------------------------------------------------------------------------
  function challengePolicyOf(durationSec) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    var min = durationSec / 60;
    if (min <= 10) return { required: false, intervalMin: 0, text: "总时长 ≤ 10 分钟：整段不弹确认" };
    var interval = 10;
    if (min > 30) interval = 20;
    else if (min > 15) interval = 15;
    return {
      required: true,
      intervalMin: interval,
      text: "总时长 " + min.toFixed(1) + " 分钟：每 " + interval +
        " 分钟弹一次（首次约在播放后 " + interval + " 分钟）",
    };
  }
  function policyHintText() {
    var v = videoEl();
    var policy = challengePolicyOf(v ? Number(v.duration) : 0);
    if (!policy) return "弹窗规律：时长未知（视频起播后自动判断）";
    return "弹窗规律：" + policy.text;
  }

  function applyPauseConfig() {
    if (!pauseEveryEl || !pauseForEl) return;
    var rawEvery = pauseEveryEl.value;
    var rawFor = pauseForEl.value;
    var notes = [];

    // 非法输入一律钳制：空/非数字→0，并把钳制后的值回填到输入框，
    // 让用户看到"我输的东西被怎么理解了"，而不是静默失效。
    var every = parseFloat(rawEvery);
    if (!Number.isFinite(every) || every < 0) { every = 0; notes.push("间隔无效已按 0 处理"); }
    if (every > 0 && every < 1) { every = 1; notes.push("间隔小于 1 分钟已按 1 分钟"); }
    if (every > 180) { every = 180; notes.push("间隔超过 180 分钟已按 180"); }

    var dur = parseFloat(rawFor);
    if (!Number.isFinite(dur) || dur < 0) { dur = 0; notes.push("暂停时长无效已按 0 处理"); }
    if (dur > 0 && dur < 1) { dur = 1; notes.push("暂停时长小于 1 秒已按 1 秒"); }
    if (dur > 300) { dur = 300; notes.push("暂停时长超过 300 秒已按 300"); }

    OPTS.pauseEveryMin = every;
    OPTS.pauseForSec = dur;
    pauseEveryEl.value = String(every);
    pauseForEl.value = String(dur);
    gmSet("scnu_liruyun_pause_cfg", { every: every, dur: dur });

    var enabled = every > 0 && dur > 0;
    var policy = challengePolicyOf((function () { var v = videoEl(); return v ? Number(v.duration) : 0; })());
    if (enabled && policy && policy.required && every <= policy.intervalMin) {
      notes.push("提醒：本视频每 " + policy.intervalMin + " 分钟必弹一次，暂停不会重置它的计时");
    }
    log((enabled ? "定时暂停已启用：" : "定时暂停已关闭：") +
      "每 " + every + " 分钟暂停 " + dur + " 秒" + (notes.length ? "（" + notes.join("；") + "）" : ""));
    // 应用后立刻重置计时基准，避免刚设置完就马上触发一次
    if (enabled) { lastPauseCycleAt = Date.now(); pauseCycleArmed = true; }
    flashPanel(enabled ? "#22c55e" : "#64748b");
    setStatus(enabled
      ? "定时暂停已启用：每 " + every + " 分钟暂停 " + dur + " 秒（首次将在 " + every + " 分钟后）"
      : "定时暂停未启用（间隔填 0 即关闭）");
  }

  // 下次暂停倒计时文案：未启用 / 暂停中 / 剩余 mm:ss
  function pauseCountdownText() {
    var every = OPTS.pauseEveryMin;
    var dur = OPTS.pauseForSec;
    if (!every || !dur) return "定时暂停关闭";
    if (pauseInProgress) return "暂停中，剩 " + Math.max(0, Math.ceil((pauseUntilAt - Date.now()) / 1000)) + "s";
    if (!pauseCycleArmed) return "定时暂停待播";
    var remainMs = lastPauseCycleAt + every * 60000 - Date.now();
    if (remainMs <= 0) return "定时暂停即将触发";
    var totalSec = Math.ceil(remainMs / 1000);
    var mm = Math.floor(totalSec / 60);
    var ss = totalSec % 60;
    return "下次暂停 " + mm + ":" + (ss < 10 ? "0" : "") + ss + "（停 " + dur + "s）";
  }
  function pauseEnabled() { return Boolean(OPTS.pauseEveryMin && OPTS.pauseForSec); }
  function pauseCycle(paused, challengeUp) {
    if (!OPTS.pauseEveryMin || !OPTS.pauseForSec) return;
    if (!paused) { pauseInProgress = false; pauseCycleArmed = true; }
    if (!pauseCycleArmed || pauseInProgress || challengeUp) return;
    if (Date.now() - lastPauseCycleAt < OPTS.pauseEveryMin * 60000) return;

    lastPauseCycleAt = Date.now();
    pauseCycleArmed = false;
    pauseInProgress = true;
    pauseCycleCount += 1;
    pauseUntilAt = Date.now() + OPTS.pauseForSec * 1000;
    var v = videoEl();
    if (v) { try { v.pause(); } catch (_) {} }
    log("定时暂停 #" + pauseCycleCount + "：暂停 " + OPTS.pauseForSec + " 秒后自动继续");
    setStatus("定时暂停 " + OPTS.pauseForSec + " 秒…（每 " + OPTS.pauseEveryMin + " 分钟一次）");
    clearTimeout(pauseResumeTimer);
    pauseResumeTimer = setTimeout(function () {
      pauseInProgress = false;
      if (hasHumanChallenge()) { log("定时续播跳过：当前有学习确认弹窗"); return; }
      var v2 = videoEl();
      if (v2 && v2.paused) {
        log("定时暂停结束 → 继续播放");
        playOrReplay(false);
      }
    }, OPTS.pauseForSec * 1000);
  }

  // 队列续跑：跨页跳转回来后，若队列仍在运行则恢复监控。
  // 起播不再等这里 —— 脚本加载时就已 tryStartPlayback（见文件末尾）。
  function autoResumeIfNeeded() {
    var s = loadState();
    if (!s.running || !(s.queue || []).length) return;
    var inResource = RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; });
    if (inResource) ensureMonitor();
  }

  // ==========================================================================
  //  事件体检：把"页面到底认哪套事件"直接测出来，不再靠猜
  // ==========================================================================
  function auditEvents() {
    var btn = findHoldButton();
    if (!btn) { log("体检：当前没有确认弹窗"); return null; }
    var pt = pointOf(btn);
    var listeners = [];
    var types = ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "click"];
    types.forEach(function (type) {
      var fn = function () { listeners.push(type); };
      btn.addEventListener(type, fn, true);
      setTimeout(function () { btn.removeEventListener(type, fn, true); }, 3000);
    });
    // 监听 window/document 上的 up 事件
    var upSeen = [];
    var upFn = function (e) { upSeen.push(e.type); };
    ["pointerup", "mouseup", "touchend"].forEach(function (t) {
      PAGE.addEventListener(t, upFn, true);
      setTimeout(function () { PAGE.removeEventListener(t, upFn, true); }, 3000);
    });

    var top = null;
    try { top = document.elementFromPoint(pt.x, pt.y); } catch (_) {}
    var info = {
      按钮: (btn.id || "(无id)") + " <" + btn.tagName + ">",
      文案: nodeText(btn),
      中心命中: top ? (top.tagName + (top.id ? "#" + top.id : "")) : "null",
      进度条: progressBarOf(btn) ? "找到" : "未找到",
      遮罩id: (findChallengeMask() || {}).id || "(无)",
    };

    // 只观察，不下发按压（避免干扰真实尝试）：轻点一下 pointerdown 看是否有人接
    pointerEvent(btn, "pointerdown", pt, 1);
    mouseEvent(btn, "mousedown", pt, 1);
    touchEvent(btn, "touchstart", pt);

    setTimeout(function () {
      releaseWith("pointer", btn, pt);
      releaseWith("mouse", btn, pt);
      setTimeout(function () {
        info.按钮收到的事件 = listeners.join(",") || "（无）—— 说明合成事件没有触达按钮";
        info.window收到的事件 = upSeen.join(",") || "（无）";
        log("体检结果：" + JSON.stringify(info));
        setStatus("体检完成，详见面板日志 / 控制台");
      }, 400);
    }, 600);
    return info;
  }

  // ------------------------------------------------------------------ 启动
  // 启动要快：面板先建好，起播**立刻**开始，不等监控循环的第一次 tick。
  var bootAt = Date.now();
  installUi();
  log("双模式脚本已加载：安全模式=原版全功能；暴力模式=可选高风险（默认不发包）");
  log("当前页签：" + (uiMode === "safe" ? "安全模式" : "暴力模式（不会自动发包）") +
    "；切换页签即可换模式，切换会自动停掉另一个");
  // 列表来源一开机就写一行：换课程后「列表不全」时，先看这一行、再看「诊断读数」里的列表诊断
  try {
    var bootList = collectResourcesFromPage();
    log("视频列表：" + bootList.length + " 条，来源 " + ADAPTIVE.source);
  } catch (_) {}
  var onResourcePage = RESOURCE_PATHS.some(function (p) { return location.href.indexOf(p) >= 0; });
  if (onResourcePage) {
    // 不等 1.2 秒：马上尝试起播（播放器没就绪会自动重试），监控随后挂上
    tryStartPlayback("脚本加载");
    ensureMonitor();
    log("启动耗时 " + (Date.now() - bootAt) + "ms");
  } else {
    log("当前不是资源页：进入某节视频后监控会自动启动");
  }
  log("控制台可用：__liruyun.snapshot() / __liruyun.audit() / __liruyun.pass()");
  PAGE.__liruyun = {
    // ---- 暴力模式（新增模块）----
    brute: function () { return setUiMode("brute") || bruteDebugApi().snapshot(); },
    safe: function () { setUiMode("safe"); return uiMode; },
    mode: function (m) { setUiMode(m); return uiMode; },
    bruteApi: bruteDebugApi,
    // ---- 视频列表（v3：自适应采集）----
    // refreshList()：强制重扫（清缓存 + 服务端兜底），列表不全时先试它
    refreshList: function () { return adaptiveRefreshNow().length; },
    listInfo: adaptiveListLines,
    adaptive: adaptiveDebugApi,
    // ---- 站点弹窗（v3.1）----
    // dialogGuard(false)：关掉「自动确定」（弹窗照常弹）；dialogGuard() 看拦了多少条
    dialogGuard: dialogGuardDebugApi,
    dialogInfo: dialogGuardLines,
    // ---- 播放偏好（v3.2）----
    // prefs()：看「完成后是否自动下一节 / 达标进度 / 急停」；prefs({autoNext:false}) 改它
    prefs: prefsDebugApi,
    // ---- 安全模式（原版）----
    state: state,
    logs: logs,
    pass: passChallenge,
    audit: auditEvents,
    opts: OPTS,
    snapshot: function () {
      var mask = findChallengeMask();
      var btn = mask ? findHoldButton(mask) : null;
      var info = {
        hasMask: Boolean(mask), maskId: mask ? mask.id : null,
        hasButton: Boolean(btn), buttonId: btn ? btn.id : null,
        buttonText: btn ? nodeText(btn) : null,
        barFound: btn ? Boolean(progressBarOf(btn)) : false,
        eventFlavor: eventFlavor, flavorProven: flavorProven,
        required: readRequiredProgress(), progress: readProgress(), completed: readCompletionStatus(),
        video: videoState(),
        // 页面上所有 <video>（确认盯的是哪一个：isPicked=true 的那个）
        allVideos: listVideos(),
        // 资源收集诊断：每个 fsresource 锚点被提取成什么标题
        scan: lastScanReport,
        monitor: {
          running: Boolean(monitorTimer),
          lastTickMsAgo: monitorTickAt ? (Date.now() - monitorTickAt) : null,
          autoPass: state.autoPass,
          autoReplay: OPTS.autoReplay,
          autoReplayCount: autoReplayCount,
          challenge: state.challengeSeen + " seen / " + state.challengePassed + " passed / " + state.challengeFailed + " failed",
        },
        antiBotNodes: Array.prototype.map.call(document.querySelectorAll("[id^='anti-bot-']"), function (n) {
          return n.id + (isOwnNode(n) ? "(本脚本·已排除)" : "");
        }),
      };
      log("体检：" + JSON.stringify(info));
      return info;
    },
  };
  // v3pro：面板重排的控制台入口（必须在这里挂 —— 前面那次 PAGE.__liruyun = {…}
  // 会把更早挂上去的属性覆盖掉）
  try { PAGE.__liruyun.proUi = proDebugApi; } catch (_) {}
  PAGE.__liruyunUnload = bruteUnload;
  // 面板迟到告警：如果 3 秒后面板还没挂进文档，明确报出来（而不是让用户对着空页面猜）
  setTimeout(function () {
    try {
      if (!document.getElementById("scnu-liruyun-helper")) {
        console.error(TAG, "启动 3 秒后面板仍未出现：安装界面阶段可能失败了，请看上面 [liruyun] 的报错");
      }
    } catch (_) {}
  }, 3000);
  autoResumeIfNeeded();
  renderList();
})();
