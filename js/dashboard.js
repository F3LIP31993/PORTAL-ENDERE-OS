let dadosCSV = [];

// Armazena os dados carregados (por categoria) para que cada planilha seja independente
const dadosPorCategoria = {};
let categoriaAtualParaImport = null;
let importMode = "local"; // local | network | web

let dddSelecionado = "todos"; // Armazena o DDD selecionado globalmente

// Usado para controlar qual aba está ativa em 'Pendente Autorização'
let pendenteActiveTab = 'vistoria';

let currentUser = null;

const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";
const STORAGE_COLUMN_DENSITY_KEY = "portalColumnDensity";
const STORAGE_DATASET_CACHE_KEY = "portalDatasetCache";

const BACKLOG_EMPRESARIAL_STATUS = [
  "1.VISTORIA", "2.PROJETO_INTERNO", "3.PROJETO_REDE", "4.CONSTRUCAO_REDE", "5.CONSTRUCAO", "7.LIBERACAO"
];
const BACKLOG_MDU_ONGOING_STATUS = [
  "1.VISTORIA", "2.PROJETO_INTERNO", "5.CONSTRUCAO", "7.EM_LIBERACAO", "EXPANSÃO_MDU", "4.CONSTRUCAO_REDE", "3.PROJETO_REDE"
];
const BACKLOG_MDU_ONGOING_MOTIVOS = [
  "5.CONSTRUCAO_INTERNA", "7.EM_LIBERACAO", "4.PEND_EXECUTAR_SAR", "2.PROJETO_INTERNO_BACKBONE", "3.PROJETO_SAR", "1.VISTORIA",
  "4.FIBRA_SEM_SINAL", "6.AGUARDANDO_ASBUILT", "8.VALIDAÇÃO_VISTORIA_SIMPLIFICADA", "4.REPROJETO_SAR", "5.CONSTRUCAO_INTERNA_AGENDADA",
  "1.VISTORIA_AGENDADA", "AGUARDANDO_AGEND_COMERCIAL", "AGUARDANDO_AGEND_CLIENTE_SGD", "AGUARDANDO_CRIAÇAO_END_GED",
  "AGUARDANDO_AGEND_TECNICA", "6.ATIVAÇÃO_MDU_CONSTRUIDO", "AGUARDANDO_DE_ACORDO_DIRETOR", "AGUARDANDO_ESTUDO_SAR",
  "AGUARDANDO_APRO_COMERCIAL", "1.PENDENTE_RETORNO_VISTORIA_EPO", "2.VALIDAÇÃO_VISTORIA", "4.REDE_GPON_ESTRUTURADO",
  "1.MEDIÇÃO_PENDENTE_ENVIO_PLANILHA_EPO"
];

// ===== AJUSTE VISUAL DE COLUNAS =====
function applyColumnDensity(density = "compact") {
  const safeDensity = ["compact", "default", "wide"].includes(density) ? density : "compact";

  document.body.classList.remove(
    "column-density-compact",
    "column-density-default",
    "column-density-wide"
  );
  document.body.classList.add(`column-density-${safeDensity}`);

  const select = document.getElementById("columnDensitySelect");
  if (select) {
    select.value = safeDensity;
  }
}

function setColumnDensity(density) {
  const safeDensity = ["compact", "default", "wide"].includes(density) ? density : "compact";
  localStorage.setItem(STORAGE_COLUMN_DENSITY_KEY, safeDensity);
  applyColumnDensity(safeDensity);
}

function getLocalDatasetCache() {
  try {
    const raw = localStorage.getItem(STORAGE_DATASET_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalDatasetCache(cache) {
  localStorage.setItem(STORAGE_DATASET_CACHE_KEY, JSON.stringify(cache || {}));
}

function cacheDatasetLocally(categoria, items, meta = {}) {
  if (!categoria || !Array.isArray(items)) return;
  const cache = getLocalDatasetCache();
  const previous = cache[categoria] || {};
  cache[categoria] = {
    items,
    updatedAt: meta.updatedAt || new Date().toISOString(),
    source: meta.source || previous.source || 'shared',
    locked: typeof meta.locked === 'boolean' ? meta.locked : Boolean(previous.locked),
  };
  saveLocalDatasetCache(cache);
}

function hasLockedDataset(categoria) {
  const cache = getLocalDatasetCache();
  return Boolean(cache?.[categoria]?.locked);
}

function getPreferredDataset(categoriaId) {
  const localCache = getLocalDatasetCache();
  const localSnapshot = localCache?.[categoriaId] || {};
  const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
  const stateItems = Array.isArray(dadosPorCategoria[categoriaId]) ? dadosPorCategoria[categoriaId] : [];

  if (localSnapshot?.locked && localItems.length) {
    return localItems;
  }

  if (stateItems.length) {
    return stateItems;
  }

  if (localItems.length) {
    return localItems;
  }

  if (['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId)) {
    const backlogRows = Array.isArray(dadosPorCategoria['backlog']) ? dadosPorCategoria['backlog'] : [];
    if (backlogRows.length) {
      return getDerivedBacklogItems(categoriaId, backlogRows);
    }
  }

  return [];
}

function applyDatasetToState(categoria, items) {
  const safeItems = Array.isArray(items) ? items : [];
  dadosPorCategoria[categoria] = safeItems;

  if (categoria === "backlog") {
    dadosCSV = safeItems;
  }

  if (categoria === "ongoing") {
    dadosCSVOngoing = safeItems;
    dadosCSVOngoingOriginal = safeItems;
  }
}

function getDerivedBacklogItems(categoriaId, sourceRows = []) {
  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  if (!rows.length) return [];

  if (categoriaId === 'pendente-autorizacao') {
    return rows
      .filter(item => {
        const status = (getField(item, 'STATUS_GERAL', 'STATUS', 'status') || '').toString();
        return status.includes('FILA_PENDENTE_AUTORIZAÇÃO_VISTORIA') ||
          status.includes('1.FILA_PENDENTE_AUTORIZAÇÃO_VISTORIA') ||
          status.includes('FILA_PENDENTE_AUTORIZAÇÃO_BACKBONE') ||
          status.includes('4.FILA_PENDENTE_AUTORIZAÇÃO_BACKBONE');
      })
      .map(item => {
        const cloned = { ...item };
        const status = (getField(cloned, 'STATUS_GERAL', 'STATUS', 'status') || '').toString().toUpperCase();
        if (status.includes('VISTORIA')) cloned.__pendenteTipo = 'vistoria';
        if (status.includes('BACKBONE')) cloned.__pendenteTipo = 'backbone';
        return cloned;
      });
  }

  if (categoriaId === 'empresarial') {
    const statusPermitidos = BACKLOG_EMPRESARIAL_STATUS.map(value => normalizeKey(value));
    return rows.filter(item => {
      const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').trim().toUpperCase();
      const status = normalizeKey(getField(item, 'STATUS_GERAL', 'status_geral', 'status') || '');
      return solicitante === 'EMPRESARIAL' && statusPermitidos.includes(status);
    });
  }

  if (categoriaId === 'mdu-ongoing') {
    const statusPermitidos = BACKLOG_MDU_ONGOING_STATUS.map(value => normalizeKey(value));
    const motivosPermitidos = BACKLOG_MDU_ONGOING_MOTIVOS.map(value => normalizeKey(value));

    return rows.filter(item => {
      const status = normalizeKey(getField(item, 'STATUS_GERAL', 'status_geral', 'status') || '');
      const motivo = normalizeKey(getField(item, 'MOTIVO_GERAL', 'motivo_geral', 'motivo') || '');
      return statusPermitidos.includes(status) && motivosPermitidos.includes(motivo);
    });
  }

  if (categoriaId === 'sar-rede') {
    return rows.filter(item => {
      const solicitante = normalizeText(getField(item, 'SOLICITANTE', 'solicitante'));
      const status = normalizeText(getField(item, 'STATUS_GERAL', 'status_geral', 'status'));
      const motivo = normalizeText(getField(item, 'MOTIVO_GERAL', 'motivo_geral', 'motivo'));
      return solicitante.includes('sar') || status.includes('sar') || motivo.includes('sar');
    });
  }

  return rows;
}

function syncDerivedCategoriesFromBacklog(sourceRows = [], persistToServer = false) {
  if (!Array.isArray(sourceRows) || !sourceRows.length) return;

  ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].forEach(categoriaId => {
    const shouldPreserveManualImport = ['empresarial', 'mdu-ongoing'].includes(categoriaId)
      && (hasLockedDataset(categoriaId) || (dadosPorCategoria[categoriaId] || []).length > 0);

    if (shouldPreserveManualImport) {
      return;
    }

    const derivados = getDerivedBacklogItems(categoriaId, sourceRows);
    if (derivados.length || !dadosPorCategoria[categoriaId]?.length) {
      applyDatasetToState(categoriaId, derivados);
    }
    if (persistToServer) {
      persistirDadosCompartilhados(categoriaId, derivados, { source: 'derived' });
    }
  });
}

// ===== USUÁRIOS E NOTIFICAÇÕES =====
function getStoredUsers() {
  try {
    const raw = localStorage.getItem(STORAGE_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveStoredUsers(users) {
  localStorage.setItem(STORAGE_USERS_KEY, JSON.stringify(users || []));
}

function getCurrentUser() {
  if (currentUser) return currentUser;

  const username = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
  if (!username) return null;

  const users = getStoredUsers();
  const storedUser = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (storedUser) {
    currentUser = storedUser;
    return storedUser;
  }

  const fallbackUser = {
    username,
    name: username,
    email: "",
    role: "viewer",
  };

  currentUser = fallbackUser;
  return fallbackUser;
}

function setCurrentUserLocally(user) {
  if (!user || !user.username) return;
  localStorage.setItem(STORAGE_CURRENT_USER_KEY, user.username);

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === user.username.toLowerCase());
  const dateNow = new Date().toISOString();

  if (idx === -1) {
    users.push({
      username: user.username,
      password: user.password || "",
      name: user.name || user.username,
      email: user.email || "",
      role: user.role || "viewer",
      createdAt: dateNow,
      approvedAt: dateNow,
    });
  } else {
    users[idx].name = user.name || users[idx].name;
    users[idx].email = user.email || users[idx].email;
    users[idx].role = user.role || users[idx].role;
  }

  saveStoredUsers(users);
}

async function syncCurrentUserFromServer() {
  if (!window.location.protocol.startsWith("http")) return null;
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    const data = await res.json();
    if (data && data.authenticated && data.user) {
      currentUser = data.user;
      setCurrentUserLocally(data.user);
      return data.user;
    }
  } catch (e) {
    // Falha ao conectar com o backend - continuar em modo local
  }
  return null;
}

async function carregarDadosCompartilhados() {
  const localCache = getLocalDatasetCache();

  if (!window.location.protocol.startsWith("http")) {
    Object.entries(localCache).forEach(([categoria, snapshot]) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      applyDatasetToState(categoria, items);
    });

    const backlogLocal = dadosPorCategoria['backlog'] || [];
    if (backlogLocal.length) {
      syncDerivedCategoriesFromBacklog(backlogLocal, false);
    }

    atualizarContadores();
    const secaoAtiva = document.querySelector('.secao.ativa')?.id;
    if (secaoAtiva) {
      carregarDadosCategoria(secaoAtiva);
    }
    agendarRenderVisaoGerencia(true);
    return;
  }

  try {
    const res = await fetch("/api/shared_datasets", { credentials: "include" });
    if (!res.ok) return;

    const payload = await res.json().catch(() => ({}));
    const datasets = payload?.datasets || {};
    const isAdmin = getCurrentUser()?.role === 'admin';

    Object.entries(datasets).forEach(([categoria, snapshot]) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      const existingItems = Array.isArray(dadosPorCategoria[categoria]) ? dadosPorCategoria[categoria] : [];
      const localSnapshot = localCache?.[categoria] || {};
      const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
      const shouldKeepLockedLocal = ['empresarial', 'mdu-ongoing'].includes(categoria)
        && Boolean(localSnapshot?.locked)
        && localItems.length;

      if (shouldKeepLockedLocal) {
        applyDatasetToState(categoria, localItems);
        return;
      }

      // Evita que um snapshot vazio do servidor apague dados já carregados localmente.
      if (items.length || !existingItems.length) {
        applyDatasetToState(categoria, items);
      }
    });

    Object.entries(localCache).forEach(([categoria, snapshot]) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      const serverSnapshot = datasets?.[categoria] || {};
      const serverItems = Array.isArray(serverSnapshot?.items) ? serverSnapshot.items : [];
      const localUpdatedAt = Date.parse(snapshot?.updatedAt || '') || 0;
      const serverUpdatedAt = Date.parse(serverSnapshot?.updated_at || serverSnapshot?.updatedAt || '') || 0;
      const shouldPreferLocal = items.length && (
        snapshot?.locked ||
        !serverItems.length ||
        localUpdatedAt > serverUpdatedAt
      );

      if (shouldPreferLocal) {
        applyDatasetToState(categoria, items);
      } else if (!dadosPorCategoria[categoria]?.length && items.length) {
        applyDatasetToState(categoria, items);
      }

      if (isAdmin && items.length && (!serverItems.length || (snapshot?.locked && localUpdatedAt >= serverUpdatedAt))) {
        persistirDadosCompartilhados(categoria, items, {
          source: snapshot?.source || 'local',
          locked: Boolean(snapshot?.locked),
          updatedAt: snapshot?.updatedAt
        });
      }
    });

    const backlogCompartilhado = dadosPorCategoria['backlog'] || [];
    if (backlogCompartilhado.length) {
      syncDerivedCategoriesFromBacklog(backlogCompartilhado, isAdmin);
    }

    atualizarContadores();

    const secaoAtiva = document.querySelector(".secao.ativa")?.id;
    if (secaoAtiva) {
      carregarDadosCategoria(secaoAtiva);
    }

    agendarRenderVisaoGerencia(true);
  } catch (error) {
    console.warn("Não foi possível carregar os dados compartilhados do portal.", error);
  }
}

async function persistirDadosCompartilhados(categoria, items, meta = {}) {
  if (!categoria || !Array.isArray(items)) {
    return;
  }

  cacheDatasetLocally(categoria, items, meta);

  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";

  if (!window.location.protocol.startsWith("http") || !isAdmin) {
    return;
  }

  try {
    const response = await fetch(`/api/shared_datasets/${encodeURIComponent(categoria)}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody?.error || `Falha ao sincronizar a categoria ${categoria}`);
    }
  } catch (error) {
    console.warn(`Falha ao salvar dados compartilhados da categoria ${categoria}.`, error);
    const statusEl = document.getElementById('import-status');
    if (statusEl) {
      statusEl.textContent = `⚠️ Dados carregados localmente, mas a sincronização do portal compartilhado falhou em ${categoria}.`;
    }
  }
}

function updateUserProfileInfo() {
  const user = getCurrentUser();
  if (!user) return;

  const nameEl = document.querySelector(".user-name");
  const roleEl = document.querySelector(".user-role");

  if (nameEl) nameEl.textContent = user.name || user.username || "Usuário";

  if (roleEl) {
    if (user.role === "admin") {
      roleEl.textContent = "Administrador";
    } else if (user.role === "viewer") {
      roleEl.textContent = "Visualização";
    } else {
      roleEl.textContent = "Solicitante";
    }
  }
}

function applyAccessControl() {
  const user = getCurrentUser();
  if (!user) return;

  const sidebar = document.querySelector("aside.sidebar");
  const topActions = document.querySelector(".topbar-actions");
  const menuButtons = document.querySelectorAll(".menu-btn");
  const settingsBtn = document.querySelector(".settings-btn");
  const notificationBtn = document.querySelector(".notification-btn");

  // Cria uma camada de proteção na interface (o backend também protege as APIs)
  const isAdmin = user.role === "admin";

  if (sidebar) sidebar.style.display = "flex";
  if (topActions) topActions.style.display = "flex";
  if (settingsBtn) settingsBtn.style.display = "inline-flex";
  if (notificationBtn) notificationBtn.style.display = isAdmin ? "inline-flex" : "none";

  menuButtons.forEach(btn => {
    const adminOnly = btn.dataset.adminOnly === "true";
    btn.style.display = adminOnly && !isAdmin ? "none" : "block";
  });

  // Usuários de acompanhamento não podem importar nem exportar planilhas
  const importSection = document.getElementById("global-import-section");
  if (importSection && !isAdmin) {
    importSection.style.display = "none";
  }

  if (!isAdmin && ["historico", "relatorios"].includes(document.querySelector(".secao.ativa")?.id || "")) {
    mostrarSecao("inicio");
  }

  // Verificar modo read-only
  checkReadOnlyMode();
}

async function checkReadOnlyMode() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    
    if (config.readOnly) {
      // Aplicar modo read-only
      applyReadOnlyRestrictions();
    }
  } catch (error) {
    console.log("Config endpoint não disponível (modo offline?)");
  }
}

function applyReadOnlyRestrictions() {
  // Desabilitar botão de importação
  const importBtn = document.getElementById("btnImprotar");
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.title = "Modo leitura - Importação desabilitada";
    importBtn.style.opacity = "0.5";
    importBtn.style.cursor = "not-allowed";
  }

  // Desabilitar seção de importação
  const importSection = document.getElementById("global-import-section");
  if (importSection) {
    importSection.style.display = "none";
  }

  // Desabilitar botões de edição/salvar em modais
  const saveButtons = document.querySelectorAll("[id*='save'], [id*='add'], [id*='delete']");
  saveButtons.forEach(btn => {
    if (btn && btn.tagName === "BUTTON") {
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.style.cursor = "not-allowed";
    }
  });

  // Desabilitar inputs em formulários
  const inputs = document.querySelectorAll("input[type='file'], textarea[id*='note']");
  inputs.forEach(input => {
    input.disabled = true;
    input.style.opacity = "0.5";
  });

  // Adicionar aviso visual
  const banner = document.createElement("div");
  banner.id = "readonly-banner";
  banner.style.cssText = `
    background-color: #ffc107;
    color: #000;
    padding: 10px 20px;
    text-align: center;
    font-weight: bold;
    font-size: 14px;
    border-bottom: 2px solid #ff9800;
    position: sticky;
    top: 0;
    z-index: 1000;
  `;
  banner.textContent = "🔒 MODO LEITURA - Portal em modo visualização apenas (sem permissão para editar)";
  
  const body = document.body;
  if (body.firstChild) {
    body.insertBefore(banner, body.firstChild);
  } else {
    body.appendChild(banner);
  }

  console.log("✓ Modo read-only ativado - Portal em visualização apenas");
}

function getPendingUsers() {
  return getStoredUsers().filter(u => u.role === "pending");
}

const STORAGE_NOTIFICATION_SEEN_PREFIX = "portalNotificationSeen:";

function getNotificationSeenKey() {
  const user = getCurrentUser();
  return `${STORAGE_NOTIFICATION_SEEN_PREFIX}${(user?.username || 'anon').toLowerCase()}`;
}

function getNotificationSeenAt() {
  return localStorage.getItem(getNotificationSeenKey()) || "";
}

function setNotificationSeenAt(value) {
  if (!value) return;
  localStorage.setItem(getNotificationSeenKey(), value);
}

function getNotificationEventTime(event) {
  const raw = event?.created_at || event?.createdAt;
  const timestamp = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function fetchNotificationFeed() {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  if (!isAdmin) return [];

  const useApi = window.location.protocol.startsWith("http");
  if (useApi) {
    try {
      const res = await fetch("/api/notifications_feed?limit=40", { credentials: "include" });
      if (res.ok) {
        const items = await res.json();
        return Array.isArray(items) ? items : [];
      }
    } catch (error) {
      console.warn("Falha ao carregar notificações do servidor.", error);
    }
  }

  return getStoredUsers()
    .filter(u => u.username && u.username.toLowerCase() !== "admin")
    .map(u => ({
      type: "cadastro",
      source: "Cadastro",
      title: `Novo cadastro: ${u.name || u.username}`,
      subtitle: `Usuário: ${u.username}`,
      message: `E-mail: ${u.email || 'sem e-mail'} • Perfil: ${u.role || 'viewer'}`,
      created_by: u.username,
      created_at: u.createdAt || new Date().toISOString(),
      reference: u.username,
    }))
    .sort((a, b) => getNotificationEventTime(b) - getNotificationEventTime(a))
    .slice(0, 20);
}

function markNotificationFeedAsSeen(events = []) {
  const latest = [...events].sort((a, b) => getNotificationEventTime(b) - getNotificationEventTime(a))[0];
  setNotificationSeenAt(latest?.created_at || new Date().toISOString());
}

async function loadHistory() {
  const tbody = document.getElementById("tabela-historico");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" style="text-align:center">Carregando...</td></tr>`;

  const useApi = window.location.protocol.startsWith("http");
  let rows = [];

  if (useApi) {
    try {
      const res = await fetch("/api/history", { credentials: "include" });
      if (res.ok) {
        rows = await res.json();
      }
    } catch {
      rows = [];
    }
  } else {
    rows = getStoredUsers()
      .filter(u => u.role)
      .map(u => ({
        username: u.username,
        name: u.name,
        email: u.email,
        role: u.role,
        created_at: u.createdAt,
        decision_at: u.approvedAt,
      }));
  }

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center">Nenhuma solicitação registrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(u => {
    const status = u.role === "pending"
      ? "Pendente"
      : u.role === "admin"
        ? "Aprovado (Admin)"
        : u.role === "viewer"
          ? "Aprovado (Acompanh.)"
          : u.role === "rejected"
            ? "Rejeitado"
            : u.role;

    const created = u.created_at ? new Date(u.created_at).toLocaleString() : "-";
    const decision = u.decision_at ? new Date(u.decision_at).toLocaleString() : "-";

    return `
      <tr>
        <td>${u.username || ""}</td>
        <td>${u.name || ""}</td>
        <td>${u.email || ""}</td>
        <td>${status}</td>
        <td>${created}</td>
        <td>${decision}</td>
      </tr>`;
  }).join("");
}

function updateNotificationBadge() {
  const badge = document.getElementById("notificationBadge");
  if (!badge) return;

  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";
  if (!isAdmin) {
    badge.textContent = "";
    badge.classList.add("hidden");
    return;
  }

  const localPendings = getPendingUsers();
  const useApi = window.location.protocol.startsWith("http");

  const serverPendingsPromise = useApi
    ? fetch("/api/pending", { credentials: "include" })
        .then(res => (res.ok ? res.json() : []))
        .catch(() => [])
    : Promise.resolve([]);

  Promise.all([serverPendingsPromise, fetchNotificationFeed()]).then(([serverPendings, events]) => {
    const seenAt = getNotificationSeenAt();
    const seenTimestamp = seenAt ? new Date(seenAt).getTime() : 0;

    const uniqueUsers = new Set();
    localPendings.forEach(u => uniqueUsers.add(u.username));
    (serverPendings || []).forEach(u => uniqueUsers.add(u.username));

    const unreadEvents = (events || []).filter(event => getNotificationEventTime(event) > seenTimestamp).length;
    const total = uniqueUsers.size + unreadEvents;

    if (total > 0) {
      badge.textContent = total > 9 ? "9+" : String(total);
      badge.classList.remove("hidden");
    } else {
      badge.textContent = "";
      badge.classList.add("hidden");
    }
  });
}

function toggleNotifications() {
  const panel = document.getElementById("notificationPanel");
  if (!panel) return;
  const isHidden = panel.classList.contains("hidden");
  if (isHidden) {
    renderNotificationList();
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

function toggleSettings() {
  const panel = document.getElementById("settingsPanel");
  const isHidden = panel && panel.classList.contains("hidden");
  if (!panel) return;
  if (isHidden) {
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

function openChangePassword() {
  const user = getCurrentUser();
  if (!user) return;

  const current = prompt("Digite sua senha atual:");
  if (current === null) return;
  if (current !== user.password) {
    alert("⚠️ Senha atual incorreta.");
    return;
  }

  const next = prompt("Digite a nova senha (mínimo 3 caracteres):");
  if (next === null) return;
  if (next.length < 3) {
    alert("⚠️ A senha deve ter pelo menos 3 caracteres.");
    return;
  }

  const confirm = prompt("Confirme a nova senha:");
  if (confirm === null) return;
  if (next !== confirm) {
    alert("⚠️ As senhas não coincidem.");
    return;
  }

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === user.username.toLowerCase());
  if (idx === -1) return;

  users[idx].password = next;
  saveStoredUsers(users);
  alert("✅ Senha atualizada com sucesso.");
  toggleSettings();
}

function openEditProfile() {
  const user = getCurrentUser();
  if (!user) return;

  const newName = prompt("Nome completo:", user.name || "");
  if (newName === null) return;

  const newEmail = prompt("Email:", user.email || "");
  if (newEmail === null) return;

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === user.username.toLowerCase());
  if (idx === -1) return;

  users[idx].name = newName.trim();
  users[idx].email = newEmail.trim();
  saveStoredUsers(users);

  updateUserProfileInfo();
  alert("✅ Dados atualizados com sucesso.");
  toggleSettings();
}

async function renderNotificationList() {
  const list = document.getElementById("notificationList");
  if (!list) return;

  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";

  if (!isAdmin) {
    list.innerHTML = '<p class="notification-empty">Somente administradores podem visualizar as notificações do portal.</p>';
    return;
  }

  list.innerHTML = '<p class="notification-empty">Carregando notificações...</p>';

  const pendings = getPendingUsers();
  const useApi = window.location.protocol.startsWith("http");

  const serverPendingsPromise = useApi
    ? fetch("/api/pending", { credentials: "include" })
        .then(res => (res.ok ? res.json() : []))
        .catch(() => [])
    : Promise.resolve([]);

  const [serverPendings, events] = await Promise.all([serverPendingsPromise, fetchNotificationFeed()]);

  const hasLocal = pendings.length > 0;
  const hasServer = Array.isArray(serverPendings) && serverPendings.length > 0;
  const registrationEvents = (events || []).filter(event => event.type === 'cadastro');
  const noteEvents = (events || []).filter(event => event.type === 'observacao');

  if (!hasLocal && !hasServer && registrationEvents.length === 0 && noteEvents.length === 0) {
    list.innerHTML = '<p class="notification-empty">Nenhuma notificação recente.</p>';
    return;
  }

  const renderFeedCard = (event) => {
    const created = event?.created_at ? new Date(event.created_at).toLocaleString() : '-';
    const title = escapeHtml(event?.title || 'Atualização do portal');
    const subtitle = escapeHtml(event?.subtitle || event?.source || 'Portal MDU');
    const message = escapeHtml(event?.message || '');
    const who = escapeHtml(event?.created_by || 'sistema');
    const reference = event?.reference ? ` • Ref: ${escapeHtml(String(event.reference))}` : '';

    return `
      <div class="notification-item">
        <p><strong>${title}</strong></p>
        <p>${subtitle}</p>
        ${message ? `<p>${message}</p>` : ''}
        <p class="notification-meta">${who} • ${created}${reference}</p>
      </div>
    `;
  };

  const parts = [];

  if (hasLocal || hasServer) {
    parts.push('<p class="notification-section-title">Solicitações pendentes</p>');
  }

  if (hasLocal) {
    parts.push(pendings.map(u => {
      const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : "-";
      return `
        <div class="notification-item">
          <p><strong>${escapeHtml(u.name || u.username)}</strong> <span style="opacity:.7">(${escapeHtml(u.username)})</span></p>
          <p class="notification-meta">${escapeHtml(u.email || 'sem e-mail')} • ${created}</p>
          <div class="notification-actions">
            <button class="approve" onclick="approveUser('${u.username}', 'admin')">Aprovar (Admin)</button>
            <button class="approve-alt" onclick="approveUser('${u.username}', 'viewer')">Aprovar (Visualização)</button>
            <button class="deny" onclick="denyUser('${u.username}')">Rejeitar</button>
          </div>
        </div>
      `;
    }).join(""));
  }

  if (hasServer) {
    parts.push(serverPendings.map(u => {
      const created = u.created_at ? new Date(u.created_at).toLocaleString() : "-";
      return `
        <div class="notification-item">
          <p><strong>${escapeHtml(u.name || u.username)}</strong> <span style="opacity:.7">(${escapeHtml(u.username)})</span></p>
          <p class="notification-meta">${escapeHtml(u.email || 'sem e-mail')} • ${created}</p>
          <div class="notification-actions">
            <button class="approve" onclick="approveUser('${u.username}', 'admin')">Aprovar (Admin)</button>
            <button class="approve-alt" onclick="approveUser('${u.username}', 'viewer')">Aprovar (Visualização)</button>
            <button class="deny" onclick="denyUser('${u.username}')">Rejeitar</button>
          </div>
        </div>
      `;
    }).join(""));
  }

  if (registrationEvents.length > 0) {
    parts.push('<p class="notification-section-title">Cadastros recentes</p>');
    parts.push(registrationEvents.map(renderFeedCard).join(""));
  }

  if (noteEvents.length > 0) {
    parts.push('<p class="notification-section-title">Observações recentes</p>');
    parts.push(noteEvents.map(renderFeedCard).join(""));
  }

  list.innerHTML = parts.join("");
  markNotificationFeedAsSeen(events || []);
  updateNotificationBadge();
}

function approveUser(username, role) {
  const useApi = window.location.protocol.startsWith("http");

  if (useApi) {
    fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, role }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Falha ao aprovar usuário");
        }

        updateNotificationBadge();
        renderNotificationList();
        alert(`✅ Usuário '${username}' aprovado como ${role === "admin" ? "Administrador" : "Visualização"}.`);
      })
      .catch(() => {
        // fallback local
        const users = getStoredUsers();
        const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx === -1) return;

        users[idx].role = role;
        users[idx].approvedAt = new Date().toISOString();
        saveStoredUsers(users);

        updateNotificationBadge();
        renderNotificationList();
        alert(`✅ Usuário '${users[idx].username}' aprovado como ${role === "admin" ? "Administrador" : "Visualização"}.`);
      });

    return;
  }

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return;

  users[idx].role = role;
  users[idx].approvedAt = new Date().toISOString();
  saveStoredUsers(users);

  updateNotificationBadge();
  renderNotificationList();
  alert(`✅ Usuário '${users[idx].username}' aprovado como ${role === "admin" ? "Administrador" : "Visualização"}.`);
}

function denyUser(username) {
  const useApi = window.location.protocol.startsWith("http");

  if (useApi) {
    fetch("/api/deny", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Falha ao rejeitar solicitação");
        }

        updateNotificationBadge();
        renderNotificationList();
        alert(`❌ Solicitação de '${username}' rejeitada.`);
      })
      .catch(() => {
        // fallback local
        const users = getStoredUsers();
        const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx === -1) return;

        users.splice(idx, 1);
        saveStoredUsers(users);

        updateNotificationBadge();
        renderNotificationList();
        alert(`❌ Solicitação de '${username}' rejeitada.`);
      });

    return;
  }

  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return;

  users.splice(idx, 1);
  saveStoredUsers(users);

  updateNotificationBadge();
  renderNotificationList();
  alert(`❌ Solicitação de '${username}' rejeitada.`);
}

// ===== PERFIL DO USUÁRIO =====
// Carregar foto de perfil do localStorage se existir
window.addEventListener("DOMContentLoaded", async () => {
  const savedPhoto = localStorage.getItem("userPhoto");
  if (savedPhoto) {
    document.getElementById("profileImage").src = savedPhoto;
  }

  applyColumnDensity(localStorage.getItem(STORAGE_COLUMN_DENSITY_KEY) || "compact");

  // Sincronizar usuário com o backend (se estiver rodando)
  await syncCurrentUserFromServer();

  // Se não há usuário logado, redirecionar para cadastro/login
  const current = getCurrentUser();
  if (!current) {
    window.location.href = "register.html";
    return;
  }

  // Atualizar dados de usuário e notificações
  updateUserProfileInfo();
  updateNotificationBadge();
  applyAccessControl();
  await carregarDadosCompartilhados();

  // Inicializar componentes de interface
  initHeaderSearch();
  inicializarFiltrosDDD();
  setImportMode(importMode);
  agendarRenderVisaoGerencia(true);

  window.setInterval(() => {
    updateNotificationBadge();
    carregarDadosCompartilhados();

    const panel = document.getElementById("notificationPanel");
    if (panel && !panel.classList.contains("hidden")) {
      renderNotificationList();
    }
  }, 30000);

  // Atualizar badge quando outra aba/máquina mudar os usuários (localStorage)
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_USERS_KEY) {
      updateNotificationBadge();
      // se notificação estiver aberta, atualizar lista
      const panel = document.getElementById("notificationPanel");
      if (panel && !panel.classList.contains("hidden")) {
        renderNotificationList();
      }
    }
  });
});

// Upload de foto de perfil
document.getElementById("fotoPerfil").addEventListener("change", function() {
  const file = this.files[0];
  if (!file) return;

  // Validar tipo de arquivo
  if (!file.type.startsWith("image/")) {
    alert("⚠️ Selecione uma imagem válida");
    return;
  }

  // Validar tamanho (máx 2MB)
  if (file.size > 2 * 1024 * 1024) {
    alert("⚠️ A imagem deve ter no máximo 2MB");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const photoData = e.target.result;
    const profileImage = document.getElementById("profileImage");
    
    // Salvar no localStorage
    localStorage.setItem("userPhoto", photoData);
    
    // Atualizar imagem
    profileImage.src = photoData;
    
    // Feedback visual
    profileImage.style.transform = "scale(0.9)";
    setTimeout(() => {
      profileImage.style.transform = "scale(1)";
    }, 100);
  };
  
  reader.readAsDataURL(file);
});

function getCategoriaNome(categoriaId) {
  const mapping = {
    "pendente-autorizacao": "Pendente Autorização",
    "novos-empreendimentos": "Novos Empreendimentos",
    "empresarial": "Empresarial",
    "sar-rede": "SAR Rede",
    "mdu-ongoing": "MDU Ongoing",
    "ongoing": "ONGOING",
    "projeto-f": "Projeto F",
    "epo": "EPO",
    "financeiro": "Financeiro",
    "reuniao": "Reunião",
  };
  return mapping[categoriaId] || categoriaId || "-";
}

function updateImportTargetLabel() {
  const label = document.getElementById("import-target-name");
  if (!label) return;
  label.textContent = categoriaAtualParaImport ? getCategoriaNome(categoriaAtualParaImport) : "-";
}

function setImportMode(mode) {
  importMode = mode;

  document.querySelectorAll(".import-mode-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
  });

  const local = document.getElementById("import-local");
  const network = document.getElementById("import-network");
  const web = document.getElementById("import-web");

  if (local) local.style.display = mode === "local" ? "flex" : "none";
  if (network) network.style.display = mode === "network" ? "flex" : "none";
  if (web) web.style.display = mode === "web" ? "flex" : "none";
}

function normalizeSheetUrl(url) {
  if (!url) return url;

  // Google Sheets: converter link de visualização em exportação CSV
  if (url.includes("docs.google.com/spreadsheets") && !url.includes("/export")) {
    const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
    }
  }

  // OneDrive/SharePoint pode exigir o uso de links de download direto. Se já houver "download=1", usamos direto.
  if (url.includes("onedrive.live.com") || url.includes("sharepoint.com")) {
    if (!url.includes("download=1")) {
      const separator = url.includes("?") ? "&" : "?";
      return `${url}${separator}download=1`;
    }
  }

  return url;
}

// Mostrar nome do arquivo selecionado e importar automaticamente
const arquivoCSVInput = document.getElementById("arquivoCSV");
if (arquivoCSVInput) {
  arquivoCSVInput.addEventListener("change", function() {
    const fileName = this.files[0]?.name || "";
    const fileNameDisplay = document.getElementById("file-name");
    if (fileNameDisplay) {
      fileNameDisplay.textContent = fileName ? `📄 ${fileName}` : "";
    }

    // Garantir que estamos importando para a categoria ativa
    const activeSection = document.querySelector('.secao.ativa');
    if (activeSection && activeSection.id) {
      categoriaAtualParaImport = activeSection.id;
      updateImportTargetLabel();
    }

    if (this.files && this.files.length > 0) {
      importarCSV();
    }
  });
}

// Mostrar nome do arquivo selecionado para Ongoing e importar automaticamente
const arquivoCSVOngoingInput = document.getElementById("arquivoCSVOngoing");
if (arquivoCSVOngoingInput) {
  arquivoCSVOngoingInput.addEventListener("change", function() {
    const fileName = this.files[0]?.name || "";
    const fileNameDisplay = document.getElementById("file-name-ongoing");
    if (fileNameDisplay) {
      fileNameDisplay.textContent = fileName ? `📄 ${fileName}` : "";
    }

    if (this.files && this.files.length > 0) {
      importarCSVOngoing();
    }
  });
}

// IMPORTAR CSV (local)
function parseGenericCsvRows(csv, delimiter = ';') {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  const cabecalhoRaw = (linhas[0] || '').trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(',') && !cabecalhoRaw.includes(';')) {
    delimiter = ',';
  }

  const cabecalho = _splitCsvLine(cabecalhoRaw, delimiter).map(c => c.replace(/^\uFEFF/, '').trim());
  const parsed = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const cols = _splitCsvLine(linha, delimiter);
    const item = {};

    cabecalho.forEach((c, j) => {
      const key = (c || '').trim();
      const value = (cols[j] || '').trim();
      item[key] = value;

      const normalizedKey = normalizeKey(key);
      if (normalizedKey && item[normalizedKey] === undefined) {
        item[normalizedKey] = value;
      }
    });

    parsed.push(item);
  }

  return parsed;
}

function _splitCsvLine(line, delimiter) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === delimiter && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function importarCSV() {
  const categoria = categoriaAtualParaImport || document.querySelector('.secao.ativa')?.id;
  if (!categoria) {
    return alert("Selecione uma categoria antes de importar.");
  }

  const input = document.getElementById("arquivoCSV");
  if (!input || !input.files.length) return alert("Selecione o CSV");

  const statusEl = document.getElementById('import-status');
  if (statusEl) {
    statusEl.textContent = '⏳ Importando... Aguarde.';
  }

  const reader = new FileReader();
  reader.onload = e => {
    // Remover BOM se presente (muito comum em CSV exportado pelo Excel)
    const text = e.target.result.replace(/^\uFEFF/, "");
    const linhas = text.split(/\r?\n/);

    if (!linhas.length || !linhas[0]?.trim()) {
      alert('⚠️ Arquivo vazio ou inválido.');
      return;
    }

    const cabecalhoRaw = linhas[0] || "";
    const delimiter = cabecalhoRaw.includes(';') ? ';' : (cabecalhoRaw.includes(',') ? ',' : ';');
    const cabecalho = cabecalhoRaw.split(delimiter).map(c => c.replace(/^\uFEFF/, "").trim());

    // Mapear índices de colunas por chave (normalizada) para não precisar varrer todo o objeto por linha
    const headerIndex = {};
    cabecalho.forEach((c, idx) => {
      const normalized = normalizeKey(c);
      if (normalized) {
        headerIndex[normalized] = idx;
      }
    });

    const statusIndexes = Object.entries(headerIndex)
      .filter(([k]) => k.includes('status'))
      .map(([, idx]) => idx);

    const isPendente = categoria === 'pendente-autorizacao';
    const isOngoing = categoria === 'ongoing';
    const isMduOngoing = categoria === 'mdu-ongoing';
    const isProjetoF = categoria === 'projeto-f';

    if (isOngoing) {
      const dados = processarCSVOngoing(text, delimiter);
      dadosCSVOngoing = dados;
      dadosCSVOngoingOriginal = dados;
      dadosPorCategoria['ongoing'] = dados;
      filtroFilaAtivo = 'todos';

      // Resetar botões para TODOS
      document.querySelectorAll('.fila-btn').forEach(btn => {
        btn.classList.remove('ativo');
        if (btn.getAttribute('data-fila') === 'todos') {
          btn.classList.add('ativo');
        }
      });

      renderTabelaOngoing(dadosCSVOngoing);
      persistirDadosCompartilhados('ongoing', dados, { source: 'manual', locked: true });
      if (statusEl) {
        statusEl.textContent = `✅ Importado ${dados.length} registro(s)`;
      }
      const fileNameDisplay = document.getElementById('file-name');
      if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name ? `📄 ${file.name}` : '';
      }
      return;
    }

    if (isMduOngoing) {
      const dadosBacklogGerencia = parseGenericCsvRows(text, delimiter);
      if (dadosBacklogGerencia.length) {
        dadosCSV = dadosBacklogGerencia;
        applyDatasetToState('backlog', dadosBacklogGerencia);
        syncDerivedCategoriesFromBacklog(dadosBacklogGerencia, true);
      }

      const dados = processarCSVMduOngoing(text, delimiter);
      applyDatasetToState('mdu-ongoing', dados);
      renderTabelaMduOngoing(`tabela-mdu-ongoing`, dados);
      persistirDadosCompartilhados('mdu-ongoing', dados, { source: 'manual', locked: true });
      if (dadosBacklogGerencia.length) {
        persistirDadosCompartilhados('backlog', dadosBacklogGerencia, { source: 'manual', locked: true });
      }
      invalidateVisaoGerenciaCache();
      agendarRenderVisaoGerencia();
      if (statusEl) {
        statusEl.textContent = `✅ Importado ${dados.length} registro(s)`;
      }
      const fileNameDisplay = document.getElementById('file-name');
      if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name ? `📄 ${file.name}` : '';
      }
      return;
    }

    if (isProjetoF) {
      const dados = processarCSVProjetoF(text, delimiter);
      dadosPorCategoria['projeto-f'] = dados;
      renderTabelaProjetoF(`tabela-projeto-f`, dados);
      persistirDadosCompartilhados('projeto-f', dados, { source: 'manual', locked: true });
      invalidateVisaoGerenciaCache();
      agendarRenderVisaoGerencia();
      if (statusEl) {
        statusEl.textContent = `✅ Importado ${dados.length} registro(s)`;
      }
      const fileNameDisplay = document.getElementById('file-name');
      if (fileNameDisplay) {
        fileNameDisplay.textContent = file.name ? `📄 ${file.name}` : '';
      }
      return;
    }

    const keepKeys = isPendente
      ? ["COD-MDUGO", "ENDEREÇO", "NUMERO", "CIDADE", "AGE", "STATUS_GERAL", "MOTIVO_GERAL", "OBS", "OBSERVACAO"]
      : null;

    const keepIndexes = {};
    if (keepKeys) {
      keepKeys.forEach(k => {
        const idx = headerIndex[normalizeKey(k)];
        if (idx !== undefined) {
          keepIndexes[k] = idx;
        }
      });
    }

    const parsed = [];
    let linhaAtual = 1;
    const batchSize = 1000;
    const maxItensPendente = 5000; // Limite para evitar travar em planilhas gigantes
    let truncado = false;

    const processBatch = () => {
      const fim = Math.min(linhas.length, linhaAtual + batchSize);
      for (; linhaAtual < fim; linhaAtual++) {
        const linha = linhas[linhaAtual];
        if (!linha || !linha.trim()) continue;

        const cols = linha.split(delimiter);

        if (isPendente) {
          // Construir apenas o suficiente para avaliar o status e armazenar dados mínimos
          let statusRaw = '';
          statusIndexes.forEach(idx => {
            statusRaw += (cols[idx] || '') + ' ';
          });
          statusRaw = statusRaw.trim();

          const statusNorm = normalizeText(statusRaw);
          const isVistoria = statusNorm.includes('fila_pendente_autorizacao_vistoria') ||
            statusNorm.includes('1.fila_pendente_autorizacao_vistoria') ||
            (statusNorm.includes('pendente') && statusNorm.includes('vistoria'));

          const isBackbone = statusNorm.includes('fila_pendente_autorizacao_backbone') ||
            statusNorm.includes('4.fila_pendente_autorizacao_backbone') ||
            (statusNorm.includes('pendente') && statusNorm.includes('backbone'));

          if (!isVistoria && !isBackbone) {
            // Ignorar linha que não é pendente
            continue;
          }

          const item = {};
          Object.entries(keepIndexes).forEach(([key, idx]) => {
            const value = (cols[idx] || "").trim();
            item[key] = value;
            const normalizedKey = normalizeKey(key);
            if (normalizedKey && item[normalizedKey] === undefined) {
              item[normalizedKey] = value;
            }
          });
          item.__pendenteTipo = isVistoria ? 'vistoria' : 'backbone';
          parsed.push(item);

          if (parsed.length >= maxItensPendente) {
            truncado = true;
            linhaAtual = linhas.length; // força término do processamento
            break;
          }
        } else {
          const fullItem = {};
          cabecalho.forEach((c, j) => {
            const key = (c || "").trim();
            const value = (cols[j] || "").trim();

            fullItem[key] = value;
            const normalizedKey = normalizeText(key).replace(/[^a-z0-9]/g, "_");
            if (normalizedKey && !fullItem[normalizedKey]) {
              fullItem[normalizedKey] = value;
            }
          });
          parsed.push(fullItem);
        }
      }

      if (statusEl) {
        const linhasProcessadas = Math.min(linhaAtual, linhas.length - 1);
        const destino = truncado ? `${parsed.length}+` : parsed.length;
        statusEl.textContent = `⏳ Importando... ${linhasProcessadas}/${linhas.length - 1} linhas processadas, ${destino} registro(s)`;
      }

      if (linhaAtual < linhas.length) {
        setTimeout(processBatch, 0);
      } else {
        dadosPorCategoria[categoria] = parsed;

        const looksLikeBacklog = cabecalho.some(coluna => {
          const normalized = normalizeKey(coluna);
          return normalized.includes('qtd_blocos')
            || normalized.includes('status_geral')
            || normalized.includes('data_concluido')
            || normalized.includes('data_conclu');
        });

        if (looksLikeBacklog) {
          dadosCSV = parsed;
          applyDatasetToState('backlog', parsed);
          persistirDadosCompartilhados('backlog', parsed, { source: 'manual', locked: true });
          syncDerivedCategoriesFromBacklog(parsed, true);
        }

        applyDatasetToState(categoria, parsed);
        persistirDadosCompartilhados(categoria, parsed, { source: 'manual', locked: true });

        if (statusEl) {
          if (truncado) {
            statusEl.textContent = `✅ Importado ${parsed.length}+ registros (limite atingido, há mais linhas no arquivo)`;
          } else {
            statusEl.textContent = `✅ Importado ${parsed.length} registro(s)`;
          }
        }
        atualizarSeccaoAtivaComDados();
      }
    };

    processBatch();
  };

  reader.readAsText(input.files[0], "ISO-8859-1");
}

// IMPORTAR CSV a partir de caminho no servidor (rede)
async function importarDoCaminhoRede() {
  if (!window.location.protocol.startsWith("http")) {
    return alert("⚠️ Recurso disponível apenas quando o servidor estiver rodando (acessar via http://localhost:5000).\nNo modo local (arquivo), não é possível ler caminhos de rede.");
  }

  const categoria = categoriaAtualParaImport;
  if (!categoria) {
    return alert("Selecione uma categoria antes de importar.");
  }

  const path = document.getElementById("networkPath")?.value?.trim();
  if (!path) return alert("Informe o caminho do arquivo de rede");

  try {
    const res = await fetch("/api/load_csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Falha ao carregar CSV de rede");
    }

    const dados = await res.json();
    dadosPorCategoria[categoria] = dados;
    persistirDadosCompartilhados(categoria, dados, { source: 'manual', locked: true });
    atualizarSeccaoAtivaComDados();
  } catch (err) {
    alert(`⚠️ ${err.message}\nVerifique se o servidor está rodando e se o caminho está acessível (pode exigir VPN / rede interna).`);
  }
}

// IMPORTAR CSV a partir de URL (Google Sheets / OneDrive)
async function importarDeUrl() {
  if (!window.location.protocol.startsWith("http")) {
    return alert("⚠️ Recurso disponível apenas quando o servidor estiver rodando (acessar via http://localhost:5000).\nNo modo local (arquivo), não é possível buscar URLs externas.");
  }

  const categoria = categoriaAtualParaImport;
  if (!categoria) {
    return alert("Selecione uma categoria antes de importar.");
  }

  let url = document.getElementById("sheetUrl")?.value?.trim();
  if (!url) return alert("Informe a URL do arquivo");

  url = normalizeSheetUrl(url);

  try {
    const res = await fetch("/api/load_csv_url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Falha ao carregar planilha da web");
    }

    const dados = await res.json();
    dadosPorCategoria[categoria] = dados;
    persistirDadosCompartilhados(categoria, dados, { source: 'manual', locked: true });
    atualizarSeccaoAtivaComDados();
  } catch (err) {
    alert(`⚠️ ${err.message}\nVerifique se o servidor está rodando e se a URL é acessível (pode exigir VPN / rede interna).`);
  }
}

function atualizarSeccaoAtivaComDados() {
  const secaoAtiva = document.querySelector(".secao.ativa");
  if (secaoAtiva && secaoAtiva.id) {
    carregarDadosCategoria(secaoAtiva.id);
  }

  invalidateVisaoGerenciaCache();
  agendarRenderVisaoGerencia();
}

// RENDER
function renderTabela(id, lista, atualizarRelatoriosFlag = true) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (id === "tabela-enderecos") {
    dadosCSV = Array.isArray(lista) ? [...lista] : [];
    dadosPorCategoria['backlog'] = dadosCSV;
  }

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">Nenhum registro</td></tr>`;
    return;
  }

  const rows = lista.map(i => {
    const codigo = getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo");
    const endereco = `${getField(i, "ENDEREÇO", "ENDERECO")} ${getField(i, "NUMERO", "NUM")} `.trim();
    const cidade = getField(i, "CIDADE", "cidade");
    const status = getField(i, "STATUS_GERAL", "STATUS", "status");
    const motivo = getField(i, "MOTIVO_GERAL", "MOTIVO", "motivo");
    const age = obterAge(i) || "—";

    return `
      <tr>
        <td>${codigo}</td>
        <td>${endereco}</td>
        <td>${cidade}</td>
        <td>${status}</td>
        <td><strong>${age}</strong></td>
        <td>${motivo}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;

  // Se estivermos atualizando a tabela principal e também atualizando relatórios,
  // manter a cópia na tabela de relatórios
  if (id === "tabela-enderecos" && atualizarRelatoriosFlag) {
    const tabelaRelatorios = document.getElementById("tabela-relatorios");
    if (tabelaRelatorios) {
      tabelaRelatorios.innerHTML = document.getElementById("tabela-enderecos").innerHTML;
    }
  }

  // Atualizar gráficos do dashboard e relatórios somente se a flag permitir
  atualizarDashboard();
  if (atualizarRelatoriosFlag) {
    atualizarRelatorios();
  }
}

function renderTabelaEmpresarial(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  const dadosEmpresariais = (lista || []).filter(item => {
    const solicitante = (getField(item, "SOLICITANTE", "solicitante") || "").toLowerCase().trim();
    return solicitante.includes("empresarial");
  });

  if (!dadosEmpresariais.length) {
    tbody.innerHTML = `<tr><td colspan="10">Nenhum registro</td></tr>`;
    popularFiltrosEmpresarial(dadosEmpresariais);
    return;
  }

  const rows = dadosEmpresariais.map(i => {
    const codigo = getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo") || "-";
    const endereco = getField(i, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada") || "-";
    const numero = getField(i, "NUMERO", "numero") || "-";
    const bairro = getField(i, "BAIRRO", "bairro") || "-";
    const cidade = getField(i, "CIDADE", "cidade") || "-";
    const epo = getField(i, "EPO", "epo", "regional", "cluster") || "-";
    const solicitante = getField(i, "SOLICITANTE", "solicitante") || "-";
    const statusGeral = getField(i, "STATUS_GERAL", "status_geral", "status") || "-";
    const motivoGeral = getField(i, "MOTIVO_GERAL", "motivo_geral", "motivo") || "-";

    return `
      <tr>
        <td>${codigo}</td>
        <td>${endereco}</td>
        <td>${numero}</td>
        <td>${bairro}</td>
        <td>${cidade}</td>
        <td>${epo}</td>
        <td>${solicitante}</td>
        <td>${statusGeral}</td>
        <td>${motivoGeral}</td>
        <td><button type="button" onclick="visualizarEmpresarial('${codigo}')" class="btn-visualizar">Visualizar</button></td>
      </tr>`;
  });

  tbody.innerHTML = rows.join('');
  popularFiltrosEmpresarial(dadosEmpresariais);
}

function renderTabelaMduOngoing(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10">Nenhum registro</td></tr>`;
    popularFiltroStatusMdu();
    return;
  }

  const rows = lista.map(i => {
    const codigo = getField(i, "COD-MDUGO");
    const endereco = getField(i, "ENDEREÇO");
    const numero = getField(i, "NUMERO");
    const bairro = getField(i, "BAIRRO");
    const cidade = getField(i, "CIDADE");
    const epo = getField(i, "EPO");
    const solicitante = getField(i, "SOLICITANTE");
    const statusGeral = getField(i, "STATUS_GERAL");
    const motivoGeral = getField(i, "MOTIVO_GERAL");

    return `
      <tr>
        <td>${codigo}</td>
        <td>${endereco}</td>
        <td>${numero}</td>
        <td>${bairro}</td>
        <td>${cidade}</td>
        <td>${epo}</td>
        <td>${solicitante}</td>
        <td>${statusGeral}</td>
        <td>${motivoGeral}</td>
        <td><button onclick="visualizarMduOngoing('${codigo}')" class="btn-visualizar">🔍 Visualizar</button></td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
  popularFiltroStatusMdu();
}

function renderTabelaProjetoF(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    window.__projetoFModalData = [];
    tbody.innerHTML = `<tr><td colspan="8">Nenhum registro</td></tr>`;
    popularFiltroCidadeProjetoF();
    return;
  }

  window.__projetoFModalData = Array.isArray(lista) ? [...lista] : [];

  const rows = lista.map((i, index) => {
    const codigo = getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo");
    const codged = getField(i, "CODGED", "codged", "cod_ged");
    const cidade = getField(i, "CIDADE", "cidade");
    const bloco = getField(i, "BLOCO", "bloco");
    const endereco = getField(i, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada");
    const qtdeBlocos = getField(i, "Qtde Blocos", "QTDE_BLOCOS", "qtd_blocos");
    const statusMdu = getField(i, "STATUS MDU", "STATUS_MDU", "status_mdu");
    const statusLiberacao = getField(i, "STATUS LIBERAÇÃO", "STATUS_LIBERACAO", "status_liberacao");
    const recordKey = String(codigo || codged || `projeto-f-${index}`).replace(/"/g, '&quot;');

    return `
      <tr>
        <td>${cidade || '-'}</td>
        <td>${bloco || '-'}</td>
        <td>${codged || '-'}</td>
        <td>${endereco || '-'}</td>
        <td>${qtdeBlocos || '-'}</td>
        <td>${statusMdu || '-'}</td>
        <td>${statusLiberacao || '-'}</td>
        <td><button type="button" class="btn-visualizar" data-row-index="${index}" data-record-key="${recordKey}" onclick="visualizarProjetoF(this)">VISUALIZAR</button></td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
  popularFiltroCidadeProjetoF();
}

function popularFiltroStatusMdu() {
  const select = document.getElementById('status-filter-mdu');
  if (!select) return;

  const valorAtual = select.value || "";
  const dados = dadosPorCategoria['mdu-ongoing'] || [];
  const statusUnicos = [...new Set(dados
    .map(item => (getField(item, 'STATUS_GERAL') || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  select.innerHTML = '';
  const optionTodos = document.createElement('option');
  optionTodos.value = '';
  optionTodos.textContent = 'Todos';
  select.appendChild(optionTodos);

  statusUnicos.forEach(status => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    select.appendChild(option);
  });

  if (statusUnicos.includes(valorAtual)) {
    select.value = valorAtual;
  } else {
    select.value = '';
  }
}

function popularFiltroCidadeProjetoF() {
  const select = document.getElementById('filtro-cidade-projeto-f');
  if (!select) return;

  const valorAtual = select.value || "";
  const dados = dadosPorCategoria['projeto-f'] || [];
  const cidadesUnicas = [...new Set(dados
    .map(item => (getField(item, 'CIDADE') || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  select.innerHTML = '';
  const optionTodos = document.createElement('option');
  optionTodos.value = '';
  optionTodos.textContent = 'Todas';
  select.appendChild(optionTodos);

  cidadesUnicas.forEach(cidade => {
    const option = document.createElement('option');
    option.value = cidade;
    option.textContent = cidade;
    select.appendChild(option);
  });

  if (cidadesUnicas.includes(valorAtual)) {
    select.value = valorAtual;
  } else {
    select.value = '';
  }
}

function filtrarMduOngoingPorStatus() {
  const select = document.getElementById('status-filter-mdu');
  const statusSelecionado = select?.value || '';
  const dados = dadosPorCategoria['mdu-ongoing'] || [];

  if (!statusSelecionado) {
    return dados;
  }

  return dados.filter(item => {
    const statusGeral = (getField(item, 'STATUS_GERAL') || '').trim();
    return statusGeral === statusSelecionado;
  });
}

function atualizarFiltroStatusMdu() {
  const listaFiltrada = filtrarMduOngoingPorStatus();
  renderTabelaMduOngoing('tabela-mdu-ongoing', listaFiltrada);
}

function filtrarProjetoFPorCidade() {
  const filtroCidade = document.getElementById('filtro-cidade-projeto-f')?.value?.toLowerCase().trim() || '';
  const dados = dadosPorCategoria['projeto-f'] || [];

  if (!filtroCidade) {
    return dados;
  }

  return dados.filter(item => {
    const cidade = (getField(item, 'CIDADE') || '').toLowerCase().trim();
    return cidade.includes(filtroCidade);
  });
}

function filtrarProjetoFPorEndereco() {
  const filtroEndereco = document.getElementById('filtro-endereco-projeto-f')?.value?.toLowerCase().trim() || '';
  const dados = dadosPorCategoria['projeto-f'] || [];

  if (!filtroEndereco) {
    return dados;
  }

  return dados.filter(item => {
    const endereco = (getField(item, 'ENDEREÇO') || '').toLowerCase().trim();
    return endereco.includes(filtroEndereco);
  });
}

function aplicarFiltrosProjetoF() {
  let dadosFiltrados = dadosPorCategoria['projeto-f'] || [];

  // Aplicar filtro de cidade
  dadosFiltrados = filtrarProjetoFPorCidade();

  // Aplicar filtro de endereço sobre os dados já filtrados por cidade
  const filtroEndereco = document.getElementById('filtro-endereco-projeto-f')?.value?.toLowerCase().trim() || '';
  if (filtroEndereco) {
    dadosFiltrados = dadosFiltrados.filter(item => {
      const endereco = (getField(item, 'ENDEREÇO') || '').toLowerCase().trim();
      return endereco.includes(filtroEndereco);
    });
  }

  renderTabelaProjetoF('tabela-projeto-f', dadosFiltrados);
}

// ===== FILTROS EMPRESARIAL =====
function popularFiltrosEmpresarial(listaBase = null) {
  const selectStatus = document.getElementById('filtro-status-empresarial');
  if (!selectStatus) return;

  const valorAtual = selectStatus.value || '';
  const origem = Array.isArray(listaBase) ? listaBase : (dadosPorCategoria['empresarial'] || []);
  const dados = origem.filter(item => {
    const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').toLowerCase().trim();
    return solicitante.includes('empresarial');
  });

  const statusUnicos = [...new Set(dados
    .map(item => (getField(item, 'STATUS_GERAL', 'status_geral', 'status') || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  selectStatus.innerHTML = '<option value="">Todos os Status</option>';

  statusUnicos.forEach(stat => {
    const option = document.createElement('option');
    option.value = stat;
    option.textContent = stat;
    selectStatus.appendChild(option);
  });

  if (statusUnicos.includes(valorAtual)) {
    selectStatus.value = valorAtual;
  } else {
    selectStatus.value = '';
  }
}

function aplicarFiltrosEmpresarial() {
  const filtroStatus = document.getElementById('filtro-status-empresarial')?.value?.toLowerCase().trim() || '';
  const dados = (dadosPorCategoria['empresarial'] || []).filter(item => {
    const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').toLowerCase().trim();
    return solicitante.includes('empresarial');
  });

  let dadosFiltrados = dados;

  if (filtroStatus) {
    dadosFiltrados = dadosFiltrados.filter(item => {
      const status = (getField(item, 'STATUS_GERAL', 'status_geral', 'status') || '').toLowerCase().trim();
      return status.includes(filtroStatus);
    });
  }

  renderTabelaEmpresarial('tabela-empresarial', dadosFiltrados);
}

(function() {
  const originalRenderTabelaEmpresarial = window.renderTabelaEmpresarial;
  window.renderTabelaEmpresarial = function(id, lista) {
    const filteredLista = (lista || []).filter(item => {
      const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').toLowerCase();
      return solicitante.includes('empresarial');
    });

    if (typeof originalRenderTabelaEmpresarial === 'function') {
      originalRenderTabelaEmpresarial(id, filteredLista);
    }
  };
})();

function parseDateString(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim();
  let match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const year = parseInt(match[3], 10);
    const hours = parseInt(match[4] || '0', 10);
    const minutes = parseInt(match[5] || '0', 10);
    return new Date(year, month, day, hours, minutes);
  }

  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}`);
  }

  const parsed = new Date(normalized);
  return isNaN(parsed) ? null : parsed;
}

function formatDateKey(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function formatMonthKey(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function getFirstField(item, fields) {
  return fields.reduce((acc, key) => acc || getField(item, key), '') || '';
}

function agruparRegistrosPorData(dados, statusKeys, statusValues, dateKeys) {
  const daily = {};
  const monthly = {};

  (dados || []).forEach(item => {
    const status = getFirstField(item, statusKeys);
    if (!status) return;

    const normalizedStatus = status.toString().toLowerCase();
    const matches = statusValues.some(value => normalizedStatus.includes(value.toLowerCase()));
    if (!matches) return;

    const rawDate = getFirstField(item, dateKeys);
    const date = parseDateString(rawDate);
    if (!date) return;

    const dayKey = formatDateKey(date);
    const monthKey = formatMonthKey(date);

    daily[dayKey] = (daily[dayKey] || 0) + 1;
    monthly[monthKey] = (monthly[monthKey] || 0) + 1;
  });

  return {
    daily: Object.entries(daily).sort((a, b) => {
      const [d1] = a;
      const [d2] = b;
      return parseDateString(d1) - parseDateString(d2);
    }),
    monthly: Object.entries(monthly).sort((a, b) => {
      const [m1] = a;
      const [m2] = b;
      const [month1, year1] = m1.split('/').map(Number);
      const [month2, year2] = m2.split('/').map(Number);
      return year1 - year2 || month1 - month2;
    })
  };
}

function createAnalyticsTable(title, rows) {
  return `
    <div class="analytics-card">
      <h3>${title}</h3>
      <table class="analytics-table">
        <thead>
          <tr><th>Período</th><th>Quantidade</th></tr>
        </thead>
        <tbody>
          ${rows.map(([periodo, total]) => `<tr><td>${periodo}</td><td>${total}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderVisaoGerencia() {
  const container = document.getElementById('pesquisa');
  if (!container) return;

  let analyticsContainer = document.getElementById('visao-gerencia-analytics');
  if (!analyticsContainer) {
    analyticsContainer = document.createElement('div');
    analyticsContainer.id = 'visao-gerencia-analytics';
    analyticsContainer.className = 'visao-gerencia-analytics';
    container.appendChild(analyticsContainer);
  }

  const backlog = dadosPorCategoria['backlog'] || [];
  const projetoF = dadosPorCategoria['projeto-f'] || [];

  const backlogData = agruparRegistrosPorData(backlog, ['STATUS_GERAL', 'status_geral', 'status'], ['CONCLUIDO'], ['dthinicio', 'DTINICIO', 'DT_INICIO', 'DATA', 'DATA_CONCLUSAO', 'DT_CONSTRUÇÃO', 'DT_CONSTRUCAO']);
  const projetoFData = agruparRegistrosPorData(projetoF, ['STATUS', 'STATUS_GERAL', 'status', 'status_geral'], ['OK'], ['DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'DATA', 'DATA_CONCLUSAO', 'dthinicio', 'DTINICIO']);

  analyticsContainer.innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-group">
        <h2>BACKLOG - Concluído</h2>
        ${createAnalyticsTable('Conclusões Diárias', backlogData.daily)}
        ${createAnalyticsTable('Conclusões Mensais', backlogData.monthly)}
      </div>
      <div class="analytics-group">
        <h2>PROJETO F - OK</h2>
        ${createAnalyticsTable('Conclusões Diárias', projetoFData.daily)}
        ${createAnalyticsTable('Conclusões Mensais', projetoFData.monthly)}
      </div>
    </div>
    <div class="visao-gerencia-charts">
      <div class="chart-card">
        <h3>BACKLOG Diário</h3>
        <canvas id="visao-backlog-daily-chart"></canvas>
      </div>
      <div class="chart-card">
        <h3>PROJETO F Diário</h3>
        <canvas id="visao-projetof-daily-chart"></canvas>
      </div>
    </div>
  `;

  if (typeof Chart !== 'undefined') {
    const backlogDailyLabels = backlogData.daily.map(item => item[0]);
    const backlogDailyValues = backlogData.daily.map(item => item[1]);
    const projetoFDailyLabels = projetoFData.daily.map(item => item[0]);
    const projetoFDailyValues = projetoFData.daily.map(item => item[1]);

    const backlogCtx = document.getElementById('visao-backlog-daily-chart');
    const projetoFCtx = document.getElementById('visao-projetof-daily-chart');

    if (backlogCtx) {
      new Chart(backlogCtx, {
        type: 'line',
        data: {
          labels: backlogDailyLabels,
          datasets: [{
            label: 'Concluídos',
            data: backlogDailyValues,
            borderColor: '#1f77b4',
            backgroundColor: 'rgba(31,119,180,0.2)',
            fill: true
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }

    if (projetoFCtx) {
      new Chart(projetoFCtx, {
        type: 'line',
        data: {
          labels: projetoFDailyLabels,
          datasets: [{
            label: 'OK',
            data: projetoFDailyValues,
            borderColor: '#2ca02c',
            backgroundColor: 'rgba(44,160,44,0.2)',
            fill: true
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
  }
}

function parseDateString(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim();
  let match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const year = parseInt(match[3], 10);
    const hours = parseInt(match[4] || '0', 10);
    const minutes = parseInt(match[5] || '0', 10);
    return new Date(year, month, day, hours, minutes);
  }

  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}`);
  }

  const parsed = new Date(normalized);
  return isNaN(parsed) ? null : parsed;
}

function formatDateKey(date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function formatMonthKey(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}

function formatMonthLabel(monthKey) {
  if (!monthKey) return 'Todos os meses';
  const [month, year] = String(monthKey).split('/').map(Number);
  if (!month || !year) return monthKey;
  const label = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric'
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatMetricValue(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
}

function sortMonthKeys(monthA, monthB) {
  const [aMonth, aYear] = String(monthA).split('/').map(Number);
  const [bMonth, bYear] = String(monthB).split('/').map(Number);
  return (aYear - bYear) || (aMonth - bMonth);
}

function parseMetricNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(/\./g, '').replace(',', '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function getFirstField(item, fields) {
  return fields.reduce((acc, key) => acc || getField(item, key), '') || '';
}

function getItemQuantity(item, quantityKeys = []) {
  const parsed = parseMetricNumber(getFirstField(item, quantityKeys));
  return parsed > 0 ? parsed : 1;
}

function matchesTextTokens(value, tokens = []) {
  const normalizedValue = normalizeText(String(value || ''));
  return tokens.some(token => normalizedValue.includes(normalizeText(token)));
}

function matchesAnyField(item, fieldKeys = [], tokens = []) {
  const combinedValue = fieldKeys.map(key => getField(item, key)).filter(Boolean).join(' ');
  return matchesTextTokens(combinedValue, tokens);
}

const ONGOING_EPO_ALIAS_MAP = {
  'acesso': 'ACESSO',
  'antec': 'ANTEC',
  'arcad': 'ARCAD',
  'basic': 'BASIC',
  'cantoia': 'CANTOIA',
  'csc': 'CSC',
  'danlex': 'DANLEX',
  'eletronet': 'ELETRONET',
  'psnet': 'PSNET',
  'script call': 'SCRIPT_CALL',
  'scriptcall': 'SCRIPT_CALL',
  'visium': 'VISIUM',
  'a definir': 'A DEFINIR',
  'adefinir': 'A DEFINIR'
};

const PROJETO_F_EPO_ALIAS_MAP = {
  'acesso': 'ACESSO',
  'antec': 'ANTEC',
  'arcad': 'ARCAD',
  'basic': 'BASIC',
  'cantoia': 'CANTOIA',
  'celula migracao': 'CÉLULA MIGRAÇÃO',
  'comercial': 'COMERCIAL',
  'conectus': 'CONECTUS',
  'danlex': 'DANLEX',
  'procisa': 'PROCISA',
  'psnet': 'PSNET',
  'script call': 'SCRIPTCALL',
  'scriptcall': 'SCRIPTCALL',
  'time construcao': 'TIME CONSTRUÇÃO',
  'time instalacao': 'TIME INSTALAÇÃO',
  'time manut mdu': 'TIME MANUT. MDU',
  'visium': 'VISIUM'
};

function sanitizeEpoName(value, epoMode = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (/^\d+$/.test(raw) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) {
    return '';
  }

  const normalized = normalizeText(raw)
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || !/[a-z]/.test(normalized)) {
    return '';
  }

  if (epoMode === 'ongoing') {
    return ONGOING_EPO_ALIAS_MAP[normalized] || raw.toUpperCase();
  }

  if (epoMode === 'projeto-f') {
    return PROJETO_F_EPO_ALIAS_MAP[normalized] || raw.toUpperCase();
  }

  return raw;
}

function getNormalizedEpo(item, epoKeys = ['EPO', 'epo', 'Cluster', 'cluster', 'Regional', 'regional', 'EPO / Cluster', 'PARCEIRA', 'parceira'], epoMode = '') {
  const rawValue = getFirstField(item, epoKeys);
  const sanitized = sanitizeEpoName(rawValue, epoMode);

  if (sanitized) {
    return sanitized;
  }

  if (epoMode) {
    return '';
  }

  return (rawValue || 'Sem EPO').toString().trim() || 'Sem EPO';
}

function agruparRegistrosPorData(dados, options = {}) {
  const {
    statusKeys = [],
    statusValues = [],
    dateKeys = [],
    quantityKeys = [],
    epoKeys = ['EPO', 'epo'],
    epoMode = '',
    selectedYear = '',
    selectedMonth = '',
    selectedEpo = ''
  } = options;

  const cacheKey = buildAnalyticsCacheKey('agruparRegistrosPorData', dados, {
    statusKeys,
    statusValues,
    dateKeys,
    quantityKeys,
    epoKeys,
    epoMode,
    selectedYear,
    selectedMonth,
    selectedEpo
  });
  const cached = visaoGerenciaAggCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const daily = {};
  const monthly = {};
  const normalizedSelectedEpo = normalizeText(selectedEpo || '');

  (dados || []).forEach(item => {
    const epo = getNormalizedEpo(item, epoKeys, epoMode);
    if (!epo) {
      return;
    }

    if (normalizedSelectedEpo && normalizeText(epo) !== normalizedSelectedEpo) {
      return;
    }

    const statusText = statusKeys.map(key => getField(item, key)).filter(Boolean).join(' ');
    if (!statusText || !matchesTextTokens(statusText, statusValues)) {
      return;
    }

    const rawDate = getFirstField(item, dateKeys);
    const date = parseDateString(rawDate);
    if (!date) {
      return;
    }

    const monthKey = formatMonthKey(date);
    const yearKey = String(date.getFullYear());
    if (selectedYear && yearKey !== String(selectedYear)) {
      return;
    }

    const dayKey = formatDateKey(date);
    const quantity = getItemQuantity(item, quantityKeys);

    monthly[monthKey] = (monthly[monthKey] || 0) + quantity;

    if (!selectedMonth || monthKey === selectedMonth) {
      daily[dayKey] = (daily[dayKey] || 0) + quantity;
    }
  });

  const result = {
    daily: Object.entries(daily).sort((a, b) => parseDateString(a[0]) - parseDateString(b[0])),
    monthly: Object.entries(monthly).sort((a, b) => sortMonthKeys(a[0], b[0]))
  };

  visaoGerenciaAggCache.set(cacheKey, result);
  return result;
}

function getMonthOptions(backlogRows = [], projetoFRows = []) {
  return [...new Set([
    ...backlogRows.map(([periodo]) => periodo),
    ...projetoFRows.map(([periodo]) => periodo)
  ])].sort(sortMonthKeys);
}

function getYearOptions(backlogRows = [], projetoFRows = []) {
  return [...new Set([
    ...backlogRows.map(([periodo]) => String(periodo).split('/')[1]),
    ...projetoFRows.map(([periodo]) => String(periodo).split('/')[1])
  ].filter(Boolean))].sort((a, b) => Number(a) - Number(b));
}

function getMonthOptionsByYear(backlogRows = [], projetoFRows = [], selectedYear = '') {
  return [...new Set([
    ...backlogRows,
    ...projetoFRows
  ]
    .filter(([periodo]) => {
      const [, year] = String(periodo).split('/');
      return !selectedYear || year === String(selectedYear);
    })
    .map(([periodo]) => String(periodo).split('/')[0])
    .filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
}

function formatMonthOnlyLabel(monthValue) {
  if (!monthValue) return 'Todos os meses';
  const monthNumber = Number(monthValue);
  if (!monthNumber) return monthValue;

  const label = new Date(2000, monthNumber - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long'
  });

  return label.charAt(0).toUpperCase() + label.slice(1);
}

function filterMonthlyRowsByYear(rows = [], selectedYear = '') {
  return (rows || [])
    .filter(([periodo]) => {
      const [, year] = String(periodo).split('/');
      return !selectedYear || year === String(selectedYear);
    })
    .map(([periodo, total]) => {
      const [month] = String(periodo).split('/');
      return [selectedYear ? formatMonthOnlyLabel(month) : formatMonthLabel(periodo), total];
    });
}

function getEpoOptions(dataset = [], epoKeys = ['EPO', 'epo'], epoMode = '') {
  const cacheKey = [
    'getEpoOptions',
    getDatasetVersionToken(dataset),
    epoKeys.join('|'),
    epoMode
  ].join('::');
  const cached = visaoGerenciaAggCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const result = [...new Set((dataset || [])
    .map(item => getNormalizedEpo(item, epoKeys, epoMode))
    .filter(epo => epo && normalizeText(epo) !== 'sem epo'))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  visaoGerenciaAggCache.set(cacheKey, result);
  return result;
}

function isStatusFinalizado(value) {
  const normalized = normalizeText(String(value || ''));
  if (!normalized) return false;

  return ['finaliz', 'conclu', 'encerrad', 'liberad', 'ok']
    .some(token => normalized.includes(token));
}

function hasOngoingVistoria(item) {
  const statusVistoria = getFirstField(item, [
    'STATUS_VISTORIA', 'status_vistoria'
  ]);

  if (isStatusFinalizado(statusVistoria)) {
    return true;
  }

  return matchesAnyField(item, [
    'STATUS_GERAL', 'status_geral', 'status',
    'MOTIVO_GERAL', 'motivo_geral', 'motivo',
    'STATUS_VISTORIA', 'status_vistoria'
  ], ['vistoria']);
}

function hasOngoingConstrucao(item) {
  const statusCri = getFirstField(item, [
    'STATUS_CRI', 'status_cri'
  ]);

  if (isStatusFinalizado(statusCri)) {
    return true;
  }

  return matchesAnyField(item, [
    'STATUS_GERAL', 'status_geral', 'status',
    'MOTIVO_GERAL', 'motivo_geral', 'motivo',
    'STATUS_CRI', 'status_cri',
    'STATUS_LIBERACAO', 'STATUS_LIBERAÇÃO', 'status_liberacao'
  ], ['construcao', 'construção', 'liberacao', 'liberação']);
}

function hasBacklogVistoria(item) {
  return hasOngoingVistoria(item);
}

function hasBacklogConstrucao(item) {
  return hasOngoingConstrucao(item);
}

function buildOngoingAnalyticsData(dados, options = {}) {
  const {
    selectedYear = '',
    selectedMonth = '',
    selectedEpo = '',
    epoKeys = ['EPO', 'epo']
  } = options;

  const sharedOptions = {
    quantityKeys: ['QTD_BLOCOS', 'QTDE_BLOCOS', 'QTDE BLOCOS', 'QTD BLOCOS', 'qtd_blocos', 'qtd blocos', 'Qtde Blocos'],
    epoKeys,
    epoMode: 'ongoing',
    selectedYear,
    selectedMonth,
    selectedEpo
  };

  const backlogConcluido = agruparRegistrosPorData(dados, {
    ...sharedOptions,
    statusKeys: [
      'STATUS_GERAL', 'status_geral', 'STATUS', 'status',
      'MOTIVO_GERAL', 'motivo_geral', 'MOTIVO', 'motivo'
    ],
    statusValues: ['CONCLUIDO', 'CONCLUÍDO'],
    dateKeys: [
      'DATA CONCLUÍDO', 'DATA CONCLUIDO', 'data_concluido', 'data concluido',
      'DATA_CONCLUSAO', 'data_conclusao'
    ]
  });

  if ((backlogConcluido.daily || []).length || (backlogConcluido.monthly || []).length) {
    return backlogConcluido;
  }

  const ongoingEmAndamento = agruparRegistrosPorData(dados, {
    ...sharedOptions,
    statusKeys: [
      'STATUS_GERAL', 'STATUS', 'status_geral', 'status',
      'MOTIVO_GERAL', 'motivo_geral', 'MOTIVO', 'motivo',
      'STATUS_VISTORIA', 'status_vistoria',
      'STATUS_PROJETO', 'status_projeto',
      'STATUS_SAR', 'status_sar',
      'STATUS_CRI', 'status_cri',
      'STATUS_LIBERACAO', 'STATUS_LIBERAÇÃO', 'status_liberacao'
    ],
    statusValues: ['VISTORIA', 'PROJETO', 'CONSTRUCAO', 'CONSTRUÇÃO', 'LIBERACAO', 'LIBERAÇÃO', 'EXPANSAO', 'EXPANSÃO', 'EM_LIBERACAO', 'EM_LIBERAÇÃO'],
    dateKeys: [
      'DT_SOLICITACAO', 'dt_solicitacao',
      'DT_INICIO_VISTORIA', 'dt_inicio_vistoria',
      'DT_FIM_VISTORIA', 'dt_fim_vistoria',
      'DT_INICIO_PROJETO', 'dt_inicio_projeto',
      'DT_FIM_PROJETO', 'dt_fim_projeto',
      'DT_INICIO_PROJETO_SAR', 'dt_inicio_projeto_sar',
      'DT_FIM_PROJETO_SAR', 'dt_fim_projeto_sar',
      'DT_INICIO_SAR', 'dt_inicio_sar',
      'DT_FIM_SAR', 'dt_fim_sar',
      'DT_INICIO_CRI', 'dt_inicio_cri',
      'DT_FIM_CRI', 'dt_fim_cri',
      'DT_INICIO_LIBERACAO', 'DT_INICIO_LIBERAÇÃO', 'dt_inicio_liberacao',
      'DT_FIM_LIBERACAO', 'DT_FIM_LIBERAÇÃO', 'dt_fim_liberacao',
      'DATA', 'data'
    ]
  });

  if ((ongoingEmAndamento.daily || []).length || (ongoingEmAndamento.monthly || []).length) {
    return ongoingEmAndamento;
  }

  return agruparRegistrosPorData(dados, {
    ...sharedOptions,
    statusKeys: [
      'STATUS_GERAL', 'STATUS', 'status_geral', 'status',
      'MOTIVO_GERAL', 'motivo_geral', 'motivo'
    ],
    statusValues: ['CONCLUID', 'FINALIZ', 'OK', 'LIBERAD'],
    dateKeys: [
      'DATA CONCLUÍDO', 'DATA CONCLUIDO',
      'DT_CONCLUSAO', 'dt_conclusao',
      'DATA_CONCLUSAO', 'data_conclusao',
      'DATA', 'data'
    ]
  });
}

function hasProjetoFVistoria(item) {
  return matchesAnyField(item, ['STATUS MDU', 'STATUS_MDU', 'status_mdu'], ['vistoria']);
}

function hasProjetoFConstrucao(item) {
  const rawDate = getFirstField(item, ['DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'dt_construcao']);
  if (rawDate && parseDateString(rawDate)) {
    return true;
  }

  return matchesAnyField(item, [
    'STATUS LIBERAÇÃO', 'STATUS_LIBERACAO', 'status_liberacao',
    'STATUS MDU', 'STATUS_MDU', 'status_mdu',
    'Liberação concluida?', 'Liberacao Concluida?',
    'LIBERACAO_CONCLUIDA', 'liberacao_concluida'
  ], ['ok', 'conclu', 'libera', 'sim']);
}

function buildEpoMetrics(dados, options = {}) {
  const {
    quantityKeys = [],
    epoKeys = ['EPO', 'epo'],
    epoMode = '',
    dateKeys = [],
    selectedYear = '',
    selectedMonth = '',
    selectedEpo = '',
    isVistoriaFn = () => false,
    isConstrucaoFn = () => false
  } = options;

  const cacheKey = buildAnalyticsCacheKey('buildEpoMetrics', dados, {
    quantityKeys,
    epoKeys,
    epoMode,
    dateKeys,
    selectedYear,
    selectedMonth,
    selectedEpo,
    isVistoriaFn: isVistoriaFn.name || 'anonymous',
    isConstrucaoFn: isConstrucaoFn.name || 'anonymous'
  });
  const cached = visaoGerenciaAggCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const rowsByEpo = {};
  const normalizedSelectedEpo = normalizeText(selectedEpo || '');

  (dados || []).forEach(item => {
    const epo = getNormalizedEpo(item, epoKeys, epoMode);
    if (!epo) {
      return;
    }

    if (normalizedSelectedEpo && normalizeText(epo) !== normalizedSelectedEpo) {
      return;
    }

    if (selectedYear || selectedMonth) {
      const rawDate = getFirstField(item, dateKeys);
      const date = parseDateString(rawDate);
      if (!date) {
        return;
      }

      const itemYear = String(date.getFullYear());
      const itemMonth = formatMonthKey(date);

      if (selectedYear && itemYear !== String(selectedYear)) {
        return;
      }

      if (selectedMonth && itemMonth !== selectedMonth) {
        return;
      }
    }

    const quantity = getItemQuantity(item, quantityKeys);
    if (!rowsByEpo[epo]) {
      rowsByEpo[epo] = { epo, vistorias: 0, construcoes: 0 };
    }

    if (isVistoriaFn(item)) {
      rowsByEpo[epo].vistorias += quantity;
    }

    if (isConstrucaoFn(item)) {
      rowsByEpo[epo].construcoes += quantity;
    }
  });

  const result = Object.values(rowsByEpo)
    .sort((a, b) => (b.vistorias + b.construcoes) - (a.vistorias + a.construcoes)
      || a.epo.localeCompare(b.epo, 'pt-BR', { sensitivity: 'base' }));

  visaoGerenciaAggCache.set(cacheKey, result);
  return result;
}

function summarizeEpoMetrics(rows = []) {
  return rows.reduce((acc, item) => {
    acc.vistorias += item.vistorias || 0;
    acc.construcoes += item.construcoes || 0;
    return acc;
  }, { vistorias: 0, construcoes: 0 });
}

function getSummaryIcon(title = '') {
  const normalized = normalizeText(title);

  if (normalized.includes('vistoria')) return '🛠️';
  if (normalized.includes('constr')) return '🏗️';
  if (normalized.includes('projeto f')) return '📡';
  if (normalized.includes('ongoing')) return '⏳';
  if (normalized.includes('dia a dia')) return '📅';
  return '📊';
}

function createSummaryCard(title, value, note = '') {
  return `
    <div class="summary-card">
      <div class="summary-card-top">
        <span class="summary-icon">${getSummaryIcon(title)}</span>
        <span class="summary-pill">Indicador</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p>${formatMetricValue(value)}</p>
      <span class="summary-note">${escapeHtml(note)}</span>
    </div>
  `;
}

function createAnalyticsTable(title, rows, valueHeader = 'Blocos') {
  const bodyRows = rows && rows.length
    ? rows.map(([periodo, total]) => `<tr><td>${escapeHtml(periodo)}</td><td>${formatMetricValue(total)}</td></tr>`).join('')
    : `<tr><td colspan="2" style="text-align:center; opacity:.7;">Nenhum registro</td></tr>`;

  return `
    <div class="analytics-card">
      <h3>${escapeHtml(title)}</h3>
      <table class="analytics-table">
        <thead>
          <tr><th>Período</th><th>${escapeHtml(valueHeader)}</th></tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
  `;
}

function getGerenciaStatusLabel(statusMode = 'todos') {
  const labels = {
    todos: 'Vistorias e construções',
    vistoria: 'Vistorias',
    construcao: 'Construções'
  };

  return labels[statusMode] || labels.todos;
}

function filterEpoRowsByStatus(rows = [], statusMode = 'todos') {
  const lista = Array.isArray(rows) ? rows : [];

  if (statusMode === 'vistoria') {
    return lista.filter(item => Number(item.vistorias || 0) > 0);
  }

  if (statusMode === 'construcao') {
    return lista.filter(item => Number(item.construcoes || 0) > 0);
  }

  return lista.filter(item => Number(item.vistorias || 0) > 0 || Number(item.construcoes || 0) > 0);
}

function createEpoAnalyticsTable(title, rows, statusMode = 'todos') {
  const filteredRows = filterEpoRowsByStatus(rows, statusMode);
  const showVistorias = statusMode !== 'construcao';
  const showConstrucoes = statusMode !== 'vistoria';
  const colspan = 1 + (showVistorias ? 1 : 0) + (showConstrucoes ? 1 : 0);

  const bodyRows = filteredRows.length
    ? filteredRows.map(item => `
        <tr>
          <td>${escapeHtml(item.epo)}</td>
          ${showVistorias ? `<td>${formatMetricValue(item.vistorias)}</td>` : ''}
          ${showConstrucoes ? `<td>${formatMetricValue(item.construcoes)}</td>` : ''}
        </tr>
      `).join('')
    : `<tr><td colspan="${colspan}" style="text-align:center; opacity:.7;">Nenhum registro para o filtro selecionado</td></tr>`;

  return `
    <div class="analytics-card">
      <h3>${escapeHtml(title)}</h3>
      <table class="analytics-table">
        <thead>
          <tr>
            <th>EPO</th>
            ${showVistorias ? '<th>Vistorias</th>' : ''}
            ${showConstrucoes ? '<th>Construções</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
  `;
}

function handleGerenciaFiltersChange() {
  window.gerenciaFiltroAnoSelecionado = document.getElementById('gerencia-year-filter')?.value || '';
  window.gerenciaFiltroMesSelecionado = document.getElementById('gerencia-month-filter')?.value || '';
  window.gerenciaFiltroOngoingEpoSelecionada = document.getElementById('gerencia-ongoing-epo-filter')?.value || '';
  window.gerenciaFiltroProjetoFEpoSelecionada = document.getElementById('gerencia-projetof-epo-filter')?.value || '';
  window.gerenciaFiltroStatusSelecionado = document.getElementById('gerencia-status-filter')?.value || 'todos';
  agendarRenderVisaoGerencia(true);
}

function renderVisaoGerencia() {
  const container = document.getElementById('pesquisa');
  if (!container) return;

  let analyticsContainer = document.getElementById('visao-gerencia-analytics');
  if (!analyticsContainer) {
    analyticsContainer = document.createElement('div');
    analyticsContainer.id = 'visao-gerencia-analytics';
    analyticsContainer.className = 'visao-gerencia-analytics';
    container.insertBefore(analyticsContainer, container.querySelector('.search-section') || null);
  }

  const mduOngoing = getPreferredDataset('mdu-ongoing');
  const ongoingLegacy = getPreferredDataset('ongoing');
  const projetoF = getPreferredDataset('projeto-f');
  const ongoing = (Array.isArray(mduOngoing) && mduOngoing.length)
    ? mduOngoing
    : (Array.isArray(ongoingLegacy) ? ongoingLegacy : []);
  const ongoingQuantityKeys = ['QTD_BLOCOS', 'QTDE_BLOCOS', 'QTDE BLOCOS', 'QTD BLOCOS', 'qtd_blocos', 'qtd blocos', 'Qtde Blocos'];
  const projetoFQuantityKeys = ['Qtde Blocos', 'QTDE_BLOCOS', 'QTDE BLOCOS', 'QTD_BLOCOS', 'QTD BLOCOS', 'qtd_blocos'];

  if ((!Array.isArray(ongoing) || !ongoing.length) && window.location.protocol.startsWith('http')) {
    analyticsContainer.innerHTML = `
      <div class="analytics-card" style="padding:16px; text-align:center; opacity:.85;">
        Carregando indicadores de ONGOING...
      </div>
    `;
    carregarDaBacklog('mdu-ongoing');
    return;
  }

  const ongoingEpoKeys = ['EPO', 'epo', 'EPO / Cluster', 'epo / cluster', 'EPO_CLUSTER', 'Cluster', 'cluster'];
  const projetoFEpoKeys = ['PARCEIRA', 'parceira'];

  const ongoingEpoOptions = getEpoOptions(ongoing, ongoingEpoKeys, 'ongoing');
  const projetoFEpoOptions = getEpoOptions(projetoF, projetoFEpoKeys, 'projeto-f');

  const currentOngoingEpoValue = document.getElementById('gerencia-ongoing-epo-filter')?.value || window.gerenciaFiltroOngoingEpoSelecionada || '';
  const selectedOngoingEpo = ongoingEpoOptions.includes(currentOngoingEpoValue) ? currentOngoingEpoValue : '';

  const currentProjetoFEpoValue = document.getElementById('gerencia-projetof-epo-filter')?.value || window.gerenciaFiltroProjetoFEpoSelecionada || '';
  const selectedProjetoFEpo = projetoFEpoOptions.includes(currentProjetoFEpoValue) ? currentProjetoFEpoValue : '';

  const currentStatusValue = document.getElementById('gerencia-status-filter')?.value || window.gerenciaFiltroStatusSelecionado || 'todos';
  const selectedStatus = ['todos', 'vistoria', 'construcao'].includes(currentStatusValue) ? currentStatusValue : 'todos';

  const ongoingBaseData = buildOngoingAnalyticsData(ongoing, {
    epoKeys: ongoingEpoKeys,
    selectedEpo: selectedOngoingEpo
  });

  const projetoFBaseData = agruparRegistrosPorData(projetoF, {
    statusKeys: ['STATUS LIBERAÇÃO', 'STATUS_LIBERACAO', 'STATUS MDU', 'STATUS_MDU', 'STATUS', 'status', 'Liberação concluida?', 'Liberacao Concluida?'],
    statusValues: ['OK', 'CONCLUID', 'LIBER'],
    dateKeys: ['DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'DATA', 'DATA_CONCLUSAO', 'dthinicio', 'DTINICIO'],
    quantityKeys: ['Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos'],
    epoKeys: projetoFEpoKeys,
    epoMode: 'projeto-f',
    selectedEpo: selectedProjetoFEpo
  });

  const availableYears = getYearOptions(ongoingBaseData.monthly, projetoFBaseData.monthly);
  const currentYearValue = document.getElementById('gerencia-year-filter')?.value || window.gerenciaFiltroAnoSelecionado || '';
  const selectedYear = availableYears.includes(currentYearValue)
    ? currentYearValue
    : '';

  const availableMonthValues = getMonthOptionsByYear(ongoingBaseData.monthly, projetoFBaseData.monthly, selectedYear);
  const currentMonthValue = document.getElementById('gerencia-month-filter')?.value || window.gerenciaFiltroMesSelecionado || '';
  const selectedMonthValue = availableMonthValues.includes(currentMonthValue)
    ? currentMonthValue
    : '';
  const selectedMonth = selectedYear && selectedMonthValue ? `${selectedMonthValue}/${selectedYear}` : '';

  window.gerenciaFiltroAnoSelecionado = selectedYear;
  window.gerenciaFiltroMesSelecionado = selectedMonthValue;
  window.gerenciaFiltroOngoingEpoSelecionada = selectedOngoingEpo;
  window.gerenciaFiltroProjetoFEpoSelecionada = selectedProjetoFEpo;
  window.gerenciaFiltroStatusSelecionado = selectedStatus;

  const ongoingData = buildOngoingAnalyticsData(ongoing, {
    epoKeys: ongoingEpoKeys,
    selectedYear,
    selectedMonth,
    selectedEpo: selectedOngoingEpo
  });

  const projetoFData = agruparRegistrosPorData(projetoF, {
    statusKeys: ['STATUS LIBERAÇÃO', 'STATUS_LIBERACAO', 'STATUS MDU', 'STATUS_MDU', 'STATUS', 'status', 'Liberação concluida?', 'Liberacao Concluida?'],
    statusValues: ['OK', 'CONCLUID', 'LIBER'],
    dateKeys: ['DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'DATA', 'DATA_CONCLUSAO', 'dthinicio', 'DTINICIO'],
    quantityKeys: ['Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos'],
    epoKeys: projetoFEpoKeys,
    epoMode: 'projeto-f',
    selectedYear,
    selectedMonth,
    selectedEpo: selectedProjetoFEpo
  });

  const ongoingMonthlyRaw = (ongoingData.monthly || []).filter(([periodo]) => !selectedYear || String(periodo).endsWith(`/${selectedYear}`));
  const projetoFMonthlyRaw = (projetoFData.monthly || []).filter(([periodo]) => !selectedYear || String(periodo).endsWith(`/${selectedYear}`));
  const ongoingMonthlyRows = filterMonthlyRowsByYear(ongoingData.monthly, selectedYear);
  const projetoFMonthlyRows = filterMonthlyRowsByYear(projetoFData.monthly, selectedYear);

  const ongoingMonthTotal = selectedMonth
    ? (ongoingData.monthly.find(([periodo]) => periodo === selectedMonth)?.[1] || 0)
    : ongoingMonthlyRaw.reduce((acc, [, total]) => acc + total, 0);
  const projetoFMonthTotal = selectedMonth
    ? (projetoFData.monthly.find(([periodo]) => periodo === selectedMonth)?.[1] || 0)
    : projetoFMonthlyRaw.reduce((acc, [, total]) => acc + total, 0);

  const ongoingLastDay = ongoingData.daily.length ? ongoingData.daily[ongoingData.daily.length - 1] : ['—', 0];
  const projetoFLastDay = projetoFData.daily.length ? projetoFData.daily[projetoFData.daily.length - 1] : ['—', 0];

  const ongoingTotalBlocos = (ongoing || []).reduce((acc, item) => acc + getItemQuantity(item, ongoingQuantityKeys), 0);
  const projetoFTotalBlocos = (projetoF || []).reduce((acc, item) => acc + getItemQuantity(item, projetoFQuantityKeys), 0);

  const ongoingEpoRows = buildEpoMetrics(ongoing, {
    quantityKeys: ongoingQuantityKeys,
    dateKeys: [
      'DATA CONCLUÍDO', 'DATA CONCLUIDO', 'DT_CONCLUSAO', 'dt_conclusao', 'DATA_CONCLUSAO', 'data_conclusao',
      'dthinicio', 'DTINICIO', 'DT_INICIO', 'DATA', 'data',
      'DT_SOLICITACAO', 'dt_solicitacao',
      'DT_INICIO_VISTORIA', 'dt_inicio_vistoria',
      'DT_FIM_VISTORIA', 'dt_fim_vistoria',
      'DT_INICIO_PROJETO', 'dt_inicio_projeto',
      'DT_FIM_PROJETO', 'dt_fim_projeto',
      'DT_INICIO_PROJETO_SAR', 'dt_inicio_projeto_sar',
      'DT_FIM_PROJETO_SAR', 'dt_fim_projeto_sar',
      'DT_INICIO_SAR', 'dt_inicio_sar',
      'DT_FIM_SAR', 'dt_fim_sar',
      'DT_INICIO_CRI', 'dt_inicio_cri',
      'DT_FIM_CRI', 'dt_fim_cri',
      'DT_INICIO_LIBERACAO', 'DT_INICIO_LIBERAÇÃO', 'dt_inicio_liberacao',
      'DT_FIM_LIBERACAO', 'DT_FIM_LIBERAÇÃO', 'dt_fim_liberacao'
    ],
    epoKeys: ongoingEpoKeys,
    epoMode: 'ongoing',
    selectedYear,
    selectedMonth,
    selectedEpo: selectedOngoingEpo,
    isVistoriaFn: hasBacklogVistoria,
    isConstrucaoFn: hasBacklogConstrucao
  });

  const projetoFEpoRows = buildEpoMetrics(projetoF, {
    quantityKeys: projetoFQuantityKeys,
    dateKeys: ['DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'DATA', 'DATA_CONCLUSAO', 'dthinicio', 'DTINICIO'],
    epoKeys: projetoFEpoKeys,
    epoMode: 'projeto-f',
    selectedYear,
    selectedMonth,
    selectedEpo: selectedProjetoFEpo,
    isVistoriaFn: hasProjetoFVistoria,
    isConstrucaoFn: hasProjetoFConstrucao
  });

  const ongoingEpoSummary = summarizeEpoMetrics(ongoingEpoRows);
  const projetoFEpoSummary = summarizeEpoMetrics(projetoFEpoRows);

  const yearOptionsHtml = `
    <option value="" ${!selectedYear ? 'selected' : ''}>Todos os anos</option>
    ${availableYears.map(year => `
      <option value="${escapeHtml(year)}" ${year === selectedYear ? 'selected' : ''}>${escapeHtml(year)}</option>
    `).join('')}
  `;

  const monthOptionsHtml = `
    <option value="">Todos os meses</option>
    ${availableMonthValues.map(month => `<option value="${escapeHtml(month)}" ${month === selectedMonthValue ? 'selected' : ''}>${escapeHtml(formatMonthOnlyLabel(month))}</option>`).join('')}
  `;

  const ongoingEpoOptionsHtml = `
    <option value="">Todas as EPOs do ONGOING</option>
    ${ongoingEpoOptions.map(epo => `<option value="${escapeHtml(epo)}" ${epo === selectedOngoingEpo ? 'selected' : ''}>${escapeHtml(epo)}</option>`).join('')}
  `;

  const projetoFEpoOptionsHtml = `
    <option value="">Todas as EPOs do Projeto F</option>
    ${projetoFEpoOptions.map(epo => `<option value="${escapeHtml(epo)}" ${epo === selectedProjetoFEpo ? 'selected' : ''}>${escapeHtml(epo)}</option>`).join('')}
  `;

  const statusOptionsHtml = `
    <option value="todos" ${selectedStatus === 'todos' ? 'selected' : ''}>Todos os status</option>
    <option value="vistoria" ${selectedStatus === 'vistoria' ? 'selected' : ''}>Somente vistorias</option>
    <option value="construcao" ${selectedStatus === 'construcao' ? 'selected' : ''}>Somente construções</option>
  `;

  const periodLabel = selectedMonth
    ? formatMonthLabel(selectedMonth)
    : (selectedYear ? `Ano ${selectedYear}` : 'Todos os períodos');
  const periodLabelUpper = String(periodLabel || '').toUpperCase();
  const yearLabelUpper = String(selectedYear || 'PERÍODO').toUpperCase();
  const ongoingEpoLabel = selectedOngoingEpo || 'Todas as EPOs';
  const projetoFEpoLabel = selectedProjetoFEpo || 'Todas as EPOs';
  const statusLabel = getGerenciaStatusLabel(selectedStatus);

  const statusCardsHtml = selectedStatus === 'vistoria'
    ? `
      ${createSummaryCard(`ONGOING Vistorias • ${ongoingEpoLabel}`, ongoingEpoSummary.vistorias, 'Blocos com vistoria no filtro')}
      ${createSummaryCard(`Projeto F Vistorias • ${projetoFEpoLabel}`, projetoFEpoSummary.vistorias, 'Blocos em vistoria no filtro')}
    `
    : selectedStatus === 'construcao'
      ? `
        ${createSummaryCard(`ONGOING Construções • ${ongoingEpoLabel}`, ongoingEpoSummary.construcoes, 'Blocos com construção no filtro')}
        ${createSummaryCard(`Projeto F Construções • ${projetoFEpoLabel}`, projetoFEpoSummary.construcoes, 'Blocos de construção no filtro')}
      `
      : `
        ${createSummaryCard(`ONGOING Vistorias • ${ongoingEpoLabel}`, ongoingEpoSummary.vistorias, 'Blocos com vistoria por EPO')}
        ${createSummaryCard(`ONGOING Construções • ${ongoingEpoLabel}`, ongoingEpoSummary.construcoes, 'Blocos com construção por EPO')}
        ${createSummaryCard(`Projeto F Vistorias • ${projetoFEpoLabel}`, projetoFEpoSummary.vistorias, 'Blocos em vistoria por EPO')}
        ${createSummaryCard(`Projeto F Construções • ${projetoFEpoLabel}`, projetoFEpoSummary.construcoes, 'Blocos de construção por EPO')}
      `;

  analyticsContainer.innerHTML = `
    <div class="visao-gerencia-toolbar">
      <div class="filtro-item">
        <label for="gerencia-year-filter">Filtrar ano</label>
        <select id="gerencia-year-filter" onchange="handleGerenciaFiltersChange()">
          ${yearOptionsHtml}
        </select>
      </div>
      <div class="filtro-item">
        <label for="gerencia-month-filter">Filtrar mês</label>
        <select id="gerencia-month-filter" onchange="handleGerenciaFiltersChange()">
          ${monthOptionsHtml}
        </select>
      </div>
      <div class="filtro-item">
        <label for="gerencia-ongoing-epo-filter">EPO ONGOING</label>
        <select id="gerencia-ongoing-epo-filter" onchange="handleGerenciaFiltersChange()">
          ${ongoingEpoOptionsHtml}
        </select>
      </div>
      <div class="filtro-item">
        <label for="gerencia-projetof-epo-filter">EPO Projeto F</label>
        <select id="gerencia-projetof-epo-filter" onchange="handleGerenciaFiltersChange()">
          ${projetoFEpoOptionsHtml}
        </select>
      </div>
      <div class="filtro-item">
        <label for="gerencia-status-filter">Filtrar status</label>
        <select id="gerencia-status-filter" onchange="handleGerenciaFiltersChange()">
          ${statusOptionsHtml}
        </select>
      </div>
    </div>

    <div class="visao-gerencia-summary">
      ${createSummaryCard('ONGOING • TOTAL DE BLOCOS', ongoingTotalBlocos, 'Blocos totais carregados no MDU Ongoing')}
      ${createSummaryCard(`ONGOING • ${periodLabelUpper}`, ongoingMonthTotal, 'Blocos do MDU Ongoing no período filtrado')}
      ${createSummaryCard('ONGOING • DIA A DIA', ongoingLastDay[1], `Última data: ${ongoingLastDay[0]}`)}
      ${createSummaryCard(`PROJETO F • ${periodLabelUpper}`, projetoFMonthTotal, 'Blocos OK no período filtrado')}
      ${createSummaryCard('PROJETO F • TOTAL DE BLOCOS', projetoFTotalBlocos, 'Blocos totais carregados no Projeto F')}
      ${createSummaryCard('PROJETO F • DIA A DIA', projetoFLastDay[1], `Última data: ${projetoFLastDay[0]}`)}
    </div>

    <div class="analytics-grid">
      <div class="analytics-group">
        <h2>ONGOING - MDU ONGOING</h2>
        ${createAnalyticsTable(`DIA A DIA • ${periodLabelUpper}`, ongoingData.daily)}
        ${createAnalyticsTable(`MOVIMENTAÇÃO POR MÊS • ${yearLabelUpper}`, ongoingMonthlyRows, 'Blocos')}
      </div>
      <div class="analytics-group">
        <h2>PROJETO F - BLOCOS OK</h2>
        ${createAnalyticsTable(`DIA A DIA • ${periodLabelUpper}`, projetoFData.daily)}
        ${createAnalyticsTable(`OK POR MÊS • ${yearLabelUpper}`, projetoFMonthlyRows, 'Blocos')}
      </div>
    </div>

    <div class="visao-gerencia-summary">
      ${statusCardsHtml}
    </div>

    <div class="analytics-grid">
      <div class="analytics-group">
        <h2>EPO - ONGOING</h2>
        ${createEpoAnalyticsTable(`${String(statusLabel).toUpperCase()} POR EPO`, ongoingEpoRows, selectedStatus)}
      </div>
      <div class="analytics-group">
        <h2>EPO - PROJETO F</h2>
        ${createEpoAnalyticsTable(`${String(statusLabel).toUpperCase()} POR EPO`, projetoFEpoRows, selectedStatus)}
      </div>
    </div>

    <div class="visao-gerencia-charts">
      <div class="chart-card">
        <h3>ONGOING DIÁRIO</h3>
        <canvas id="visao-backlog-daily-chart"></canvas>
      </div>
      <div class="chart-card">
        <h3>PROJETO F DIÁRIO</h3>
        <canvas id="visao-projetof-daily-chart"></canvas>
      </div>
    </div>
  `;

  if (typeof Chart !== 'undefined') {
    if (window.chartVisaoBacklogDaily) window.chartVisaoBacklogDaily.destroy();
    if (window.chartVisaoProjetoFDaily) window.chartVisaoProjetoFDaily.destroy();

    const backlogDailyLabels = ongoingData.daily.map(item => item[0]);
    const backlogDailyValues = ongoingData.daily.map(item => item[1]);
    const projetoFDailyLabels = projetoFData.daily.map(item => item[0]);
    const projetoFDailyValues = projetoFData.daily.map(item => item[1]);

    const backlogCtx = document.getElementById('visao-backlog-daily-chart');
    const projetoFCtx = document.getElementById('visao-projetof-daily-chart');

    if (backlogCtx) {
      window.chartVisaoBacklogDaily = new Chart(backlogCtx, {
        type: 'line',
        data: {
          labels: backlogDailyLabels,
          datasets: [{
            label: 'Blocos ONGOING',
            data: backlogDailyValues,
            borderColor: '#1d4ed8',
            backgroundColor: 'rgba(37,99,235,0.18)',
            fill: true,
            tension: 0.35
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }

    if (projetoFCtx) {
      window.chartVisaoProjetoFDaily = new Chart(projetoFCtx, {
        type: 'line',
        data: {
          labels: projetoFDailyLabels,
          datasets: [{
            label: 'Blocos OK',
            data: projetoFDailyValues,
            borderColor: '#16a34a',
            backgroundColor: 'rgba(34,197,94,0.18)',
            fill: true,
            tension: 0.35
          }]
        },
        options: { responsive: true, maintainAspectRatio: false }
      });
    }
  }
}

function processarCSVOngoing(csv, delimiter = ";") {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  let cabecalhoRaw = linhas[0].trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(",") && !cabecalhoRaw.includes(";")) {
    delimiter = ",";
  }

  const cabecalho = cabecalhoRaw.split(delimiter).map(c => c.trim());
  const dados = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = linha.split(delimiter);
    const item = {};

    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      item[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        item[normalized] = valor;
      }
    });

    const idDemanda = getField(item, "ID DEMANDA", "iddemanda", "id_demanda", "idDemanda");
    const fila = getField(item, "FILA", "fila");
    const tipo = getField(item, "TIPO", "tipo");
    const endereco = getField(item, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada");
    const aging = getField(item, "AGING", "aging", "aging_total", "aging total");
    const slaFase = getField(item, "SLA FASE", "SLA_FASE", "sla_fase", "sla fase");
    const status = getField(item, "STATUS_GERAL", "status_geral", "status geral", "status");
    const motivo = getField(item, "MOTIVO_GERAL", "motivo_geral", "motivo geral", "motivo");
    const obs = getField(item, "OBS", "obs", "OBSERVACAO", "observacao");

    item["IDDEMANDA"] = idDemanda || "";
    item["FILA"] = fila || "";
    item["TIPO"] = tipo || "";
    item["ENDEREÇO"] = endereco || "";
    item["AGING"] = aging || "";
    item["SLA FASE"] = slaFase || "";
    item["STATUS_GERAL"] = status || "";
    item["MOTIVO_GERAL"] = motivo || "";
    item["OBS"] = obs || "";

    dados.push(item);
  }

  return dados;
}

// ===== RELATÓRIOS =====
let chartDDD = null;
let chartPizza = null;
let chartAge = null;

function atualizarRelatorios(dddFiltro = "todos") {
  if (dadosCSV.length === 0) {
    document.getElementById("totalRegistrosTop").textContent = "0";
    return;
  }

  // Filtrar dados por DDD se necessário
  let dadosFiltrados = dadosCSV;
  if (dddFiltro !== "todos") {
    dadosFiltrados = dadosCSV.filter(item => {
      const ddd = extrairDDD(getField(item, "CIDADE", "cidade"));
      return ddd.toString() === dddFiltro;
    });
  }

  // Atualizar total de registros no card do topo
  document.getElementById("totalRegistrosTop").textContent = dadosFiltrados.length;
  document.getElementById("totalEnderecos").textContent = dadosFiltrados.length;

  // Contar DDDs
  const dddCount = {};
  dadosFiltrados.forEach(item => {
    const ddd = extrairDDD(getField(item, "CIDADE", "cidade"));
    dddCount[ddd] = (dddCount[ddd] || 0) + 1;
  });

  // Criar array com todos DDDs de 12 a 19 + Outro
  const todosDDD = {};
  for (let i = 12; i <= 19; i++) {
    todosDDD[i.toString()] = dddCount[i.toString()] || 0;
  }
  todosDDD["Outro"] = dddCount["Outro"] || 0;

  // Ordenar por quantidade (decrescente)
  const dddOrdenado = Object.entries(todosDDD)
    .sort((a, b) => b[1] - a[1]);

  // Renderizar tabela de relatórios com dados filtrados
  renderTabelaRelatorios("tabela-relatorios", dadosFiltrados);

  // Criar gráficos com dados filtrados
  criarGraficoPizzaNovo(dadosFiltrados);
  criarGraficoAGENovo(dadosFiltrados);
  criarGraficoDDDNovo(dddOrdenado);
}

// Função para renderizar tabela de relatórios com dados filtrados
function renderTabelaRelatorios(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  
  tbody.innerHTML = "";

  if (!lista || !lista.length) {
    tbody.innerHTML = `<tr><td colspan="6">Nenhum registro</td></tr>`;
    return;
  }

  const rows = lista.map(i => {
    const codigo = getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo");
    const endereco = `${getField(i, "ENDEREÇO", "ENDERECO")} ${getField(i, "NUMERO", "NUM")} `.trim();
    const cidade = getField(i, "CIDADE", "cidade");
    const status = getField(i, "STATUS_GERAL", "STATUS", "status");
    const motivo = getField(i, "MOTIVO_GERAL", "MOTIVO", "motivo");
    const age = obterAge(i) || "—";

    return `
      <tr>
        <td>${codigo}</td>
        <td>${endereco}</td>
        <td>${cidade}</td>
        <td>${status}</td>
        <td><strong>${age}</strong></td>
        <td>${motivo}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

// Novo gráfico de Pizza sem título
function criarGraficoPizzaNovo(dados = null) {
  const ctx = document.getElementById("chartPizza");
  
  if (!ctx) return;

  if (chartPizza) {
    chartPizza.destroy();
  }

  const dadosUso = dados || dadosCSV;
  const total = dadosUso.length;

  chartPizza = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: [],
      datasets: [{
        data: [total],
        backgroundColor: ["#2563eb"],
        borderColor: "#ffffff",
        borderWidth: 3,
        hoverBackgroundColor: ["#1e40af"]
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: false
        }
      }
    }
  });
}

// Novo gráfico de AGE - Duas linhas: Vermelho (>20), Azul (<20)
function criarGraficoAGENovo(dados = null) {
  const ctx = document.getElementById("chartAge");
  
  if (!ctx) return;

  const dadosUso = dados || dadosCSV;

  // Pegar dados com AGE válido
  const dadosComAge = dadosUso.map((item, index) => ({
    endereco: item["ENDEREÇO"] || "Sem endereço",
    age: obterAge(item),
    index: index
  })).filter(d => d.age > 0)
    .sort((a, b) => b.age - a.age);

  // Separar em dois grupos: >20 (vermelho) e <=20 (azul)
  const agesAltos = dadosComAge.filter(d => d.age > 20).slice(0, 10);
  const agesBaixos = dadosComAge.filter(d => d.age <= 20).slice(0, 10);

  // Criar labels e dados
  const maxLength = Math.max(agesAltos.length, agesBaixos.length);
  const labels = Array.from({length: maxLength}, (_, i) => "");

  // Dados para linha vermelha (>20)
  const dadosAltos = Array(maxLength).fill(null);
  agesAltos.forEach((item, i) => {
    dadosAltos[i] = item.age;
  });

  // Dados para linha azul (<=20)
  const dadasBaixos = Array(maxLength).fill(null);
  agesBaixos.forEach((item, i) => {
    dadasBaixos[i] = item.age;
  });

  if (chartAge) {
    chartAge.destroy();
  }

  chartAge = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "AGE > 20 dias",
          data: dadosAltos,
          borderColor: "#dc2626", // Vermelho
          backgroundColor: "rgba(220, 38, 38, 0.05)",
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#dc2626",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          hoverBackgroundColor: "#991b1b",
          spanGaps: true
        },
        {
          label: "AGE ≤ 20 dias",
          data: dadasBaixos,
          borderColor: "#2563eb", // Azul
          backgroundColor: "rgba(37, 99, 235, 0.05)",
          borderWidth: 3,
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#2563eb",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          hoverBackgroundColor: "#1e40af",
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          padding: 12,
          titleFont: { size: 13, weight: "600" },
          bodyFont: { size: 13 },
          cornerRadius: 4,
          callbacks: {
            title: function(context) {
              const datasetIndex = context[0].datasetIndex;
              const dataIndex = context[0].dataIndex;
              
              if (datasetIndex === 0 && agesAltos[dataIndex]) {
                return agesAltos[dataIndex].endereco;
              } else if (datasetIndex === 1 && agesBaixos[dataIndex]) {
                return agesBaixos[dataIndex].endereco;
              }
              return "";
            },
            label: function(context) {
              return `${context.parsed.y} dias`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            display: false
          },
          ticks: {
            display: false
          }
        },
        x: {
          grid: {
            display: false
          },
          ticks: {
            display: false
          }
        }
      }
    }
  });
}

// Novo gráfico de DDD - Mostra todos os DDDs de 12 a 19// Novo gráfico DDD - SEM LABELS, CENTRALIZADO
function criarGraficoDDDNovo(dddOrdenado) {
  const ctx = document.getElementById("chartDDD");
  
  if (!ctx) return;

  // Garantir que todos os DDDs de 12 a 19 apareçam
  const todosDDD = {};
  for (let ddd = 12; ddd <= 19; ddd++) {
    todosDDD[ddd] = 0;
  }

  // Preencher com dados de fato
  dddOrdenado.forEach(([ddd, quantidade]) => {
    if (todosDDD.hasOwnProperty(ddd)) {
      todosDDD[ddd] = quantidade;
    }
  });

  const dddArray = Object.keys(todosDDD).map(d => parseInt(d));
  const dddValues = Object.values(todosDDD);
  const labels = dddArray.map(ddd => `${ddd}`); // Labels com DDDs

  // Cores baseadas em intensidade
  const coresVermelhas = [
    "#8b0000",  // Vermelho muito escuro
    "#a00000",  // Vermelho muito escuro
    "#b00000",  // Vermelho muito escuro
    "#c00000",  // Vermelho muito escuro
    "#d00000",  // Vermelho muito escuro
    "#dc2626",  // Vermelho muito escuro
    "#ef4444"   // Vermelho muito escuro
  ];

  // Mapear cores baseado no valor
  const coresOrdenadas = dddValues.map((valor) => {
    if (valor === 0) return "#e5e7eb";
    const maxValor = Math.max(...dddValues);
    const proporcao = valor / maxValor;
    
    if (proporcao === 1) return coresVermelhas[0];
    if (proporcao >= 0.86) return coresVermelhas[1];
    if (proporcao >= 0.71) return coresVermelhas[2];
    if (proporcao >= 0.57) return coresVermelhas[3];
    if (proporcao >= 0.43) return coresVermelhas[4];
    if (proporcao >= 0.28) return coresVermelhas[5];
    return coresVermelhas[6];
  });

  // Destruir gráfico anterior se existir
  if (chartDDD) {
    chartDDD.destroy();
  }

  chartDDD = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels, // Labels vazios
      datasets: [{
        data: dddValues,
        backgroundColor: coresOrdenadas,
        borderColor: "#991b1b",
        borderWidth: 0,
        borderRadius: 6,
        hoverBackgroundColor: "#991b1b",
        hoverBorderWidth: 0
      }]
    },
    options: {
      indexAxis: undefined,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: true,
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          padding: 12,
          titleFont: { size: 14, weight: "600" },
          bodyFont: { size: 13 },
          cornerRadius: 4,
          callbacks: {
            title: function(context) {
              const dddIndex = context[0].dataIndex;
              return `DDD ${dddArray[dddIndex]}`;
            },
            label: function(context) {
              return `${context.parsed.y} endereços`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            display: false,
            drawBorder: false
          },
          ticks: {
            display: false
          }
        },
        x: {
          grid: {
            display: false
          },
          ticks: {
            display: true,
            font: {
              size: 14,
              weight: "bold"
            },
            color: "#0f172a",
            padding: 8
          }
        }
      }
    }
  });
}

function extrairDDD(cidade) {
  // Normalizar: remover acentos e converter para maiúscula
  function normalizarTexto(texto) {
    if (!texto) return "";
    return texto
      .toUpperCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""); // Remove acentos
  }

  // Mapear cidades aos seus DDDs (SP - DDDs 11-19)
  const dddMap = {
    // DDD 11 - São Paulo
    "11": ["SAO PAULO", "GUARULHOS", "SANTO ANDRE"],
    
    // DDD 12 - São José dos Campos
      "12": [
        "SAO JOSE DOS CAMPOS",
        "PINDAMONHANGABA",
        "UBATUBA",
        "SAO SEBASTIAO",
        "GUARATINGUETA",
        "CARAGUATATUBA",
        "TAUBATE", "APARECIDA", "CAÇAPAVA", "CRUZEIRO", "CACHOEIRA PAULISTA",
        "CAMPOS DO JORDAO", "LORENA", "POTIM", "JACAREI", "TREMEMBE"
      ],
    
    // DDD 13 - Santos
    "13": ["SANTOS", "SAO VICENTE", "GUARUJA", "PRAIA GRANDE", "BERTIOGA", "PERUIBE",
      "ITANHAEM", "MONGAGUA", "PERUIBE", "CUBATAO", "REGISTRO"
    ],
    
    // DDD 14 - Sorocaba
    "14": ["BAURU", "LINS", "OURINHOS", "AVARE", "AGUDOS", "BOTUCATU", "GARÇA",
      "JAU", "LENCOIS PAULISTA", "PROMISSAO", "SANTA CRUZ DO RIO PARDO"
     ],
    
    // DDD 15 - Campinas
    "15": ["SOROCABA", "BOITUVA", "CERQUILHO", "IBIUNA", "IPERO", "ITAPETININGA",
      "ITAPEVA", "PIEDADE", "PORTO FELIZ", "TATUI", "TIETE", "VOTORANTEM"
    ],
    
    // DDD 16 - Araraquara
    "16": ["ARARAQUARA", "SAO CARLOS", "MATAO", "AMERICO BRASILIENSE", "BARRETOS",
      "BARRINHA", "BATATAIS", "CRAVINHOS", "FRANCA", "IBATE", "IBATÉ", "ITUVERAVA",
      "JABOTICABAL", "JARDINOPOLIS", "MONTE ALTO", "ORLANDIA", "RIBEIRAO PRETO",
      "SAO JOAQUIM DA BARRA", "SERRANA", "SERTÃOZINHO"
    ],
    
    // DDD 17 - São José do Rio Preto
    "17": ["SAO JOSE DO RIO PRETO", "MIRASSOL", "BALSAS", "BADY BASSIT", "BEBEDOURO",
      "CATANDUVA", "FERNANDOPOLIS", "GUAIRA", "GUAPIACU", "JALES", "JOSE BONIFACIO", "OLIMPIA",
      "VOTUPORANGA"
    ],
    
    // DDD 18 - Presidente Prudente
    "18": ["PRESIDENTE PRUDENTE", "RANCHARIA", "ALVARES MACHADO", "ADAMANTINA", "ANDRADINA", "ARACATUBA",
      "BIRIGUI", "BRACENA", "GUARARAPES", "PENAPOLIS", "PRESIDENTE BERNARDES"
    ], 
    
    // DDD 19 - Campinas/Piracicaba
    "19": ["AMERICANA", "AMPARO", "ARARAS", "ARTUR NOGUEIRA", "LIMEIRA", "PIRACICABA", "HORTOLANDIA", "LEME", "PIRASSUNUNGA", "CAMPINAS",
      "COSMOPOLIS", "DESCALVADO", "ESPIRITO SANTO DO PINHAL", "HORTOLANDIA", "INDAIATUBA", "ITAPIRA", "JAGUARIUNA",
      "LEME", "LIMEIRA", "LOUVEIRA", "MOCOCA", "MOGI GUACU", "MOGI MIRIM", "NOVA ODESSA", "PAULINIA", "PEDREIRA", "PIRACICABA",
      "PIRASSUNUNGA", "PORTO FERREIRA", "RIO CLARO", "SANTA BARBARA D'OSTE", "SAO JOAO DA BOA VISTA", "SAO JOSE DO RIO PARDO",
      "SERRA NEGRA", "SUMARE", "VALINHOS", "VINHEDO"
    ]
  };

  if (!cidade) return "Outro";

  const cidadeNormalizada = normalizarTexto(cidade);

  // Procurar em cada DDD
  for (const [ddd, cidades] of Object.entries(dddMap)) {
    for (const city of cidades) {
      if (cidadeNormalizada === city || cidadeNormalizada.includes(city) || city.includes(cidadeNormalizada)) {
        return ddd;
      }
    }
  }

  // Se não encontrar, retornar "Outro"
  return "Outro";
}

// PESQUISA
function pesquisarEndereco() {
  const cod = document.getElementById("pesquisaCodigo").value.trim();
  const res = dadosCSV.filter(i => getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo") === cod);
  renderTabela("tabela-pesquisa", res);
}

// FILTRO DE DDD
function selecionarDDD(ddd) {
  // Atualizar variável global
  dddSelecionado = ddd;
  
  // Atualizar estado dos botões
  document.querySelectorAll(".ddd-btn").forEach(btn => {
    btn.classList.remove("ativo");
    if (btn.getAttribute("data-ddd") === ddd) {
      btn.classList.add("ativo");
    }
  });
  
  // Filtrar apenas a tabela da PÁGINA INICIAL sem navegar
  let dadosFiltrados = dadosCSV;
  if (ddd !== "todos") {
    dadosFiltrados = dadosCSV.filter(item => {
      const d = extrairDDD(getField(item, "CIDADE", "cidade"));
      return d.toString() === ddd;
    });
  }

  // Renderizar somente a tabela na página inicial e NÃO atualizar a aba Relatórios
  renderTabela("tabela-enderecos", dadosFiltrados, false);
  
  // Atualizar badge de contagem
  const badgeElement = document.getElementById("ddd-total");
  if (badgeElement) {
    const totalFiltrado = dadosFiltrados.length;
    badgeElement.textContent = `${totalFiltrado} registro${totalFiltrado !== 1 ? 's' : ''}`;
  }
}

// Obter AGE de forma segura da planilha
function obterAge(item) {
  const age = parseInt(getField(item, "AGE", "age"));
  return isNaN(age) ? 0 : age;
}

// Adiciona o campo de busca no cabeçalho apenas nas categorias que não têm busca própria
function initHeaderSearch() {
  const categoriasComBuscaNoCabecalho = new Set([
    'pendente-autorizacao',
    'empresarial',
    'sar-rede',
    'mdu-ongoing'
  ]);

  document.querySelectorAll('.categoria-header').forEach(header => {
    if (header.querySelector('.header-search')) return;

    const secao = header.closest('.secao');
    if (!secao) return;

    const categoriaId = secao.id;
    if (!categoriaId || !categoriasComBuscaNoCabecalho.has(categoriaId)) return;

    const container = document.createElement('div');
    container.className = 'header-search';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '🔍 Buscar por ID...';
    input.className = 'header-search-input';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'header-search-btn';
    button.textContent = 'Buscar';

    button.addEventListener('click', () => {
      buscarEmCategoria(categoriaId);
    });

    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        buscarEmCategoria(categoriaId);
      }
    });

    container.appendChild(input);
    container.appendChild(button);

    header.appendChild(container);
  });
}

// Atualizar todos os gráficos do dashboard
function atualizarDashboard() {
  if (dadosCSV.length === 0) {
    return;
  }

  // Não precisa criar gráficos aqui
}

// MENU
function mostrarSecao(id) {
  const user = getCurrentUser();
  const isAdmin = user?.role === "admin";

  if (!isAdmin && ["historico", "relatorios"].includes(id)) {
    id = "inicio";
  }

  document.querySelectorAll(".secao").forEach(s => s.classList.remove("ativa"));
  const section = document.getElementById(id);
  if (!section) return;
  section.classList.add("ativa");

  const globalImport = document.getElementById("global-import-section");
  const isCategoria = section.classList.contains("categoria-secao");
  if (isCategoria) {
    categoriaAtualParaImport = id;
    updateImportTargetLabel();
    setImportMode(importMode); // garante que a UI esteja no modo correto

    // Limpar informações de importação para evitar confusão ao navegar entre categorias
    const fileNameDisplay = document.getElementById("file-name");
    if (fileNameDisplay) fileNameDisplay.textContent = "";
    const statusEl = document.getElementById("import-status");
    if (statusEl) statusEl.textContent = "";
    const fileInput = document.getElementById("arquivoCSV");
    if (fileInput) fileInput.value = "";
    const networkInput = document.getElementById("networkPath");
    if (networkInput) networkInput.value = "";
    const sheetInput = document.getElementById("sheetUrl");
    if (sheetInput) sheetInput.value = "";
  } else {
    categoriaAtualParaImport = null;
  }

  if (globalImport) {
    if (isCategoria && isAdmin) {
      // Sempre garantir que o bloco de importação esteja visível e localizado na seção ativa
      globalImport.style.display = "block";

      const header = section.querySelector(".categoria-header");
      const shouldMove = !section.contains(globalImport) || (header && globalImport.previousElementSibling !== header);

      if (shouldMove) {
        if (header) {
          section.insertBefore(globalImport, header.nextSibling);
        } else {
          section.insertBefore(globalImport, section.firstChild);
        }
      }

      // Se estamos em uma categoria, reaplicar os dados já carregados para ela
      carregarDadosCategoria(id);
    } else {
      // Oculta o bloco de importação quando não estamos em uma categoria ou o usuário não é admin.
      globalImport.style.display = "none";
      if (isCategoria) {
        carregarDadosCategoria(id);
      }
    }
  }

  if (id === "historico") {
    loadHistory();
  }

  if (id === "pesquisa") {
    agendarRenderVisaoGerencia(true);
  }
}

// FILTRO POR DDD

// Adicionar event listeners aos botões de DDD ao carregar a página
function inicializarFiltrosDDD() {
  // Ativar botão "Todos" por padrão
  const btnTodos = document.querySelector('[data-ddd="todos"]');
  if (btnTodos) {
    btnTodos.classList.add("ativo");
  }
}

// IMPORTAR CSV NA SEÇÃO ONGOING
function importarCSVOngoing() {
  const fileInput = document.getElementById("arquivoCSVOngoing");
  const file = fileInput.files[0];
  
  if (!file) {
    alert("Selecione um arquivo CSV");
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const csv = e.target.result;
    // Processar CSV com delimitador ponto-e-vírgula e encoding ISO-8859-1
    debugCSVOngoing(csv); // Debug: exibir estrutura
    dadosCSVOngoing = processarCSVOngoing(csv);
    dadosCSVOngoingOriginal = dadosCSVOngoing; // Salvar cópia dos dados originais
    filtroFilaAtivo = "todos"; // Resetar filtro
    
    if (dadosCSVOngoing.length === 0) {
      alert("⚠️ Nenhum dado válido encontrado no arquivo");
      return;
    }
    
    // Resetar botões para TODOS
    document.querySelectorAll(".fila-btn").forEach(btn => {
      btn.classList.remove("ativo");
      if (btn.getAttribute("data-fila") === "todos") {
        btn.classList.add("ativo");
      }
    });

    // Atualizar tabela ONGOING
    renderTabelaOngoing(dadosCSVOngoing);
    
    // Mostrar nome do arquivo
    document.getElementById("file-name-ongoing").textContent = `Arquivo: ${file.name}`;
    alert(`✅ ${dadosCSVOngoing.length} registros importados!`);
  };
  
  reader.readAsText(file, "ISO-8859-1");
}

// Processar CSV da seção ONGOING com os campos específicos
function processarCSVOngoing(csv, delimiter = ";") {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  const cabecalhoRaw = linhas[0].trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(",") && !cabecalhoRaw.includes(";")) {
    delimiter = ",";
  }

  const cabecalho = cabecalhoRaw.split(delimiter).map(c => c.trim());
  const dados = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = linha.split(delimiter);
    if (colunas.length < cabecalho.length) continue;

    const item = {};
    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      item[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        item[normalized] = valor;
      }
    });

    const idDemanda = getField(item, "iddemanda", "id_demanda", "id demanda", "id", "ID Demanda");
    const fila = getField(item, "fila", "Fila");
    const tipo = getField(item, "tipo", "Tipo");
    const endereco = getField(item, "endereco_entrada", "endereco_entrada", "endereco_unico", "endereco", "endereço", "endereco entrada", "Endereço");
    const epo = getField(item, "epo", "EPO");
    const aging = getField(item, "aging", "Aging", "age");
    const slaTudo = getField(item, "SLA TUDO", "sla tudo", "sla_fase", "sla fase", "sla_tudo", "sla", "SLA TUDO");
    const status = getField(item, "STATUS_GERAL", "status_geral", "status", "Status");
    const motivo = getField(item, "MOTIVO_GERAL", "motivo_geral", "motivo", "Motiv", "Motivo");

    item["iddemanda"] = idDemanda || "";
    item["fila"] = fila || "";
    item["tipo"] = tipo || "";
    item["endereco_unico"] = endereco || "";
    item["endereco"] = endereco || "";
    item["epo"] = epo || "";
    item["Aging arredondado"] = aging || "";
    item["SLA TUDO"] = slaTudo || "";
    item["STATUS_GERAL"] = status || "";
    item["MOTIVO_GERAL"] = motivo || "";

    if (idDemanda || fila || endereco || status || motivo) {
      dados.push(item);
    }
  }

  return dados;
}

// Processar CSV da seção MDU ONGOING com filtros específicos
function processarCSVMduOngoing(csv, delimiter = ";") {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  const cabecalhoRaw = linhas[0].trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(",") && !cabecalhoRaw.includes(";")) {
    delimiter = ",";
  }

  const cabecalho = cabecalhoRaw.split(delimiter).map(c => c.trim());
  const headerIndex = {};
  cabecalho.forEach((c, idx) => {
    const normalized = normalizeKey(c);
    headerIndex[normalized] = idx;
    headerIndex[c.trim()] = idx;
  });

  const dados = [];

  // Status permitidos para STATUS_GERAL
  const statusPermitidos = [
    "1.VISTORIA", "2.PROJETO_INTERNO", "5.CONSTRUCAO", "7.EM_LIBERACAO",
    "EXPANSÃO_MDU", "4.CONSTRUCAO_REDE", "3.PROJETO_REDE"
  ];

  // Motivos permitidos para MOTIVO_GERAL
  const motivosPermitidos = [
    "5.CONSTRUCAO_INTERNA", "7.EM_LIBERACAO", "4.PEND_EXECUTAR_SAR",
    "2.PROJETO_INTERNO_BACKBONE", "3.PROJETO_SAR", "1.VISTORIA",
    "4.FIBRA _SEM_SINAL", "6.AGUARDANDO ASBUILT", "8.VALIDAÇÃO VISTORIA_SIMPLIFICADA",
    "4.REPROJETO_SAR", "5.CONSTRUCAO_INTERNA_AGENDADA", "1.VISTORIA_AGENDADA",
    "AGUARDANDO_AGEND_COMERCIAL", "AGUARDANDO_AGEND_CLIENTE_SGD",
    "AGUARDANDO_CRIAÇAO_END_GED", "AGUARDANDO_AGEND_TECNICA",
    "6.ATIVAÇÃO_MDU_CONSTRUIDO", "AGUARDANDO_DE_ACORDO_DIRETOR",
    "AGUARDANDO_ESTUDO_SAR", "AGUARDANDO_APRO_COMERCIAL",
    "1.PENDENTE_ RETORNO_VISTORIA_EPO", "2.VALIDAÇÃO VISTORIA",
    "4. REDE GPON ESTRUTURADO", "1.MEDIÇÃO_PENDENTE_ENVIO PLANILHA_EPO"
  ];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = linha.split(delimiter);
    if (colunas.length < cabecalho.length) continue;

    const item = {};
    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      item[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        item[normalized] = valor;
      }
    });

    // Preencher campos comuns
    const codMdugo = getField(item, "COD-MDUGO", "cod_mdugo", "codigo");
    const endereco = getField(item, "ENDEREÇO", "endereco");
    const numero = getField(item, "NUMERO", "numero");
    const bairro = getField(item, "BAIRRO", "bairro");
    const cidade = getField(item, "CIDADE", "cidade");
    const epo = getField(item, "EPO", "epo");
    const solicitante = getField(item, "SOLICITANTE", "solicitante");
    const codImovel = getField(item, "COD_IMOVEL", "cod_imovel");
    const statusGeral = getField(item, "STATUS_GERAL", "status_geral", "status");
    const motivoGeral = getField(item, "MOTIVO_GERAL", "motivo_geral", "motivo");

    // Filtrar apenas linhas com status e motivo permitidos
    if (statusPermitidos.includes(statusGeral) && motivosPermitidos.includes(motivoGeral)) {
      item["COD-MDUGO"] = codMdugo || "";
      item["ENDEREÇO"] = endereco || "";
      item["NUMERO"] = numero || "";
      item["BAIRRO"] = bairro || "";
      item["CIDADE"] = cidade || "";
      item["EPO"] = epo || "";
      item["SOLICITANTE"] = solicitante || "";
      item["COD_IMOVEL"] = codImovel || "";
      item["STATUS_GERAL"] = statusGeral || "";
      item["MOTIVO_GERAL"] = motivoGeral || "";

      dados.push(item);
    }
  }

  return dados;
}

// Processar CSV da seção PROJETO F
function processarCSVProjetoF(csv, delimiter = ";") {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  const cabecalhoRaw = linhas[0].trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(",") && !cabecalhoRaw.includes(";")) {
    delimiter = ",";
  }

  const cabecalho = cabecalhoRaw.split(delimiter).map(c => c.trim());
  const headerIndex = {};
  cabecalho.forEach((c, idx) => {
    const normalized = normalizeKey(c);
    headerIndex[normalized] = idx;
    headerIndex[c.trim()] = idx;
  });

  const dados = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = linha.split(delimiter);
    if (colunas.length < cabecalho.length) continue;

    const item = {};
    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      item[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        item[normalized] = valor;
      }
    });

    // Preencher campos específicos do PROJETO F
    const codMdugo = getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo", "codigo");
    const cidade = getField(item, "CIDADE", "cidade", "cidada");
    const bloco = getField(item, "BLOCO", "bloco");
    const codged = getField(item, "CODGED", "codged", "cod_ged", "COD GED", "CÓD. GED", "CÓDIGO GED", "cod ged");
    const endereco = getField(item, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada");
    const qtdeBlocos = getField(item, "Qtde Blocos", "QTDE_BLOCOS", "qtd_blocos", "qtd blocos", "qtde blocos");
    const statusMdu = getField(item, "STATUS MDU", "STATUS_MDU", "status_mdu", "status mdu");
    const statusLiberacao = getField(item, "STATUS LIBERAÇÃO", "STATUS_LIBERACAO", "status_liberacao", "status liberacao");

    // Campos adicionais para detalhes
    const idNode = getField(item, "ID_NODE", "id_node", "id node");
    const areaRecorte = getField(item, "Área Recorte", "Area Recorte", "area_recorte", "area recorte");
    const subiuProjnet = getField(item, "Subiu projnet?", "subiu_projnet", "subiu projnet");
    const liberacaoConcluida = getField(item, "Liberação concluida?", "Liberacao Concluida?", "liberacao_concluida", "liberacao concluida");
    const dtConstrucao = getField(item, "DT_CONSTRUÇÃO", "DT_CONSTRUCAO", "dt_construcao", "dt construcao");
    const parceira = getField(item, "PARCEIRA", "parceira");
    const obs = getField(item, "OBS", "obs", "observacao", "OBSERVACAO");

    item["COD-MDUGO"] = codMdugo || "";
    item["CIDADE"] = cidade || "";
    item["BLOCO"] = bloco || "";
    item["CODGED"] = codged || "";
    item["ENDEREÇO"] = endereco || "";
    item["Qtde Blocos"] = qtdeBlocos || "";
    item["STATUS MDU"] = statusMdu || "";
    item["STATUS LIBERAÇÃO"] = statusLiberacao || "";

    // Campos para detalhes
    item["ID_NODE"] = idNode || "";
    item["Área Recorte"] = areaRecorte || "";
    item["Subiu projnet?"] = subiuProjnet || "";
    item["Liberação concluida?"] = liberacaoConcluida || "";
    item["DT_CONSTRUÇÃO"] = dtConstrucao || "";
    item["PARCEIRA"] = parceira || "";
    item["OBS"] = obs || "";

    dados.push(item);
  }

  return dados;
}

// Debug: Log para verificar cabeçalhos do CSV
function debugCSVOngoing(csv) {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 1) return;
  
  const cabecalho = linhas[0].split(";");
  console.log("=== DEBUG CSV ONGOING ===");
  console.log("Cabeçalhos encontrados:", cabecalho.map(c => `"${c.trim()}"`));
  console.log("Total de colunas:", cabecalho.length);
  
  if (linhas.length > 1) {
    const col = linhas[1].split(";");
    console.log("Primeira linha de dados:", col.map(c => `"${c?.trim() || ''}"`));
    const item = {};
    cabecalho.forEach((c, j) => {
      item[c.trim()] = col[j]?.trim() || "";
    });
    console.log("Primeiro item parseado:", item);
  }
}

// Variável global para armazenar dados filtrados
let dadosCSVOngoingOriginal = [];
let filtroFilaAtivo = "todos";

// Filtrar tabela ONGOING por fila (VISTORIA, BACKBONE)
function filtrarPorFila(fila) {
  filtroFilaAtivo = fila;
  
  // Atualizar estado dos botões
  document.querySelectorAll(".fila-btn").forEach(btn => {
    btn.classList.remove("ativo");
    if (btn.getAttribute("data-fila") === fila) {
      btn.classList.add("ativo");
    }
  });
  
  // Filtrar dados
  let dadosFiltrados = dadosCSVOngoingOriginal;
  if (fila !== "todos") {
    dadosFiltrados = dadosCSVOngoingOriginal.filter(item => {
      const filaItem = (item["fila"] || "").toLowerCase().trim();
      return filaItem.includes(fila.toLowerCase());
    });
  }
  
  // Renderizar tabela filtrada
  renderTabelaOngoing(dadosFiltrados);
}

// Renderizar tabela ONGOING com novos campos
let dadosCSVOngoing = [];
let dadosTabelaExibida = []; // Armazenar dados atualmente exibidos na tabela

function renderTabelaOngoing(dados) {
  const tbody = document.getElementById("tabela-ongoing");
  
  if (!dados || dados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center">Nenhum dado</td></tr>';
    return;
  }
  
  // Ordenar por AGING (do maior para o menor)
  const dadosOrdenados = [...dados].sort((a, b) => {
    // Extrair números de AGING de forma robusta
    const extrairAgingNumero = (item) => {
      const agingRaw = item["Aging arredondado"] || "0";
      // Remover espaços, extrair apenas dígitos
      const match = agingRaw.toString().match(/\d+/);
      return match ? parseInt(match[0]) : 0;
    };
    
    const agingA = extrairAgingNumero(a);
    const agingB = extrairAgingNumero(b);
    
    // Ordenação decrescente (maior para menor)
    return agingB - agingA;
  });
  
  // Salvar dados ordenados para uso no modal de detalhes
  dadosTabelaExibida = dadosOrdenados;
  
  tbody.innerHTML = dadosOrdenados.map((item, idx) => {
    // Extrair apenas o número do Aging (remover " dias" ou qualquer texto)
    const agingRaw = item["Aging arredondado"] || "0";
    const match = agingRaw.toString().match(/\d+/);
    const agingNumero = match ? parseInt(match[0]) : 0;

    // Determinar classe de badge para AGING > 20 (níveis críticos por bucket)
    let badgeClass = "";
    if (agingNumero > 20) {
      let level = 1;
      if (agingNumero <= 30) level = 1;
      else if (agingNumero <= 40) level = 2;
      else if (agingNumero <= 60) level = 3;
      else if (agingNumero <= 80) level = 4;
      else level = 5;
      badgeClass = `aging-badge level-${level}`;
    }

    return `
      <tr>
        <td>${item["iddemanda"] || "-"}</td>
        <td>${item["fila"] || "-"}</td>
        <td>${item["tipo"] || "-"}</td>
        <td>${getField(item, "endereco_unico", "endereco", "endereço", "endereco_entrada") || "-"}</td>
        <td>${getField(item, "epo", "EPO", "regional", "REGIONAL", "cluster", "CLUSTER") || "-"}</td>
        <td>${badgeClass ? `<span class="${badgeClass}">${agingNumero}</span>` : agingNumero}</td>
        <td>${getField(item, "SLA TUDO", "SLA FASE", "sla_tudo", "sla_fase", "sla") || "-"}</td>
        <td>${getField(item, "STATUS_GERAL", "status") || "-"}</td>
        <td>${getField(item, "MOTIVO_GERAL", "motivo") || "-"}</td>
        <td>
          <button class="btn-visualizar" onclick="abrirDetalhesOngoing(${idx})">\ud83d\udd0d Visualizar</button>
        </td>
      </tr>
    `;
  }).join("");
  
  // Atualizar estatísticas
  atualizarEstatisticasOngoing(dadosOrdenados);
}

// Calcular e exibir estatísticas
function atualizarEstatisticasOngoing(dados) {
  if (!dados || dados.length === 0) {
    document.getElementById("total-enderecos-ongoing").textContent = "0";
    document.getElementById("dentro-sla").textContent = "0";
    document.getElementById("fora-sla").textContent = "0";
    return;
  }
  
  const total = dados.length;
  let dentroslA = 0;
  let foraslA = 0;
  
  dados.forEach(item => {
    const slaTudo = (getField(item, "SLA TUDO", "SLA FASE", "sla_tudo", "sla_fase", "sla") || "").toLowerCase().trim();
    if (slaTudo === "dentro" || slaTudo === "dentro sla") {
      dentroslA++;
    } else if (slaTudo === "fora" || slaTudo === "fora sla") {
      foraslA++;
    }
  });
  
  document.getElementById("total-enderecos-ongoing").textContent = total;
  document.getElementById("dentro-sla").textContent = dentroslA;
  document.getElementById("fora-sla").textContent = foraslA;
}

// Buscar por ID Demanda
function buscarPorIDOngoing() {
  const id = document.getElementById("buscarIDOngoing").value.trim();
  
  if (!id) {
    alert("⚠️ Digite um ID para buscar");
    return;
  }
  
  const resultado = dadosCSVOngoingOriginal.filter(item => {
    return (item["iddemanda"] || "").toString().includes(id);
  });
  
  if (resultado.length === 0) {
    alert(`❌ Nenhum ID encontrado com: ${id}`);
    renderTabelaOngoing(dadosCSVOngoingOriginal);
    return;
  }
  
  renderTabelaOngoing(resultado);
}

// Abrir detalhes do registro
async function abrirDetalhesOngoing(indice) {
  const item = dadosTabelaExibida[indice]; // Usar dados atualmente exibidos
  if (!item) return;

  const idDemanda = getField(item, "iddemanda", "IDDEMANDA", "ID_DEMANDA", "id") || "-";
  const fila = getField(item, "fila", "FILA") || "-";
  const tipo = getField(item, "tipo", "TIPO") || "-";
  const endereco = getField(item, "endereco_unico", "endereco", "endereço", "endereco_entrada") || "-";
  const bairro = getField(item, "bairro", "BAIRRO") || "-";
  const cidade = getField(item, "cidade", "CIDADE") || "-";
  const epo = getField(item, "epo", "EPO", "regional", "REGIONAL", "cluster", "CLUSTER") || "-";
  const status = getField(item, "STATUS_GERAL", "status") || "-";
  const motivo = getField(item, "MOTIVO_GERAL", "motivo") || "-";
  const sla = getField(item, "SLA TUDO", "SLA FASE", "sla_tudo", "sla_fase", "sla") || "-";
  const obsOriginal = getField(item, "STATUS OBS", "OBS", "OBSERVACAO", "observacao") || "Nenhuma observação disponível";

  // Extrair apenas o número do Aging de forma robusta
  const agingRaw = item["Aging arredondado"] || "0";
  const match = agingRaw.toString().match(/\d+/);
  const agingNumero = match ? parseInt(match[0], 10) : 0;

  const referenceKey = [
    idDemanda,
    getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo"),
    endereco
  ].find(value => value && value !== "-") || `ongoing-${indice}`;

  currentPendenteCodigo = String(referenceKey);

  // Mantém a página de detalhes sincronizada, caso seja usada no futuro.
  document.getElementById("detalhe-iddemanda").textContent = idDemanda;
  document.getElementById("detalhe-fila").innerHTML = renderModalBadge(fila);
  document.getElementById("detalhe-tipo").textContent = tipo;
  document.getElementById("detalhe-endereco").textContent = endereco;
  document.getElementById("detalhe-aging").innerHTML = `<span class="modal-badge ${agingNumero > 20 ? 'badge-danger' : 'badge-success'}">${agingNumero}</span>`;
  document.getElementById("detalhe-sla").innerHTML = renderModalBadge(sla);
  document.getElementById("detalhe-status").innerHTML = renderModalBadge(status);
  document.getElementById("detalhe-motivo").innerHTML = renderModalBadge(motivo);
  document.getElementById("detalhe-obs").textContent = obsOriginal;

  document.getElementById('modal-codigo').textContent = idDemanda;
  document.getElementById('modal-endereco').textContent = endereco;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(status);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(motivo);
  document.getElementById('modal-obs-original').textContent = obsOriginal;
  document.getElementById('modal-obs-adicional').value = "";

  applyModalContext({
    themeClass: 'mdu-ongoing-modal',
    title: 'Detalhes Ongoing',
    kicker: 'Painel operacional do ongoing',
    heroChip: 'Ongoing',
    heroTitle: endereco || idDemanda,
    heroSubtitle: [fila, tipo, epo].filter(value => value && value !== '-').join(' • ') || 'Acompanhamento detalhado do registro selecionado.',
    statusLabel: 'Status Geral',
    motivoLabel: 'Motivo Geral',
    heroPills: [
      { label: 'ID Demanda', value: idDemanda },
      { label: 'Aging', value: String(agingNumero || 0) },
      { label: 'SLA', value: sla, badge: true }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('Fila', fila, { featured: true })}
        ${renderModalInfoCard('Tipo', tipo)}
        ${renderModalInfoCard('EPO / Cluster', epo)}
        ${renderModalInfoCard('Aging', String(agingNumero || 0))}
        ${renderModalInfoCard('SLA Tudo', sla)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  await carregarObservacoesPendente(currentPendenteCodigo);
  await carregarAnexosPendente(currentPendenteCodigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = "";
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(currentPendenteCodigo, file);
      }
    };
  }

  window.scrollTo(0, 0);
}

// Voltar da página de detalhes
function voltarOngoing() {
  // Voltar para a seção ONGOING usando o sistema de navegação
  mostrarSecao('ongoing');
  window.scrollTo(0, 0);
}
document.addEventListener("DOMContentLoaded", function() {
  const inputBusca = document.getElementById("buscarIDOngoing");
  if (inputBusca) {
    inputBusca.addEventListener("keypress", function(e) {
      if (e.key === "Enter") {
        buscarPorIDOngoing();
      }
    });
  }
});

// LOGOUT
function logout() {
  currentUser = null;
  localStorage.removeItem(STORAGE_CURRENT_USER_KEY);

  if (window.location.protocol.startsWith("http")) {
    fetch("/api/logout", { method: "POST", credentials: "include" })
      .finally(() => {
        window.location.href = "login.html";
      });
  } else {
    window.location.href = "login.html";
  }
}

// ===== EXPORTAR PLANILHA CSV =====
function converterParaCSV(dados) {
  if (!dados || !dados.length) return '';
  
  const chaves = Object.keys(dados[0]);
  const linhaHeader = chaves.map(ch => `"${ch}"`).join(';');
  
  const linhas = dados.map(obj => {
    return chaves.map(chave => {
      const valor = obj[chave] || '';
      const valorEscapado = valor.toString().replace(/"/g, '""');
      return valor === '' ? '' : `"${valorEscapado}"`;
    }).join(';');
  });
  
  return [linhaHeader, ...linhas].join('\n');
}

function baixarCSV(nomeArquivo, conteudoCSV) {
  const blob = new Blob([conteudoCSV], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', nomeArquivo);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportarPaginaInicial() {
  if (!dadosCSV || dadosCSV.length === 0) {
    alert('⚠️ Nenhum dado carregado para exportar');
    return;
  }
  
  let dadosParaExportar = dadosCSV;
  
  // Se houver um filtro DDD ativo, exportar apenas esses dados
  if (typeof dddSelecionado !== 'undefined' && dddSelecionado !== 'todos') {
    dadosParaExportar = dadosCSV.filter(item => {
      const ddd = extrairDDD(item['CIDADE']);
      return ddd.toString() === dddSelecionado;
    });
  }
  
  if (dadosParaExportar.length === 0) {
    alert('⚠️ Nenhum registro no filtro atual');
    return;
  }
  
  const csv = converterParaCSV(dadosParaExportar);
  const dataAtual = new Date().toISOString().slice(0, 10);
  baixarCSV(`relatorio_pagina_inicial_${dataAtual}.csv`, csv);
  alert('✅ Arquivo exportado com sucesso!');
}

function exportarOngoing() {
  if (!dadosCSVOngoing || dadosCSVOngoing.length === 0) {
    alert('⚠️ Nenhum dado carregado para exportar');
    return;
  }
  
  // Usar dados atualmente exibidos (que podem estar filtrados)
  const dadosParaExportar = dadosTabelaExibida && dadosTabelaExibida.length ? dadosTabelaExibida : dadosCSVOngoing;
  
  if (dadosParaExportar.length === 0) {
    alert('⚠️ Nenhum registro para exportar');
    return;
  }
  
  const csv = converterParaCSV(dadosParaExportar);
  const dataAtual = new Date().toISOString().slice(0, 10);
  baixarCSV(`relatorio_ongoing_${dataAtual}.csv`, csv);
  alert('✅ Arquivo exportado com sucesso!');
}
// ===== FUNÇÕES PARA CATEGORIAS =====

// Abrir seção de categoria clicando no card
function abrirCategoria(categoriaId) {
  // Mostra a seção e ajusta/importa o bloco de importação
  mostrarSecao(categoriaId);

  // Carregar dados da categoria
  carregarDadosCategoria(categoriaId);
}

// Voltar à página inicial
function voltarDoCategoria() {
  mostrarSecao('inicio');
  
  // Limpar buscas
  document.querySelectorAll('[id^="buscar-"]').forEach(input => {
    input.value = '';
  });
}

let epoSelecionadaAtual = '';
let epoAcaoAtual = '';
let epoUltimoAceite = null;
const STORAGE_EPO_TECNICOS_KEY = 'portalEpoTecnicos';
const STORAGE_EPO_ACEITES_KEY = 'portalEpoAceites';
const STORAGE_EPO_NOVOS_KEY = 'portalEpoNovosEntrantes';

const EPO_PILLS = ['ACESSO','ANTEC','ARCAD','BASIC','CANTOIA','CSC','DANLEX','ELETRONET','PSNET','SCRIPT_CALL','VISIUM'];

function getEpoNovosStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_EPO_NOVOS_KEY) || '{}'); } catch { return {}; }
}

function saveEpoNovosStore(store) {
  localStorage.setItem(STORAGE_EPO_NOVOS_KEY, JSON.stringify(store || {}));
}

function getEpoNovosParaEpo(nomeEpo) {
  const store = getEpoNovosStore();
  return Array.isArray(store[nomeEpo]) ? store[nomeEpo] : [];
}

function abrirImportEpoNovos() {
  const input = document.getElementById('epo-novos-import-file');
  if (input) { input.value = ''; input.click(); }
}

function _resolverEpoDaLinha(item) {
  const EPO_KEYS = ['EPO','epo','PARCEIRA','parceira','CLUSTER','cluster','EPO / Cluster','epo / cluster'];
  const raw = (getField(item, ...EPO_KEYS) || '').toString().trim().toUpperCase();
  if (!raw) return null;
  const exact = EPO_PILLS.find(p => p === raw);
  if (exact) return exact;
  return EPO_PILLS.find(p => raw.includes(p) || p.includes(raw)) || raw;
}

function importarPlanilhaEpoNovos() {
  const input = document.getElementById('epo-novos-import-file');
  const statusEl = document.getElementById('epo-novos-import-status');
  const file = input?.files?.[0];
  if (!file) return;
  if (statusEl) statusEl.textContent = 'Importando...';

  const processarTexto = (text) => {
    const textClean = text.replace(/^\uFEFF/, '');
    const delimiter = (textClean.split(/\r?\n/)[0] || '').includes(';') ? ';' : ',';
    const linhas = parseGenericCsvRows(textClean, delimiter);

    const vistorias = linhas.filter(item => {
      const s = (getField(item, 'STATUS_GERAL', 'STATUS', 'status') || '').toString().trim();
      return s === '1.VISTORIA' || normalizeText(s) === '1.vistoria';
    });

    const byEpo = {};
    vistorias.forEach(item => {
      const key = _resolverEpoDaLinha(item);
      if (!key) return;
      if (!byEpo[key]) byEpo[key] = [];
      byEpo[key].push(item);
    });

    saveEpoNovosStore(byEpo);
    atualizarCountPillsEpo();

    const total = vistorias.length;
    const epoCount = Object.keys(byEpo).length;
    const resumo = Object.entries(byEpo).map(([k, v]) => `${k}:${v.length}`).join(' | ');

    if (statusEl) statusEl.textContent = `✅ ${total} endereços em ${epoCount} EPOs`;
    const resultEl = document.getElementById('epo-action-result');
    if (resultEl) resultEl.textContent = `✅ Importado: ${resumo}`;

    if (epoAcaoAtual === 'novos' && epoSelecionadaAtual) renderNovosEntrantesEpo();
    if (input) input.value = '';
  };

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = String(e.target?.result || '');
    // Se contiver caractere de substituição, o arquivo é ANSI — relê como windows-1252
    if (text.includes('\ufffd')) {
      const reader2 = new FileReader();
      reader2.onload = (e2) => processarTexto(String(e2.target?.result || ''));
      reader2.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
      reader2.readAsText(file, 'windows-1252');
    } else {
      processarTexto(text);
    }
  };
  reader.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
  reader.readAsText(file);
}

function atualizarCountPillsEpo() {
  const store = getEpoNovosStore();
  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    const epoName = btn.dataset.epo;
    const count = Array.isArray(store[epoName]) ? store[epoName].length : 0;
    const span = btn.querySelector('.epo-pill-count');
    if (span) span.textContent = count > 0 ? ` (${count})` : '';
  });
}

function getEpoTecnicosStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_EPO_TECNICOS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveEpoTecnicosStore(store) {
  localStorage.setItem(STORAGE_EPO_TECNICOS_KEY, JSON.stringify(store || {}));
}

function getEpoAceitesStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_EPO_ACEITES_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveEpoAceitesStore(store) {
  localStorage.setItem(STORAGE_EPO_ACEITES_KEY, JSON.stringify(store || {}));
}

function getNomeResponsavelAtual() {
  const user = getCurrentUser();
  return String(user?.name || user?.username || 'Usuário').trim() || 'Usuário';
}

function normalizeListaAceitesEpo(lista) {
  if (!Array.isArray(lista)) return [];

  return lista
    .map((item) => {
      if (typeof item === 'string') {
        return { codigo: item, responsavel: '-', aceitoEm: null };
      }

      if (!item || typeof item !== 'object') return null;

      return {
        codigo: String(item.codigo || item.cod || item.COD_MDUGO || '').trim(),
        responsavel: String(item.responsavel || item.user || '-').trim() || '-',
        aceitoEm: item.aceitoEm || item.createdAt || null
      };
    })
    .filter((item) => item && item.codigo);
}

function formatDateTimeBr(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR');
}

function getTecnicosDaEpo(nomeEpo) {
  const store = getEpoTecnicosStore();
  const lista = Array.isArray(store?.[nomeEpo]) ? store[nomeEpo] : [];
  return lista;
}

function saveTecnicosDaEpo(nomeEpo, lista) {
  const store = getEpoTecnicosStore();
  store[nomeEpo] = Array.isArray(lista) ? lista : [];
  saveEpoTecnicosStore(store);
}

function setEpoActionButtonActive(tipoAcao) {
  document.querySelectorAll('#epo .epo-action-trigger').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.action === tipoAcao);
  });
}

function renderTabelaTecnicosEpo(lista) {
  if (!Array.isArray(lista) || !lista.length) {
    return '<p style="opacity:.75; margin:8px 0 0 0;">Nenhum técnico cadastrado para esta EPO.</p>';
  }

  const rows = lista.map(item => `
    <tr>
      <td>${escapeHtml(item.nome || '-')}</td>
      <td>${escapeHtml(item.rg || '-')}</td>
      <td>${escapeHtml(item.cpf || '-')}</td>
      <td>${escapeHtml(item.placa || '-')}</td>
      <td>${escapeHtml(item.modelo || '-')}</td>
      <td>${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : '-')}</td>
    </tr>
  `).join('');

  return `
    <div class="epo-table-wrap">
      <table class="epo-table">
        <thead>
          <tr>
            <th>Nome do Técnico</th>
            <th>RG</th>
            <th>CPF</th>
            <th>Placa Carro</th>
            <th>Modelo Carro</th>
            <th>Cadastrado em</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderListaEquipesEpo() {
  const container = document.getElementById('epo-action-content');
  if (!container) return;

  const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
  container.innerHTML = `
    <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • LISTA DE EQUIPES</p>
    <button type="button" class="btn-primary" onclick="toggleCadastroTecnicoEpo()">CADASTRAR TÉCNICO</button>

    <div id="cadastro-tecnico-form" class="epo-form-shell" style="display:none;">
      <div class="epo-form-grid">
        <input id="epo-tecnico-nome" type="text" placeholder="NOME DO TECNICO" />
        <input id="epo-tecnico-rg" type="text" placeholder="RG" />
        <input id="epo-tecnico-cpf" type="text" placeholder="CPF" />
        <input id="epo-tecnico-placa" type="text" placeholder="PLACA CARRO" />
        <input id="epo-tecnico-modelo" type="text" placeholder="MODELO CARRO" />
      </div>
      <div class="epo-form-actions">
        <button type="button" class="btn-primary" onclick="salvarCadastroTecnicoEpo()">SALVAR CADASTRO</button>
      </div>
      <div class="epo-form-actions epo-upload-row">
        <input id="epo-tecnicos-file" type="file" accept=".csv,.txt" style="display:none;" onchange="importarTecnicosEpoPorPlanilha()" />
        <button type="button" class="btn-secondary epo-clip-upload" onclick="abrirSeletorPlanilhaTecnicosEpo()" title="Adicionar planilha">📎</button>
        <span id="epo-tecnicos-file-name" class="epo-file-name">Nenhum arquivo selecionado</span>
      </div>
      <p class="epo-upload-note">Importação esperada: NOME DO TECNICO, RG, CPF, PLACA CARRO, MODELO CARRO.</p>
    </div>

    ${renderTabelaTecnicosEpo(tecnicos)}
  `;
}

function toggleCadastroTecnicoEpo() {
  const form = document.getElementById('cadastro-tecnico-form');
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function abrirSeletorPlanilhaTecnicosEpo() {
  const input = document.getElementById('epo-tecnicos-file');
  if (input) input.click();
}

function salvarCadastroTecnicoEpo() {
  if (!epoSelecionadaAtual) return;

  const nome = (document.getElementById('epo-tecnico-nome')?.value || '').trim();
  const rg = (document.getElementById('epo-tecnico-rg')?.value || '').trim();
  const cpf = (document.getElementById('epo-tecnico-cpf')?.value || '').trim();
  const placa = (document.getElementById('epo-tecnico-placa')?.value || '').trim();
  const modelo = (document.getElementById('epo-tecnico-modelo')?.value || '').trim();

  if (!nome || !rg || !cpf || !placa || !modelo) {
    alert('⚠️ Preencha todos os campos do cadastro técnico.');
    return;
  }

  const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
  tecnicos.push({ nome, rg, cpf, placa, modelo, createdAt: new Date().toISOString() });
  saveTecnicosDaEpo(epoSelecionadaAtual, tecnicos);

  executarAcaoEpo('equipes');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `✅ Técnico cadastrado com sucesso em ${epoSelecionadaAtual}.`;
}

function importarTecnicosEpoPorPlanilha() {
  if (!epoSelecionadaAtual) return;

  const input = document.getElementById('epo-tecnicos-file');
  const nomeArquivo = document.getElementById('epo-tecnicos-file-name');
  const file = input?.files?.[0];
  if (!file) {
    if (nomeArquivo) nomeArquivo.textContent = 'Nenhum arquivo selecionado';
    alert('⚠️ Selecione uma planilha CSV para importar os técnicos.');
    return;
  }

  if (nomeArquivo) nomeArquivo.textContent = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = String(e.target?.result || '').replace(/^\uFEFF/, '');
    const cabecalho = text.split(/\r?\n/)[0] || '';
    const delimiter = cabecalho.includes(';') ? ';' : ',';
    const linhas = parseGenericCsvRows(text, delimiter);

    const novos = linhas.map(item => ({
      nome: getField(item, 'NOME DO TECNICO', 'NOME_TECNICO', 'NOME', 'nome') || '',
      rg: getField(item, 'RG', 'rg') || '',
      cpf: getField(item, 'CPF', 'cpf') || '',
      placa: getField(item, 'PLACA CARRO', 'PLACA', 'placa') || '',
      modelo: getField(item, 'MODELO CARRO', 'MODELO', 'modelo') || '',
      createdAt: new Date().toISOString()
    })).filter(item => item.nome);

    if (!novos.length) {
      alert('⚠️ Não foi possível identificar técnicos na planilha.');
      return;
    }

    const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
    saveTecnicosDaEpo(epoSelecionadaAtual, [...tecnicos, ...novos]);
    executarAcaoEpo('equipes');

    const resultEl = document.getElementById('epo-action-result');
    if (resultEl) resultEl.textContent = `✅ ${novos.length} técnico(s) importado(s) para ${epoSelecionadaAtual}.`;

    if (input) input.value = '';
    if (nomeArquivo) nomeArquivo.textContent = 'Nenhum arquivo selecionado';
  };

  reader.readAsText(file);
}

function getBacklogParaNovosEntrantes() {
  const preferred = getPreferredDataset('backlog');
  if (Array.isArray(preferred) && preferred.length) return preferred;

  const local = getLocalDatasetCache()?.backlog?.items;
  if (Array.isArray(local) && local.length) return local;

  return [];
}

function renderNovosEntrantesEpo() {
  const container = document.getElementById('epo-action-content');
  if (!container) return;

  const dados = getEpoNovosParaEpo(epoSelecionadaAtual);
  if (!dados.length) {
    container.innerHTML = '<p class="epo-empty-state">Nenhum endereço encontrado para esta EPO. Use o 📎 para importar a planilha com STATUS 1.VISTORIA.</p>';
    return;
  }

  const aceitesStore = getEpoAceitesStore();
  const listaAceites = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);
  const aceites = new Map(listaAceites.map((item) => [String(item.codigo), item]));
  window.__epoNovosEntrantesRows = dados;

  const rows = dados.map((item, idx) => {
    const codigo = String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || `LINHA-${idx + 1}`);
    const tipoRede = getField(item, 'TIPO_REDE', 'tipo_rede', 'TIPO DE REDE') || '-';
    const enderecoBase = getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '-';
    const numero = getField(item, 'NUMERO', 'numero', 'num') || '-';
    const bairro = getField(item, 'BAIRRO', 'bairro') || '-';
    const cidade = getField(item, 'CIDADE', 'cidade') || '-';
    const solicitante = getField(item, 'SOLICITANTE', 'solicitante') || '-';
    const status = getField(item, 'STATUS_GERAL', 'STATUS', 'status') || '-';
    const motivo = getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo') || '-';
    const aceiteInfo = aceites.get(codigo);
    const aceito = Boolean(aceiteInfo);
    const responsavel = aceiteInfo?.responsavel || '-';
    const destaqueRecente = Boolean(
      aceito && epoUltimoAceite
      && epoUltimoAceite.epo === epoSelecionadaAtual
      && epoUltimoAceite.codigo === codigo
      && (Date.now() - Number(epoUltimoAceite.at || 0) <= 15000)
    );

    return `
      <tr class="${aceito ? 'epo-row-aceita' : ''} ${destaqueRecente ? 'epo-row-aceita-recente' : ''}">
        <td>${escapeHtml(codigo)}</td>
        <td>${escapeHtml(tipoRede)}</td>
        <td>${escapeHtml(enderecoBase)}</td>
        <td>${escapeHtml(numero)}</td>
        <td>${escapeHtml(bairro)}</td>
        <td>${escapeHtml(cidade)}</td>
        <td>${escapeHtml(solicitante)}</td>
        <td>${escapeHtml(status)}</td>
        <td>
          <div class="epo-inline-actions">
            <button type="button" class="btn-secondary" onclick="visualizarNovoEntrante(${idx})">Visualizar</button>
            <button type="button" class="btn-primary ${aceito ? `epo-btn-aceito ${destaqueRecente ? 'pulse' : ''}` : ''}" ${aceito ? 'disabled' : ''} onclick="aceitarNovoEntrante(${idx})">${aceito ? 'Aceito' : 'Aceite'}</button>
          </div>
          ${aceito ? `<p class="epo-aceite-owner">Responsável: ${escapeHtml(responsavel)}</p>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • NOVOS ENTRANTES (${dados.length})</p>
    <div class="epo-table-wrap">
      <table class="epo-table">
        <thead>
          <tr>
            <th>COD-MDUGO</th>
            <th>TIPO_REDE</th>
            <th>ENDEREÇO</th>
            <th>NUMERO</th>
            <th>BAIRRO</th>
            <th>CIDADE</th>
            <th>SOLICITANTE</th>
            <th>STATUS_GERAL</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function visualizarNovoEntrante(index) {
  const item = window.__epoNovosEntrantesRows?.[index];
  if (!item) return;

  const codigo = String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || `LINHA-${index + 1}`);
  const enderecoBase = getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '-';
  const numero = getField(item, 'NUMERO', 'numero', 'num') || '-';
  const enderecoCompleto = numero && numero !== '-' ? `${enderecoBase}, ${numero}` : enderecoBase || '-';
  const bairro = getField(item, 'BAIRRO', 'bairro') || '-';
  const cidade = getField(item, 'CIDADE', 'cidade') || '-';
  const tipoRede = getField(item, 'TIPO_REDE', 'tipo_rede', 'TIPO DE REDE') || '-';
  const contato = getField(item, 'CONTATO', 'contato', 'TELEFONE') || '-';
  const status = getField(item, 'STATUS_GERAL', 'STATUS', 'status') || '-';
  const motivo = getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo') || '-';
  const obsOriginal = getField(item, 'OBS', 'OBSERVACAO', 'observacao') || '-';
  const nodeAreaTecnica = getField(item, 'NODE&ÁREA TÉCNICA', 'NODE&AREA TECNICA', 'NODE_AREA_TECNICA', 'NODE', 'node') || '-';
  const dadosCliente = getField(item, 'DADOS_CLIENTE', 'DADOS CLIENTE', 'dados_cliente') || '-';
  const solicitante = getField(item, 'SOLICITANTE', 'solicitante') || '-';

  const aceitesStore = getEpoAceitesStore();
  const listaAceites = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);
  const aceiteInfo = listaAceites.find((entry) => String(entry.codigo) === codigo) || null;
  const responsavelAceite = aceiteInfo?.responsavel || 'Sem responsável';
  const aceiteEm = formatDateTimeBr(aceiteInfo?.aceitoEm);

  const referencia = `${epoSelecionadaAtual || 'EPO'}::${codigo}`;
  currentPendenteCodigo = referencia;

  document.getElementById('modal-codigo').textContent = codigo;
  document.getElementById('modal-endereco').textContent = enderecoCompleto;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epoSelecionadaAtual || '-';
  document.getElementById('modal-status').innerHTML = renderModalBadge(status);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(motivo);
  document.getElementById('modal-obs-original').textContent = obsOriginal;
  document.getElementById('modal-obs-adicional').value = '';

  applyModalContext({
    themeClass: 'empresarial-modal',
    title: 'Detalhes EPO',
    kicker: 'Painel executivo de novos entrantes',
    heroChip: 'EPO',
    heroTitle: enderecoCompleto || codigo,
    heroSubtitle: [cidade, bairro, epoSelecionadaAtual].filter(v => v && v !== '-').join(' • ') || 'Visualização detalhada do entrante selecionado.',
    statusLabel: 'Status Geral',
    motivoLabel: 'Motivo Geral',
    heroPills: [
      { label: 'COD-MDUGO', value: codigo },
      { label: 'NOME', value: dadosCliente },
      { label: 'CONTATO', value: contato },
      { label: 'STATUS', value: status, badge: true },
      { label: 'MOTIVO', value: motivo, badge: true }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const oldExtra = modalBody.querySelector('.modal-extra.modal-extra-grid');
    if (oldExtra) oldExtra.remove();
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('NODE&ÁREA TÉCNICA', nodeAreaTecnica, { featured: true })}
        ${renderModalInfoCard('TIPO_REDE', tipoRede, { featured: true })}
        ${renderModalInfoCard('DADOS_CLIENTE', dadosCliente)}
        ${renderModalInfoCard('CONTATO', contato)}
        ${renderModalInfoCard('SOLICITANTE', solicitante)}
        ${renderModalInfoCard('RESPONSÁVEL DO ACEITE', responsavelAceite)}
        ${renderModalInfoCard('ACEITO EM', aceiteEm)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  await carregarObservacoesPendente(referencia);
  await carregarAnexosPendente(referencia);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const footer = document.querySelector('#modal-obs .modal-footer');
  if (footer) {
    const oldBtn = document.getElementById('modal-retirar-responsavel');
    if (oldBtn) oldBtn.remove();

    if (aceiteInfo) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'modal-retirar-responsavel';
      btn.className = 'btn-secondary';
      btn.textContent = 'Retirar do responsável';
      btn.onclick = () => retirarResponsavelNovoEntrante(index);
      footer.insertBefore(btn, footer.querySelector('.btn-primary'));
    }
  }

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = '';
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(referencia, file);
      }
    };
  }
}

async function aceitarNovoEntrante(index) {
  const item = window.__epoNovosEntrantesRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || `LINHA-${index + 1}`);
  const aceitesStore = getEpoAceitesStore();
  const listaAtual = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);
  const responsavel = getNomeResponsavelAtual();
  const idxExistente = listaAtual.findIndex((entry) => String(entry.codigo) === codigo);

  if (idxExistente === -1) {
    listaAtual.push({ codigo, responsavel, aceitoEm: new Date().toISOString() });
  } else {
    listaAtual[idxExistente] = {
      ...listaAtual[idxExistente],
      responsavel,
      aceitoEm: new Date().toISOString()
    };
  }

  aceitesStore[epoSelecionadaAtual] = listaAtual;
  saveEpoAceitesStore(aceitesStore);

  epoUltimoAceite = {
    epo: epoSelecionadaAtual,
    codigo,
    at: Date.now()
  };

  executarAcaoEpo('novos');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `✅ Endereço ${codigo} aceito por ${responsavel}.`;

  await visualizarNovoEntrante(index);
}

async function retirarResponsavelNovoEntrante(index) {
  const item = window.__epoNovosEntrantesRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || `LINHA-${index + 1}`);
  const aceitesStore = getEpoAceitesStore();
  const listaAtual = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);

  aceitesStore[epoSelecionadaAtual] = listaAtual.filter((entry) => String(entry.codigo) !== codigo);
  saveEpoAceitesStore(aceitesStore);

  if (epoUltimoAceite && epoUltimoAceite.epo === epoSelecionadaAtual && epoUltimoAceite.codigo === codigo) {
    epoUltimoAceite = null;
  }

  executarAcaoEpo('novos');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `↩️ Responsável removido do endereço ${codigo}. O aceite foi liberado novamente.`;

  await visualizarNovoEntrante(index);
}

function selecionarEpo(nomeEpo) {
  epoSelecionadaAtual = String(nomeEpo || '').trim();

  const panel = document.getElementById('epo-action-panel');
  const selectedNameEl = document.getElementById('epo-selected-name');
  const resultEl = document.getElementById('epo-action-result');

  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.epo === epoSelecionadaAtual);
  });
  atualizarCountPillsEpo();

  if (panel) panel.style.display = 'block';
  if (selectedNameEl) selectedNameEl.textContent = epoSelecionadaAtual || '-';
  if (resultEl) {
    resultEl.textContent = epoSelecionadaAtual
      ? `Selecione uma opção para ${epoSelecionadaAtual}.`
      : 'Selecione uma EPO para habilitar as opções.';
  }

  if (epoAcaoAtual) {
    executarAcaoEpo(epoAcaoAtual);
  }
}

function executarAcaoEpo(tipoAcao) {
  epoAcaoAtual = tipoAcao;
  setEpoActionButtonActive(tipoAcao);

  const resultEl = document.getElementById('epo-action-result');
  if (!epoSelecionadaAtual) {
    if (resultEl) {
      resultEl.textContent = 'Selecione uma EPO antes de clicar nas opções.';
    }
    return;
  }

  const acao = tipoAcao === 'equipes' ? 'LISTA DE EQUIPES' : 'NOVOS ENTRANTES';

  if (tipoAcao === 'equipes') {
    renderListaEquipesEpo();
  } else {
    renderNovosEntrantesEpo();
  }

  if (resultEl) {
    resultEl.textContent = `✅ ${acao} clicado para ${epoSelecionadaAtual}.`;
  }
}

// Auxiliares para normalizar textos e chaves de CSV (para lidar com acentos, maiúsculas, espaços)
function normalizeText(text) {
  if (!text && text !== 0) return "";
  return text.toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeKey(key) {
  return normalizeText(key).replace(/[^a-z0-9]/g, "_");
}

const normalizedItemKeyCache = new WeakMap();
const visaoGerenciaAggCache = new Map();
const visaoGerenciaDatasetVersion = new WeakMap();
let visaoGerenciaDatasetCounter = 0;
let visaoGerenciaRenderQueued = false;

function getNormalizedItemMap(item) {
  if (!item || typeof item !== "object") return null;

  let cached = normalizedItemKeyCache.get(item);
  if (!cached) {
    cached = {};
    Object.keys(item).forEach(originalKey => {
      const normalized = normalizeKey(originalKey);
      if (normalized && cached[normalized] === undefined) {
        cached[normalized] = originalKey;
      }
    });
    normalizedItemKeyCache.set(item, cached);
  }

  return cached;
}

function getDatasetVersionToken(dataset) {
  if (!Array.isArray(dataset)) return 'empty';

  let version = visaoGerenciaDatasetVersion.get(dataset);
  if (!version) {
    version = ++visaoGerenciaDatasetCounter;
    visaoGerenciaDatasetVersion.set(dataset, version);
  }

  return `${version}:${dataset.length}`;
}

function buildAnalyticsCacheKey(prefix, dataset, options = {}) {
  const optionKey = Object.entries(options)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : String(value ?? '')}`)
    .join('::');

  return `${prefix}::${getDatasetVersionToken(dataset)}::${optionKey}`;
}

function invalidateVisaoGerenciaCache() {
  visaoGerenciaAggCache.clear();
}

function agendarRenderVisaoGerencia(force = false) {
  const section = document.getElementById('pesquisa');
  if (!section) return;

  const isVisible = section.classList.contains('ativa');
  if (!force && !isVisible) return;
  if (visaoGerenciaRenderQueued) return;

  visaoGerenciaRenderQueued = true;

  window.setTimeout(() => {
    window.requestAnimationFrame(() => {
      visaoGerenciaRenderQueued = false;
      renderVisaoGerencia();
    });
  }, 0);
}

function getField(item, ...keys) {
  if (!item) return "";

  const normalizedMap = getNormalizedItemMap(item);

  for (const key of keys) {
    if (!key) continue;

    if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
      return item[key];
    }

    const normalized = normalizeKey(key);
    const originalKey = normalizedMap?.[normalized];
    if (originalKey !== undefined && item[originalKey] !== undefined && item[originalKey] !== null && item[originalKey] !== "") {
      return item[originalKey];
    }
  }

  return "";
}

function getStatusText(item) {
  // Busca em todas as chaves que contêm "STATUS" para tornar a seleção mais tolerante
  const statusFields = Object.keys(item).filter(k => /status/i.test(k));
  const valores = statusFields.map(k => item[k] || "").filter(Boolean);
  return valores.join(" ");
}

// Renderização específica para Pendente Autorização
function renderTabelaPendente(tabelaId, lista) {
  const tbody = document.getElementById(tabelaId);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center">Nenhum registro</td></tr>`;
    return;
  }

  let html = "";
  lista.forEach(item => {
    const codigo = getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo").toString();
    const endereco = `${getField(item, "ENDEREÇO", "ENDERECO")} ${getField(item, "NUMERO", "NUM")} `.trim();
    const cidade = getField(item, "CIDADE", "cidade");
    const age = getField(item, "AGE", "age");
    const status = getField(item, "STATUS_GERAL", "STATUS", "status");
    const motivo = getField(item, "MOTIVO_GERAL", "MOTIVO", "motivo");

    // Escape simples para evitar quebra de JS caso o código contenha aspas
    const codigoEscaped = codigo.replace(/'/g, "\\'");

    html += `
      <tr>
        <td>${codigo}</td>
        <td>${endereco}</td>
        <td>${cidade}</td>
        <td>${age}</td>
        <td>${status}</td>
        <td>${motivo}</td>
        <td><button class="btn-visualizar" onclick="abrirDetalhesPendente('${codigoEscaped}')">🔍 Visualizar</button></td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function setPendenteTab(tab) {
  pendenteActiveTab = tab;
  document.getElementById('tab-vistoria')?.classList.toggle('active', tab === 'vistoria');
  document.getElementById('tab-backbone')?.classList.toggle('active', tab === 'backbone');

  const cardVistoria = document.getElementById('card-pendente-vistoria');
  const cardBackbone = document.getElementById('card-pendente-backbone');
  if (cardVistoria) cardVistoria.style.display = tab === 'vistoria' ? 'block' : 'none';
  if (cardBackbone) cardBackbone.style.display = tab === 'backbone' ? 'block' : 'none';

  renderPendenteAutorizacao();
}

function renderPendenteAutorizacao() {
  const dados = (dadosPorCategoria['pendente-autorizacao'] || []).filter(item => item.__pendenteTipo === pendenteActiveTab);
  const MAX_DISPLAY = 2500;
  const dadosParaRender = dados.length > MAX_DISPLAY ? dados.slice(0, MAX_DISPLAY) : dados;

  const statusMsgEl = document.getElementById('import-status');
  if (statusMsgEl) {
    if (dados.length > MAX_DISPLAY) {
      statusMsgEl.textContent = `⚠️ Mostrando os primeiros ${MAX_DISPLAY} de ${dados.length} registros. Use o filtro para refinar.`;
    } else {
      statusMsgEl.textContent = `✅ Importado ${dados.length} registro(s)`;
    }
  }

  const tabelaId = pendenteActiveTab === 'vistoria' ? 'tabela-pendente-vistoria' : 'tabela-pendente-backbone';
  renderTabelaPendente(tabelaId, dadosParaRender);
}

function getStorageKeyObs(codigo) {
  return `pendente_obs_${codigo}`;
}

function getStorageKeyAnexos(codigo) {
  return `pendente_anexos_${codigo}`;
}

async function abrirDetalhesPendente(codigo) {
  currentPendenteCodigo = codigo;
  const dados = dadosPorCategoria['pendente-autorizacao'] || [];
  const item = dados.find(i => ((i["COD-MDUGO"] || i["cod-mdugo"] || "") + "").toString() === codigo);
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  resetModalPresentation();

  document.getElementById('modal-codigo').textContent = codigo;
  document.getElementById('modal-endereco').textContent = `${getField(item, "ENDEREÇO", "ENDERECO")} ${getField(item, "NUMERO", "NUM")} `.trim();
  document.getElementById('modal-bairro').textContent = getField(item, "BAIRRO", "bairro") || "-";
  document.getElementById('modal-cidade').textContent = getField(item, "CIDADE", "cidade");
  document.getElementById('modal-epo').textContent = getField(item, "EPO", "epo") || "-";
  document.getElementById('modal-status').innerHTML = renderModalBadge(getField(item, "STATUS_GERAL", "STATUS", "status") || '-');
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(getField(item, "MOTIVO_GERAL", "MOTIVO", "motivo") || '-');
  document.getElementById('modal-obs-original').textContent = getField(item, "OBS", "OBSERVACAO", "observacao") || "-";

  document.getElementById('modal-obs-adicional').value = "";

  await carregarObservacoesPendente(codigo);
  await carregarAnexosPendente(codigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = "";
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(codigo, file);
      }
    };
  }
}

function fecharModalObs() {
  const modal = document.getElementById('modal-obs');
  if (modal) {
    modal.classList.add('hidden');
  }

  resetModalPresentation();

  const statusLabel = document.getElementById('modal-status')?.closest('.modal-row')?.querySelector('label');
  const motivoLabel = document.getElementById('modal-motivo')?.closest('.modal-row')?.querySelector('label');
  const modalHeader = document.querySelector('#modal-obs .modal-header h2');
  const modalKicker = document.querySelector('#modal-obs .modal-kicker');

  if (statusLabel) statusLabel.textContent = 'Status Geral';
  if (motivoLabel) motivoLabel.textContent = 'Motivo Geral';
  if (modalHeader) modalHeader.textContent = 'Detalhes Pendente Autorização';
  if (modalKicker) modalKicker.textContent = 'Visualização detalhada';

  currentPendenteCodigo = null;
}

async function salvarObsModal() {
  if (!currentPendenteCodigo) return;

  const valor = (document.getElementById('modal-obs-adicional')?.value || "").trim();
  if (!valor) {
    alert('⚠️ Digite algo para salvar.');
    return;
  }

  const user = getCurrentUser();
  const useApi = window.location.protocol.startsWith('http');
  const reference = encodeURIComponent(String(currentPendenteCodigo));

  if (useApi) {
    try {
      const res = await fetch(`/api/pendente/${reference}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: valor }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao salvar observação');
      }

      document.getElementById('modal-obs-adicional').value = "";
      await carregarObservacoesPendente(currentPendenteCodigo);
      updateNotificationBadge();
      const panel = document.getElementById('notificationPanel');
      if (panel && !panel.classList.contains('hidden')) {
        await renderNotificationList();
      }
      alert('✅ Observação salva.');
      return;
    } catch (err) {
      console.warn('Falha ao salvar observação via API, salvando localmente', err);
      // fallback para localStorage abaixo
    }
  }

  // Fallback local
  const key = getStorageKeyObs(currentPendenteCodigo);
  const metadata = {
    value: valor,
    created_by: user?.name || user?.username || 'Local',
    created_at: new Date().toISOString(),
  };
  localStorage.setItem(key, JSON.stringify(metadata));
  await carregarObservacoesPendente(currentPendenteCodigo);
  updateNotificationBadge();
  const panel = document.getElementById('notificationPanel');
  if (panel && !panel.classList.contains('hidden')) {
    await renderNotificationList();
  }
  alert('✅ Observação salva localmente.');
}

async function carregarObservacoesPendente(codigo) {
  const useApi = window.location.protocol.startsWith('http');
  const reference = encodeURIComponent(String(codigo));
  let notes = [];

  if (useApi) {
    try {
      const res = await fetch(`/api/pendente/${reference}/notes`, { credentials: 'include' });
      if (res.ok) {
        notes = await res.json();
      }
    } catch {
      notes = [];
    }
  }

  if (!notes || !notes.length) {
    const raw = localStorage.getItem(getStorageKeyObs(codigo));
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.value) {
          notes = [
            {
              note: parsed.value,
              created_by: parsed.created_by || 'Local',
              created_at: parsed.created_at || new Date().toISOString(),
            },
          ];
        }
      } catch {
        notes = [];
      }
    }
  }

  renderObservacoesLista(codigo, notes);
}

function renderObservacoesLista(codigo, notas) {
  const container = document.getElementById('modal-notes');
  if (!container) return;

  if (!notas || notas.length === 0) {
    container.innerHTML = '<li style="opacity:.7">Nenhuma observação registrada.</li>';
    return;
  }

  container.innerHTML = notas
    .map(n => {
      const who = n.created_by ? `por ${n.created_by}` : '';
      const when = n.created_at ? ` (${new Date(n.created_at).toLocaleString()})` : '';
      return `<li style="margin-bottom:6px;"><strong>${who}</strong>${when}: ${n.note}</li>`;
    })
    .join('');
}

async function carregarAnexosPendente(codigo) {
  const useApi = window.location.protocol.startsWith('http');
  const reference = encodeURIComponent(String(codigo));
  let anexos = [];
  let isAdmin = false;

  const user = getCurrentUser();
  if (user) isAdmin = user.role === 'admin';

  const anexoInput = document.getElementById('modal-anexo');
  const helper = document.getElementById('modal-anexo-helper');
  if (anexoInput) {
    const allow = useApi && Boolean(user);
    anexoInput.style.display = allow ? 'block' : 'none';
  }
  const anexoButton = document.getElementById('modal-anexo-button');
  if (anexoButton) {
    const allow = useApi && Boolean(user);
    anexoButton.style.display = allow ? 'inline-flex' : 'none';
  }
  if (helper) {
    helper.textContent = !useApi
      ? 'Recursos offline: anexos não estão disponíveis. Use o servidor para salvar anexos.'
      : user
      ? 'Anexe arquivos para este endereço sempre que necessário.'
      : 'Faça login para anexar arquivos.';
  }

  if (useApi) {
    try {
      const res = await fetch(`/api/pendente/${reference}/attachments`, { credentials: 'include' });
      if (res.ok) {
        anexos = await res.json();
      }
    } catch {
      anexos = [];
    }
  }

  if (!anexos || anexos.length === 0) {
    // Fallback local storage
    const lista = JSON.parse(localStorage.getItem(getStorageKeyAnexos(codigo)) || '[]');
    if (lista && lista.length) {
      anexos = lista.map((item, idx) => ({
        id: idx,
        filename: item.name || `Anexo ${idx + 1}`,
        dataUrl: item.dataUrl,
        created_by: item.created_by || 'Local',
        created_at: item.created_at || new Date().toISOString(),
        isLocal: true,
      }));
    }
  }

  renderAnexosLista(codigo, anexos);
}

async function uploadAnexoPendente(codigo, file) {
  const useApi = window.location.protocol.startsWith('http');
  const user = getCurrentUser();
  const reference = encodeURIComponent(String(codigo));

  if (useApi && user) {
    const form = new FormData();
    form.append('file', file);

    try {
      const res = await fetch(`/api/pendente/${reference}/attachments`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Falha ao enviar anexo');
      }

      await carregarAnexosPendente(codigo);
      alert('✅ Anexo enviado com sucesso.');
      return;
    } catch (err) {
      console.warn('Falha ao enviar anexo via API:', err);
    }
  }

  // Fallback local storage
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const key = getStorageKeyAnexos(codigo);
    const atual = JSON.parse(localStorage.getItem(key) || '[]');
    atual.push({
      name: file.name,
      type: file.type,
      dataUrl,
      created_by: user?.name || user?.username || 'Local',
      created_at: new Date().toISOString(),
    });
    localStorage.setItem(key, JSON.stringify(atual));
    carregarAnexosPendente(codigo);
  };
  reader.readAsDataURL(file);
}

function renderAnexosLista(codigo, anexos) {
  const container = document.getElementById('modal-anexos');
  if (!container) return;

  if (!anexos || anexos.length === 0) {
    container.innerHTML = '<li style="opacity:.7">Nenhum anexo</li>';
    return;
  }

  container.innerHTML = anexos
    .map((item, index) => {
      const name = item.filename || `Anexo ${index + 1}`;
      const createdBy = item.created_by ? ` por ${item.created_by}` : '';
      const createdAt = item.created_at ? ` (${new Date(item.created_at).toLocaleString()})` : '';
      const href = item.dataUrl ? item.dataUrl : `/api/pendente/${encodeURIComponent(String(codigo))}/attachments/${item.id}`;
      const downloadAttr = item.dataUrl ? `download="${name}"` : '';
      return `
      <li style="margin-bottom:6px;">
        <a href="${href}" ${downloadAttr} style="font-weight:600;">${name}</a> <span style="opacity:.7;">${createdBy}${createdAt}</span>
      </li>`;
    })
    .join('');
}

function carregarDaBacklog(categoriaId) {
  const localSnapshot = getLocalDatasetCache()?.[categoriaId];
  const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
  const shouldPreserveManualImport = ['empresarial', 'mdu-ongoing'].includes(categoriaId)
    && Boolean(localSnapshot?.locked)
    && localItems.length;

  if (shouldPreserveManualImport) {
    applyDatasetToState(categoriaId, localItems);

    if (categoriaId === 'empresarial') {
      renderTabelaEmpresarial(`tabela-${categoriaId}`, localItems);
      popularFiltrosEmpresarial(localItems);
    } else if (categoriaId === 'mdu-ongoing') {
      renderTabelaMduOngoing(`tabela-${categoriaId}`, localItems);
    }

    atualizarContadores();
    invalidateVisaoGerenciaCache();
    agendarRenderVisaoGerencia();
    return;
  }

  // Carregar automaticamente da BACKLOG via API
  fetch(`/api/backlog/${categoriaId}`, { credentials: "include" })
    .then(response => {
      if (!response.ok) throw new Error('Erro na API');
      return response.json();
    })
    .then(dados => {
      if (categoriaId === 'empresarial') {
        dados = dados.filter(item => {
          const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').toLowerCase().trim();
          return solicitante.includes('empresarial');
        });
      }

      applyDatasetToState(categoriaId, dados);
      if (['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId)) {
        persistirDadosCompartilhados(categoriaId, dados);
      }
      
      // Re-renderizar após carregar
      if (categoriaId === 'pendente-autorizacao') {
        setPendenteTab(pendenteActiveTab);
      } else if (categoriaId === 'empresarial') {
        renderTabelaEmpresarial(`tabela-${categoriaId}`, dados);
        popularFiltrosEmpresarial();
      } else if (categoriaId === 'mdu-ongoing') {
        renderTabelaMduOngoing(`tabela-${categoriaId}`, dados);
      } else {
        const tabelaId = `tabela-${categoriaId}`;
        const tabela = document.getElementById(tabelaId);
        if (tabela) {
          renderTabela(tabelaId, dados, false);
        }
      }
      atualizarContadores();
      invalidateVisaoGerenciaCache();
      agendarRenderVisaoGerencia();
      
      console.log(`Carregados ${dados.length} registros para ${categoriaId}`);
    })
    .catch(error => {
      console.error('Erro ao carregar BACKLOG:', error);
    });
}

function carregarDadosCategoria(categoriaId) {
  if (!categoriaId) return;

  // Caso especial: Ongoing usa um parser diferente e layout de tabela próprio
  if (categoriaId === 'ongoing') {
    if ((!dadosCSVOngoing || dadosCSVOngoing.length === 0) && dadosPorCategoria['ongoing']) {
      dadosCSVOngoing = dadosPorCategoria['ongoing'];
      dadosCSVOngoingOriginal = dadosCSVOngoing;
    }
    renderTabelaOngoing(dadosCSVOngoing || []);
    atualizarContadores();
    return;
  }

  // Verificar se já temos dados carregados para esta categoria
  let dados = getPreferredDataset(categoriaId);

  const localCache = getLocalDatasetCache();
  if ((!dados || dados.length === 0) && Array.isArray(localCache?.[categoriaId]?.items) && localCache[categoriaId].items.length) {
    applyDatasetToState(categoriaId, localCache[categoriaId].items);
    dados = localCache[categoriaId].items;
  }

  // Se for uma categoria derivada do backlog, tentar montar localmente antes de recorrer à API
  if ((!dados || dados.length === 0) && ['empresarial', 'mdu-ongoing', 'pendente-autorizacao', 'sar-rede'].includes(categoriaId)) {
    const backlogLocal = dadosPorCategoria['backlog'] || [];
    if (backlogLocal.length && !hasLockedDataset(categoriaId)) {
      const derivados = getDerivedBacklogItems(categoriaId, backlogLocal);
      if (derivados.length) {
        applyDatasetToState(categoriaId, derivados);
        dados = derivados;
      }
    }
  }

  // Se ainda não temos dados, carregar automaticamente do backlog pela API
  if ((!dados || dados.length === 0) && ['empresarial', 'mdu-ongoing', 'pendente-autorizacao', 'sar-rede'].includes(categoriaId)) {
    dados = carregarDaBacklog(categoriaId);
    if (dados) {
      applyDatasetToState(categoriaId, dados);
    }
  }

  if (categoriaId === 'pendente-autorizacao') {
    // Ajustar visibilidade dos 'tabs' e renderizar apenas o ativo
    setPendenteTab(pendenteActiveTab);
    atualizarContadores();
    return;
  }

  const tabelaId = `tabela-${categoriaId}`;
  const tabela = document.getElementById(tabelaId);

  if (tabela) {
    if (categoriaId === 'empresarial') {
      renderTabelaEmpresarial(tabelaId, dados || []);
    } else if (categoriaId === 'mdu-ongoing') {
      if (!dados) {
        carregarDaBacklog('mdu-ongoing');
      } else {
        renderTabelaMduOngoing(tabelaId, dados);
      }
    } else if (categoriaId === 'projeto-f') {
      if ((!dados || dados.length === 0) && window.location.protocol.startsWith('http')) {
        fetch('/api/shared_datasets', { credentials: 'include' })
          .then(response => response.ok ? response.json() : null)
          .then(payload => {
            const itensCompartilhados = payload?.datasets?.['projeto-f']?.items;
            if (Array.isArray(itensCompartilhados) && itensCompartilhados.length) {
              applyDatasetToState('projeto-f', itensCompartilhados);
              cacheDatasetLocally('projeto-f', itensCompartilhados, { source: 'shared' });
              renderTabelaProjetoF(tabelaId, itensCompartilhados);
              atualizarContadores();
            }
          })
          .catch(() => {});
      }
      renderTabelaProjetoF(tabelaId, dados || []);
    } else {
      renderTabela(tabelaId, dados || [], false);
    }
  }

  // Atualizar contador na página inicial
  atualizarContadores();
}

// Filtrar dados por status
function filtrarPorStatus(status) {
  if (!dadosCSV || dadosCSV.length === 0) {
    return [];
  }
  
  return dadosCSV.filter(item => {
    const statusGeral = getField(item, "STATUS_GERAL", "STATUS", "status");
    return statusGeral.includes(status) || statusGeral === status;
  });
}

// Buscar em categoria
function buscarEmCategoria(categoriaId) {
  const secao = document.getElementById(categoriaId);
  const inputElement = secao?.querySelector('.header-search-input');
  const termoBusca = (inputElement?.value || "").toLowerCase().trim();

  if (!termoBusca) {
    alert('🔍 Digite um ID para buscar');
    return;
  }

  const todosDados = dadosPorCategoria[categoriaId] || [];
  let resultado;

  if (categoriaId === 'projeto-f') {
    // Para PROJETO F, buscar por COD-MDUGO ou ENDEREÇO
    resultado = todosDados.filter(item => {
      const codigo = getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo").toString().toLowerCase();
      const endereco = getField(item, "ENDEREÇO", "ENDERECO").toString().toLowerCase();

      return codigo.includes(termoBusca) || endereco.includes(termoBusca);
    });
  } else {
    // Busca padrão para outras categorias
    resultado = todosDados.filter(item => {
      const codigo = getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo").toString().toLowerCase();
      const id = getField(item, "ID", "id").toString().toLowerCase();
      const endereco = getField(item, "ENDEREÇO", "ENDERECO").toString().toLowerCase();

      return codigo.includes(termoBusca) ||
             id.includes(termoBusca) ||
             endereco.includes(termoBusca);
    });
  }

  if (categoriaId === 'pendente-autorizacao') {
    const pendenteVistoria = resultado.filter(item => {
      const status = getField(item, "STATUS_GERAL", "STATUS", "status").toString();
      return status.includes('FILA_PENDENTE_AUTORIZAÇÃO_VISTORIA') || status.includes('1.FILA_PENDENTE_AUTORIZAÇÃO_VISTORIA');
    });

    const pendenteBackbone = resultado.filter(item => {
      const status = getField(item, "STATUS_GERAL", "STATUS", "status").toString();
      return status.includes('FILA_PENDENTE_AUTORIZAÇÃO_BACKBONE') || status.includes('4.FILA_PENDENTE_AUTORIZAÇÃO_BACKBONE');
    });

    renderTabelaPendente('tabela-pendente-vistoria', pendenteVistoria);
    renderTabelaPendente('tabela-pendente-backbone', pendenteBackbone);

    alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
    return;
  }

  if (categoriaId === 'projeto-f') {
    if (resultado.length === 0) {
      alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
      renderTabelaProjetoF('tabela-projeto-f', todosDados);
    } else {
      renderTabelaProjetoF('tabela-projeto-f', resultado);
      alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
    }
    return;
  }

  const tabelaId = `tabela-${categoriaId}`;

  if (resultado.length === 0) {
    alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
    renderTabela(tabelaId, todosDados, false);
  } else {
    renderTabela(tabelaId, resultado, false);
    alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
  }
}

// Atualizar contadores nas categorias
let currentPendenteCodigo = null;

function atualizarContadores() {
  const contadores = {
    'pendente-autorizacao': (dadosPorCategoria['pendente-autorizacao'] || []).length,
    'ongoing': (dadosPorCategoria['ongoing'] || dadosCSVOngoing || []).length,
    'novos-empreendimentos': (dadosPorCategoria['novos-empreendimentos'] || []).length,
    'empresarial': (dadosPorCategoria['empresarial'] || []).length,
    'sar-rede': (dadosPorCategoria['sar-rede'] || []).length,
    'mdu-ongoing': (dadosPorCategoria['mdu-ongoing'] || []).length
  };

  for (const [categoria, count] of Object.entries(contadores)) {
    const elemento = document.getElementById(`count-${categoria}`);
    if (elemento) {
      elemento.textContent = count;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getModalBadgeClass(value) {
  const text = String(value || '').toLowerCase().trim();
  if (!text || text === '-') return 'badge-neutral';
  if (text === 'sim' || text === 'yes' || text === 'true') return 'badge-success';
  if (text === 'nao' || text === 'não' || text === 'no' || text === 'false') return 'badge-danger';
  if (text.includes('ok') || text.includes('conclu') || text.includes('dentro sla') || text.includes('libera')) return 'badge-success';
  if (text.includes('fora sla') || text.includes('cancel') || text.includes('pendente') || text.includes('sem sinal') || text.includes('obstru')) return 'badge-danger';
  return 'badge-warning';
}

function renderModalBadge(value) {
  const text = value || '-';
  return `<span class="modal-badge ${getModalBadgeClass(text)}">${escapeHtml(text)}</span>`;
}

const MODAL_THEME_CLASSES = ['projeto-f-modal', 'empresarial-modal', 'mdu-ongoing-modal'];

function resetModalPresentation() {
  const modal = document.getElementById('modal-obs');
  const modalContent = modal?.querySelector('.modal-content');
  const modalBody = modal?.querySelector('.modal-body');

  if (modalContent) {
    MODAL_THEME_CLASSES.forEach(themeClass => modalContent.classList.remove(themeClass));
  }

  if (modalBody) {
    modalBody.querySelectorAll('.modal-extra').forEach(element => element.remove());
  }
}

function renderModalInfoCard(label, value, options = {}) {
  const content = options.badge
    ? renderModalBadge(value || '-')
    : escapeHtml(value || '-');

  return `
    <div class="modal-info-card${options.featured ? ' featured' : ''}">
      <span class="modal-info-label">${escapeHtml(label)}</span>
      <span class="modal-info-value">${content}</span>
    </div>
  `;
}

function renderModalHeroPills(items = []) {
  return items
    .filter(item => item && (item.value || item.value === 0))
    .map(item => `
      <div class="modal-hero-pill">
        <span class="modal-hero-pill-label">${escapeHtml(item.label)}</span>
        <span class="modal-hero-pill-value">${item.badge ? renderModalBadge(item.value) : escapeHtml(item.value)}</span>
      </div>
    `)
    .join('');
}

function applyModalContext({
  themeClass = '',
  title = 'Detalhes do Registro',
  kicker = 'Visualização detalhada',
  heroChip = 'Registro',
  heroTitle = '',
  heroSubtitle = '',
  statusLabel = 'Status Geral',
  motivoLabel = 'Motivo Geral',
  heroPills = []
} = {}) {
  resetModalPresentation();

  const modal = document.getElementById('modal-obs');
  const modalContent = modal?.querySelector('.modal-content');
  const modalBody = modal?.querySelector('.modal-body');
  const statusLabelElement = document.getElementById('modal-status')?.closest('.modal-row')?.querySelector('label');
  const motivoLabelElement = document.getElementById('modal-motivo')?.closest('.modal-row')?.querySelector('label');
  const modalHeader = document.querySelector('#modal-obs .modal-header h2');
  const modalKicker = document.querySelector('#modal-obs .modal-kicker');

  if (modalContent && themeClass) {
    modalContent.classList.add(themeClass);
  }

  if (statusLabelElement) statusLabelElement.textContent = statusLabel;
  if (motivoLabelElement) motivoLabelElement.textContent = motivoLabel;
  if (modalHeader) modalHeader.textContent = title;
  if (modalKicker) modalKicker.textContent = kicker;

  if (modalBody) {
    const heroHtml = `
      <div class="modal-extra modal-hero-panel">
        <div class="modal-hero-copy">
          <span class="modal-hero-chip">${escapeHtml(heroChip)}</span>
          <h3>${escapeHtml(heroTitle || title)}</h3>
          <p>${escapeHtml(heroSubtitle || 'Acompanhamento detalhado do registro selecionado.')}</p>
        </div>
        <div class="modal-hero-pills">
          ${renderModalHeroPills(heroPills)}
        </div>
      </div>
    `;
    modalBody.insertAdjacentHTML('afterbegin', heroHtml);
  }
}

function visualizarEmpresarial(codigo) {
  currentPendenteCodigo = codigo;
  const dados = dadosPorCategoria['empresarial'] || [];
  const item = dados.find(i => getField(i, "COD-MDUGO") === codigo);
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const enderecoCompleto = `${getField(item, "ENDEREÇO") || '-'} ${getField(item, "NUMERO") || ''}`.trim();
  const bairro = getField(item, "BAIRRO") || '-';
  const cidade = getField(item, "CIDADE") || '-';
  const epo = getField(item, "EPO", "cluster", "regional") || '-';
  const solicitante = getField(item, "SOLICITANTE", "solicitante") || '-';
  const statusGeral = getField(item, "STATUS_GERAL") || '-';
  const motivoGeral = getField(item, "MOTIVO_GERAL") || '-';
  const obsOriginal = getField(item, "OBS") || '-';
  const heroSubtitle = [cidade, bairro, epo].filter(value => value && value !== '-').join(' • ') || 'Registro empresarial selecionado';

  document.getElementById('modal-codigo').textContent = codigo;
  document.getElementById('modal-endereco').textContent = enderecoCompleto;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusGeral);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(motivoGeral);
  document.getElementById('modal-obs-original').textContent = obsOriginal;
  document.getElementById('modal-obs-adicional').value = "";

  applyModalContext({
    themeClass: 'empresarial-modal',
    title: 'Detalhes Empresarial',
    kicker: 'Painel executivo do atendimento empresarial',
    heroChip: 'Empresarial',
    heroTitle: enderecoCompleto || codigo,
    heroSubtitle,
    statusLabel: 'Status Geral',
    motivoLabel: 'Motivo Geral',
    heroPills: [
      { label: 'Código', value: codigo },
      { label: 'Status', value: statusGeral, badge: true },
      { label: 'Motivo', value: motivoGeral, badge: true }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('Solicitante', solicitante, { featured: true })}
        ${renderModalInfoCard('EPO / Cluster', epo)}
        ${renderModalInfoCard('Bairro', bairro)}
        ${renderModalInfoCard('Cidade', cidade)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  carregarObservacoesPendente(codigo);
  carregarAnexosPendente(codigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');
  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = "";
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(codigo, file);
      }
    };
  }
}

function visualizarMduOngoing(codigo) {
  currentPendenteCodigo = codigo;
  const dados = dadosPorCategoria['mdu-ongoing'] || [];
  const item = dados.find(i => getField(i, "COD-MDUGO") === codigo);
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const codigoExibicao = getField(item, "COD-MDUGO") || codigo;
  const enderecoCompleto = `${getField(item, "ENDEREÇO") || '-'} ${getField(item, "NUMERO") || ''}`.trim();
  const bairro = getField(item, "BAIRRO") || '-';
  const cidade = getField(item, "CIDADE") || '-';
  const epo = getField(item, "EPO", "cluster", "regional") || '-';
  const solicitante = getField(item, "SOLICITANTE") || '-';
  const codImovel = getField(item, "COD_IMOVEL", "COD IMOVEL", "cod_imovel") || '-';
  const statusGeral = getField(item, "STATUS_GERAL") || '-';
  const motivoGeral = getField(item, "MOTIVO_GERAL") || '-';
  const obsOriginal = getField(item, "OBS") || '-';
  const tipoRede = getField(item, "TIPO_REDE") || '-';
  const ddd = getField(item, "DDD") || '-';
  const qtdBlocos = getField(item, "QTD_BLOCOS") || '-';
  const qtdHps = getField(item, "QTD_HPS") || '-';
  const venc = getField(item, "Venc", "VENC", "vencimento") || '-';
  const heroSubtitle = [cidade, bairro, epo].filter(value => value && value !== '-').join(' • ') || 'Visão operacional do MDU Ongoing';

  document.getElementById('modal-codigo').textContent = codigoExibicao;
  document.getElementById('modal-endereco').textContent = enderecoCompleto;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusGeral);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(motivoGeral);
  document.getElementById('modal-obs-original').textContent = obsOriginal;
  document.getElementById('modal-obs-adicional').value = "";

  applyModalContext({
    themeClass: 'mdu-ongoing-modal',
    title: 'Detalhes MDU Ongoing',
    kicker: 'Painel premium do MDU Ongoing',
    heroChip: 'MDU Ongoing',
    heroTitle: enderecoCompleto || codigoExibicao,
    heroSubtitle,
    statusLabel: 'Status Geral',
    motivoLabel: 'Motivo Geral',
    heroPills: [
      { label: 'Código', value: codigoExibicao },
      { label: 'Status', value: statusGeral, badge: true },
      { label: 'Motivo', value: motivoGeral, badge: true }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('Tipo Rede', tipoRede, { featured: true })}
        ${renderModalInfoCard('DDD', ddd)}
        ${renderModalInfoCard('Qtd Blocos', qtdBlocos)}
        ${renderModalInfoCard('Qtd HPS', qtdHps)}
        ${renderModalInfoCard('Solicitante', solicitante)}
        ${renderModalInfoCard('Cód. Imóvel', codImovel)}
        ${renderModalInfoCard('Vencimento', venc)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  carregarObservacoesPendente(codigo);
  carregarAnexosPendente(codigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = "";
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(codigo, file);
      }
    };
  }
}

function visualizarProjetoF(source) {
  const dadosRenderizados = window.__projetoFModalData || [];
  const dados = dadosPorCategoria['projeto-f'] || [];

  let item = null;
  let codigoInformado = '';

  if (source && typeof source === 'object' && source.dataset) {
    const rowIndex = Number(source.dataset.rowIndex);
    codigoInformado = source.dataset.recordKey || '';

    if (!Number.isNaN(rowIndex) && dadosRenderizados[rowIndex]) {
      item = dadosRenderizados[rowIndex];
    }
  } else if (source && typeof source === 'object') {
    item = source;
  } else {
    codigoInformado = String(source || '');
  }

  if (!item && codigoInformado) {
    item = dados.find(i => {
      const codigo = String(getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo") || '');
      const codged = String(getField(i, "CODGED", "codged", "cod_ged") || '');
      return codigo === codigoInformado || codged === codigoInformado;
    });
  }

  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const codigo = getField(item, "COD-MDUGO", "CODGED", "cod-mdugo", "codmdugo", "codged", "cod_ged") || codigoInformado || '-';
  const enderecoBase = getField(item, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada") || '-';
  const numero = getField(item, "NUMERO", "numero") || '';
  const enderecoCompleto = [enderecoBase, numero].filter(Boolean).join(' - ') || '-';
  const bairro = getField(item, "BAIRRO", "bairro") || '-';
  const cidade = getField(item, "CIDADE", "cidade") || '-';
  const epo = getField(item, "EPO", "epo") || '-';
  const statusMdu = getField(item, "STATUS MDU", "STATUS_MDU", "status_mdu") || '-';
  const statusLiberacao = getField(item, "STATUS LIBERAÇÃO", "STATUS_LIBERACAO", "status_liberacao") || '-';
  const obsOriginal = getField(item, "OBS", "obs", "OBSERVACAO", "observacao") || '-';

  currentPendenteCodigo = getField(item, "CODGED", "codged", "cod_ged", "COD-MDUGO", "cod-mdugo", "codmdugo") || codigoInformado || enderecoBase;

  document.getElementById('modal-codigo').textContent = codigo;
  document.getElementById('modal-endereco').textContent = enderecoCompleto;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusMdu);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(statusLiberacao);
  document.getElementById('modal-obs-original').textContent = obsOriginal;

  applyModalContext({
    themeClass: 'projeto-f-modal',
    title: 'Detalhes PROJETO F',
    kicker: 'Painel executivo do Projeto F',
    heroChip: 'Projeto F',
    heroTitle: enderecoCompleto || codigo,
    heroSubtitle: [cidade, bairro, epo].filter(value => value && value !== '-').join(' • ') || 'Registro estratégico do Projeto F',
    statusLabel: 'Status MDU',
    motivoLabel: 'Status Liberação',
    heroPills: [
      { label: 'Código', value: codigo },
      { label: 'Status MDU', value: statusMdu, badge: true },
      { label: 'Liberação', value: statusLiberacao, badge: true }
    ]
  });

  const modal = document.getElementById('modal-obs');
  const modalBody = document.querySelector('#modal-obs .modal-body');

  if (modalBody) {
    const bloco = getField(item, "BLOCO", "bloco") || '-';
    const qtdeBlocos = getField(item, "Qtde Blocos", "QTDE_BLOCOS", "qtd_blocos") || '-';
    const idNode = getField(item, "ID_NODE", "id_node") || '-';
    const areaRecorte = getField(item, "Área Recorte", "Area Recorte", "AREA_RECORTE", "area_recorte") || '-';
    const subiuProjnet = getField(item, "Subiu projnet?", "SUBIU_PROJNET", "subiu_projnet") || '-';
    const liberacaoConcluida = getField(item, "Liberação concluida?", "Liberacao Concluida?", "LIBERACAO_CONCLUIDA", "liberacao_concluida") || '-';
    const dtConstrucao = getField(item, "DT_CONSTRUÇÃO", "DT_CONSTRUCAO", "dt_construcao") || '-';
    const parceira = getField(item, "PARCEIRA", "parceira") || '-';

    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('Bloco', bloco, { featured: true })}
        ${renderModalInfoCard('Qtde Blocos', qtdeBlocos)}
        ${renderModalInfoCard('ID Node', idNode)}
        ${renderModalInfoCard('Área Recorte', areaRecorte)}
        ${renderModalInfoCard('Subiu Projnet?', subiuProjnet, { badge: true })}
        ${renderModalInfoCard('Liberação Concluída?', liberacaoConcluida, { badge: true })}
        ${renderModalInfoCard('DT Construção', dtConstrucao)}
        ${renderModalInfoCard('Parceira', parceira)}
      </div>
    `;

    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  document.getElementById('modal-obs-adicional').value = "";
  carregarObservacoesPendente(currentPendenteCodigo);
  carregarAnexosPendente(currentPendenteCodigo);

  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = "";
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(currentPendenteCodigo, file);
      }
    };
  }
}

// Chamar atualizar contadores quando os dados forem carregados
const originalRenderTabela = renderTabela;
renderTabela = function(id, lista, atualizarRelatoriosFlag = true) {
  originalRenderTabela.call(this, id, lista, atualizarRelatoriosFlag);
  
  // Atualizar contadores após renderizar tabela principal
  if (id === "tabela-enderecos") {
    atualizarContadores();
  }
};
