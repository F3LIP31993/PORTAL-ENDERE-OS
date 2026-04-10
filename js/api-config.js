(function () {
  const STORAGE_KEY = "portalApiBaseUrl";

  const getSavedApiBase = () => {
    try {
      return (localStorage.getItem(STORAGE_KEY) || "").trim();
    } catch {
      return "";
    }
  };

  const saveApiBase = (value) => {
    if (!value) return;
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Ignora falhas de storage.
    }
  };

  let queryApiBase = "";
  try {
    queryApiBase = (new URLSearchParams(window.location.search).get("api") || "").trim();
  } catch {
    queryApiBase = "";
  }

  const metaApiBase = document.querySelector('meta[name="portal-api-base"]')?.content?.trim() || "";
  const globalApiBase = (typeof window.PORTAL_API_BASE_URL === "string" ? window.PORTAL_API_BASE_URL : "").trim();

  if (queryApiBase) {
    saveApiBase(queryApiBase.replace(/\/+$/, ""));
  }

  const fallbackApiBase = window.location.protocol === "file:" ? "http://localhost:5000" : "";
  const runtimeOrigin = window.location.protocol.startsWith("http") ? window.location.origin : "";
  const apiBase = [queryApiBase, globalApiBase, metaApiBase, runtimeOrigin, getSavedApiBase(), fallbackApiBase].find(Boolean) || "";
  const normalizedBase = apiBase.replace(/\/+$/, "");

  window.PORTAL_API_BASE_URL = normalizedBase;
  window.buildApiUrl = function (path) {
    if (typeof path !== "string") return path;
    if (!path.startsWith("/api")) return path;
    return normalizedBase ? `${normalizedBase}${path}` : path;
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init = {}) {
    const resource = typeof input === "string" ? window.buildApiUrl(input) : input;
    const isApiRequest = typeof resource === "string" && /\/api(\/|$)/.test(resource);

    if (isApiRequest && typeof init.credentials === "undefined") {
      return nativeFetch(resource, { ...init, credentials: "include" });
    }

    return nativeFetch(resource, init);
  };

  if (normalizedBase) {
    console.info(`[Portal MDU] Backend configurado em: ${normalizedBase}`);
  }
})();
