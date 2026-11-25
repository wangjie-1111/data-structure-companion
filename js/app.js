/* ===== 数据结构智能学伴 PWA 主逻辑 =====
 * 通过扣子平台 OpenAPI (/v3/chat, SSE 流式) 与已发布的数据结构学伴 Bot 对话。
 */
"use strict";

const LS_KEY = "ds_tutor_config";

// ---------- 元素引用 ----------
const el = {
  chatArea: document.getElementById("chatArea"),
  inputBox: document.getElementById("inputBox"),
  btnSend: document.getElementById("btnSend"),
  quickBar: document.getElementById("quickBar"),
  settingsMask: document.getElementById("settingsMask"),
  settingsPanel: document.getElementById("settingsPanel"),
  btnSettings: document.getElementById("btnSettings"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  btnSaveCfg: document.getElementById("btnSaveCfg"),
  btnTestCfg: document.getElementById("btnTestCfg"),
  cfgBotId: document.getElementById("cfgBotId"),
  cfgToken: document.getElementById("cfgToken"),
  cfgBaseUrl: document.getElementById("cfgBaseUrl"),
  cfgStatus: document.getElementById("cfgStatus"),
};

// ---------- 会话状态 ----------
let conversationId = null; // 多轮对话复用同一会话，保持上下文
let userId = "mobile_user";
let isStreaming = false;
let config = loadConfig();

// ---------- 配置存取 ----------
function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch (e) {
    return {};
  }
}
function saveConfig(cfg) {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}
function fillSettingsForm() {
  el.cfgBotId.value = config.bot_id || "";
  el.cfgToken.value = config.token || "";
  el.cfgBaseUrl.value = config.base_url || "https://api.coze.cn";
}

// ---------- Markdown 极简渲染（安全处理） ----------
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMd(text) {
  let t = escapeHtml(text);
  // 粗体
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 行内代码
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 换行
  t = t.replace(/\n/g, "<br>");
  // <br> 前若紧跟 <br> 合并
  t = t.replace(/(<br>\s*){2,}/g, "<br><br>");
  return t;
}

// ---------- 消息渲染 ----------
function appendMessage(role, content, isHtml = false) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (role === "bot") {
    const img = document.createElement("img");
    img.src = "icons/icon-192.png";
    img.alt = "学伴";
    avatar.appendChild(img);
  } else {
    avatar.textContent = "我";
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = isHtml ? content : renderMd(content);

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  el.chatArea.appendChild(wrap);
  el.chatArea.scrollTop = el.chatArea.scrollHeight;
  return bubble;
}

function appendTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg bot";
  wrap.id = "typingMsg";
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  const img = document.createElement("img");
  img.src = "icons/icon-192.png";
  img.alt = "学伴";
  avatar.appendChild(img);
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = "<span></span><span></span><span></span>";
  wrap.appendChild(avatar);
  wrap.appendChild(typing);
  el.chatArea.appendChild(wrap);
  el.chatArea.scrollTop = el.chatArea.scrollHeight;
}
function removeTyping() {
  const t = document.getElementById("typingMsg");
  if (t) t.remove();
}

// ---------- 欢迎语 ----------
function showWelcome() {
  const bubble = appendMessage("bot",
    "同学你好呀！我是你的数据结构智能学伴 📚 你可以点击下方按钮选择服务方式：\n\n" +
    "🧭 **「这题怎么入手」**——帮你找到解题思路，轻引导不剧透\n" +
    "👣 **「一步步引导我」**——分步引导，我们一起推理\n" +
    "⚡ **「直接给答案」**——快速获取答案与解析\n\n" +
    "当然，也可以直接把题目发给我～");
  bubble.lastElementChild.className = "bubble"; // 保持样式
}

// ---------- Bot 对话（SSE 流式，遵循扣子 /v3/chat） ----------
async function chatWithBot(userText) {
  if (!config.bot_id || !config.token) {
    appendMessage("bot", "还没有配置 Bot 连接信息，请点击右上角 ⚙️ 填写你的 Bot ID 和 Token ~");
    openSettings();
    return;
  }

  const baseUrl = (config.base_url || "https://api.coze.cn").replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };

  const payload = {
    bot_id: config.bot_id,
    user_id: userId,
    stream: true,
    auto_save_history: true,
    additional_messages: [
      { role: "user", content: userText, content_type: "text" },
    ],
  };
  if (conversationId) payload.conversation_id = conversationId;

  isStreaming = true;
  setSendDisabled(true);
  appendTyping();

  try {
    const resp = await fetch(`${baseUrl}/v3/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${errText.slice(0, 200)}`);
    }

    removeTyping();
    const bubble = appendMessage("bot", "");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answerText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        function parseSse() {
          let event = "";
          let data = "";
          // SSE 块内 event: / data: 可能在不同行
          const evtMatch = line.match(/^event:\s*(.*)$/);
          const dataMatch = line.match(/^data:\s*(.*)$/);
          if (evtMatch) { event = evtMatch[1].trim(); data = ""; }
          if (dataMatch) { data = dataMatch[1].trim(); }
          return { event, data };
        }

        const { event, data } = parseSse();
        if (!data || data === "[DONE]") continue;

        let json;
        try { json = JSON.parse(data); } catch (e) { continue; }

        if (event === "conversation.message.delta") {
          const delta =
            (json.reasoning_content ? `${json.reasoning_content}` : "") +
            (json.content ? json.content : "");
          if (delta) {
            answerText += delta;
            bubble.innerHTML = renderMd(answerText);
            el.chatArea.scrollTop = el.chatArea.scrollHeight;
          }
        } else if (event === "conversation.chat.created") {
          if (json.conversation_id) conversationId = json.conversation_id;
        } else if (event === "conversation.chat.completed") {
          if (json.conversation_id) conversationId = json.conversation_id;
          if (!answerText && json.answer) {
            answerText = json.answer;
            bubble.innerHTML = renderMd(answerText);
            el.chatArea.scrollTop = el.chatArea.scrollHeight;
          }
        }
      }
    }

    if (!answerText.trim()) {
      bubble.innerHTML = renderMd("（没有收到回复，请检查连接设置或 Bot 是否已发布）");
    }
  } catch (err) {
    removeTyping();
    appendMessage("bot", `对话出错：${err.message || err}`);
  } finally {
    isStreaming = false;
    setSendDisabled(false);
    el.chatArea.scrollTop = el.chatArea.scrollHeight;
  }
}

function setSendDisabled(disabled) {
  el.btnSend.disabled = disabled;
  el.btnSend.style.opacity = disabled ? "0.5" : "1";
}

// ---------- 发送 ----------
function sendMessage(text) {
  const msg = (text || el.inputBox.value).trim();
  if (!msg || isStreaming) return;
  el.inputBox.value = "";
  el.inputBox.style.height = "auto";
  appendMessage("user", msg);
  chatWithBot(msg);
}

// ---------- 快捷按钮：将指令作为消息发送，切换服务模式 ----------
el.quickBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-btn");
  if (!btn) return;
  const mode = btn.dataset.mode;
  let text = "";
  if (mode === "guide") text = "这题怎么入手";
  else if (mode === "step") text = "一步步引导我";
  else if (mode === "direct") text = "直接给答案";
  sendMessage(text);
});

// ---------- 输入事件 ----------
el.btnSend.addEventListener("click", () => sendMessage());
el.inputBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
el.inputBox.addEventListener("input", () => {
  el.inputBox.style.height = "auto";
  el.inputBox.style.height = Math.min(el.inputBox.scrollHeight, 120) + "px";
});

// ---------- 设置面板 ----------
function openSettings() {
  fillSettingsForm();
  el.settingsPanel.classList.add("open");
  el.settingsMask.classList.remove("hidden");
}
function closeSettings() {
  el.settingsPanel.classList.remove("open");
  el.settingsMask.classList.add("hidden");
}
el.btnSettings.addEventListener("click", openSettings);
el.btnCloseSettings.addEventListener("click", closeSettings);
el.settingsMask.addEventListener("click", closeSettings);

el.btnSaveCfg.addEventListener("click", () => {
  config = {
    bot_id: el.cfgBotId.value.trim(),
    token: el.cfgToken.value.trim(),
    base_url: (el.cfgBaseUrl.value.trim() || "https://api.coze.cn").replace(/\/+$/, ""),
  };
  saveConfig(config);
  el.cfgStatus.className = "cfg-status ok";
  el.cfgStatus.textContent = "✅ 已保存。现在可以开始和学伴对话啦！";
  conversationId = null; // 换 Bot 后开启新会话
  setTimeout(closeSettings, 1200);
});

el.btnTestCfg.addEventListener("click", async () => {
  const botId = el.cfgBotId.value.trim();
  const token = el.cfgToken.value.trim();
  const baseUrl = (el.cfgBaseUrl.value.trim() || "https://api.coze.cn").replace(/\/+$/, "");
  if (!botId || !token) {
    el.cfgStatus.className = "cfg-status err";
    el.cfgStatus.textContent = "请先填写 Bot ID 和 Token";
    return;
  }
  el.cfgStatus.className = "cfg-status";
  el.cfgStatus.textContent = "⏳ 正在测试连接…";
  try {
    const resp = await fetch(`${baseUrl}/v3/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: "connect_test",
        stream: false,
        auto_save_history: false,
        additional_messages: [
          { role: "user", content: "你好", content_type: "text" },
        ],
      }),
    });
    const json = await resp.json().catch(() => ({}));
    if (resp.ok && json.code === 0) {
      el.cfgStatus.className = "cfg-status ok";
      el.cfgStatus.textContent = "✅ 连接成功！Bot 在线可对话。";
    } else {
      el.cfgStatus.className = "cfg-status err";
      el.cfgStatus.textContent = `❌ 连接失败：${json.msg || `HTTP ${resp.status}`}`;
    }
  } catch (err) {
    el.cfgStatus.className = "cfg-status err";
    el.cfgStatus.textContent = `❌ 连接失败：${err.message || err}`;
  }
});

// ---------- 注册 Service Worker（离线缓存 + 可安装） ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- 初始化 ----------
showWelcome();