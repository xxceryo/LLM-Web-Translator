const DEFAULT_SETTINGS = {
  provider: "openai",
  apiKey: "",
  model: "gpt-4o-mini",
  targetLanguage: "简体中文",
  temperature: 0.2,
  reasoningEffort: "minimal",
  concurrency: 4,
  bilingualMode: false
};

const PROVIDER_STRATEGIES = {
  openai: {
    apiUrls: ["https://api.openai.com/v1/chat/completions"],
    responseFormat: "json_schema",
    reasoningEffort: true,
    thinking: "none"
  },
  deepseek: {
    apiUrls: [
      "https://api.deepseek.com/chat/completions",
      "https://api.deepseek.com/v1/chat/completions"
    ],
    responseFormat: "json_object",
    reasoningEffort: false,
    thinking: "disabled"
  },
  openrouter: {
    apiUrls: ["https://openrouter.ai/api/v1/chat/completions"],
    responseFormat: "json_schema",
    reasoningEffort: false,
    thinking: "none",
    headers: {
      "HTTP-Referer": "https://localhost",
      "X-OpenRouter-Title": "LLM Web Translator"
    }
  },
  minimax: {
    apiUrls: [
      "https://api.minimax.io/v1/chat/completions",
      "https://api.minimaxi.com/v1/chat/completions"
    ],
    responseFormat: "json_object",
    reasoningEffort: false,
    thinking: "none"
  },
  dashscope: {
    apiUrls: ["https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    responseFormat: "json_object",
    reasoningEffort: false,
    thinking: "none"
  }
};

const CONTEXT_MENU_TRANSLATE_SELECTION = "llm-web-translator-translate-selection";
const CONTEXT_MENU_RESTORE_SELECTION = "llm-web-translator-restore-selection";

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...settings });
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "translate-current-page") {
    return;
  }

  await runTranslateCurrentPageCommand();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (![CONTEXT_MENU_TRANSLATE_SELECTION, CONTEXT_MENU_RESTORE_SELECTION].includes(info.menuItemId)) {
    return;
  }

  if (!tab?.id || !isWebPageUrl(tab.url)) {
    return;
  }

  await setBadge(tab.id, "...");

  try {
    if (info.menuItemId === CONTEXT_MENU_RESTORE_SELECTION) {
      const response = await sendMessageToTab(tab.id, { type: "RESTORE_SELECTION" });
      await setBadge(tab.id, response?.restored > 0 ? "原" : "0");
    } else {
      await sendMessageToTab(tab.id, {
        type: "TRANSLATE_SELECTION",
        selectedText: info.selectionText || ""
      });
      await setBadge(tab.id, "OK");
    }
  } catch (error) {
    console.error("LLM Web Translator selection failed:", error);
    await setBadge(tab.id, "ERR");
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    }, 1800);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TRANSLATE_BATCH") {
    return false;
  }

  translateBatch(message.texts)
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_TRANSLATE_SELECTION,
      title: "翻译选中内容",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_RESTORE_SELECTION,
      title: "还原选中翻译",
      contexts: ["selection"]
    });
  });
}

async function runTranslateCurrentPageCommand() {
  const tab = await getActiveTab();
  if (!tab?.id || !isWebPageUrl(tab.url)) {
    return;
  }

  await setBadge(tab.id, "...");

  try {
    const response = await sendMessageToTab(tab.id, { type: "TOGGLE_TRANSLATION" });
    await setBadge(tab.id, response?.mode === "restored" ? "原" : "OK");
  } catch (error) {
    console.error("LLM Web Translator shortcut failed:", error);
    await setBadge(tab.id, "ERR");
  } finally {
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    }, 1800);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isWebPageUrl(url) {
  return /^https?:\/\//.test(url || "");
}

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!String(error.message).includes("Receiving end does not exist")) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function setBadge(tabId, text) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#246BFE" });
  await chrome.action.setBadgeText({ tabId, text });
}

async function translateBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const settings = normalizeSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
  validateSettings(settings);
  const strategy = getProviderStrategy(settings.provider);

  const items = texts.map((text, index) => ({ id: index, text }));
  const requestBody = buildTranslationRequestBody(settings, items, strategy);
  const { response, apiUrl, errorText } = await fetchFirstAvailableApi(strategy, settings.apiKey, requestBody);

  if (!response.ok) {
    const detail = errorText ?? await response.text();
    throw new Error(`API request failed (${response.status}) at ${apiUrl}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const translations = parseTranslationResponse(content, texts);

  return translations.map((item, index) => normalizeTranslation(item, texts[index]));
}

function buildTranslationRequestBody(settings, items, strategy) {
  const body = {
    model: settings.model,
    temperature: Number(settings.temperature ?? DEFAULT_SETTINGS.temperature),
    messages: [
      {
        role: "system",
        content: [
          "You are a deterministic webpage translation engine.",
          `Translate each item to ${settings.targetLanguage}.`,
          "Output translations only. Do not explain, summarize, comment, or answer the source text.",
          "Keep URLs, emails, numbers, code, placeholders, and brand names unchanged when appropriate.",
          "Do not include reasoning, chain-of-thought, <think> tags, explanations, markdown, or extra text.",
          "Return only valid JSON in this exact shape:",
          "{\"translations\":[{\"id\":0,\"text\":\"translated text\"}]}",
          "Keep every input id exactly once.",
          "Each text field must contain only the translated text for that item."
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({ items })
      }
    ]
  };

  if (strategy.thinking === "disabled") {
    body.thinking = { type: "disabled" };
  }

  if (strategy.responseFormat === "json_object") {
    body.response_format = {
      type: "json_object"
    };
  } else if (strategy.responseFormat === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "webpage_translations",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            translations: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: {
                    type: "integer"
                  },
                  text: {
                    type: "string"
                  }
                },
                required: ["id", "text"]
              }
            }
          },
          required: ["translations"]
        }
      }
    };
  }

  if (strategy.reasoningEffort && settings.reasoningEffort !== "default") {
    body.reasoning_effort = settings.reasoningEffort || DEFAULT_SETTINGS.reasoningEffort;
  }

  return body;
}

async function fetchFirstAvailableApi(strategy, apiKey, requestBody) {
  let lastResponse;
  let lastUrl;
  let lastErrorText;

  for (const apiUrl of strategy.apiUrls) {
    let response = await postJson(apiUrl, apiKey, requestBody, strategy.headers);

    if (response.ok) {
      return { response, apiUrl };
    }

    let errorText = await response.text();

    if (response.status >= 400 && requestBody.reasoning_effort && mentionsUnsupportedParameter(errorText, "reasoning_effort")) {
      const retryBody = { ...requestBody };
      delete retryBody.reasoning_effort;
      response = await postJson(apiUrl, apiKey, retryBody, strategy.headers);
      if (response.ok) {
        return { response, apiUrl };
      }
      errorText = await response.text();
    }

    if (
      response.status >= 400 &&
      requestBody.response_format &&
      (mentionsUnsupportedParameter(errorText, "response_format") || mentionsUnsupportedParameter(errorText, "json_schema"))
    ) {
      const retryBody = { ...requestBody };
      delete retryBody.reasoning_effort;
      delete retryBody.response_format;
      response = await postJson(apiUrl, apiKey, retryBody, strategy.headers);
      if (response.ok) {
        return { response, apiUrl };
      }
      errorText = await response.text();
    }

    if (response.status >= 400 && requestBody.thinking && mentionsUnsupportedParameter(errorText, "thinking")) {
      const retryBody = { ...requestBody };
      delete retryBody.thinking;
      response = await postJson(apiUrl, apiKey, retryBody, strategy.headers);
      if (response.ok) {
        return { response, apiUrl };
      }
      errorText = await response.text();
    }

    if (response.status !== 404) {
      return { response, apiUrl, errorText };
    }

    lastResponse = response;
    lastUrl = apiUrl;
    lastErrorText = errorText;
  }

  return { response: lastResponse, apiUrl: lastUrl, errorText: lastErrorText };
}

async function postJson(apiUrl, apiKey, body, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    return await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function mentionsUnsupportedParameter(errorText, parameterName) {
  const text = String(errorText || "").toLowerCase();
  const parameter = parameterName.toLowerCase();
  return text.includes(parameter) && (
    text.includes("unsupported") ||
    text.includes("unknown") ||
    text.includes("unrecognized") ||
    text.includes("not supported") ||
    text.includes("invalid parameter") ||
    text.includes("extra inputs")
  );
}

function validateSettings(settings) {
  if (!PROVIDER_STRATEGIES[settings.provider]) {
    throw new Error("Please choose a supported provider in the extension options.");
  }

  if (!settings.apiKey) {
    throw new Error("Please set an API key in the extension options.");
  }

  if (!settings.model) {
    throw new Error("Please set a model name in the extension options.");
  }
}

function normalizeSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  if (next.apiUrl && (!settings.provider || settings.provider === DEFAULT_SETTINGS.provider)) {
    next.provider = inferProviderFromUrl(next.apiUrl);
  }
  if (!PROVIDER_STRATEGIES[next.provider]) {
    next.provider = DEFAULT_SETTINGS.provider;
  }
  return next;
}

function inferProviderFromUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (hostname.includes("deepseek")) {
      return "deepseek";
    }
    if (hostname.includes("openrouter")) {
      return "openrouter";
    }
    if (hostname.includes("minimax")) {
      return "minimax";
    }
    if (hostname.includes("dashscope") || hostname.includes("aliyuncs")) {
      return "dashscope";
    }
  } catch {
    return DEFAULT_SETTINGS.provider;
  }
  return "openai";
}

function getProviderStrategy(provider) {
  return PROVIDER_STRATEGIES[provider] || PROVIDER_STRATEGIES[DEFAULT_SETTINGS.provider];
}

function parseTranslations(content) {
  if (typeof content !== "string") {
    throw new Error("The model returned an empty response.");
  }

  const trimmed = removeReasoningBlocks(content).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : trimmed;

  try {
    const parsed = JSON.parse(jsonText);
    if (!isUsableTranslationPayload(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    const candidate = extractJsonCandidate(jsonText);
    if (candidate) {
      const parsed = JSON.parse(candidate);
      if (isUsableTranslationPayload(parsed)) {
        return parsed;
      }
    }
  }

  throw new Error("The model did not return valid translation JSON.");
}

function parseTranslationResponse(content, fallbackTexts) {
  try {
    return mapTranslations(parseTranslations(content), fallbackTexts);
  } catch (error) {
    const cleaned = sanitizeModelText(content);
    if (fallbackTexts.length === 1 && cleaned) {
      return [cleaned];
    }
    throw error;
  }
}

function isUsableTranslationPayload(value) {
  return Array.isArray(value) || Array.isArray(value?.translations);
}

function mapTranslations(payload, fallbackTexts) {
  const source = Array.isArray(payload) ? payload : payload.translations;
  const output = [...fallbackTexts];

  source.forEach((item, index) => {
    if (typeof item === "string") {
      output[index] = item;
      return;
    }

    if (!item || typeof item !== "object") {
      return;
    }

    const id = Number(item.id ?? item.index);
    const text = item.text ?? item.translation ?? item.value;
    if (Number.isInteger(id) && id >= 0 && id < output.length && typeof text === "string") {
      output[id] = text;
    }
  });

  return output;
}

function normalizeTranslation(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  return sanitizeModelText(value) || fallback;
}

function stripCodeFence(value) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function sanitizeModelText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const withoutReasoning = removeReasoningBlocks(stripCodeFence(value)).trim();
  const jsonCandidate = extractJsonCandidate(withoutReasoning);
  if (jsonCandidate) {
    try {
      const payload = JSON.parse(jsonCandidate);
      const translations = Array.isArray(payload) ? payload : payload?.translations;
      if (Array.isArray(translations) && translations.length === 1) {
        const item = translations[0];
        if (typeof item === "string") {
          return item.trim();
        }
        if (typeof item?.text === "string") {
          return item.text.trim();
        }
      }
    } catch {
      // Fall through and return cleaned text.
    }
  }

  return withoutReasoning
    .replace(/^["']|["']$/g, "")
    .trim();
}

function removeReasoningBlocks(value) {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
}

function extractJsonCandidate(value) {
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return value.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return value.slice(arrayStart, arrayEnd + 1);
  }

  return "";
}
