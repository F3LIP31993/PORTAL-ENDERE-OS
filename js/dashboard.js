// ====== IndexedDB Utility for Large Datasets ======
const PLANILHA_DB_NAME = 'portalPlanilhasDB';
const PLANILHA_DB_VERSION = 1;
const PLANILHA_CATEGORIAS_INDEXEDDB = [
  'projeto-f', 'sar-rede', 'ongoing', 'liberados', 'mdu-ongoing', 'empresarial', 'pendente-autorizacao', 'backlog', 'epo-gpon-ongoing', 'epo-projeto-f'
];

function openPlanilhaDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PLANILHA_DB_NAME, PLANILHA_DB_VERSION);
    request.onupgradeneeded = function(event) {
      const db = event.target.result;
      PLANILHA_CATEGORIAS_INDEXEDDB.forEach(cat => {
        if (!db.objectStoreNames.contains(cat)) {
          db.createObjectStore(cat, { keyPath: 'id' });
        }
      });
    };
    request.onsuccess = function(event) {
      resolve(event.target.result);
    };
    request.onerror = function(event) {
      reject(event.target.error);
    };
  });
}

async function salvarPlanilhaIndexedDB(categoria, items) {
  if (!PLANILHA_CATEGORIAS_INDEXEDDB.includes(categoria)) return;
  const db = await openPlanilhaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([categoria], 'readwrite');
    const store = tx.objectStore(categoria);
    store.put({ id: 'main', items });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

async function lerPlanilhaIndexedDB(categoria) {
  if (!PLANILHA_CATEGORIAS_INDEXEDDB.includes(categoria)) return null;
  const db = await openPlanilhaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([categoria], 'readonly');
    const store = tx.objectStore(categoria);
    const req = store.get('main');
    req.onsuccess = () => resolve(req.result ? req.result.items : null);
    req.onerror = (e) => reject(e);
  });
}

// ====== Fim IndexedDB Utility ======
let dadosCSV = [];

// Armazena os dados carregados (por categoria) para que cada planilha seja independente
const dadosPorCategoria = {};
let categoriaAtualParaImport = null;
let importMode = "local"; // local | network | web

let dddSelecionado = "todos"; // Armazena o DDD selecionado globalmente

// Usado para controlar qual aba está ativa em 'Pendente Autorização'
let pendenteActiveTab = 'vistoria';

let currentUser = null;

const LIBERADOS_ABAS = ['projeto-f', 'gpon-hfc', 'greenfield'];
let liberadosAbaAtiva = 'projeto-f';
let liberadosSubcardSelecionado = false;
const sharedSyncRetryQueue = {};
let sharedSyncRetryInProgress = false;
let sharedDatasetsVersionToken = '';
let carregarDadosCompartilhadosInProgress = false;
let ongoingDatasetLoadPromise = null;
let projetoFDatasetLoadPromise = null;
let liberadosDatasetLoadPromise = null;
let projetoFCityFilterCacheToken = '';
let projetoFCityFilterCacheOptions = [];

const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";
const STORAGE_COLUMN_DENSITY_KEY = "portalColumnDensity";
const STORAGE_DATASET_CACHE_KEY = "portalDatasetCache";
const STORAGE_SHARED_SYNC_QUEUE_KEY = "portalSharedSyncRetryQueue";
const SESSION_ONLY_DATASET_KEYS = [];
const SHARED_REFRESH_INTERVAL_MS = 120000;
const BUILD_VERSION_CHECK_INTERVAL_MS = 45000;
const MAX_LOCAL_CACHE_ITEMS_BY_CATEGORY = {
  'projeto-f': 5000,
  'liberados': 5000,
  'sar-rede': 5000,
  'epo-gpon-ongoing': 5000,
  'epo-projeto-f': 5000,
  'mdu-ongoing': 5000,
  'empresarial': 5000,
  'pendente-autorizacao': 5000,
  'backlog': 5000
};
const PRIORITY_DATASET_CACHE_KEYS = [
  'projeto-f',
  'liberados',
  'sar-rede',
  'epo-gpon-ongoing',
  'epo-projeto-f',
  'mdu-ongoing',
  'empresarial',
  'pendente-autorizacao',
  'backlog'
];

const runtimeDatasetCache = {};
const runtimeEpoStores = {
  'gpon-ongoing': null,
  'projeto-f': null,
};
let currentPortalBuildVersion = '';
let portalBuildReloadScheduled = false;

async function checkForNewPortalBuild(forceInit = false) {
  if (!window.location.protocol.startsWith('http')) return;

  try {
    const configUrl = `/api/config?_build_check=${Date.now()}`;
    const response = await fetch(configUrl, {
      credentials: 'include',
      cache: 'no-store'
    });

    if (!response.ok) return;

    const config = await response.json().catch(() => ({}));
    const buildVersion = String(config?.buildVersion || config?.version || '').trim();
    if (!buildVersion) return;

    if (!currentPortalBuildVersion || forceInit) {
      currentPortalBuildVersion = buildVersion;
      return;
    }

    if (currentPortalBuildVersion !== buildVersion && !portalBuildReloadScheduled) {
      portalBuildReloadScheduled = true;
      const statusEl = document.getElementById('import-status');
      if (statusEl) {
        statusEl.textContent = '♻️ Nova versão publicada no Render. Atualizando página...';
      }

      setTimeout(() => {
        window.location.reload();
      }, 1200);
    }
  } catch {
    // Sem bloqueio: se a API estiver indisponível, tenta no próximo ciclo.
  }
}

function stripSessionOnlyDatasets(cache = {}) {
  const sanitized = { ...(cache || {}) };
  SESSION_ONLY_DATASET_KEYS.forEach((key) => {
    delete sanitized[key];
  });
  return sanitized;
}

function loadSharedSyncRetryQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_SHARED_SYNC_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSharedSyncRetryQueue() {
  try {
    localStorage.setItem(STORAGE_SHARED_SYNC_QUEUE_KEY, JSON.stringify(sharedSyncRetryQueue || {}));
  } catch {
    // Sem bloqueio: fila continua em memória.
  }
}

Object.assign(sharedSyncRetryQueue, loadSharedSyncRetryQueue());

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
    const persisted = stripSessionOnlyDatasets(raw ? JSON.parse(raw) : {});
    return { ...persisted, ...runtimeDatasetCache };
  } catch {
    return { ...runtimeDatasetCache };
  }
}

function saveLocalDatasetCache(cache) {
  const sanitized = stripSessionOnlyDatasets(cache || {});

  try {
    localStorage.setItem(STORAGE_DATASET_CACHE_KEY, JSON.stringify(sanitized));
    return;
  } catch (error) {
    // Em quota excedida, preserva os datasets mais críticos para o portal.
    const reduced = {};
    PRIORITY_DATASET_CACHE_KEYS.forEach((key) => {
      if (sanitized[key]) {
        reduced[key] = sanitized[key];
      }
    });

    // Mantém metadados e reduz listas muito grandes para caber no armazenamento local.
    Object.entries(reduced).forEach(([key, snapshot]) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      // Não trunca mais ao salvar cache
      reduced[key] = {
        ...snapshot,
        items: items
      };
    });

    try {
      localStorage.setItem(STORAGE_DATASET_CACHE_KEY, JSON.stringify(reduced));
    } catch {
      console.warn('Não foi possível salvar cache local completo dos datasets. O portal continuará com sincronização via servidor.', error);
    }
  }
}

function cleanupSessionOnlyDatasetStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_DATASET_CACHE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    const sanitized = stripSessionOnlyDatasets(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
      localStorage.setItem(STORAGE_DATASET_CACHE_KEY, JSON.stringify(sanitized));
    }
  } catch {
    // Sem bloqueio: segue usando cache em memória.
  }
}

cleanupSessionOnlyDatasetStorage();

function cacheDatasetLocally(categoria, items, meta = {}) {
  if (!categoria || !Array.isArray(items)) return;
  const cache = getLocalDatasetCache();
  const previous = cache[categoria] || {};
  const currentUser = getCurrentUser();
  const inferredUpdatedBy = currentUser?.username || currentUser?.name || '';
  // Não trunca mais os dados salvos localmente
  const snapshot = {
    items,
    updatedAt: meta.updatedAt || new Date().toISOString(),
    source: meta.source || previous.source || 'shared',
    locked: typeof meta.locked === 'boolean' ? meta.locked : Boolean(previous.locked),
    updatedBy: meta.updatedBy || meta.updated_by || previous.updatedBy || inferredUpdatedBy,
    truncated: false,
    fullCount: undefined,
  };

  if (SESSION_ONLY_DATASET_KEYS.includes(categoria)) {
    runtimeDatasetCache[categoria] = snapshot;
  } else {
    cache[categoria] = snapshot;
    saveLocalDatasetCache(cache);
  }

  if (categoria === categoriaAtualParaImport) {
    updateImportLockInfo(categoria);
  }
}

function formatDatasetTimestampBr(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('pt-BR');
}

function buildSharedDatasetsToken(datasets = {}) {
  const entries = Object.entries(datasets || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([categoria, snapshot]) => {
      const updatedAt = snapshot?.updated_at || snapshot?.updatedAt || '';
      const count = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;
      return `${categoria}:${updatedAt}:${count}`;
    });
  return entries.join('|');
}

function getOrCreateImportLockInfoElement() {
  let lockInfoEl = document.getElementById('import-lock-info');
  if (lockInfoEl) return lockInfoEl;

  const statusEl = document.getElementById('import-status');
  if (!statusEl || !statusEl.parentElement) return null;

  lockInfoEl = document.createElement('div');
  lockInfoEl.id = 'import-lock-info';
  lockInfoEl.className = 'import-status-line';
  lockInfoEl.style.marginTop = '4px';
  lockInfoEl.style.fontSize = '12px';
  lockInfoEl.style.opacity = '.85';
  statusEl.insertAdjacentElement('afterend', lockInfoEl);

  return lockInfoEl;
}

function updateImportLockInfo(categoriaId = categoriaAtualParaImport) {
  const lockInfoEl = getOrCreateImportLockInfoElement();
  if (!lockInfoEl) return;

  lockInfoEl.textContent = '';
  lockInfoEl.style.display = 'none';
  return;

  lockInfoEl.style.display = 'flex';
  lockInfoEl.style.flexBasis = '100%';
  lockInfoEl.style.width = '100%';
  lockInfoEl.style.whiteSpace = 'normal';

  if (!categoriaId) {
    lockInfoEl.textContent = '';
    return;
  }

  if (categoriaId === 'ongoing') {
    lockInfoEl.textContent = '';
    lockInfoEl.style.display = 'none';
    return;
  }

  const categoriaNorm = normalizeText(categoriaId || '').replace(/[^a-z0-9]/g, '-');
  if (categoriaId === 'sar-rede' || categoriaNorm === 'sar-rede' || categoriaNorm.includes('sar') && categoriaNorm.includes('rede')) {
    lockInfoEl.textContent = '';
    lockInfoEl.style.display = 'none';
    return;
  }

  const snapshot = getLocalDatasetCache()?.[categoriaId] || {};
  const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  const stateItems = Array.isArray(dadosPorCategoria?.[categoriaId]) ? dadosPorCategoria[categoriaId] : [];
  const items = snapshotItems.length ? snapshotItems : stateItems;
  // Prioriza contagem do estado (dados completos importados) sobre o cache local (pode estar truncado)
  const displayCount = stateItems.length || Number(snapshot?.fullCount || items.length || 0);
  const sourceText = snapshot.source || (stateItems.length ? 'estado' : 'local');

  if (!items.length) {
    lockInfoEl.textContent = '';
    return;
  }

  const details = [
    `📌 Base ativa: ${displayCount} registro(s)`,
    (snapshot.locked || (categoriaId === 'projeto-f' && items.length > 0)) ? 'travado' : 'não travado',
    sourceText ? `origem ${sourceText}` : '',
  ].filter(Boolean).join(' • ');

  lockInfoEl.textContent = details;
}

function updateEpoLockInfo(extraText = '') {
  updateEpoImportStatus('gpon-ongoing', extraText);
  updateEpoImportStatus('projeto-f');
}

function hasLockedDataset(categoria) {
  const cache = getLocalDatasetCache();
  return Boolean(cache?.[categoria]?.locked);
}

function getPreferredDataset(categoriaId) {
  // Para LIBERADOS, nunca usar localStorage/cache, só o estado
  if (categoriaId === 'liberados') {
    return Array.isArray(dadosPorCategoria['liberados']) ? dadosPorCategoria['liberados'] : [];
  }
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

  // Para LIBERADOS, sempre sobrescrever, nunca usar locked/localStorage
  if (categoria === 'liberados') {
    dadosPorCategoria['liberados'] = safeItems;
    return;
  }

  // Proteção: nunca sobrescrever SAR REDE local locked: true
  if (categoria === 'sar-rede') {
    const localSnapshot = getLocalDatasetCache()?.[categoria];
    if (localSnapshot?.locked && Array.isArray(localSnapshot.items) && localSnapshot.items.length) {
      // Mantém sempre o local travado
      dadosPorCategoria[categoria] = localSnapshot.items;
      return;
    }
  }

  // Protecao: nao deixar sincronizacoes vazias apagarem dados do card Empresarial.
  if (categoria === "empresarial" && safeItems.length === 0) {
    const atual = Array.isArray(dadosPorCategoria[categoria]) ? dadosPorCategoria[categoria] : [];
    if (atual.length) {
      return;
    }

    const localSnapshot = getLocalDatasetCache()?.[categoria];
    const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
    if (localItems.length) {
      dadosPorCategoria[categoria] = localItems;
      return;
    }
  }

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
    return rows.filter(item => {
      const solicitante = (getField(item, 'SOLICITANTE', 'solicitante') || '').trim().toUpperCase();
      return solicitante === 'EMPRESARIAL';
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
    const shouldPreserveManualImport = ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId)
      && hasLockedDataset(categoriaId);

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
      epo_access: Array.isArray(user.epo_access) ? user.epo_access : null,
      must_change_password: Boolean(user.must_change_password),
      createdAt: dateNow,
      approvedAt: dateNow,
    });
  } else {
    users[idx].name = user.name || users[idx].name;
    users[idx].email = user.email || users[idx].email;
    users[idx].role = user.role || users[idx].role;
    if (Array.isArray(user.epo_access)) {
      users[idx].epo_access = user.epo_access;
    }
    if (typeof user.must_change_password === 'boolean') {
      users[idx].must_change_password = user.must_change_password;
    }
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
    // Sessao expirada (ex: restart do servidor) - tenta re-login silencioso com credenciais salvas
    const storedUsername = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
    const storedUser = storedUsername
      ? getStoredUsers().find(u => u.username.toLowerCase() === storedUsername.toLowerCase())
      : null;
    if (storedUser && storedUser.password) {
      try {
        const loginRes = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: storedUser.username, password: storedUser.password }),
          credentials: "include",
        });
        if (loginRes.ok) {
          const loginData = await loginRes.json().catch(() => ({}));
          if (loginData?.user) {
            currentUser = loginData.user;
            setCurrentUserLocally(loginData.user);
            return loginData.user;
          }
        }
      } catch { /* continuar em modo local */ }
    }
  } catch (e) {
    // Falha ao conectar com o backend - continuar em modo local
  }
  return null;
}

async function carregarDadosCompartilhados() {
  if (carregarDadosCompartilhadosInProgress) return;
  carregarDadosCompartilhadosInProgress = true;

  const localCache = getLocalDatasetCache();

  try {
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
      updateImportLockInfo();
      agendarRenderVisaoGerencia(true);
      return;
    }

    const res = await fetch("/api/shared_datasets", { credentials: "include" });
    if (!res.ok) return;

    const payload = await res.json().catch(() => ({}));
    const datasets = payload?.datasets || {};
    const nextToken = buildSharedDatasetsToken(datasets);
    const hasSyncQueue = Object.keys(sharedSyncRetryQueue || {}).length > 0;
    if (nextToken && nextToken === sharedDatasetsVersionToken && !hasSyncQueue) {
      updateImportLockInfo();
      return;
    }
    const isAdmin = getCurrentUser()?.role === 'admin';

    for (const [categoria, snapshot] of Object.entries(datasets)) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      const existingItems = Array.isArray(dadosPorCategoria[categoria]) ? dadosPorCategoria[categoria] : [];
      const localSnapshot = localCache?.[categoria] || {};
      const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
      const localUpdatedAt = Date.parse(localSnapshot?.updatedAt || '') || 0;
      const sharedUpdatedAt = Date.parse(snapshot?.updated_at || snapshot?.updatedAt || '') || 0;
      const localIsTruncated = Boolean(localSnapshot?.truncated);
      // NUNCA sobrescrever SAR REDE local locked: true
      if (
        categoria === 'sar-rede' &&
        Boolean(localSnapshot?.locked) &&
        localItems.length &&
        !localIsTruncated
      ) {
        applyDatasetToState(categoria, localItems);
        continue;
      }
      const shouldKeepLockedLocal = ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'projeto-f', 'ongoing'].includes(categoria)
        && Boolean(localSnapshot?.locked)
        && localItems.length
        && !localIsTruncated
        && (!items.length || localUpdatedAt >= sharedUpdatedAt);
      if (shouldKeepLockedLocal) {
        applyDatasetToState(categoria, localItems);
        continue;
      }

      // Se snapshot indicar truncado ou server, buscar dados completos do backend
      if (snapshot?.truncated || snapshot?.server) {
        try {
          const res = await fetch(`/api/shared_datasets/${encodeURIComponent(categoria)}`, { credentials: "include" });
          const payload = res.ok ? await res.json() : null;
          const fullItems = Array.isArray(payload?.items) ? payload.items : [];
          if (fullItems.length) {
            applyDatasetToState(categoria, fullItems);
            cacheDatasetLocally(categoria, fullItems, {
              ...snapshot,
              truncated: false,
              server: true,
              updatedAt: snapshot?.updated_at || snapshot?.updatedAt || new Date().toISOString(),
              updatedBy: snapshot?.updated_by || snapshot?.updatedBy || '',
            });
            await salvarPlanilhaIndexedDB(categoria, fullItems);
          } else {
            // Se não conseguir buscar do backend, tenta IndexedDB, senão snapshot mínimo local
            const idxItems = await lerPlanilhaIndexedDB(categoria);
            if (idxItems && idxItems.length) {
              applyDatasetToState(categoria, idxItems);
            } else {
              applyDatasetToState(categoria, localItems);
            }
          }
        } catch {
          // Se erro na requisição, tenta IndexedDB, senão snapshot mínimo local
          const idxItems = await lerPlanilhaIndexedDB(categoria);
          if (idxItems && idxItems.length) {
            applyDatasetToState(categoria, idxItems);
          } else {
            applyDatasetToState(categoria, localItems);
          }
        }
        continue;
      }

      // Evita que um snapshot vazio do servidor apague dados já carregados localmente.
      if (items.length || !existingItems.length) {
        applyDatasetToState(categoria, items);
        if (items.length) {
          cacheDatasetLocally(categoria, items, {
            source: snapshot?.source || 'shared',
            updatedAt: snapshot?.updated_at || snapshot?.updatedAt || new Date().toISOString(),
            updatedBy: snapshot?.updated_by || snapshot?.updatedBy || '',
            locked: true,
            truncated: false,
            server: true,
          });
          await salvarPlanilhaIndexedDB(categoria, items);
        }
      }
    }

    Object.entries(localCache).forEach(([categoria, snapshot]) => {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      const serverSnapshot = datasets?.[categoria] || {};
      const serverItems = Array.isArray(serverSnapshot?.items) ? serverSnapshot.items : [];
      const localUpdatedAt = Date.parse(snapshot?.updatedAt || '') || 0;
      const serverUpdatedAt = Date.parse(serverSnapshot?.updated_at || serverSnapshot?.updatedAt || '') || 0;
      const shouldPreferLocal = items.length && (
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

    sharedDatasetsVersionToken = nextToken;

    atualizarContadores();

    const secaoAtiva = document.querySelector(".secao.ativa")?.id;
    if (secaoAtiva) {
      carregarDadosCategoria(secaoAtiva);
    }

    updateImportLockInfo();
    agendarRenderVisaoGerencia(true);
  } catch (error) {
    console.warn("Não foi possível carregar os dados compartilhados do portal.", error);
    updateImportLockInfo();
  } finally {
    carregarDadosCompartilhadosInProgress = false;
  }
}

async function persistirDadosCompartilhados(categoria, items, meta = {}) {
  if (!categoria || !Array.isArray(items)) {
    return { synced: false, skipped: true };
  }

  const slimItemsForStorage = (rows = []) => {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;

      const keys = Object.keys(row);
      const byNorm = {};
      keys.forEach((key) => {
        const norm = normalizeKey(key || '');
        if (!norm) return;
        if (!Array.isArray(byNorm[norm])) byNorm[norm] = [];
        byNorm[norm].push(key);
      });

      const slim = {};
      keys.forEach((key) => {
        const norm = normalizeKey(key || '');
        const value = row[key];

        if (!norm) {
          slim[key] = value;
          return;
        }

        const siblings = byNorm[norm] || [];
        const isLikelyNormalizedKey = key === norm;
        if (isLikelyNormalizedKey && siblings.length > 1) {
          const hasOriginalTwin = siblings.some((other) => {
            if (other === key) return false;
            return row[other] === value && other !== normalizeKey(other || '');
          });
          if (hasOriginalTwin) return;
        }

        slim[key] = value;
      });

      return slim;
    });
  };

  const itemsToPersist = slimItemsForStorage(items);

  const normalizeProjetoFRowsForStorage = async (rows = []) => {
    if (!Array.isArray(rows) || !rows.length) return [];

    const compact = [];
    const chunkSize = 700;

    const buildPayload = (row) => ({
      "COD-MDUGO": getField(row, "COD-MDUGO", "cod-mdugo", "codmdugo"),
      "CIDADE": getField(row, "CIDADE", "cidade", "Cidade"),
      "BLOCO": getField(row, "BLOCO", "bloco", "Bloco"),
      "CODGED": getField(row, "CODGED", "codged", "cod_ged", "COD GED", "CÓD. GED"),
      "ENDEREÇO": getField(row, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada"),
      "Qtde Blocos": getField(row, "Qtde Blocos", "QTDE_BLOCOS", "QTD_BLOCOS", "qtd_blocos"),
      "STATUS MDU": getField(row, "STATUS MDU", "STATUS_MDU", "status_mdu"),
      "STATUS LIBERAÇÃO": getField(row, "STATUS LIBERAÇÃO", "STATUS_LIBERACAO", "status_liberacao"),
      "DT_CONSTRUÇÃO": getField(row, "DT_CONSTRUÇÃO", "DT_CONSTRUCAO", "dt_construcao"),
      "PARCEIRA": getField(row, "PARCEIRA", "parceira"),
    });

    let start = 0;
    while (start < rows.length) {
      const end = Math.min(start + chunkSize, rows.length);
      for (let i = start; i < end; i += 1) {
        const payload = buildPayload(rows[i]);
        const hasRelevantData = [
          payload["COD-MDUGO"],
          payload["CODGED"],
          payload["ENDEREÇO"],
          payload["CIDADE"],
          payload["STATUS MDU"],
          payload["STATUS LIBERAÇÃO"],
        ].some((value) => String(value || '').trim() !== '');
        if (hasRelevantData) compact.push(payload);
      }

      start = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return compact;
  };

  const normalizeOngoingRowsForStorage = async (rows = []) => {
    if (!Array.isArray(rows) || !rows.length) return [];

    const compact = [];
    const chunkSize = 1000;

    const buildPayload = (row) => ({
      'IDDEMANDA': getField(row, 'IDDEMANDA', 'iddemanda', 'ID DEMANDA', 'ID_DEMANDA', 'id'),
      'FILA': getField(row, 'FILA', 'fila'),
      'TIPO': getField(row, 'TIPO', 'tipo', 'SOLICITANTE', 'solicitante'),
      'ENDEREÇO': getField(row, 'ENDEREÇO', 'ENDERECO', 'endereco_unico', 'endereco', 'endereco_entrada'),
      'EPO': getField(row, 'EPO', 'epo', 'regional', 'REGIONAL', 'cluster', 'CLUSTER'),
      'AGING': getField(row, 'AGING', 'aging', 'Aging arredondado', 'aging_total', 'AGE'),
      'SLA TUDO': getField(row, 'SLA TUDO', 'SLA FASE', 'sla_tudo', 'sla_fase', 'sla'),
      'STATUS_GERAL': getField(row, 'STATUS_GERAL', 'status_geral', 'STATUS', 'status'),
      'MOTIVO_GERAL': getField(row, 'MOTIVO_GERAL', 'motivo_geral', 'MOTIVO', 'motivo'),
      'OBS': getField(row, 'OBS', 'obs', 'OBSERVACAO', 'observacao', 'STATUS OBS', 'status_obs')
    });

    let start = 0;
    while (start < rows.length) {
      const end = Math.min(start + chunkSize, rows.length);
      for (let i = start; i < end; i += 1) {
        const payload = buildPayload(rows[i]);
        const hasRelevantData = [
          payload['IDDEMANDA'],
          payload['FILA'],
          payload['ENDEREÇO'],
          payload['STATUS_GERAL'],
          payload['MOTIVO_GERAL']
        ].some((value) => String(value || '').trim() !== '');
        if (hasRelevantData) compact.push(payload);
      }

      start = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return compact;
  };

  const normalizeLiberadosRowsForStorage = async (rows = []) => {
    if (!Array.isArray(rows) || !rows.length) return [];

    const compact = [];
    const chunkSize = 1000;

    const buildPayload = (row) => ({
      "TIPO_REDE": getField(row, "TIPO_REDE", "TIPO REDE", "tipo_rede"),
      "SOLICITANTE": getField(row, "SOLICITANTE", "solicitante"),
      "DDD": getField(row, "DDD", "ddd"),
      "CIDADE": getField(row, "CIDADE", "cidade", "Cidade"),
      "ENDEREÇO": getField(row, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada"),
      "BLOCOS": getField(row, "BLOCOS", "BLOCO", "blocos", "bloco"),
      "HP": getField(row, "HP", "HPS", "hp", "hps"),
      "STATUS": getField(row, "STATUS", "STATUS_GERAL", "status", "status_geral"),
      "DT_CONCLUIDO": getField(row, "DT_CONCLUIDO", "DT CONCLUIDO", "DATA_CONCLUIDO", "data_concluido"),
      "COD_IMOVEL": getField(row, "COD_IMOVEL", "COD IMOVEL", "ID IMOVEL", "cod_imovel"),
      "_aba_liberados": normalizeLiberadosAba(getField(row, "_aba_liberados") || inferirAbaLiberadosPorRegistro(row, "projeto-f"))
    });

    let start = 0;
    while (start < rows.length) {
      const end = Math.min(start + chunkSize, rows.length);
      for (let i = start; i < end; i += 1) {
        const payload = buildPayload(rows[i]);
        const hasRelevantData = [
          payload["TIPO_REDE"],
          payload["SOLICITANTE"],
          payload["CIDADE"],
          payload["ENDEREÇO"],
          payload["STATUS"],
          payload["COD_IMOVEL"],
        ].some((value) => String(value || '').trim() !== '');
        if (hasRelevantData) compact.push(payload);
      }

      start = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return compact;
  };

  const normalizeEpoProjetoFRowsForStorage = async (rows = []) => {
    if (!Array.isArray(rows) || !rows.length) return [];

    const compact = [];
    const chunkSize = 1000;

    const buildPayload = (row) => ({
      '__epoBucket': getField(row, '__epoBucket', '__epobucket'),
      'PARCEIRA': getField(row, 'PARCEIRA', 'parceira', 'EPO', 'epo', 'CLUSTER', 'cluster'),
      'CIDADE': getField(row, 'CIDADE', 'cidade', 'Cidade'),
      'BLOCO': getField(row, 'BLOCO', 'bloco', 'Bloco'),
      'CODGED': getField(row, 'CODGED', 'codged', 'cod_ged', 'COD GED', 'CÓD. GED', 'GED'),
      'ENDEREÇO': getField(row, 'ENDEREÇO', 'ENDERECO', 'endereco', 'endereco_entrada'),
      'NUMERO': getField(row, 'NUMERO', 'NÚMERO', 'numero', 'num'),
      'Qtde Blocos': getField(row, 'Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos'),
      'STATUS MDU': getField(row, 'STATUS MDU', 'STATUS_MDU', 'status_mdu'),
      'STATUS LIBERAÇÃO': getField(row, 'STATUS LIBERAÇÃO', 'STATUS LIBERACAO', 'STATUS_LIBERACAO', 'status_liberacao'),
      'DT_CONSTRUÇÃO': getField(row, 'DT_CONSTRUÇÃO', 'DT_CONSTRUCAO', 'dt_construcao'),
    });

    let start = 0;
    while (start < rows.length) {
      const end = Math.min(start + chunkSize, rows.length);
      for (let i = start; i < end; i += 1) {
        const payload = buildPayload(rows[i]);
        const hasRelevantData = [
          payload['PARCEIRA'],
          payload['CODGED'],
          payload['ENDEREÇO'],
          payload['CIDADE'],
          payload['STATUS MDU'],
          payload['STATUS LIBERAÇÃO'],
        ].some((value) => String(value || '').trim() !== '');
        if (hasRelevantData) compact.push(payload);
      }

      start = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return compact;
  };

  const normalizeEpoOngoingRowsForStorage = async (rows = []) => {
    if (!Array.isArray(rows) || !rows.length) return [];

    const compact = [];
    const chunkSize = 1000;

    const buildPayload = (row) => ({
      '__epoBucket': getField(row, '__epoBucket', '__epobucket'),
      'COD-MDUGO': getField(row, 'COD-MDUGO', 'CODIGO', 'CÓDIGO', 'cod-mdugo', 'codmdugo'),
      'ENDEREÇO': getField(row, 'ENDEREÇO', 'ENDERECO', 'endereco_unico', 'endereco', 'endereco_entrada'),
      'NUMERO': getField(row, 'NUMERO', 'NÚMERO', 'numero', 'num'),
      'BAIRRO': getField(row, 'BAIRRO', 'bairro'),
      'CIDADE': getField(row, 'CIDADE', 'cidade', 'Cidade'),
      'EPO': getField(row, 'EPO', 'epo', 'CLUSTER', 'cluster', 'PARCEIRA', 'parceira'),
      'SOLICITANTE': getField(row, 'SOLICITANTE', 'solicitante', 'TIPO', 'tipo'),
      'STATUS_GERAL': getField(row, 'STATUS_GERAL', 'status_geral', 'STATUS', 'status', 'Status Geral'),
      'MOTIVO_GERAL': getField(row, 'MOTIVO_GERAL', 'motivo_geral', 'MOTIVO', 'motivo', 'Motivo Geral'),
      'OBS': getField(row, 'OBS', 'obs', 'OBSERVACAO', 'observacao', 'STATUS OBS', 'status_obs')
    });

    let start = 0;
    while (start < rows.length) {
      const end = Math.min(start + chunkSize, rows.length);
      for (let i = start; i < end; i += 1) {
        const payload = buildPayload(rows[i]);
        const hasRelevantData = [
          payload['COD-MDUGO'],
          payload['ENDEREÇO'],
          payload['STATUS_GERAL'],
          payload['MOTIVO_GERAL'],
          payload['EPO'],
        ].some((value) => String(value || '').trim() !== '');
        if (hasRelevantData) compact.push(payload);
      }

      start = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return compact;
  };

  const finalItemsToPersist = (categoria === 'projeto-f')
    ? await (async () => {
        const compactRows = await normalizeProjetoFRowsForStorage(itemsToPersist);
        return compactRows.length ? compactRows : itemsToPersist;
      })()
    : (categoria === 'ongoing')
      ? await (async () => {
          const compactRows = await normalizeOngoingRowsForStorage(itemsToPersist);
          return compactRows.length ? compactRows : itemsToPersist;
        })()
    : (categoria === 'liberados')
      ? await (async () => {
          const compactRows = await normalizeLiberadosRowsForStorage(itemsToPersist);
          return compactRows.length ? compactRows : itemsToPersist;
        })()
    : (categoria === 'epo-projeto-f')
      ? await (async () => {
          const compactRows = await normalizeEpoProjetoFRowsForStorage(itemsToPersist);
          return compactRows.length ? compactRows : itemsToPersist;
        })()
    : (categoria === 'epo-gpon-ongoing')
      ? await (async () => {
          const compactRows = await normalizeEpoOngoingRowsForStorage(itemsToPersist);
          return compactRows.length ? compactRows : itemsToPersist;
        })()
    : itemsToPersist;

  const user = getCurrentUser();
  const metaWithUser = {
    ...meta,
    updatedBy: meta.updatedBy || meta.updated_by || user?.username || user?.name || '',
    updatedAt: meta.updatedAt || new Date().toISOString(),
  };

  // Evita sobrescrever snapshot local não-vazio com payload vazio em sync automático.
  if (finalItemsToPersist.length === 0) {
    const localSnapshot = getLocalDatasetCache()?.[categoria];
    const localItems = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
    if (localItems.length) {
      return { synced: false, skipped: true };
    }
  }

  // Salva todos os dados no IndexedDB e no cache local (sem truncar)
  try {
    let categoriaStore = categoria;
    // Para LIBERADOS, salva em store separada por aba
    if (categoria === 'liberados' && meta && meta._abaLiberados) {
      categoriaStore = `liberados-${meta._abaLiberados}`;
    }
    await salvarPlanilhaIndexedDB(categoriaStore, finalItemsToPersist);
    // Não salva mais grandes volumes no localStorage para LIBERADOS
    if (!categoriaStore.startsWith('liberados-')) {
      cacheDatasetLocally(categoriaStore, finalItemsToPersist, {
        updatedAt: metaWithUser.updatedAt || new Date().toISOString(),
        source: metaWithUser.source || 'shared',
        updatedBy: metaWithUser.updatedBy || '',
        truncated: false,
        server: true
      });
    }
  } catch (cacheError) {
    console.warn(`Falha ao salvar dados no IndexedDB/cache local da categoria ${categoria}.`, cacheError);
  }

  const isAdmin = user?.role === "admin";
  if (!window.location.protocol.startsWith("http") || !isAdmin) {
    return { synced: false, localOnly: true };
  }
  try {
    await enviarDatasetCompartilhadoParaServidor(categoria, finalItemsToPersist);
    delete sharedSyncRetryQueue[categoria];
    saveSharedSyncRetryQueue();
    return { synced: true, queued: false };
  } catch (error) {
    sharedSyncRetryQueue[categoria] = {
      categoria,
      items: finalItemsToPersist,
      meta: metaWithUser,
      retries: Number(sharedSyncRetryQueue[categoria]?.retries || 0) + 1,
      lastError: error?.message || 'Falha desconhecida',
      queuedAt: new Date().toISOString()
    };
    saveSharedSyncRetryQueue();
    console.warn(`Falha ao salvar dados compartilhados da categoria ${categoria}.`, error);
    const statusEl = document.getElementById('import-status');
    if (statusEl) {
      statusEl.textContent = `⚠️ Dados salvos localmente. A sincronização compartilhada de ${categoria} será tentada novamente automaticamente.`;
    }
    return { synced: false, queued: true, error: error?.message || 'Falha desconhecida' };
  }
}

async function enviarDatasetCompartilhadoParaServidor(categoria, items) {
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
}

async function processarFilaSyncCompartilhada() {
  if (sharedSyncRetryInProgress) return;
  if (!window.location.protocol.startsWith("http")) return;

  const user = getCurrentUser();
  if (!user || user.role !== 'admin') return;

  const pendentes = Object.values(sharedSyncRetryQueue || {});
  if (!pendentes.length) return;

  sharedSyncRetryInProgress = true;
  try {
    for (let i = 0; i < pendentes.length; i += 1) {
      const entry = pendentes[i];
      const categoria = entry?.categoria;
      const items = Array.isArray(entry?.items) ? entry.items : [];

      if (!categoria || !items.length) {
        if (categoria) delete sharedSyncRetryQueue[categoria];
        continue;
      }

      try {
        await enviarDatasetCompartilhadoParaServidor(categoria, items);
        delete sharedSyncRetryQueue[categoria];
        saveSharedSyncRetryQueue();
      } catch (error) {
        sharedSyncRetryQueue[categoria] = {
          ...entry,
          retries: Number(entry?.retries || 0) + 1,
          lastError: error?.message || 'Falha desconhecida',
          queuedAt: entry?.queuedAt || new Date().toISOString()
        };
        saveSharedSyncRetryQueue();
      }
    }
  } finally {
    sharedSyncRetryInProgress = false;
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
      roleEl.textContent = "Acompanhamento";
    } else {
      roleEl.textContent = "Solicitante";
    }
  }
}

async function loadViewerUserProfileData() {
  const user = getCurrentUser();
  if (!user || user.role !== "viewer") return;

  try {
    const res = await fetch("/api/user_profile", { credentials: "include" });
    if (!res.ok) return;

    const profile = await res.json();
    
    if (profile.registration_obs) {
      // Armazena obs do cadastro no localStorage para referência
      const key = `viewer_profile_${user.username}`;
      localStorage.setItem(key, JSON.stringify(profile));
      console.log(`✅ Perfil de acompanhamento carregado para ${user.username}`);
    }
  } catch (error) {
    console.warn("Não foi possível carregar perfil do usuário de acompanhamento", error);
  }
}

function usuarioPodeImportar() {
  const user = getCurrentUser();
  return Boolean(user && user.role === 'admin');
}

function applyAccessControl() {
  const user = getCurrentUser();
  if (!user) return;

  const sidebar = document.querySelector("aside.sidebar");
  const topActions = document.querySelector(".topbar-actions");
  const adminOnlyElements = document.querySelectorAll('[data-admin-only="true"]');
  const settingsBtn = document.querySelector(".settings-btn");
  const notificationBtn = document.querySelector(".notification-btn");

  // Cria uma camada de proteção na interface (o backend também protege as APIs)
  const isAdmin = user.role === "admin";
  const canImport = usuarioPodeImportar();

  if (sidebar) sidebar.style.display = "flex";
  if (topActions) topActions.style.display = "flex";
  if (settingsBtn) settingsBtn.style.display = "inline-flex";
  if (notificationBtn) notificationBtn.style.display = isAdmin ? "inline-flex" : "none";

  adminOnlyElements.forEach((element) => {
    if (!isAdmin) {
      element.style.display = 'none';
    } else {
      element.style.display = element.classList.contains('menu-btn') ? 'block' : '';
    }
  });

  // Usuários de acompanhamento não podem importar nem exportar planilhas
  const importSection = document.getElementById("global-import-section");
  if (importSection && !canImport) {
    importSection.style.display = "none";
  }

  document.querySelectorAll('.epo-clip-upload').forEach((btn) => {
    btn.style.display = canImport ? 'inline-flex' : 'none';
  });

  const modalAnexoBtn = document.getElementById('modal-anexo-button');
  if (modalAnexoBtn) {
    modalAnexoBtn.style.display = canImport ? 'inline-flex' : 'none';
  }

  const modalAnexoInput = document.getElementById('modal-anexo');
  if (modalAnexoInput) {
    modalAnexoInput.disabled = !canImport;
  }

  if (!isAdmin && ["historico", "pesquisa", "relatorios", "reuniao", "financeiro"].includes(document.querySelector(".secao.ativa")?.id || "")) {
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
const STORAGE_OBS_ACK_PREFIX = "portalObsNotificationAck:";

function getNotificationSeenKey() {
  const user = getCurrentUser();
  return `${STORAGE_NOTIFICATION_SEEN_PREFIX}${(user?.username || 'anon').toLowerCase()}`;
}

function getObsAckKey() {
  const user = getCurrentUser();
  return `${STORAGE_OBS_ACK_PREFIX}${(user?.username || 'anon').toLowerCase()}`;
}

function getObsAckMap() {
  try {
    const raw = localStorage.getItem(getObsAckKey());
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveObsAckMap(map) {
  localStorage.setItem(getObsAckKey(), JSON.stringify(map || {}));
}

function getObsEventKey(event) {
  return [
    event?.type || '',
    event?.entity || event?.source || '',
    event?.reference || '',
    event?.created_at || event?.createdAt || ''
  ].join('::');
}

function isObsEventAcknowledged(event) {
  if (!event || event.type !== 'observacao') return false;
  const map = getObsAckMap();
  return Boolean(map[getObsEventKey(event)]);
}

function acknowledgeObsEvent(event) {
  if (!event || event.type !== 'observacao') return;
  const map = getObsAckMap();
  map[getObsEventKey(event)] = new Date().toISOString();
  saveObsAckMap(map);
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

    const unreadEvents = (events || []).filter(event => {
      if (event?.type === 'observacao' && isObsEventAcknowledged(event)) return false;
      return getNotificationEventTime(event) > seenTimestamp;
    }).length;
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
  const pendingSet = new Set((serverPendings || []).map(u => u.username));
  const registrationEvents = (events || []).filter(event => event.type === 'cadastro');
  const noteEvents = (events || [])
    .filter(event => event.type === 'observacao')
    .filter(event => !isObsEventAcknowledged(event));

  if (!hasLocal && registrationEvents.length === 0 && noteEvents.length === 0) {
    list.innerHTML = '<p class="notification-empty">Nenhuma notificação recente.</p>';
    return;
  }

  const renderFeedCard = (event, index) => {
    const created = event?.created_at ? new Date(event.created_at).toLocaleString() : '-';
    const title = escapeHtml(event?.title || 'Atualização do portal');
    const subtitle = escapeHtml(event?.subtitle || event?.source || 'Portal MDU');
    const message = escapeHtml(event?.message || '');
    const who = escapeHtml(event?.created_by || 'sistema');
    const reference = event?.reference ? ` • Ref: ${escapeHtml(String(event.reference))}` : '';
    const canAcceptObs = event?.type === 'observacao' && event?.reference;

    return `
      <div class="notification-item">
        <p><strong>${title}</strong></p>
        <p>${subtitle}</p>
        ${message ? `<p>${message}</p>` : ''}
        <p class="notification-meta">${who} • ${created}${reference}</p>
        ${canAcceptObs ? `
          <div class="notification-actions">
            <button class="approve" onclick="aceitarObsNotificacao(${index})">Aceitar OBS</button>
          </div>
        ` : ''}
      </div>
    `;
  };

  const renderRegistrationCard = (event) => {
    const username = event?.reference || event?.created_by || '';
    const isPending = pendingSet.has(username);
    const title = escapeHtml(event?.title || 'Novo cadastro');
    const message = escapeHtml(event?.message || '');
    const obs = escapeHtml(event?.obs || '');
    const created = event?.created_at ? new Date(event.created_at).toLocaleString() : '-';
    const safeUser = escapeHtml(username);

    return `
      <div class="notification-item">
        <p><strong>${title}</strong></p>
        ${obs ? `<p><em>OBS: ${obs}</em></p>` : ''}
        ${message ? `<p>${message}</p>` : ''}
        <p class="notification-meta">${created}</p>
        ${isPending ? `
          <div class="notification-actions">
            <button class="approve" onclick="approveUser('${safeUser}', 'admin')">Aprovar (Admin)</button>
            <button class="approve-alt" onclick="approveUser('${safeUser}', 'viewer')">Aprovar (Visualização)</button>
            <button class="deny" onclick="denyUser('${safeUser}')">Rejeitar</button>
          </div>
        ` : `<p class="notification-meta" style="color:#16a34a">✓ Acesso processado</p>`}
      </div>
    `;
  };

  const parts = [];

  if (hasLocal) {
    parts.push('<p class="notification-section-title">Solicitações locais pendentes</p>');
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

  if (registrationEvents.length > 0) {
    parts.push('<p class="notification-section-title">Cadastros</p>');
    parts.push(registrationEvents.map(renderRegistrationCard).join(""));
  }

  if (noteEvents.length > 0) {
    window.__notificationObsEvents = noteEvents;
    parts.push('<p class="notification-section-title">Observações recentes</p>');
    parts.push(noteEvents.map((event, idx) => renderFeedCard(event, idx)).join(""));
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

function localizarRegistroPorCodigo(lista = [], referencia = '') {
  const ref = String(referencia || '').trim().toLowerCase();
  if (!ref) return null;

  return (Array.isArray(lista) ? lista : []).find((item) => {
    const codigo = String(getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo", "CODGED", "codged", "cod_ged", "ID", "id") || '').toLowerCase();
    return codigo === ref;
  }) || null;
}

async function abrirRegistroDaObsNotificacao(event) {
  const referencia = String(event?.reference || '').trim();
  if (!referencia) {
    alert('⚠️ Não foi possível identificar o ID da observação.');
    return;
  }

  const entidade = normalizeText(event?.entity || event?.source || '');

  if (entidade.includes('projeto_f') || entidade.includes('projeto f') || entidade.includes('projetof')) {
    mostrarSecao('projeto-f');
    carregarDadosCategoria('projeto-f');
    const dadosProjetoF = dadosPorCategoria['projeto-f'] || [];
    const item = localizarRegistroPorCodigo(dadosProjetoF, referencia);

    if (item) {
      visualizarProjetoF(item);
      return;
    }

    alert(`⚠️ OBS aceita. Não encontrei o ID ${referencia} no Projeto F carregado.`);
    return;
  }

  mostrarSecao('pendente-autorizacao');
  carregarDadosCategoria('pendente-autorizacao');
  await abrirDetalhesPendente(referencia);
}

async function aceitarObsNotificacao(index) {
  const event = window.__notificationObsEvents?.[index];
  if (!event) return;

  acknowledgeObsEvent(event);
  await abrirRegistroDaObsNotificacao(event);

  const panel = document.getElementById('notificationPanel');
  if (panel && !panel.classList.contains('hidden')) {
    await renderNotificationList();
  }
  updateNotificationBadge();
}

// ===== PERFIL DO USUÁRIO =====
// Carregar foto de perfil do localStorage se existir
window.addEventListener("DOMContentLoaded", async () => {
  const savedPhoto = localStorage.getItem("userPhoto");
  if (savedPhoto) {
    document.getElementById("profileImage").src = savedPhoto;
  }

  applyColumnDensity(localStorage.getItem(STORAGE_COLUMN_DENSITY_KEY) || "compact");

  // Verificacao rapida a partir do localStorage (sem esperar o servidor)
  const quickUser = getCurrentUser();
  if (!quickUser) {
    // Sem usuario local - tenta sincronizar com servidor antes de redirecionar
    await syncCurrentUserFromServer();
    if (!getCurrentUser()) {
      window.location.href = "register.html";
      return;
    }
  }

  // Atualizar UI imediatamente com dados locais
  updateUserProfileInfo();
  updateNotificationBadge();
  applyAccessControl();

  // Carregar dados e sincronizar com servidor em paralelo
  const [, ] = await Promise.all([
    syncCurrentUserFromServer().then(serverUser => {
      if (serverUser) {
        updateUserProfileInfo();
        applyAccessControl();
      }
    }).catch(() => {}),
    carregarDadosCompartilhados(),
  ]);
  await carregarEpoDatasetsCompartilhados();
  await processarFilaSyncCompartilhada();
  aplicarRestricaoEpoAccess();

  // Preenche os cards/tabelas principais já na entrada para evitar tela vazia.
  ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'projeto-f'].forEach(carregarDadosCategoria);
  // SAR REDE: força sempre o cache local locked, se existir
  const localSar = getLocalDatasetCache()?.['sar-rede'];
  if (localSar?.locked && Array.isArray(localSar.items) && localSar.items.length) {
    applyDatasetToState('sar-rede', localSar.items);
  } else {
    carregarDadosCategoria('sar-rede');
  }
  atualizarContadores();
  
  // Carregar dados específicos de usuário de acompanhamento
  await loadViewerUserProfileData();

  // Inicializar componentes de interface
  initHeaderSearch();
  inicializarFiltrosDDD();
  setImportMode(importMode);
  agendarRenderVisaoGerencia(true);
  await checkForNewPortalBuild(true);

  window.setInterval(() => {
    updateNotificationBadge();
    carregarDadosCompartilhados();
    carregarEpoDatasetsCompartilhados();
    processarFilaSyncCompartilhada();
    checkForNewPortalBuild();

    const panel = document.getElementById("notificationPanel");
    if (panel && !panel.classList.contains("hidden")) {
      renderNotificationList();
    }
  }, SHARED_REFRESH_INTERVAL_MS);

  window.setInterval(() => {
    checkForNewPortalBuild();
  }, BUILD_VERSION_CHECK_INTERVAL_MS);

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

// REGISTRO GLOBAL DA FUNÇÃO DE DIAGNÓSTICO
function logTamanhoPlanilhasLocalStorage() {
  if (typeof localStorage === 'undefined') {
    console.warn('localStorage não está disponível.');
    return;
  }
  const tamanhos = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    try {
      const value = localStorage.getItem(key);
      const bytes = value ? new Blob([value]).size : 0;
      tamanhos.push({ key, bytes });
    } catch (e) {
      tamanhos.push({ key, bytes: -1, erro: true });
    }
  }
  tamanhos.sort((a, b) => b.bytes - a.bytes);
  console.log('Tamanho das planilhas/categorias no localStorage:');
  tamanhos.forEach(({ key, bytes, erro }) => {
    if (erro) {
      console.log(`- ${key}: erro ao calcular`);
    } else {
      const kb = (bytes / 1024).toFixed(2);
      console.log(`- ${key}: ${bytes} bytes (${kb} KB)`);
    }
  });
  if (tamanhos.length === 0) {
    console.log('Nenhuma planilha/categoria encontrada no localStorage.');
  }
  return tamanhos;
}
window.logTamanhoPlanilhasLocalStorage = logTamanhoPlanilhasLocalStorage;

// AVISO AUTOMÁTICO DE LOCALSTORAGE QUASE CHEIO
// Removido alerta automático de localStorage quase cheio
window.logTamanhoPlanilhasLocalStorage = logTamanhoPlanilhasLocalStorage;

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
    "mdu-ongoing": "MDU ONGOING",
    "ongoing": "ONGOING",
    "projeto-f": "Projeto F",
    "liberados": "LIBERADOS",
    "epo": "EPO",
    "financeiro": "Financeiro",
    "reuniao": "Reunião",
  };
  return mapping[categoriaId] || categoriaId || "-";
}

function updateImportTargetLabel() {
  const label = document.getElementById("import-target-name");
  if (!label) return;

  if (categoriaAtualParaImport === 'liberados' && liberadosSubcardSelecionado) {
    label.textContent = `${getCategoriaNome(categoriaAtualParaImport)} • ${getLiberadosAbaLabel(liberadosAbaAtiva)}`;
  } else {
    label.textContent = categoriaAtualParaImport ? getCategoriaNome(categoriaAtualParaImport) : "-";
  }

  updateImportLockInfo(categoriaAtualParaImport);
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

function detectarLinhaCabecalhoCSV(linhas = [], delimiter = ';') {
  let melhorIndice = 0;
  let melhorScore = -1;

  const limite = Math.min(linhas.length, 8);
  for (let i = 0; i < limite; i++) {
    const linha = (linhas[i] || '').trim();
    if (!linha) continue;

    const colunas = _splitCsvLine(linha, delimiter);
    const naoVazias = colunas.filter(col => String(col || '').trim() !== '').length;

    if (!naoVazias) continue;

    const tokensCabecalho = ['status', 'cidade', 'cliente', 'projeto', 'cod', 'id', 'endereco', 'ddd', 'obs', 'epo'];
    const scoreTokens = colunas.reduce((acc, col) => {
      const key = normalizeText(col);
      return acc + (tokensCabecalho.some(token => key.includes(token)) ? 1 : 0);
    }, 0);

    const score = (naoVazias * 2) + (scoreTokens * 3);
    if (score > melhorScore) {
      melhorScore = score;
      melhorIndice = i;
    }
  }

  return melhorIndice;
}

function detectarMelhorDelimitadorCSV(linhas = []) {
  const candidatos = [';', ',', '\t', '|'];
  let melhor = ';';
  let melhorScore = -1;

  candidatos.forEach((delimiter) => {
    const headerIdx = detectarLinhaCabecalhoCSV(linhas, delimiter);
    const linhaHeader = (linhas[headerIdx] || '').trim();
    if (!linhaHeader) return;

    const colunas = _splitCsvLine(linhaHeader, delimiter);
    const naoVazias = colunas.filter(c => String(c || '').trim() !== '').length;

    const tokensCabecalho = [
      'status', 'cidade', 'cliente', 'projeto', 'cod', 'id', 'endereco', 'ddd', 'obs', 'epo',
      'previs', 'age', 'enviado'
    ];

    const scoreTokens = colunas.reduce((acc, col) => {
      const key = normalizeText(col);
      return acc + (tokensCabecalho.some(token => key.includes(token)) ? 1 : 0);
    }, 0);

    const score = (naoVazias * 2) + (scoreTokens * 4);
    if (score > melhorScore) {
      melhorScore = score;
      melhor = delimiter;
    }
  });

  return melhor;
}

function parseSarRedeCsvRows(linhas = [], fallbackDelimiter = ';') {
  if (!Array.isArray(linhas) || !linhas.length) return [];

  const headerIndex = linhas.length > 1 ? 1 : 0;
  const headerLine = (linhas[headerIndex] || '').trim();
  if (!headerLine) return [];

  const delimiters = [';', ',', '\t', '|'];
  let delimiter = fallbackDelimiter;
  let bestCount = -1;

  delimiters.forEach((d) => {
    const count = _splitCsvLine(headerLine, d).length;
    if (count > bestCount) {
      bestCount = count;
      delimiter = d;
    }
  });

  const rows = [];
  for (let i = headerIndex + 1; i < linhas.length; i++) {
    const line = linhas[i];
    if (!line || !line.trim()) continue;

    let cols = _splitCsvLine(line, delimiter).map(v => String(v || '').trim());
    if (cols.length <= 1) {
      let localBest = cols;
      delimiters.forEach((d) => {
        const attempt = _splitCsvLine(line, d).map(v => String(v || '').trim());
        if (attempt.length > localBest.length) {
          localBest = attempt;
        }
      });
      cols = localBest;
    }

    const row = {
      'ID Projeto': cols[0] || '',
      'DDD': cols[1] || '',
      'Cidade': cols[2] || '',
      'Projeto': cols[3] || '',
      'BLOCOS': cols[4] || '',
      'HPS': cols[5] || '',
      'Área': cols[6] || '',
      'Cliente': cols[7] || '',
      'PROJETADO': cols[8] || '',
      'AGE GERAL': cols[9] || '',
      'FAIXA AGE': cols[10] || '',
      'ENVIADO': cols[11] || '',
      'PREVISÃO': cols[12] || '',
      'PREVISAO': cols[12] || '',
      'AGE': cols[13] || '',
      'EPO': cols[15] || '',
      'Status Projeto Real': cols[16] || '',
      'STATUS PROJETO REAL': cols[16] || ''
    };

    const hasMainData = [
      row['ID Projeto'], row['Cidade'], row['Cliente'], row['AGE GERAL'], row['Status Projeto Real']
    ].some(v => String(v || '').trim() !== '');

    if (hasMainData) {
      rows.push(row);
    }
  }

  return rows;
}

function getLiberadosAbaLabel(aba = 'projeto-f') {
  const mapping = {
    'projeto-f': 'PROJETO F',
    'gpon-hfc': 'GPON E HFC',
    'greenfield': 'GREENFIELD'
  };
  return mapping[aba] || 'PROJETO F';
}

function normalizeLiberadosAba(aba = '') {
  const norm = normalizeText(aba).replace(/[^a-z0-9]/g, '-');
  if (norm.includes('greenfield') || norm.includes('greenfild')) return 'greenfield';
  if (norm.includes('gpon') || norm.includes('hfc')) return 'gpon-hfc';
  return 'projeto-f';
}

function inferirAbaLiberadosPorRegistro(item = {}, abaPadrao = 'projeto-f') {
  const tipoRede = normalizeText(getField(item, 'TIPO_REDE', 'TIPO REDE', 'tipo_rede'));
  if (tipoRede.includes('greenfield') || tipoRede.includes('greenfild') || tipoRede.includes('green field')) return 'greenfield';
  if (tipoRede.includes('gpon') || tipoRede.includes('hfc')) return 'gpon-hfc';
  if (tipoRede.includes('projeto f') || tipoRede.includes('projetof')) return 'projeto-f';

  const texto = normalizeText([
    getField(item, 'TIPO_REDE', 'TIPO REDE', 'tipo_rede'),
    getField(item, 'STATUS', 'STATUS_GERAL', 'status'),
    getField(item, 'SOLICITANTE', 'solicitante'),
    getField(item, 'Projeto', 'PROJETO', 'projeto'),
    getField(item, 'Status Projeto Real', 'STATUS PROJETO REAL', 'status projeto real'),
    getField(item, 'EPO', 'epo'),
    getField(item, 'Observações Gerais', 'Observacoes Gerais', 'OBSERVACOES GERAIS', 'obs_gerais')
  ].join(' '));

  if (texto.includes('greenfield') || texto.includes('greenfild') || texto.includes('green field')) return 'greenfield';
  if (texto.includes('gpon') || texto.includes('hfc')) return 'gpon-hfc';
  if (texto.includes('projeto f') || texto.includes('projeto_f')) return 'projeto-f';
  return normalizeLiberadosAba(abaPadrao);
}

function parseLiberadosCsvRows(linhas = [], fallbackDelimiter = ';', abaPadrao = 'projeto-f') {
  const sourceLines = Array.isArray(linhas) ? linhas : [];
  const delimiters = Array.from(new Set([fallbackDelimiter, ';', '\t', ',', '|'].filter(Boolean)));
  const normalizeHeader = (value = '') => normalizeText(String(value || '')).replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

  const splitBest = (line = '') => {
    let best = [String(line || '')];
    delimiters.forEach((d) => {
      const cols = _splitCsvLine(String(line || ''), d);
      if (cols.length > best.length) best = cols;
    });
    return best.map((v) => String(v || '').trim());
  };

  const colunasLiberados = [
    { key: 'TIPO_REDE', aliases: ['TIPO_REDE', 'TIPO REDE', 'TIPO-REDE'] },
    { key: 'SOLICITANTE', aliases: ['SOLICITANTE'] },
    { key: 'DDD', aliases: ['DDD'] },
    { key: 'CIDADE', aliases: ['CIDADE'] },
    { key: 'ENDEREÇO', aliases: ['ENDEREÇO', 'ENDERECO', 'ENDERE O'] },
    { key: 'BLOCOS', aliases: ['BLOCOS', 'BLOCO'] },
    { key: 'HP', aliases: ['HP', 'HPS'] },
    { key: 'STATUS', aliases: ['STATUS', 'STATUS_GERAL'] },
    { key: 'DT_CONCLUIDO', aliases: ['DT_CONCLUIDO', 'DT CONCLUIDO', 'DT-CONCLUIDO', 'DATA_CONCLUIDO', 'DATA CONCLUIDO'] },
    { key: 'COD_IMOVEL', aliases: ['COD_IMOVEL', 'COD IMOVEL', 'COD-IMOVEL', 'ID IMOVEL'] }
  ];

  const buildHeaderMap = (cols = []) => {
    const map = {};
    cols.forEach((col, idx) => {
      const normalized = normalizeHeader(col);
      if (normalized && map[normalized] === undefined) {
        map[normalized] = idx;
      }
    });
    return map;
  };

  let headerLineIndex = -1;
  let headerMap = {};
  for (let i = 0; i < Math.min(sourceLines.length, 20); i += 1) {
    const cols = splitBest(sourceLines[i]);
    if (!cols.some((c) => String(c || '').trim() !== '')) continue;

    const candidateMap = buildHeaderMap(cols);
    const score = colunasLiberados.reduce((acc, col) => {
      const exists = col.aliases.some((alias) => candidateMap[normalizeHeader(alias)] !== undefined);
      return acc + (exists ? 1 : 0);
    }, 0);

    if (score >= 5) {
      headerLineIndex = i;
      headerMap = candidateMap;
      if (score === colunasLiberados.length) break;
    }
  }

  const getByAliases = (cols = [], aliases = []) => {
    for (const alias of aliases) {
      const idx = headerMap[normalizeHeader(alias)];
      if (idx !== undefined && idx < cols.length) {
        const value = String(cols[idx] || '').trim();
        if (value !== '') return value;
      }
    }
    return '';
  };

  const formatFromExactObject = (obj = {}, aba = abaPadrao) => ({
    'TIPO_REDE': String(getField(obj, 'TIPO_REDE', 'TIPO REDE') || '').trim(),
    'SOLICITANTE': String(getField(obj, 'SOLICITANTE') || '').trim(),
    'DDD': String(getField(obj, 'DDD') || '').trim(),
    'CIDADE': String(getField(obj, 'CIDADE', 'Cidade') || '').trim(),
    'ENDEREÇO': String(getField(obj, 'ENDEREÇO', 'ENDERECO', 'Cliente', 'ENDERECO_ENTRADA') || '').trim(),
    'BLOCOS': String(getField(obj, 'BLOCOS', 'BLOCO', 'Qtde Blocos', 'QTDE_BLOCOS') || '').trim(),
    'HP': String(getField(obj, 'HP', 'HPS') || '').trim(),
    'STATUS': String(getField(obj, 'STATUS', 'STATUS_GERAL', 'Status Projeto Real', 'STATUS PROJETO REAL') || '').trim(),
    'DT_CONCLUIDO': String(getField(obj, 'DT_CONCLUIDO', 'DT CONCLUIDO', 'DATA_CONCLUIDO', 'PREVISÃO', 'PREVISAO') || '').trim(),
    'COD_IMOVEL': String(getField(obj, 'COD_IMOVEL', 'COD IMOVEL', 'COD_GED', 'CÓD. GED', 'ID Projeto', 'ID_PROJETO') || '').trim(),
    '_aba_liberados': normalizeLiberadosAba(aba)
  });

  if (headerLineIndex >= 0) {
    const parsedRows = [];
    for (let i = headerLineIndex + 1; i < sourceLines.length; i += 1) {
      const cols = splitBest(sourceLines[i]);
      if (!cols.some((c) => String(c || '').trim() !== '')) continue;

      const raw = {};
      colunasLiberados.forEach((col) => {
        raw[col.key] = getByAliases(cols, col.aliases);
      });

      const row = formatFromExactObject(raw, inferirAbaLiberadosPorRegistro(raw, abaPadrao));
      const hasData = colunasLiberados.some((col) => String(row[col.key] || '').trim() !== '');
      if (hasData) parsedRows.push(row);
    }

    if (parsedRows.length) return parsedRows;
  }

  // Fallback para planilhas com 10 colunas em formato fixo mesmo com header corrompido (ex.: ENDERE�O).
  if (sourceLines.length >= 2) {
    const firstCols = splitBest(sourceLines[0] || '');
    const headerHint = normalizeHeader(firstCols.join(' '));
    const hasLiberadosHint = headerHint.includes('tipo rede')
      && headerHint.includes('solicitante')
      && headerHint.includes('ddd')
      && headerHint.includes('cidade');

    if (hasLiberadosHint && firstCols.length >= 9) {
      const fixedRows = [];
      for (let i = 1; i < sourceLines.length; i += 1) {
        const cols = splitBest(sourceLines[i]);
        if (!cols.some((c) => String(c || '').trim() !== '')) continue;

        const row = {
          'TIPO_REDE': String(cols[0] || '').trim(),
          'SOLICITANTE': String(cols[1] || '').trim(),
          'DDD': String(cols[2] || '').trim(),
          'CIDADE': String(cols[3] || '').trim(),
          'ENDEREÇO': String(cols[4] || '').trim(),
          'BLOCOS': String(cols[5] || '').trim(),
          'HP': String(cols[6] || '').trim(),
          'STATUS': String(cols[7] || '').trim(),
          'DT_CONCLUIDO': String(cols[8] || '').trim(),
          'COD_IMOVEL': String(cols[9] || '').trim(),
          '_aba_liberados': normalizeLiberadosAba(abaPadrao)
        };

        const hasData = colunasLiberados.some((col) => String(row[col.key] || '').trim() !== '');
        if (hasData) fixedRows.push(row);
      }

      if (fixedRows.length) return fixedRows;
    }
  }

  const baseRows = parseSarRedeCsvRows(sourceLines, fallbackDelimiter);
  return baseRows
    .map((row) => formatFromExactObject(row, inferirAbaLiberadosPorRegistro(row, abaPadrao)))
    .filter((row) => colunasLiberados.some((col) => String(row[col.key] || '').trim() !== ''));
}

function getDadosLiberadosEstruturados(base = []) {
  const estrutura = {
    'projeto-f': [],
    'gpon-hfc': [],
    'greenfield': []
  };

  if (!Array.isArray(base)) return estrutura;

  base.forEach((item) => {
    const aba = normalizeLiberadosAba(item?._aba_liberados || inferirAbaLiberadosPorRegistro(item, 'projeto-f'));
    estrutura[aba].push(item);
  });

  return estrutura;
}

function flattenDadosLiberadosEstruturados(estrutura = {}) {
  const merged = [];
  LIBERADOS_ABAS.forEach((aba) => {
    const rows = Array.isArray(estrutura?.[aba]) ? estrutura[aba] : [];
    rows.forEach((row) => {
      merged.push({ ...row, _aba_liberados: aba });
    });
  });
  return merged;
}

function getDadosLiberadosDaAba(base = [], aba = liberadosAbaAtiva) {
  const estrutura = getDadosLiberadosEstruturados(base);
  return estrutura[normalizeLiberadosAba(aba)] || [];
}

async function importarLiberadosPorAba(abaDestino = 'projeto-f', linhas = [], delimiter = ';', file = null, statusEl = null) {
  const aba = normalizeLiberadosAba(abaDestino);
  await carregarLiberadosDatasetRemotamente();
  const dadosAtuais = getPreferredDataset('liberados');
  const estruturaAtual = getDadosLiberadosEstruturados(dadosAtuais || []);
  const novosDadosImportados = parseLiberadosCsvRows(linhas, delimiter, aba)
    .map((row) => ({ ...row, _aba_liberados: aba }));

  estruturaAtual[aba] = novosDadosImportados;
  liberadosAbaAtiva = aba;
  atualizarBotoesAbaLiberados();

  const dadosAbaAtiva = estruturaAtual[aba] || [];
  const consolidados = flattenDadosLiberadosEstruturados(estruturaAtual);

  applyDatasetToState('liberados', consolidados);
  cacheDatasetLocally('liberados', consolidados, { source: 'manual', locked: true });
  await persistirDadosCompartilhados('liberados', consolidados, { source: 'manual', locked: true });

  renderTabelaLiberados('tabela-liberados', dadosAbaAtiva);
  atualizarBadgesLiberados();
  atualizarContadores();

  const infoEl = document.getElementById('liberados-aba-info');
  if (infoEl) {
    infoEl.textContent = `Aba ativa: ${getLiberadosAbaLabel(aba)} • ${dadosAbaAtiva.length} registro(s)`;
  }

  if (statusEl) {
    statusEl.textContent = `✅ Importado ${novosDadosImportados.length} registro(s) em ${getLiberadosAbaLabel(aba)}`;
  }

  const fileNameDisplay = document.getElementById('file-name');
  if (fileNameDisplay) {
    fileNameDisplay.textContent = file?.name ? `📄 ${file.name}` : '';
  }
}

async function importarLiberadosProjetoF(linhas = [], delimiter = ';', file = null, statusEl = null) {
  await importarLiberadosPorAba('projeto-f', linhas, delimiter, file, statusEl);
}

async function importarLiberadosGponHfc(linhas = [], delimiter = ';', file = null, statusEl = null) {
  await importarLiberadosPorAba('gpon-hfc', linhas, delimiter, file, statusEl);
}

async function importarLiberadosGreenfield(linhas = [], delimiter = ';', file = null, statusEl = null) {
  await importarLiberadosPorAba('greenfield', linhas, delimiter, file, statusEl);
}

function importarCSV() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const categoria = categoriaAtualParaImport || document.querySelector('.secao.ativa')?.id;
  if (!categoria) {
    return alert("Selecione uma categoria antes de importar.");
  }

  const categoriaNorm = normalizeText(categoria || '').replace(/[^a-z0-9]/g, '-');

  const input = document.getElementById("arquivoCSV");
  if (!input || !input.files.length) return alert("Selecione o CSV");
  const file = input.files[0];

  const statusEl = document.getElementById('import-status');
  if (statusEl) {
    statusEl.textContent = '⏳ Importando... Aguarde.';
  }

  const reader = new FileReader();
  reader.onload = async e => {
    // Remover BOM se presente (muito comum em CSV exportado pelo Excel)
    const text = e.target.result.replace(/^\uFEFF/, "");
    const linhas = text.split(/\r?\n/);

    if (!linhas.length || !linhas.some(l => (l || '').trim())) {
      alert('⚠️ Arquivo vazio ou inválido.');
      return;
    }

    const primeiraLinhaBruta = String(linhas[0] || '');
    if (primeiraLinhaBruta.startsWith('PK')) {
      alert('⚠️ Arquivo Excel (.xlsx/.xlsm) detectado. Para importar no portal, exporte a aba desejada em CSV e importe novamente.');
      if (statusEl) statusEl.textContent = '⚠️ Importe um CSV exportado da aba desejada.';
      return;
    }

    // Fail-safe: se o CSV tiver assinatura da aba ANALITICO SAR, usa parser dedicado sempre.
    const linha2 = String(linhas[1] || '').trim();
    const assinaturaSar = normalizeText(linha2);
    const isSarByFileSignature = assinaturaSar.includes('id projeto')
      && assinaturaSar.includes('ddd')
      && assinaturaSar.includes('cidade')
      && assinaturaSar.includes('cliente')
      && assinaturaSar.includes('status projeto real');

    const delimiter = detectarMelhorDelimitadorCSV(linhas);
    const headerLineIndex = detectarLinhaCabecalhoCSV(linhas, delimiter);
    const cabecalhoRaw = linhas[headerLineIndex] || "";
    const cabecalho = _splitCsvLine(cabecalhoRaw, delimiter).map(c => c.replace(/^\uFEFF/, "").trim());

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

    const isPendente = categoria === 'pendente-autorizacao' || categoriaNorm === 'pendente-autorizacao';
    const isOngoing = categoria === 'ongoing' || categoriaNorm === 'ongoing';
    const isMduOngoing = categoria === 'mdu-ongoing' || categoriaNorm === 'mdu-ongoing';
    const isProjetoF = categoria === 'projeto-f' || categoriaNorm === 'projeto-f';
    const isLiberados = categoria === 'liberados' || categoriaNorm === 'liberados';
    const isSarRede = categoria === 'sar-rede' || categoriaNorm === 'sar-rede' || (categoriaNorm.includes('sar') && categoriaNorm.includes('rede'));

    if (isSarByFileSignature || isSarRede) {
      const dados = parseSarRedeCsvRows(linhas, delimiter);

      applyDatasetToState('sar-rede', dados);
      cacheDatasetLocally('sar-rede', dados, { source: 'manual', locked: true });
      await persistirDadosCompartilhados('sar-rede', dados, { source: 'manual', locked: true });

      renderTabelaSarRede('tabela-sar-rede', dados);
      popularFiltroStatusSarRede(dados);
      atualizarContadores();
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

    if (isOngoing) {
      const dados = processarCSVOngoingCompartilhado(text, delimiter);
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
      cacheDatasetLocally('ongoing', dados, { source: 'manual', locked: true });
      const persistResult = await persistirDadosCompartilhados('ongoing', dados, { source: 'manual', locked: true });
      if (statusEl) {
        statusEl.textContent = persistResult?.queued
          ? `✅ Importado ${dados.length} registro(s) • sincronização compartilhada pendente`
          : `✅ Importado ${dados.length} registro(s)`;
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
        cacheDatasetLocally('backlog', dadosBacklogGerencia, { source: 'manual', locked: true });
      }

      const dados = processarCSVMduOngoing(text, delimiter);
      applyDatasetToState('mdu-ongoing', dados);
      renderTabelaMduOngoing(`tabela-mdu-ongoing`, dados);
      cacheDatasetLocally('mdu-ongoing', dados, { source: 'manual', locked: true });
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
      applyDatasetToState('projeto-f', dados);
      cacheDatasetLocally('projeto-f', dados, { source: 'manual', locked: true });
      renderTabelaProjetoF(`tabela-projeto-f`, dados);
      // Evita travamento perceptível da UI logo após importação grande.
      window.requestAnimationFrame(() => {
        window.setTimeout(async () => {
          await persistirDadosCompartilhados('projeto-f', dados, { source: 'manual', locked: true });
          // Salva lista compacta de cidades para garantir dropdown completo em outros dispositivos.
          const seenCities = new Set();
          const cityRows = [];
          for (const row of dados) {
            const c = String(getField(row, 'CIDADE', 'cidade', 'Cidade') || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (!c) continue;
            const ck = normalizeText(c).replace(/[^a-z0-9]/g, '');
            if (!ck || seenCities.has(ck)) continue;
            seenCities.add(ck);
            cityRows.push({ CIDADE: c });
          }
          if (cityRows.length) {
            applyDatasetToState('projeto-f-cities', cityRows);
            cacheDatasetLocally('projeto-f-cities', cityRows, { source: 'derived', locked: true });
            await persistirDadosCompartilhados('projeto-f-cities', cityRows, { source: 'derived', locked: true });
            projetoFCityFilterCacheToken = null; // força rebuild do dropdown
          }
        }, 0);
      });
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

    if (isLiberados) {
      const abaSelecionada = normalizeLiberadosAba(liberadosAbaAtiva);
      if (abaSelecionada === 'projeto-f') {
        await importarLiberadosProjetoF(linhas, delimiter, file, statusEl);
      } else if (abaSelecionada === 'greenfield') {
        await importarLiberadosGreenfield(linhas, delimiter, file, statusEl);
      } else {
        await importarLiberadosGponHfc(linhas, delimiter, file, statusEl);
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
    let linhaAtual = headerLineIndex + 1;
    const batchSize = 1000;
    const maxItensPendente = 5000; // Limite para evitar travar em planilhas gigantes
    let truncado = false;

    const processBatch = () => {
      const fim = Math.min(linhas.length, linhaAtual + batchSize);
      for (; linhaAtual < fim; linhaAtual++) {
        const linha = linhas[linhaAtual];
        if (!linha || !linha.trim()) continue;

        const cols = _splitCsvLine(linha, delimiter);

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
        const totalDados = Math.max(0, linhas.length - (headerLineIndex + 1));
        const linhasProcessadas = Math.max(0, Math.min(linhaAtual - (headerLineIndex + 1), totalDados));
        const destino = truncado ? `${parsed.length}+` : parsed.length;
        statusEl.textContent = `⏳ Importando... ${linhasProcessadas}/${totalDados} linhas processadas, ${destino} registro(s)`;
      }

      if (linhaAtual < linhas.length) {
        setTimeout(processBatch, 0);
      } else {
        if (categoria === 'empresarial') {
          parsed.forEach(item => {
            const hasSolicitante = Boolean(getField(item, 'SOLICITANTE', 'solicitante'));
            if (!hasSolicitante) {
              item.SOLICITANTE = 'EMPRESARIAL';
              item.solicitante = 'EMPRESARIAL';
            }
          });
        }

        parsed.forEach(item => {
          const obsValue = getField(item, 'OBS', 'obs', 'OBSERVACAO', 'observacao', 'STATUS OBS', 'status_obs');
          if (obsValue && !item.OBS) {
            item.OBS = obsValue;
            item.obs = obsValue;
          }
        });

        if (categoria === 'sar-rede') {
          // Em SAR REDE, a importacao manual precisa prevalecer sobre qualquer base derivada.
          applyDatasetToState('sar-rede', parsed);
          cacheDatasetLocally('sar-rede', parsed, { source: 'manual', locked: true });
          persistirDadosCompartilhados('sar-rede', parsed, { source: 'manual', locked: true });

          if (statusEl) {
            if (truncado) {
              statusEl.textContent = `✅ Importado ${parsed.length}+ registros (limite atingido, há mais linhas no arquivo)`;
            } else {
              statusEl.textContent = `✅ Importado ${parsed.length} registro(s)`;
            }
          }

          renderTabelaSarRede('tabela-sar-rede', parsed);
          popularFiltroStatusSarRede(parsed);
          atualizarSeccaoAtivaComDados();
          return;
        }

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

  reader.readAsText(file, "ISO-8859-1");
}

// IMPORTAR CSV a partir de caminho no servidor (rede)
async function importarDoCaminhoRede() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

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
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

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

  const dadosEmpresariais = Array.isArray(lista) ? lista : [];

  if (!dadosEmpresariais.length) {
    window.__empresarialRowsSnapshot = [];
    tbody.innerHTML = `<tr><td colspan="10">Nenhum registro</td></tr>`;
    popularFiltrosEmpresarial(dadosEmpresariais);
    return;
  }

  window.__empresarialRowsSnapshot = dadosEmpresariais;

  const rows = dadosEmpresariais.map((i, index) => {
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
        <td><span class="table-address-cell" title="${escapeHtml(endereco)}">${escapeHtml(endereco)}</span></td>
        <td>${numero}</td>
        <td>${bairro}</td>
        <td>${cidade}</td>
        <td>${epo}</td>
        <td>${solicitante}</td>
        <td>${statusGeral}</td>
        <td>${motivoGeral}</td>
        <td><button type="button" onclick="visualizarEmpresarialPorIndice(${index})" class="btn-visualizar">Visualizar</button></td>
      </tr>`;
  });

  tbody.innerHTML = rows.join('');
  popularFiltrosEmpresarial(dadosEmpresariais);
}

function _getFieldByKeyHint(item, hint) {
  if (!item || typeof item !== 'object' || !hint) return '';
  const normalizedHint = normalizeText(hint);
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || value === null || value === '') continue;
    if (normalizeText(key).includes(normalizedHint)) {
      return value;
    }
  }
  return '';
}

function getSarRedeIdProjeto(item) {
  return getField(item, 'ID Projeto', 'ID_PROJETO', 'id projeto', 'id_projeto', 'COD-MDUGO', 'cod-mdugo', 'codmdugo', 'ID')
    || _getFieldByKeyHint(item, 'id projeto')
    || _getFieldByKeyHint(item, 'id');
}

function getSarRedeCliente(item) {
  return getField(item, 'Cliente', 'CLIENTE', 'cliente', 'ENDEREÇO', 'ENDERECO', 'endereco')
    || _getFieldByKeyHint(item, 'cliente')
    || _getFieldByKeyHint(item, 'endereco');
}

function getSarRedeStatusProjetoReal(item) {
  return getField(item, 'Status Projeto Real', 'STATUS PROJETO REAL', 'status projeto real', 'status_projeto_real')
    || _getFieldByKeyHint(item, 'status projeto real')
    || _getFieldByKeyHint(item, 'status projeto');
}

function renderTabelaSarRede(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = '';

  const dados = (Array.isArray(lista) ? lista : []).filter((item) => {
    const idProjeto = String(getSarRedeIdProjeto(item) || '').trim();
    const cidade = String(getField(item, 'Cidade', 'CIDADE', 'cidade') || _getFieldByKeyHint(item, 'cidade') || '').trim();
    const cliente = String(getSarRedeCliente(item) || '').trim();
    const status = String(getSarRedeStatusProjetoReal(item) || '').trim();
    return Boolean(idProjeto || cidade || cliente || status);
  });
  if (!dados.length) {
    window.__sarRedeRowsSnapshot = [];
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center">Nenhum registro</td></tr>';
    popularFiltroStatusSarRede([]);
    return;
  }

  window.__sarRedeRowsSnapshot = dados;

  const rows = dados.map((item, index) => {
    const idProjeto = getSarRedeIdProjeto(item) || '-';
    const ddd = getField(item, 'DDD', 'ddd') || _getFieldByKeyHint(item, 'ddd') || '-';
    const cidade = getField(item, 'Cidade', 'CIDADE', 'cidade') || _getFieldByKeyHint(item, 'cidade') || '-';
    const cliente = getSarRedeCliente(item) || '-';
    const projetado = getField(item, 'PROJETADO', 'projetado') || _getFieldByKeyHint(item, 'projetado') || '-';
    const ageGeral = getField(item, 'AGE GERAL', 'age geral', 'AGE_GERAL', 'age_geral', 'AGE', 'age') || _getFieldByKeyHint(item, 'age geral') || '-';
    const enviado = getField(item, 'ENVIADO', 'enviado') || _getFieldByKeyHint(item, 'enviado') || '-';
    const previsao = getField(item, 'PREVISÃO', 'PREVISAO', 'previsao', 'previsão') || _getFieldByKeyHint(item, 'previs') || '-';
    const statusProjetoReal = getSarRedeStatusProjetoReal(item) || '-';

    return `
      <tr>
        <td>${escapeHtml(idProjeto)}</td>
        <td>${escapeHtml(ddd)}</td>
        <td>${escapeHtml(cidade)}</td>
        <td><span class="table-address-cell" title="${escapeHtml(cliente)}">${escapeHtml(cliente)}</span></td>
        <td>${escapeHtml(projetado)}</td>
        <td><strong>${escapeHtml(ageGeral)}</strong></td>
        <td>${escapeHtml(enviado)}</td>
        <td>${escapeHtml(previsao)}</td>
        <td>${escapeHtml(statusProjetoReal)}</td>
        <td><button type="button" class="btn-visualizar" onclick="visualizarSarRedePorIndice(${index})">Visualizar</button></td>
      </tr>`;
  });

  tbody.innerHTML = rows.join('');
  popularFiltroStatusSarRede(dados);
}

function popularFiltroStatusSarRede(listaBase = null) {
  const select = document.getElementById('status-filter-sar');
  if (!select) return;

  const valorAtual = select.value || '';
  const dados = Array.isArray(listaBase) ? listaBase : (dadosPorCategoria['sar-rede'] || []);
  const statusUnicos = [...new Set(dados
    .map(item => (getSarRedeStatusProjetoReal(item) || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  select.innerHTML = '<option value="">Todos</option>';
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

function atualizarFiltroStatusSarRede() {
  const statusSelecionado = document.getElementById('status-filter-sar')?.value?.toLowerCase().trim() || '';
  const dados = dadosPorCategoria['sar-rede'] || [];

  const filtrados = !statusSelecionado
    ? dados
    : dados.filter(item => (getSarRedeStatusProjetoReal(item) || '').toLowerCase().trim().includes(statusSelecionado));

  renderTabelaSarRede('tabela-sar-rede', filtrados);
}

function renderTabelaMduOngoing(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    window.__mduOngoingRowsSnapshot = [];
    tbody.innerHTML = `<tr><td colspan="10">Nenhum registro</td></tr>`;
    popularFiltroStatusMdu();
    return;
  }

  const dados = Array.isArray(lista) ? lista : [];
  window.__mduOngoingRowsSnapshot = dados;

  const rows = dados.map((i, index) => {
    const codigo = getField(i, "COD-MDUGO", "CÓDIGO", "CODIGO", "COD", "ID") || '-';
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
        <td><span class="table-address-cell" title="${escapeHtml(endereco || '-')}">${escapeHtml(endereco || '-')}</span></td>
        <td>${numero}</td>
        <td>${bairro}</td>
        <td>${cidade}</td>
        <td>${epo}</td>
        <td>${solicitante}</td>
        <td>${statusGeral}</td>
        <td>${motivoGeral}</td>
        <td><button type="button" onclick="visualizarMduOngoingPorIndice(${index})" class="btn-visualizar">🔍 Visualizar</button></td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
  popularFiltroStatusMdu();
}

function visualizarMduOngoingPorIndice(index) {
  const rows = Array.isArray(window.__mduOngoingRowsSnapshot) ? window.__mduOngoingRowsSnapshot : [];
  const item = rows[index];
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const codigo = String(getField(item, "COD-MDUGO", "CÓDIGO", "CODIGO", "COD", "ID") || '').trim();
  visualizarMduOngoing(codigo || index);
}

function renderTabelaProjetoF(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    window.__projetoFModalData = [];
    tbody.innerHTML = `<tr><td colspan="8">Nenhum registro</td></tr>`;
    popularFiltroCidadeProjetoF();
    popularFiltroStatusProjetoF(dadosPorCategoria['projeto-f'] || []);
    return;
  }

  const dados = Array.isArray(lista) ? lista : [];
  window.__projetoFModalData = dados;

  // Exibe todas as linhas
  const buildRows = (startIndex, endIndex) => dados.slice(startIndex, endIndex).map((i, localIndex) => {
    const index = startIndex + localIndex;
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

  // Exibe todas as linhas de uma vez
  tbody.innerHTML = buildRows(0, dados.length);

  popularFiltroCidadeProjetoF();
  popularFiltroStatusProjetoF(dadosPorCategoria['projeto-f'] || []);
}

function isStatusLiberadoProjetoF(item) {
  const statusLiberacao = normalizeText(getField(item, "STATUS LIBERAÇÃO", "STATUS_LIBERACAO", "status_liberacao", "Liberação concluida?", "Liberacao Concluida?", "LIBERACAO_CONCLUIDA"));
  if (!statusLiberacao) return false;

  return statusLiberacao.includes('ok')
    || statusLiberacao.includes('liber')
    || statusLiberacao.includes('concluid');
}

function getDadosLiberadosProjetoF(base = []) {
  const dados = Array.isArray(base) ? base : [];
  return dados.filter(isStatusLiberadoProjetoF);
}

function atualizarBadgesLiberados() {
  const estrutura = getDadosLiberadosEstruturados(getPreferredDataset('liberados') || []);
  const map = {
    'projeto-f': document.getElementById('liberados-badge-projeto-f'),
    'gpon-hfc': document.getElementById('liberados-badge-gpon-hfc'),
    'greenfield': document.getElementById('liberados-badge-greenfield')
  };

  Object.entries(map).forEach(([aba, el]) => {
    if (!el) return;
    const total = Array.isArray(estrutura?.[aba]) ? estrutura[aba].length : 0;
    el.textContent = `${total} registro(s)`;
    el.classList.toggle('is-empty', total === 0);
    el.classList.toggle('is-filled', total > 0);
  });
}

function atualizarLayoutLiberados() {
  const secaoLiberados = document.getElementById('liberados');
  const detalhesCard = document.getElementById('liberados-detalhes-card');
  const gridCards = document.querySelector('#liberados .liberados-subcards-grid');
  const botaoTrocar = document.getElementById('liberados-reset-selecao');
  const canImport = usuarioPodeImportar();
  const isLiberadosAtivo = Boolean(secaoLiberados?.classList.contains('ativa'));
  const mostrarDetalhes = isLiberadosAtivo && liberadosSubcardSelecionado;

  if (detalhesCard) {
    detalhesCard.style.display = mostrarDetalhes ? 'block' : 'none';
  }

  if (gridCards) {
    gridCards.classList.toggle('only-active', mostrarDetalhes);
  }

  if (botaoTrocar) {
    botaoTrocar.style.display = mostrarDetalhes ? 'inline-flex' : 'none';
  }

  const globalImport = document.getElementById('global-import-section');
  if (globalImport && isLiberadosAtivo) {
    const mostrarImport = canImport && mostrarDetalhes;
    globalImport.style.display = mostrarImport ? 'block' : 'none';
    globalImport.classList.toggle('liberados-import-premium', mostrarImport);
  } else if (globalImport) {
    globalImport.classList.remove('liberados-import-premium');
  }
}

function atualizarBotoesAbaLiberados() {
  const mapCards = {
    'projeto-f': document.getElementById('liberados-card-projeto-f'),
    'gpon-hfc': document.getElementById('liberados-card-gpon-hfc'),
    'greenfield': document.getElementById('liberados-card-greenfield')
  };

  Object.entries(mapCards).forEach(([aba, el]) => {
    if (!el) return;
    const ativa = aba === liberadosAbaAtiva && liberadosSubcardSelecionado;
    el.classList.toggle('is-active', ativa);
  });

  const mapCompatButtons = {
    'projeto-f': document.getElementById('liberados-aba-projeto-f'),
    'gpon-hfc': document.getElementById('liberados-aba-gpon-hfc'),
    'greenfield': document.getElementById('liberados-aba-greenfield')
  };

  Object.entries(mapCompatButtons).forEach(([aba, el]) => {
    if (!el) return;
    const ativa = aba === liberadosAbaAtiva;
    el.classList.toggle('btn-primary', ativa);
    el.classList.toggle('btn-secondary', !ativa);
  });
}


async function selecionarAbaLiberados(aba = 'projeto-f') {
  liberadosSubcardSelecionado = true;
  liberadosAbaAtiva = normalizeLiberadosAba(aba);
  atualizarBotoesAbaLiberados();
  updateImportTargetLabel();
  atualizarLayoutLiberados();

  // SEMPRE ler do IndexedDB ao trocar de aba
  const dadosIdx = await lerPlanilhaIndexedDB('liberados');
  if (Array.isArray(dadosIdx)) {
    applyDatasetToState('liberados', dadosIdx);
    // Atualiza badge e tabela APÓS leitura
    atualizarBadgesLiberados();
    const dadosAba = getDadosLiberadosDaAba(dadosIdx, liberadosAbaAtiva);
    renderTabelaLiberados('tabela-liberados', dadosAba);
  } else {
    // Se não houver dados, limpa badge/tabela
    atualizarBadgesLiberados();
    renderTabelaLiberados('tabela-liberados', []);
  }
  // Não usar localStorage/cache para badge/tabela LIBERADOS
}

function abrirCardLiberados(aba = 'projeto-f') {
  selecionarAbaLiberados(aba);
}

function resetarFluxoLiberados() {
  liberadosSubcardSelecionado = false;
  atualizarBotoesAbaLiberados();
  atualizarBadgesLiberados();
    // Sempre ler do IndexedDB ao trocar de aba
    atualizarBadgesLiberados();
    carregarDadosCategoria('liberados');
    updateImportTargetLabel();
    atualizarLayoutLiberados();
    applyDatasetToState('liberados', []);
    dadosPorCategoria['liberados'] = [];
    // Atualiza badge e tabela com base no IndexedDB
  const infoEl = document.getElementById('liberados-aba-info');
  if (infoEl) {
    infoEl.textContent = 'Selecione PROJETO F, GPON E HFC ou GREENFIELD para abrir anexo e tabela.';
  }

  renderTabelaLiberados('tabela-liberados', []);
}

function renderTabelaLiberados(id, lista) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  const dados = Array.isArray(lista) ? lista : [];
  window.__liberadosModalData = dados;

  const tableEl = tbody.closest('table');
  if (tableEl) {
    const headHtml = `
      <tr>
        <th>TIPO_REDE</th>
        <th>SOLICITANTE</th>
        <th>DDD</th>
        <th>CIDADE</th>
        <th>ENDEREÇO</th>
        <th>BLOCOS</th>
        <th>HP</th>
        <th>STATUS</th>
        <th>DT_CONCLUIDO</th>
        <th>COD_IMOVEL</th>
      </tr>`;
    const thead = tableEl.querySelector('thead');
    if (thead) thead.innerHTML = headHtml;
  }

  if (!dados.length) {
    tbody.innerHTML = `<tr><td colspan="10">Nenhum registro liberado</td></tr>`;
    return;
  }

  const rows = dados.map((i) => {
    const tipoRede = getField(i, 'TIPO_REDE', 'TIPO REDE') || '-';
    const solicitante = getField(i, 'SOLICITANTE') || '-';
    const ddd = getField(i, 'DDD') || '-';
    const cidade = getField(i, 'CIDADE', 'Cidade', 'cidade') || '-';
    const endereco = getField(i, 'ENDEREÇO', 'ENDERECO', 'Cliente', 'CLIENTE', 'endereco') || '-';
    const blocos = getField(i, 'BLOCOS', 'BLOCO', 'Qtde Blocos', 'QTDE_BLOCOS') || '-';
    const hp = getField(i, 'HP', 'HPS') || '-';
    const status = getField(i, 'STATUS', 'STATUS_GERAL', 'Status Projeto Real', 'STATUS PROJETO REAL') || '-';
    const dtConcluido = getField(i, 'DT_CONCLUIDO', 'DT CONCLUIDO', 'DATA_CONCLUIDO', 'PREVISÃO', 'PREVISAO') || '-';
    const codImovel = getField(i, 'COD_IMOVEL', 'COD IMOVEL', 'COD_GED', 'CÓD. GED', 'ID Projeto', 'ID_PROJETO') || '-';

    return `
      <tr>
        <td>${escapeHtml(tipoRede || '-')}</td>
        <td>${escapeHtml(solicitante || '-')}</td>
        <td>${escapeHtml(ddd || '-')}</td>
        <td>${escapeHtml(cidade || '-')}</td>
        <td><span class="table-address-cell" title="${escapeHtml(endereco || '-')}">${escapeHtml(endereco || '-')}</span></td>
        <td>${escapeHtml(blocos || '-')}</td>
        <td>${escapeHtml(hp || '-')}</td>
        <td>${escapeHtml(status || '-')}</td>
        <td>${escapeHtml(dtConcluido || '-')}</td>
        <td>${escapeHtml(codImovel || '-')}</td>
      </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

function getLiberadosRowsFiltrados(listaBase = null) {
  const dados = Array.isArray(listaBase) ? listaBase : getDadosLiberadosDaAba(getPreferredDataset('liberados') || [], liberadosAbaAtiva);
  const filtroCidade = normalizeText(document.getElementById('filtro-cidade-liberados')?.value || '').trim();

  if (!filtroCidade) {
    return dados;
  }

  return dados.filter((item) => {
    const cidade = normalizeText(getField(item, 'CIDADE', 'Cidade', 'cidade') || '');
    return cidade.includes(filtroCidade);
  });
}

function aplicarFiltrosLiberados() {
  const baseLiberados = getPreferredDataset('liberados');
  let dadosAba = getDadosLiberadosDaAba(baseLiberados || [], liberadosAbaAtiva);

  if ((!baseLiberados || !baseLiberados.length) && !dadosAba.length && liberadosAbaAtiva === 'projeto-f') {
    const baseProjetoF = getPreferredDataset('projeto-f');
    dadosAba = getDadosLiberadosProjetoF(baseProjetoF || []).map(item => ({ ...item, _aba_liberados: 'projeto-f' }));
  }

  // Sempre limpar filtro de cidade ao trocar de aba ou importar
  const filtroCidadeInput = document.getElementById('filtro-cidade-liberados');
  if (filtroCidadeInput) filtroCidadeInput.value = '';

  const infoEl = document.getElementById('liberados-aba-info');
  if (infoEl) {
    infoEl.textContent = `Aba ativa: ${getLiberadosAbaLabel(liberadosAbaAtiva)} • ${dadosAba.length} registro(s)`;
  }

  renderTabelaLiberados('tabela-liberados', dadosAba);
}

function visualizarLiberado(index) {
  const rows = Array.isArray(window.__liberadosModalData) ? window.__liberadosModalData : [];
  const item = rows[index];
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const idProjeto = getField(item, 'ID Projeto', 'ID_PROJETO', 'id projeto', 'id_projeto', 'ID', 'id', 'CÓD. GED', 'Cód. GED', 'COD_GED', 'cod_ged') || '-';
  const cidade = getField(item, 'Cidade', 'CIDADE', 'cidade') || '-';
  const cliente = getField(item, 'Cliente', 'CLIENTE', 'cliente', 'ENDEREÇO', 'ENDERECO', 'endereco') || '-';
  const statusProjetoReal = getField(item, 'Status Projeto Real', 'STATUS PROJETO REAL', 'status projeto real', 'status_projeto_real', 'STATUS LIBERAÇÃO', 'STATUS_LIBERACAO', 'Status Liberação') || '-';
  const previsao = getField(item, 'PREVISÃO', 'PREVISAO', 'previsao', 'previsão', 'Status MDU', 'STATUS_MDU', 'STATUS MDU') || '-';
  const ddd = getField(item, 'DDD', 'ddd') || '-';
  const ageGeral = getField(item, 'AGE GERAL', 'age geral', 'AGE_GERAL', 'age_geral', 'AGE', 'age') || '-';
  const projetado = getField(item, 'PROJETADO', 'projetado') || '-';
  const epo = getField(item, 'EPO', 'epo') || '-';
  const site = getField(item, 'SITE', 'site') || '-';
  const caboFo = getField(item, 'CABO FO', 'CABO_FO', 'cabo_fo', 'cabo fo') || '-';
  const observacoesGerais = getField(item, 'Observações Gerais', 'Observacoes Gerais', 'OBSERVACOES GERAIS', 'obs_gerais', 'OBS') || '-';
  const blocos = getField(item, 'BLOCOS', 'blocos') || '-';
  const hps = getField(item, 'HPS', 'hps') || '-';
  const area = getField(item, 'Área', 'Area', 'AREA', 'área') || '-';

  currentPendenteCodigo = String(idProjeto || `liberados-${index}`);

  document.getElementById('modal-codigo').textContent = idProjeto;
  document.getElementById('modal-endereco').textContent = cliente;
  document.getElementById('modal-bairro').textContent = '-';
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusProjetoReal);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(previsao);
  document.getElementById('modal-obs-original').textContent = observacoesGerais;
  document.getElementById('modal-obs-adicional').value = '';

  applyModalContext({
    themeClass: 'mdu-ongoing-modal',
    title: `Detalhes LIBERADOS • ${getLiberadosAbaLabel(liberadosAbaAtiva)}`,
    kicker: 'Painel analítico de liberados',
    heroChip: getLiberadosAbaLabel(liberadosAbaAtiva),
    heroTitle: cliente || idProjeto,
    heroSubtitle: [cidade, epo].filter(v => v && v !== '-').join(' • ') || 'Registro liberado selecionado',
    statusLabel: 'Status Projeto Real',
    motivoLabel: 'Previsão',
    heroPills: [
      { label: 'ID Projeto', value: idProjeto },
      { label: 'DDD', value: ddd },
      { label: 'Age Geral', value: ageGeral }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('EPO', epo, { featured: true })}
        ${renderModalInfoCard('SITE', site)}
        ${renderModalInfoCard('CABO FO', caboFo)}
        ${renderModalInfoCard('BLOCOS', blocos)}
        ${renderModalInfoCard('HPS', hps)}
        ${renderModalInfoCard('Área', area)}
        ${renderModalInfoCard('Projetado', projetado)}
      </div>
      ${renderModalAllFields(item)}
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  carregarObservacoesPendente(currentPendenteCodigo);
  carregarAnexosPendente(currentPendenteCodigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = '';
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(currentPendenteCodigo, file);
      }
    };
  }
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
  const input = document.getElementById('filtro-cidade-projeto-f');
  const sugestoes = document.getElementById('filtro-cidade-projeto-f-sugestoes');
  if (!input || !sugestoes) return;

  const valorAtual = input.value || '';
  const filtro = valorAtual.toLowerCase().trim();
  const dados = dadosPorCategoria['projeto-f'] || [];
  const dadosCidadesLen = (dadosPorCategoria['projeto-f-cities'] || []).length;
  const cacheToken = `projeto-f:${getDatasetVersionToken(dados)}:${dados.length}:${dadosCidadesLen}`;
  const sanitizeCidadeProjetoF = (value = '') => String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Valida se o valor parece um nome de cidade real (rejeita emails, URLs, textos longos, etc.)
  const ehCidadeValida = (cidade = '') => {
    if (!cidade || cidade.length < 2 || cidade.length > 60) return false;
    if (/@|\/\/|https?:|www\.|\.com|\.br/.test(cidade)) return false;
    // Deve conter apenas letras (incluindo acentuadas), espaços e hífens
    if (/[^a-zA-ZÀ-ÿ\u00C0-\u017E\s'\-]/.test(cidade)) return false;
    // Não pode ter mais de 4 palavras (cidades brasileiras raramente têm mais)
    if (cidade.trim().split(/\s+/).length > 5) return false;
    return true;
  };

  let cidadesUnicas = [];
  if (cacheToken === projetoFCityFilterCacheToken && projetoFCityFilterCacheOptions.length) {
    cidadesUnicas = projetoFCityFilterCacheOptions.slice();
  } else {
    const seen = new Set();

    // 1) Cidades das linhas carregadas
    for (let i = 0; i < dados.length; i += 1) {
      const cidadeRaw = getField(dados[i], 'CIDADE', 'cidade', 'Cidade') || '';
      const cidade = sanitizeCidadeProjetoF(cidadeRaw);
      if (!cidade || !ehCidadeValida(cidade)) continue;
      const key = normalizeText(cidade).replace(/[^a-z0-9]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cidadesUnicas.push(cidade);
      if (cidadesUnicas.length >= 50000) break;
    }

    // 2) Cidades do dataset compacto (salvo na importação)
    const dadosCidades = dadosPorCategoria['projeto-f-cities'] || [];
    for (let i = 0; i < dadosCidades.length; i += 1) {
      const cidadeRaw = getField(dadosCidades[i], 'CIDADE', 'cidade', 'Cidade') || '';
      const cidade = sanitizeCidadeProjetoF(cidadeRaw);
      if (!cidade || !ehCidadeValida(cidade)) continue;
      const key = normalizeText(cidade).replace(/[^a-z0-9]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cidadesUnicas.push(cidade);
    }

    cidadesUnicas.sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
    projetoFCityFilterCacheToken = cacheToken;
    projetoFCityFilterCacheOptions = cidadesUnicas.slice();
  }

  const cidadesFiltradas = cidadesUnicas.filter(cidade => !filtro || cidade.toLowerCase().includes(filtro));
  const cidadesVisiveis = cidadesFiltradas;

  const headHtml = `
    <div class="filtro-cidade-projeto-f-head">
      <span class="filtro-cidade-projeto-f-icon" aria-hidden="true">📍</span>
      <span class="filtro-cidade-projeto-f-title">Cidades</span>
      <span class="filtro-cidade-projeto-f-count">${cidadesFiltradas.length}</span>
    </div>
  `;

  if (!cidadesVisiveis.length) {
    sugestoes.innerHTML = `${headHtml}<div class="filtro-cidade-projeto-f-vazio">Nenhuma cidade encontrada</div>`;
    sugestoes.classList.remove('hidden');
    return;
  }

  sugestoes.innerHTML = `${headHtml}<div class="filtro-cidade-projeto-f-list">${cidadesVisiveis.map(cidade => `
    <button type="button" class="filtro-cidade-projeto-f-opcao" onclick='selecionarCidadeProjetoF(${JSON.stringify(cidade)})'>${escapeHtml(cidade)}</button>
  `).join('')}</div>`;

  sugestoes.classList.remove('hidden');
}

function mostrarSugestoesCidadeProjetoF() {
  popularFiltroCidadeProjetoF();
}

function ocultarSugestoesCidadeProjetoF() {
  const sugestoes = document.getElementById('filtro-cidade-projeto-f-sugestoes');
  if (sugestoes) {
    sugestoes.classList.add('hidden');
  }
}

function selecionarCidadeProjetoF(cidade) {
  const input = document.getElementById('filtro-cidade-projeto-f');
  if (input) {
    input.value = cidade || '';
  }

  ocultarSugestoesCidadeProjetoF();
  aplicarFiltrosProjetoF();
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
  const filtroCidade = normalizeText(document.getElementById('filtro-cidade-projeto-f')?.value || '').trim();
  const dados = dadosPorCategoria['projeto-f'] || [];

  if (!filtroCidade) {
    return dados;
  }

  return dados.filter(item => {
    const cidade = normalizeText(String(getField(item, 'CIDADE', 'cidade', 'Cidade') || '')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
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

function popularFiltroStatusProjetoF(listaBase = null) {
  const input = document.getElementById('filtro-status-projeto-f');
  const sugestoes = document.getElementById('filtro-status-projeto-f-sugestoes');
  if (!input || !sugestoes) return;

  const valorAtual = input.value || '';
  const filtro = normalizeText(valorAtual);
  const dados = Array.isArray(listaBase) ? listaBase : (dadosPorCategoria['projeto-f'] || []);

  const statusUnicos = [...new Set(dados
    .map(item => String(getField(item, 'STATUS MDU', 'STATUS_MDU', 'status_mdu') || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  const statusFiltrados = statusUnicos
    .filter(status => !filtro || normalizeText(status).includes(filtro));
  const statusVisiveis = statusFiltrados.slice(0, 12);

  const headHtml = `
    <div class="filtro-status-projeto-f-head">
      <span class="filtro-status-projeto-f-icon" aria-hidden="true">🏷️</span>
      <span class="filtro-status-projeto-f-title">Status MDU</span>
      <span class="filtro-status-projeto-f-count">${statusFiltrados.length}</span>
    </div>
  `;

  if (!statusVisiveis.length) {
    sugestoes.innerHTML = `${headHtml}<div class="filtro-status-projeto-f-vazio">Nenhum status encontrado</div>`;
    sugestoes.classList.remove('hidden');
    return;
  }

  sugestoes.innerHTML = `${headHtml}<div class="filtro-status-projeto-f-list">${statusVisiveis.map(status => `
    <button type="button" class="filtro-status-projeto-f-opcao" onclick='selecionarStatusProjetoF(${JSON.stringify(status)})'>${escapeHtml(status)}</button>
  `).join('')}</div>`;

  sugestoes.classList.remove('hidden');
}

function mostrarSugestoesStatusProjetoF() {
  popularFiltroStatusProjetoF();
}

function ocultarSugestoesStatusProjetoF() {
  const sugestoes = document.getElementById('filtro-status-projeto-f-sugestoes');
  if (sugestoes) {
    sugestoes.classList.add('hidden');
  }
}

function selecionarStatusProjetoF(status) {
  const input = document.getElementById('filtro-status-projeto-f');
  if (input) {
    input.value = status || '';
  }

  ocultarSugestoesStatusProjetoF();
  aplicarFiltrosProjetoF();
}

function filtrarProjetoFPorStatus(listaBase = null) {
  const statusSelecionado = String(document.getElementById('filtro-status-projeto-f')?.value || '').trim();
  const dados = Array.isArray(listaBase) ? listaBase : (dadosPorCategoria['projeto-f'] || []);
  if (!statusSelecionado) return dados;

  const statusNormalizado = normalizeText(statusSelecionado);

  return dados.filter(item => {
    const statusMdu = String(getField(item, 'STATUS MDU', 'STATUS_MDU', 'status_mdu') || '').trim();
    return normalizeText(statusMdu).includes(statusNormalizado);
  });
}

function aplicarFiltrosProjetoF() {
  popularFiltroCidadeProjetoF();

  // Aplicar filtro de cidade
  let dadosFiltrados = filtrarProjetoFPorCidade();

  // Aplicar filtro de endereço sobre os dados já filtrados por cidade
  const filtroEndereco = document.getElementById('filtro-endereco-projeto-f')?.value?.toLowerCase().trim() || '';
  if (filtroEndereco) {
    dadosFiltrados = dadosFiltrados.filter(item => {
      const endereco = (getField(item, 'ENDEREÇO') || '').toLowerCase().trim();
      return endereco.includes(filtroEndereco);
    });
  }

  popularFiltroStatusProjetoF(dadosFiltrados);
  dadosFiltrados = filtrarProjetoFPorStatus(dadosFiltrados);

  renderTabelaProjetoF('tabela-projeto-f', dadosFiltrados);
}

document.addEventListener('click', (event) => {
  const filtroProjetoF = document.querySelector('.filtro-item-cidade-projetof');
  const filtroStatusProjetoF = document.querySelector('.filtro-item-status-projetof');

  if (filtroProjetoF && !filtroProjetoF.contains(event.target)) {
    ocultarSugestoesCidadeProjetoF();
  }

  if (filtroStatusProjetoF && !filtroStatusProjetoF.contains(event.target)) {
    ocultarSugestoesStatusProjetoF();
  }
});

// ===== FILTROS EMPRESARIAL =====
function popularFiltrosEmpresarial(listaBase = null) {
  const selectStatus = document.getElementById('filtro-status-empresarial');
  if (!selectStatus) return;

  const valorAtual = selectStatus.value || '';
  const dados = Array.isArray(listaBase) ? listaBase : (dadosPorCategoria['empresarial'] || []);

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
  const dados = dadosPorCategoria['empresarial'] || [];

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
    const filteredLista = Array.isArray(lista) ? lista : [];

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

function processarCSVOngoingCompartilhado(csv, delimiter = ";") {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];

  let cabecalhoRaw = linhas[0].trim();
  if (!cabecalhoRaw) return [];
  if (cabecalhoRaw.includes(",") && !cabecalhoRaw.includes(";")) {
    delimiter = ",";
  }

  const cabecalho = _splitCsvLine(cabecalhoRaw, delimiter).map(c => c.trim());
  const dados = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = _splitCsvLine(linha, delimiter);
    if (!colunas.some((col) => String(col || '').trim() !== '')) continue;
    const itemRaw = {};

    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      itemRaw[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        itemRaw[normalized] = valor;
      }
    });

    const idDemanda = getField(itemRaw, "ID DEMANDA", "IDDEMANDA", "iddemanda", "id_demanda", "idDemanda");
    const fila = getField(itemRaw, "FILA", "fila");
    const tipo = getField(itemRaw, "TIPO", "tipo");
    const endereco = getField(itemRaw, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada");
    const cidade = getField(itemRaw, "CIDADE", "cidade");
    const bairro = getField(itemRaw, "BAIRRO", "bairro");
    const epo = getField(itemRaw, "EPO", "epo", "cluster", "CLUSTER", "regional", "REGIONAL");
    const codMdugo = getField(itemRaw, "COD-MDUGO", "cod-mdugo", "codmdugo", "codigo");
    const aging = getField(itemRaw, "Aging arredondado", "AGING", "AGE", "aging", "age", "aging_total", "aging total");
    const slaFase = getField(itemRaw, "SLA TUDO", "SLA FASE", "SLA_FASE", "sla_tudo", "sla_fase", "sla fase");
    const status = getField(itemRaw, "STATUS_GERAL", "status_geral", "status geral", "status");
    const motivo = getField(itemRaw, "MOTIVO_GERAL", "motivo_geral", "motivo geral", "motivo");
    const obs = getField(itemRaw, "OBS", "obs", "OBSERVACAO", "observacao", "STATUS OBS", "status_obs");

    const item = {
      iddemanda: idDemanda || "",
      fila: fila || "",
      tipo: tipo || "",
      endereco_unico: endereco || "",
      endereco: endereco || "",
      cidade: cidade || "",
      bairro: bairro || "",
      epo: epo || "",
      cod_mdugo: codMdugo || "",
      aging: aging || "",
      sla_tudo: slaFase || "",
      status_geral: status || "",
      motivo_geral: motivo || "",
      obs: obs || "",
    };

    if (item.iddemanda || item.fila || item.endereco || item.status_geral || item.motivo_geral) {
      dados.push(item);
    }
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
    'mdu-ongoing',
    'epo',
    'liberados'
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
    input.placeholder = '🔍 Buscar por ID ou endereço...';
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

    input.addEventListener('input', () => {
      if (categoriaId === 'epo' && !input.value.trim()) {
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

  if (!isAdmin && ["historico", "pesquisa", "relatorios", "reuniao", "financeiro"].includes(id)) {
    id = "inicio";
  }

  document.querySelectorAll(".secao").forEach(s => s.classList.remove("ativa"));
  const section = document.getElementById(id);
  if (!section) return;
  if (!isAdmin && section.dataset.adminOnly === 'true') {
    return mostrarSecao('inicio');
  }
  section.classList.add("ativa");

  const globalImport = document.getElementById("global-import-section");
  const isCategoria = section.classList.contains("categoria-secao") || id === 'liberados';
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

  if (id === 'liberados') {
    atualizarLayoutLiberados();
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
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const fileInput = document.getElementById("arquivoCSVOngoing");
  const file = fileInput.files[0];
  
  if (!file) {
    alert("Selecione um arquivo CSV");
    return;
  }
  
  const reader = new FileReader();
  reader.onload = async function(e) {
    const csv = e.target.result;
    // Processar CSV com delimitador ponto-e-vírgula e encoding ISO-8859-1
    debugCSVOngoing(csv); // Debug: exibir estrutura
    dadosCSVOngoing = processarCSVOngoing(csv);
    dadosCSVOngoingOriginal = dadosCSVOngoing; // Salvar cópia dos dados originais
    cacheDatasetLocally('ongoing', dadosCSVOngoing, { source: 'manual', locked: dadosCSVOngoing.length > 0 });
    const persistResult = await persistirDadosCompartilhados('ongoing', dadosCSVOngoing, { source: 'manual', locked: dadosCSVOngoing.length > 0 });
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
    if (persistResult?.queued) {
      alert(`✅ ${dadosCSVOngoing.length} registros importados! Sincronização compartilhada pendente.`);
    } else {
      alert(`✅ ${dadosCSVOngoing.length} registros importados!`);
    }
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

  const cabecalho = _splitCsvLine(cabecalhoRaw, delimiter).map(c => c.trim());
  const dados = [];

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || !linha.trim()) continue;

    const colunas = _splitCsvLine(linha, delimiter);
    if (!colunas.some(col => String(col || '').trim() !== '')) continue;

    const item = {};
    cabecalho.forEach((cab, j) => {
      const valor = (colunas[j] || "").trim();
      item[cab] = valor;
      const normalized = normalizeKey(cab);
      if (normalized) {
        item[normalized] = valor;
      }
    });

    const normalizado = normalizarLinhaOngoing(item);

    if (
      normalizado["iddemanda"] ||
      normalizado["fila"] ||
      normalizado["endereco"] ||
      normalizado["STATUS_GERAL"] ||
      normalizado["MOTIVO_GERAL"]
    ) {
      dados.push(normalizado);
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

  const cabecalho = _splitCsvLine(cabecalhoRaw, delimiter).map(c => c.replace(/^\uFEFF/, '').trim());
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

    const colunas = _splitCsvLine(linha, delimiter);
    if (!colunas.some(col => String(col || '').trim() !== '')) continue;

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

function matchesOngoingFila(item = {}, fila = "") {
  const alvo = normalizeText(fila);
  if (!alvo) return true;

  const textos = [
    getField(item, "fila", "FILA"),
    getField(item, "tipo", "TIPO", "SOLICITANTE", "solicitante"),
    getField(item, "STATUS_GERAL", "status_geral", "STATUS", "status"),
    getField(item, "MOTIVO_GERAL", "motivo_geral", "MOTIVO", "motivo")
  ].map(valor => normalizeText(valor)).filter(Boolean);

  return textos.some(texto => texto.includes(alvo));
}

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
      return matchesOngoingFila(item, fila);
    });
  }
  
  // Renderizar tabela filtrada
  renderTabelaOngoing(dadosFiltrados);
}

// Renderizar tabela ONGOING com novos campos
let dadosCSVOngoing = [];
let dadosTabelaExibida = []; // Armazenar dados atualmente exibidos na tabela

function extrairAgingOngoing(item = {}) {
  const agingRaw = getField(
    item,
    "Aging arredondado",
    "AGING",
    "aging",
    "aging_total",
    "aging total",
    "AGE GERAL",
    "age_geral",
    "AGE",
    "age"
  ) || "0";

  const match = String(agingRaw).match(/\d+/);
  const parsed = match ? parseInt(match[0], 10) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  // Bloqueia apenas valores claramente absurdos (ex.: seriais de data Excel > 40000)
  if (parsed > 9999) return 0;
  return parsed;
}

function normalizarLinhaOngoing(item = {}) {
  const idDemanda = getField(
    item,
    "iddemanda", "IDDEMANDA", "ID DEMANDA", "ID_DEMANDA", "id",
    "COD-MDUGO", "cod-mdugo", "codmdugo", "CODIGO", "CÓDIGO"
  );
  const filaOriginal = getField(item, "fila", "FILA");
  const fila = filaOriginal || (matchesOngoingFila(item, 'vistoria')
    ? 'VISTORIA'
    : (matchesOngoingFila(item, 'backbone') ? 'BACKBONE' : getField(item, "STATUS_GERAL", "status_geral", "STATUS")));
  const tipo = getField(item, "tipo", "TIPO", "SOLICITANTE", "solicitante");
  const enderecoBase = getField(item, "endereco_unico", "endereco", "ENDEREÇO", "ENDERECO", "endereco_entrada");
  const numero = getField(item, "NUMERO", "numero", "NUM", "num");
  const endereco = String(enderecoBase || '').trim();
  const numeroTxt = String(numero || '').trim();
  const enderecoCompleto = (endereco && numeroTxt && !endereco.includes(numeroTxt))
    ? `${endereco}, ${numeroTxt}`
    : (endereco || '-');

  const epo = getField(item, "epo", "EPO", "regional", "REGIONAL", "cluster", "CLUSTER");
  const agingNumero = extrairAgingOngoing(item);
  const sla = getField(item, "SLA TUDO", "SLA FASE", "sla_tudo", "sla_fase", "sla");
  const status = getField(item, "STATUS_GERAL", "status_geral", "STATUS", "status");
  const motivo = getField(item, "MOTIVO_GERAL", "motivo_geral", "MOTIVO", "motivo");

  return {
    ...item,
    iddemanda: idDemanda || "",
    IDDEMANDA: idDemanda || "",
    fila: fila || "",
    FILA: fila || "",
    tipo: tipo || "",
    TIPO: tipo || "",
    endereco_unico: enderecoCompleto || "",
    endereco: enderecoCompleto || "",
    epo: epo || "",
    EPO: epo || "",
    aging: String(agingNumero || ""),
    AGING: String(agingNumero || ""),
    "Aging arredondado": String(agingNumero || ""),
    "SLA TUDO": sla || "",
    STATUS_GERAL: status || "",
    MOTIVO_GERAL: motivo || "",
  };
}

function getAgingBadgeClass(agingNumero) {
  if (agingNumero <= 20) return "aging-badge level-0";
  if (agingNumero <= 40) return "aging-badge level-2";
  if (agingNumero <= 60) return "aging-badge level-3";
  if (agingNumero <= 80) return "aging-badge level-4";
  return "aging-badge level-5";
}

function renderTabelaOngoing(dados) {
  const tbody = document.getElementById("tabela-ongoing");
  
  if (!dados || dados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center">Nenhum dado</td></tr>';
    return;
  }

  const dadosNormalizados = (Array.isArray(dados) ? dados : []).map((item) => normalizarLinhaOngoing(item));
  
  // Ordenar por AGING (do maior para o menor)
  const dadosOrdenados = [...dadosNormalizados].sort((a, b) => extrairAgingOngoing(b) - extrairAgingOngoing(a));
  
  // Salvar dados ordenados para uso no modal de detalhes
  dadosTabelaExibida = dadosOrdenados;
  
  tbody.innerHTML = dadosOrdenados.map((item, idx) => {
    const agingNumero = extrairAgingOngoing(item);
    const badgeClass = getAgingBadgeClass(agingNumero);
    const idDemanda = getField(item, "iddemanda", "IDDEMANDA", "ID_DEMANDA", "id");
    const fila = getField(item, "fila", "FILA");
    const tipo = getField(item, "tipo", "TIPO");

    return `
      <tr>
        <td>${idDemanda || "-"}</td>
        <td>${fila || "-"}</td>
        <td>${tipo || "-"}</td>
        <td>${getField(item, "endereco_unico", "endereco", "endereço", "endereco_entrada") || "-"}</td>
        <td>${getField(item, "epo", "EPO", "regional", "REGIONAL", "cluster", "CLUSTER") || "-"}</td>
        <td><span class="${badgeClass}">${agingNumero}</span></td>
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
    return String(getField(item, "iddemanda", "IDDEMANDA", "ID_DEMANDA", "id") || "").includes(id);
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
  const agingNumero = extrairAgingOngoing(item);
  const sla = getField(item, "SLA TUDO", "SLA FASE", "sla_tudo", "sla_fase", "sla") || "-";
  const obsOriginal = getField(item, "STATUS OBS", "OBS", "OBSERVACAO", "observacao") || "Nenhuma observação disponível";

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
  const user = getCurrentUser();
  const isAdmin = user?.role === 'admin';
  if (!isAdmin && categoriaId === 'financeiro') {
    alert('⚠️ A categoria Financeiro está disponível apenas para administrador.');
    return;
  }

  // Mostra a seção e ajusta/importa o bloco de importação
  mostrarSecao(categoriaId);

  if (categoriaId === 'liberados') {
    resetarFluxoLiberados();
  }

  if (categoriaId === 'epo') {
    resetarSelecaoEpo();
  }

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
let epoTecnicoEditIndex = -1;
const STORAGE_EPO_TECNICOS_KEY = 'portalEpoTecnicos';
const STORAGE_EPO_ACEITES_KEY = 'portalEpoAceites';
const STORAGE_EPO_USUARIOS_CADASTRADOS_KEY = 'portalEpoUsuariosCadastrados';
const STORAGE_EPO_GPON_KEY = 'portalEpoGponOngoing';
const STORAGE_EPO_PROJETOF_KEY = 'portalEpoProjetoF';

const EPO_DATASET_CONFIG = {
  'gpon-ongoing': {
    storageKey: STORAGE_EPO_GPON_KEY,
    sharedKey: 'epo-gpon-ongoing',
    statusElementId: 'epo-gpon-import-status',
    label: 'GPON ONGOING'
  },
  'projeto-f': {
    storageKey: STORAGE_EPO_PROJETOF_KEY,
    sharedKey: 'epo-projeto-f',
    statusElementId: 'epo-projetof-import-status',
    label: 'PROJETO F'
  }
};

const EPO_PILLS = ['ACESSO','ANTEC','ARCAD','BASIC','CANTOIA','CSC','DANLEX','ELETRONET','PSNET','SCRIPT_CALL','VISIUM'];
let epoImportInProgressKey = '';

function getEpoDatasetConfig(actionKey = 'gpon-ongoing') {
  return EPO_DATASET_CONFIG[actionKey] || EPO_DATASET_CONFIG['gpon-ongoing'];
}

function getEpoStore(actionKey = 'gpon-ongoing') {
  if (runtimeEpoStores[actionKey]) {
    return runtimeEpoStores[actionKey];
  }

  const cfg = getEpoDatasetConfig(actionKey);

  const snapshot = getLocalDatasetCache()?.[cfg.sharedKey] || {};
  const rows = Array.isArray(snapshot?.items) ? snapshot.items : [];
  if (rows.length) {
    const restoredFromShared = buildEpoNovosStoreFromRows(rows, actionKey);
    runtimeEpoStores[actionKey] = restoredFromShared;
    return restoredFromShared;
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(cfg.storageKey) || '{}');
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
      runtimeEpoStores[actionKey] = parsed;
      return parsed;
    }
  } catch {
    // Continua com fallback abaixo.
  }

  return {};
}

function saveEpoStore(actionKey = 'gpon-ongoing', store = {}) {
  runtimeEpoStores[actionKey] = store || {};

  const cfg = getEpoDatasetConfig(actionKey);
  try {
    localStorage.setItem(cfg.storageKey, JSON.stringify(store || {}));
  } catch {
    // Se houver limite de quota, mantém em memória e segue via snapshot compartilhado.
  }
}

function getEpoNovosStore() {
  return getEpoStore('gpon-ongoing');
}

function saveEpoNovosStore(store = {}) {
  saveEpoStore('gpon-ongoing', store);
}

function flattenEpoNovosStore(store = {}) {
  const linhas = [];
  Object.entries(store || {}).forEach(([epo, itens]) => {
    (Array.isArray(itens) ? itens : []).forEach(item => {
      linhas.push({ ...item, __epoBucket: epo });
    });
  });
  return linhas;
}

function buildEpoNovosStoreFromRows(rows = [], actionKey = 'gpon-ongoing') {
  const byEpo = {};
  (Array.isArray(rows) ? rows : []).forEach(item => {
    const key = String(item?.__epoBucket || _resolverEpoDaLinha(item, actionKey) || '').trim().toUpperCase();
    if (!key) return;
    if (!byEpo[key]) byEpo[key] = [];
    byEpo[key].push(item);
  });
  return byEpo;
}

function getEpoRowsByAction(actionKey = 'gpon-ongoing') {
  return flattenEpoNovosStore(getEpoStore(actionKey));
}

function derivarStoreEpoProjetoFDoDatasetBase() {
  const baseProjetoF = getPreferredDataset('projeto-f');
  if (!Array.isArray(baseProjetoF) || !baseProjetoF.length) return null;

  const store = buildEpoNovosStoreFromRows(baseProjetoF.map((item) => ({ ...item })), 'projeto-f');
  return Object.keys(store).length ? store : null;
}

function garantirEpoProjetoFDerivado(options = {}) {
  const { persistShared = false } = options;
  const storeExistente = getEpoStore('projeto-f');
  if (Object.keys(storeExistente || {}).length) {
    return storeExistente;
  }

  const storeDerivado = derivarStoreEpoProjetoFDoDatasetBase();
  if (!storeDerivado) return null;

  const rows = flattenEpoNovosStore(storeDerivado);
  saveEpoStore('projeto-f', storeDerivado);
  cacheDatasetLocally('epo-projeto-f', rows, { source: 'derived', locked: false });

  if (persistShared && getCurrentUser()?.role === 'admin') {
    persistirDadosCompartilhados('epo-projeto-f', rows, { source: 'derived', locked: false });
  }

  return storeDerivado;
}

function getEpoRowsForEpo(actionKey = 'gpon-ongoing', nomeEpo = '') {
  const key = String(nomeEpo || '').trim().toUpperCase();
  if (!key) return [];

  const store = getEpoStore(actionKey);
  if (Array.isArray(store[key])) return store[key];

  const normalizeBucket = (value = '') => normalizeText(String(value || '')).replace(/[^a-z0-9]/g, '');
  const target = normalizeBucket(key);
  const foundKey = Object.keys(store || {}).find((k) => normalizeBucket(k) === target);
  return foundKey && Array.isArray(store[foundKey]) ? store[foundKey] : [];
}

function formatarResumoEpoCompleto(byEpo = {}) {
  return EPO_PILLS
    .map((epo) => `${epo}:${Array.isArray(byEpo?.[epo]) ? byEpo[epo].length : 0}`)
    .join(' | ');
}

function updateEpoImportStatus(actionKey = 'gpon-ongoing', extraText = '') {
  const cfg = getEpoDatasetConfig(actionKey);
  const statusEl = document.getElementById(cfg.statusElementId);
  if (!statusEl) return;

  const snapshot = getLocalDatasetCache()?.[cfg.sharedKey] || {};
  const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  const storeRows = getEpoRowsByAction(actionKey);
  const rows = snapshotItems.length ? snapshotItems : storeRows;
  const sourceText = snapshot.source || (storeRows.length ? 'local' : 'shared');
  const lockedText = snapshot.locked ? 'travado' : 'sincronizado';

  if (!rows.length && !extraText) {
    statusEl.textContent = '';
    return;
  }

  const parts = [
    extraText,
    `${rows.length} registros`,
    lockedText,
    `origem ${sourceText}`,
  ].filter(Boolean);

  statusEl.textContent = `✅ ${parts.join(' • ')}`;
}

async function carregarEpoDatasetsCompartilhados() {
  if (!window.location.protocol.startsWith('http')) {
    updateEpoImportStatus('gpon-ongoing');
    updateEpoImportStatus('projeto-f');
    atualizarCountPillsEpo();
    return;
  }

  try {
    const res = await fetch('/api/shared_datasets', { credentials: 'include' });
    if (!res.ok) return;

    const payload = await res.json().catch(() => ({}));

    Object.entries(EPO_DATASET_CONFIG).forEach(([actionKey, cfg]) => {
      const epoSnapshot = payload?.datasets?.[cfg.sharedKey] || {};
      const rows = epoSnapshot?.items;

      const localSnapshot = getLocalDatasetCache()?.[cfg.sharedKey] || {};
      const localSnapshotRows = Array.isArray(localSnapshot?.items) ? localSnapshot.items : [];
      const localRows = getEpoRowsByAction(actionKey);
      const localUpdatedAt = Date.parse(localSnapshot?.updatedAt || '') || 0;
      const sharedUpdatedAt = Date.parse(epoSnapshot?.updated_at || epoSnapshot?.updatedAt || '') || 0;
      const localSource = String(localSnapshot?.source || '').toLowerCase();
      const localCanOverrideShared = localSource.includes('manual') || localSource.includes('local');
      const shouldKeepLockedLocal = Boolean(localSnapshot?.locked)
        && localCanOverrideShared
        && localRows.length
        && (!Array.isArray(rows) || !rows.length || localUpdatedAt >= sharedUpdatedAt);

      if (shouldKeepLockedLocal) {
        updateEpoImportStatus(actionKey);
        return;
      }

      if (!Array.isArray(rows) || !rows.length) {
        if (localSnapshotRows.length) {
          const localStore = buildEpoNovosStoreFromRows(localSnapshotRows, actionKey);
          saveEpoStore(actionKey, localStore);
          updateEpoImportStatus(actionKey, 'carregado do cache local');
          return;
        }

        if (actionKey === 'projeto-f') {
          const user = getCurrentUser();
          const storeDerivado = garantirEpoProjetoFDerivado({
            persistShared: user?.role === 'admin'
          });
          if (storeDerivado) {
            const origemDerivada = user?.role === 'admin'
              ? 'derivado do PROJETO F'
              : 'derivado da base compartilhada PROJETO F';
            updateEpoImportStatus(actionKey, origemDerivada);
            return;
          }

          if (user?.role === 'viewer') {
            saveEpoStore(actionKey, {});
            updateEpoImportStatus(actionKey, 'aguardando base compartilhada');
            return;
          }
        }

        const user = getCurrentUser();
        if (user?.role === 'admin' && localRows.length) {
          persistirDadosCompartilhados(cfg.sharedKey, localRows, { source: 'manual', locked: false });
        }
        updateEpoImportStatus(actionKey);
        return;
      }

      cacheDatasetLocally(cfg.sharedKey, rows, {
        source: 'shared',
        updatedAt: epoSnapshot?.updated_at || epoSnapshot?.updatedAt || new Date().toISOString(),
        updatedBy: epoSnapshot?.updated_by || epoSnapshot?.updatedBy || '',
        locked: false,
      });

      const store = buildEpoNovosStoreFromRows(rows, actionKey);
      saveEpoStore(actionKey, store);
      updateEpoImportStatus(actionKey);
    });

    atualizarCountPillsEpo();
    atualizarContadores();
  } catch {
    // Sem bloqueio: mantém cache/local.
    updateEpoImportStatus('gpon-ongoing');
    updateEpoImportStatus('projeto-f');
  }
}

function getEpoNovosParaEpo(nomeEpo) {
  return getEpoRowsForEpo('gpon-ongoing', nomeEpo);
}

function abrirImportEpoGponOngoing() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const input = document.getElementById('epo-gpon-import-file');
  if (input) { input.value = ''; input.click(); }
}

function abrirImportEpoProjetoF() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const input = document.getElementById('epo-projetof-import-file');
  if (input) { input.value = ''; input.click(); }
}

function normalizarNomeEpoParaPill(rawValue = '') {
  const normalizeBucket = (value = '') => normalizeText(String(value || '')).replace(/[^a-z0-9]/g, '');
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  const rawUpper = raw.toUpperCase();
  if (EPO_PILLS.includes(rawUpper)) return rawUpper;

  const rawNorm = normalizeBucket(rawUpper);
  if (!rawNorm) return '';

  const byNormalized = EPO_PILLS.find((pill) => normalizeBucket(pill) === rawNorm);
  if (byNormalized) return byNormalized;

  const byContains = EPO_PILLS.find((pill) => {
    const pillNorm = normalizeBucket(pill);
    return rawNorm.includes(pillNorm) || pillNorm.includes(rawNorm);
  });

  return byContains || '';
}

function extrairValorEpoPorHint(item, isProjetoF = false) {
  if (!item || typeof item !== 'object') return '';

  const hints = isProjetoF
    ? ['parceira', 'parceiro', 'epo', 'cluster']
    : ['epo', 'cluster', 'parceira', 'parceiro'];

  const keys = Object.keys(item);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const normalizedKey = normalizeText(String(key || '')).replace(/[^a-z0-9]/g, '');
    if (!normalizedKey) continue;

    const isMatch = hints.some((hint) => normalizedKey.includes(hint));
    if (!isMatch) continue;

    const value = String(item[key] ?? '').trim();
    if (value) return value;
  }

  return '';
}

function _resolverEpoDaLinha(item, actionKey = 'gpon-ongoing') {
  const isProjetoF = actionKey === 'projeto-f';
  const epoMode = isProjetoF ? 'projeto-f' : 'ongoing';
  const preferredKeys = isProjetoF
    ? ['PARCEIRA', 'parceira', 'PARCEIRO', 'parceiro']
    : ['EPO', 'epo', 'EPO/CLUSTER', 'EPO / Cluster', 'EPO_CLUSTER', 'epo_cluster'];

  const fallbackKeys = isProjetoF
    ? ['EPO', 'epo', 'CLUSTER', 'cluster']
    : ['PARCEIRA', 'parceira', 'CLUSTER', 'cluster'];

  const raw =
    getField(item, ...preferredKeys) ||
    getField(item, ...fallbackKeys) ||
    extrairValorEpoPorHint(item, isProjetoF) ||
    '';
  const sanitized = sanitizeEpoName(raw, epoMode);
  return normalizarNomeEpoParaPill(sanitized || raw);
}

function getEpoCountsByName(epoName = '') {
  const key = String(epoName || '').trim().toUpperCase();
  if (!key) return { gpon: 0, projetoF: 0 };

  const buildCountMapFromStore = (actionKey = 'gpon-ongoing') => {
    const rows = getEpoRowsByAction(actionKey);
    const map = {};

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      const epo = String(item?.__epoBucket || _resolverEpoDaLinha(item, actionKey) || '').trim().toUpperCase();
      if (!epo) return;
      map[epo] = (map[epo] || 0) + 1;
    });

    return {
      map,
      hasStoreData: Array.isArray(rows) && rows.length > 0,
    };
  };

  const buildCountMapFromBase = (actionKey = 'gpon-ongoing') => {
    const categoriaBase = actionKey === 'projeto-f' ? 'projeto-f' : 'mdu-ongoing';
    const rows = getPreferredDataset(categoriaBase);
    const map = {};

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      const epo = _resolverEpoDaLinha(item, actionKey);
      if (!epo) return;
      map[epo] = (map[epo] || 0) + 1;
    });

    return {
      map,
      hasBaseData: Array.isArray(rows) && rows.length > 0,
    };
  };

  const gponStore = buildCountMapFromStore('gpon-ongoing');
  const projetoFStore = buildCountMapFromStore('projeto-f');
  const gponBase = buildCountMapFromBase('gpon-ongoing');
  const projetoFBase = buildCountMapFromBase('projeto-f');

  return {
    gpon: gponStore.hasStoreData
      ? (gponStore.map[key] || 0)
      : gponBase.hasBaseData
      ? (gponBase.map[key] || 0)
      : getEpoRowsForEpo('gpon-ongoing', key).length,
    projetoF: projetoFStore.hasStoreData
      ? (projetoFStore.map[key] || 0)
      : projetoFBase.hasBaseData
      ? (projetoFBase.map[key] || 0)
      : getEpoRowsForEpo('projeto-f', key).length
  };
}

function atualizarResumoEpoSelecionada() {
  const selectedNameEl = document.getElementById('epo-selected-name');
  if (!selectedNameEl) return;

  if (!epoSelecionadaAtual) {
    selectedNameEl.textContent = '-';
    return;
  }

  selectedNameEl.textContent = epoSelecionadaAtual;
}

function atualizarRotulosAcoesEpo() {
  const btnEquipes = document.querySelector('#epo .epo-action-trigger[data-action="equipes"]');
  const btnGpon = document.querySelector('#epo .epo-action-trigger[data-action="gpon-ongoing"]');
  const btnProjetoF = document.querySelector('#epo .epo-action-trigger[data-action="projeto-f"]');

  if (btnEquipes) btnEquipes.textContent = 'LISTA DE EQUIPES';

  if (!epoSelecionadaAtual) {
    if (btnGpon) btnGpon.textContent = 'GPON ONGOING';
    if (btnProjetoF) btnProjetoF.textContent = 'PROJETO F';
    return;
  }

  const counts = getEpoCountsByName(epoSelecionadaAtual);
  if (btnGpon) btnGpon.textContent = `GPON ONGOING (${counts.gpon})`;
  if (btnProjetoF) btnProjetoF.textContent = `PROJETO F (${counts.projetoF})`;
}

const EPO_IMPORT_TARGET_YEAR = 2026;

function extrairAnoDaLinha(item) {
  if (!item || typeof item !== 'object') return null;

  const yearKeys = [
    'ANO_SOLIC', 'ANO CONCL', 'ANO_CONCL', 'ANO',
    'DT_SOLICITACAO', 'DT_INICIO_LIBERACAO', 'DT_FIM_LIBERACAO',
    'DATA CONCLUÍDO', 'DATA CONCLUIDO', 'MES_SOLICITACAO', 'MES_CONCL',
    'MÊS CONCLUÍDO', 'MES CONCLUIDO',
    'DATA', 'DATA_BASE', 'DATA_CRIACAO',
    'ano_solic', 'ano_concl', 'ano'
  ];

  for (let i = 0; i < yearKeys.length; i += 1) {
    const raw = String(getField(item, yearKeys[i]) || '').trim();
    if (!raw) continue;

    const match = raw.match(/\b(20\d{2})\b/);
    if (match) return Number(match[1]);
  }

  return null;
}

function filtrarLinhasPorAno(linhas = [], targetYear = EPO_IMPORT_TARGET_YEAR) {
  const filtradas = [];
  let linhasComAnoDetectado = 0;

  for (let i = 0; i < linhas.length; i += 1) {
    const item = linhas[i];
    const ano = extrairAnoDaLinha(item);

    if (!Number.isInteger(ano)) continue;

    linhasComAnoDetectado += 1;
    if (ano === targetYear) {
      filtradas.push(item);
    }
  }

  // Se não foi possível detectar ano em nenhuma linha, não bloqueia a importação.
  if (linhasComAnoDetectado === 0) {
    return {
      linhasFiltradas: Array.isArray(linhas) ? linhas : [],
      linhasComAnoDetectado,
      filtroAplicado: false
    };
  }

  return {
    linhasFiltradas: filtradas,
    linhasComAnoDetectado,
    filtroAplicado: true
  };
}

function possuiCamposPreenchidos(item) {
  if (!item || typeof item !== 'object') return false;
  for (const key in item) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return true;
    }
  }
  return false;
}

function filtrarLinhasValidasRapido(linhas = []) {
  const validas = [];
  for (let i = 0; i < linhas.length; i += 1) {
    const item = linhas[i];
    if (possuiCamposPreenchidos(item)) {
      validas.push(item);
    }
  }
  return validas;
}

function distribuirLinhasPorEpoEmLotes(linhasValidas = [], actionKey = 'gpon-ongoing', statusEl = null) {
  const byEpo = {};
  EPO_PILLS.forEach((epo) => {
    byEpo[epo] = [];
  });

  const semCorrespondencia = [];
  const total = linhasValidas.length;
  const chunkSize = 1200;
  let index = 0;

  return new Promise((resolve) => {
    const processarChunk = () => {
      const limit = Math.min(index + chunkSize, total);
      for (; index < limit; index += 1) {
        const item = linhasValidas[index];
        const epo = _resolverEpoDaLinha(item, actionKey);

        if (!epo) {
          semCorrespondencia.push(item);
          continue;
        }

        if (!Array.isArray(byEpo[epo])) {
          semCorrespondencia.push(item);
          continue;
        }

        byEpo[epo].push({ ...item, __epoBucket: epo });
      }

      if (statusEl && total > chunkSize) {
        const pct = Math.round((index / total) * 100);
        statusEl.textContent = `Processando ${index}/${total} (${pct}%)...`;
      }

      if (index < total) {
        setTimeout(processarChunk, 0);
        return;
      }

      resolve({ byEpo, semCorrespondencia });
    };

    processarChunk();
  });
}

function parseEpoImportRowsRobusto(text = '') {
  const textClean = String(text || '').replace(/^\uFEFF/, '');
  const linhasBrutas = textClean.split(/\r?\n/);

  if (linhasBrutas.length < 2) return [];

  const autoDelimiter = detectarMelhorDelimitadorCSV(linhasBrutas) || ';';
  const autoHeader = detectarLinhaCabecalhoCSV(linhasBrutas, autoDelimiter);
  const autoSlice = linhasBrutas.slice(autoHeader).join('\n');
  const autoRows = parseGenericCsvRows(autoSlice, autoDelimiter);
  if (autoRows.length > 0) {
    return autoRows;
  }

  const delimCandidatos = [autoDelimiter, ';', ',', '\t', '|']
    .filter((value, idx, arr) => value && arr.indexOf(value) === idx)
    .slice(0, 3);

  const headerCandidates = [autoHeader, 0, 1, 2, 3]
    .filter((value, idx, arr) => Number.isInteger(value) && value >= 0 && arr.indexOf(value) === idx)
    .slice(0, 4);

  const sliceCache = new Map();
  const getSliceByHeader = (headerIndex) => {
    if (!sliceCache.has(headerIndex)) {
      sliceCache.set(headerIndex, linhasBrutas.slice(headerIndex).join('\n'));
    }
    return sliceCache.get(headerIndex);
  };

  let bestRows = autoRows;

  for (let d = 0; d < delimCandidatos.length; d += 1) {
    const delimiter = delimCandidatos[d];
    for (let h = 0; h < headerCandidates.length; h += 1) {
      const headerIndex = headerCandidates[h];
      const rows = parseGenericCsvRows(getSliceByHeader(headerIndex), delimiter);
      if (rows.length > bestRows.length) {
        bestRows = rows;
      }

      // Encontrou volume bom o suficiente: evita rodadas extras.
      if (bestRows.length >= 1000) {
        return bestRows;
      }
    }
  }

  return bestRows;
}

function buildRowHeaderFingerprint(rows = []) {
  const headerSet = new Set();
  const sample = Array.isArray(rows) ? rows.slice(0, 50) : [];

  sample.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    Object.keys(item).forEach((key) => {
      const normalized = normalizeText(String(key || '')).replace(/[^a-z0-9]/g, '');
      if (normalized) headerSet.add(normalized);
    });
  });

  return headerSet;
}

function detectEpoImportDatasetType(rows = []) {
  const headers = buildRowHeaderFingerprint(rows);

  const ongoingSignals = [
    'statusgeral', 'motivogeral', 'solicitante', 'fila', 'iddemanda',
    'codmdugo', 'endereco', 'aging', 'slatudo'
  ];
  const projetoFSignals = [
    'statusmdu', 'statusliberacao', 'codged', 'qtdeblocos',
    'qtdeblocos', 'bloco', 'parceira', 'dtconstrucao'
  ];

  const ongoingScore = ongoingSignals.reduce((acc, signal) => acc + (headers.has(signal) ? 1 : 0), 0);
  const projetoFScore = projetoFSignals.reduce((acc, signal) => acc + (headers.has(signal) ? 1 : 0), 0);

  return {
    ongoingScore,
    projetoFScore,
    inferredType: ongoingScore >= projetoFScore ? 'gpon-ongoing' : 'projeto-f'
  };
}

function importarPlanilhaEpoGponOngoing() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const input = document.getElementById('epo-gpon-import-file');
  const statusEl = document.getElementById('epo-gpon-import-status');
  const file = input?.files?.[0];
  if (!file) return;

  if (epoImportInProgressKey) {
    if (statusEl) statusEl.textContent = `⚠️ Aguarde a conclusão da importação ${epoImportInProgressKey}.`;
    return;
  }

  epoImportInProgressKey = 'gpon-ongoing';
  if (statusEl) statusEl.textContent = 'Importando...';

  const processarTexto = async (text) => {
    try {
      const textClean = String(text || '').replace(/^\uFEFF/, '');
      if (textClean.startsWith('PK')) {
        if (statusEl) statusEl.textContent = '⚠️ Arquivo Excel detectado. Exporte a aba em CSV para importar.';
        alert('⚠️ Arquivo Excel (.xlsx/.xlsm) detectado. Para importar no EPO, exporte a aba em CSV.');
        return;
      }

      const linhas = parseEpoImportRowsRobusto(textClean);

      if (!linhas.length) {
        if (statusEl) statusEl.textContent = '⚠️ Nenhuma linha válida encontrada. Verifique se a planilha foi exportada em CSV.';
        alert('⚠️ Nenhuma linha válida encontrada para GPON ONGOING. Verifique cabeçalho e exporte em CSV.');
        return;
      }

      const detect = detectEpoImportDatasetType(linhas);
      if (detect.projetoFScore > detect.ongoingScore && detect.projetoFScore >= 2) {
        if (statusEl) statusEl.textContent = '⚠️ Esta planilha parece ser de PROJETO F. Use o importador correto.';
        alert('⚠️ Arquivo identificado como PROJETO F. Importe no botão de PROJETO F para evitar mistura de dados.');
        return;
      }

      const linhasValidas = filtrarLinhasValidasRapido(linhas);
      if (!linhasValidas.length) {
        if (statusEl) statusEl.textContent = '⚠️ A planilha foi lida, mas não há registros válidos para importar.';
        alert('⚠️ A planilha foi lida, mas não há registros válidos para GPON ONGOING.');
        return;
      }

      const filtroAno = filtrarLinhasPorAno(linhasValidas, EPO_IMPORT_TARGET_YEAR);
      // Se o filtro de ano não encontrar registros do ano alvo, usa todos os registros válidos
      const linhasAno = filtroAno.linhasFiltradas.length > 0 ? filtroAno.linhasFiltradas : linhasValidas;
      const filtroAnoIgnorado = filtroAno.filtroAplicado && filtroAno.linhasFiltradas.length === 0;

      if (statusEl) statusEl.textContent = `Processando 0/${linhasAno.length} (0%)...`;
      const { byEpo, semCorrespondencia } = await distribuirLinhasPorEpoEmLotes(linhasAno, 'gpon-ongoing', statusEl);

      saveEpoStore('gpon-ongoing', byEpo);
      atualizarCountPillsEpo();
      atualizarResumoEpoSelecionada();
      atualizarContadores();
      const linhasPersistencia = flattenEpoNovosStore(byEpo);
      const persistResult = await persistirDadosCompartilhados('epo-gpon-ongoing', linhasPersistencia, { source: 'manual', locked: false });
      cacheDatasetLocally('epo-gpon-ongoing', linhasPersistencia, { source: 'manual', locked: false });

      const total = linhasAno.length;
      const descartadasAno = filtroAnoIgnorado ? 0 : (linhasValidas.length - linhasAno.length);
      const resumo = formatarResumoEpoCompleto(byEpo);
      const ignoredText = semCorrespondencia.length ? ` • ${semCorrespondencia.length} sem EPO` : '';
      const yearFilterText = filtroAnoIgnorado
        ? ' • todos os anos incluídos'
        : (filtroAno.filtroAplicado
          ? (descartadasAno > 0 ? ` • ${descartadasAno} fora de ${EPO_IMPORT_TARGET_YEAR}` : '')
          : ' • ano não identificado na planilha');

      if (statusEl) {
        statusEl.textContent = persistResult?.queued
          ? `✅ ${total} linhas distribuídas por EPO${ignoredText}${yearFilterText} • sync pendente`
          : `✅ ${total} linhas distribuídas por EPO${ignoredText}${yearFilterText}`;
      }
      const resultEl = document.getElementById('epo-action-result');
      if (resultEl) resultEl.textContent = `✅ Importado GPON ONGOING: ${resumo}${ignoredText}`;

      updateEpoImportStatus('gpon-ongoing');

      if (epoAcaoAtual === 'gpon-ongoing' && epoSelecionadaAtual) renderGponOngoingEpo();
      if (input) input.value = '';
    } catch (err) {
      console.error('[EPO][GPON ONGOING] Erro ao processar importação:', err);
      if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
    } finally {
      epoImportInProgressKey = '';
    }
  };

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = String(e.target?.result || '');
    // Se contiver caractere de substituição, o arquivo é ANSI — relê como windows-1252
    if (text.includes('\ufffd')) {
      const reader2 = new FileReader();
      reader2.onload = (e2) => processarTexto(String(e2.target?.result || '')).catch((err) => {
        if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
      });
      reader2.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
      reader2.readAsText(file, 'windows-1252');
    } else {
      processarTexto(text).catch((err) => {
        if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
      });
    }
  };
  reader.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
  reader.readAsText(file);
}

function importarPlanilhaEpoProjetoF() {
  if (!usuarioPodeImportar()) {
    alert('Apenas o administrador pode anexar/importar arquivos.');
    return;
  }

  const input = document.getElementById('epo-projetof-import-file');
  const statusEl = document.getElementById('epo-projetof-import-status');
  const file = input?.files?.[0];
  if (!file) return;

  if (epoImportInProgressKey) {
    if (statusEl) statusEl.textContent = `⚠️ Aguarde a conclusão da importação ${epoImportInProgressKey}.`;
    return;
  }

  epoImportInProgressKey = 'projeto-f';
  if (statusEl) statusEl.textContent = 'Importando...';

  const processarTexto = async (text) => {
    try {
      const textClean = String(text || '').replace(/^\uFEFF/, '');
      if (textClean.startsWith('PK')) {
        if (statusEl) statusEl.textContent = '⚠️ Arquivo Excel detectado. Exporte a aba em CSV para importar.';
        alert('⚠️ Arquivo Excel (.xlsx/.xlsm) detectado. Para importar no EPO, exporte a aba em CSV.');
        return;
      }

      const linhas = parseEpoImportRowsRobusto(textClean);

      if (!linhas.length) {
        if (statusEl) statusEl.textContent = '⚠️ Nenhuma linha válida encontrada. Verifique se a planilha foi exportada em CSV.';
        alert('⚠️ Nenhuma linha válida encontrada para PROJETO F. Verifique cabeçalho e exporte em CSV.');
        return;
      }

      const detect = detectEpoImportDatasetType(linhas);
      if (detect.ongoingScore > detect.projetoFScore && detect.ongoingScore >= 2) {
        if (statusEl) statusEl.textContent = '⚠️ Esta planilha parece ser de GPON ONGOING. Use o importador correto.';
        alert('⚠️ Arquivo identificado como GPON ONGOING. Importe no botão de GPON ONGOING para evitar mistura de dados.');
        return;
      }

      const linhasValidas = filtrarLinhasValidasRapido(linhas);
      if (!linhasValidas.length) {
        if (statusEl) statusEl.textContent = '⚠️ A planilha foi lida, mas não há registros válidos para importar.';
        alert('⚠️ A planilha foi lida, mas não há registros válidos para PROJETO F.');
        return;
      }

      const filtroAno = filtrarLinhasPorAno(linhasValidas, EPO_IMPORT_TARGET_YEAR);
      // Se o filtro de ano não encontrar registros do ano alvo, usa todos os registros válidos
      const linhasAno = filtroAno.linhasFiltradas.length > 0 ? filtroAno.linhasFiltradas : linhasValidas;
      const filtroAnoIgnorado = filtroAno.filtroAplicado && filtroAno.linhasFiltradas.length === 0;

      if (statusEl) statusEl.textContent = `Processando 0/${linhasAno.length} (0%)...`;
      const { byEpo, semCorrespondencia } = await distribuirLinhasPorEpoEmLotes(linhasAno, 'projeto-f', statusEl);

      saveEpoStore('projeto-f', byEpo);
      atualizarCountPillsEpo();
      atualizarResumoEpoSelecionada();
      const linhasPersistencia = flattenEpoNovosStore(byEpo);
      const persistResult = await persistirDadosCompartilhados('epo-projeto-f', linhasPersistencia, { source: 'manual', locked: false });
      cacheDatasetLocally('epo-projeto-f', linhasPersistencia, { source: 'manual', locked: false });
      atualizarContadores();

      const total = linhasAno.length;
      const descartadasAno = filtroAnoIgnorado ? 0 : (linhasValidas.length - linhasAno.length);
      const resumo = formatarResumoEpoCompleto(byEpo);
      const ignoredText = semCorrespondencia.length ? ` • ${semCorrespondencia.length} sem PARCEIRA` : '';
      const yearFilterText = filtroAnoIgnorado
        ? ' • todos os anos incluídos'
        : (filtroAno.filtroAplicado
          ? (descartadasAno > 0 ? ` • ${descartadasAno} fora de ${EPO_IMPORT_TARGET_YEAR}` : '')
          : ' • ano não identificado na planilha');

      if (statusEl) {
        statusEl.textContent = persistResult?.queued
          ? `✅ ${total} linhas distribuídas por PARCEIRA${ignoredText}${yearFilterText} • sync pendente`
          : `✅ ${total} linhas distribuídas por PARCEIRA${ignoredText}${yearFilterText}`;
      }
      const resultEl = document.getElementById('epo-action-result');
      if (resultEl) resultEl.textContent = `✅ Importado PROJETO F: ${resumo}${ignoredText}`;

      updateEpoImportStatus('projeto-f');

      if (epoAcaoAtual === 'projeto-f' && epoSelecionadaAtual) renderProjetoFEpo();
      if (input) input.value = '';
    } catch (err) {
      console.error('[EPO][PROJETO F] Erro ao processar importação:', err);
      if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
    } finally {
      epoImportInProgressKey = '';
    }
  };

  const reader = new FileReader();
  reader.onload = (e) => {
    const text = String(e.target?.result || '');
    if (text.includes('\ufffd')) {
      const reader2 = new FileReader();
      reader2.onload = (e2) => processarTexto(String(e2.target?.result || '')).catch((err) => {
        if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
      });
      reader2.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
      reader2.readAsText(file, 'windows-1252');
    } else {
      processarTexto(text).catch((err) => {
        if (statusEl) statusEl.textContent = `⚠️ Erro ao processar importação: ${err?.message || 'desconhecido'}`;
      });
    }
  };
  reader.onerror = () => { if (statusEl) statusEl.textContent = '⚠️ Erro ao ler arquivo.'; };
  reader.readAsText(file);
}

function abrirImportEpoNovos() { abrirImportEpoGponOngoing(); }
function importarPlanilhaEpoNovos() { importarPlanilhaEpoGponOngoing(); }

function atualizarCountPillsEpo() {
  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    const epoName = String(btn.dataset.epo || '').trim().toUpperCase();
    const counts = getEpoCountsByName(epoName);
    const span = btn.querySelector('.epo-pill-count');
    if (span) {
      const hasAny = counts.gpon > 0 || counts.projetoF > 0;
      span.textContent = hasAny ? ` (${counts.gpon}/${counts.projetoF})` : '';
      span.title = hasAny ? `GPON ONGOING: ${counts.gpon} | PROJETO F: ${counts.projetoF}` : '';
    }
  });

  aplicarRestricaoEpoAccess();
  atualizarResumoEpoSelecionada();
  atualizarRotulosAcoesEpo();
}

function getEpoAccessDoUsuario() {
  const user = getCurrentUser();
  const raw = user?.epo_access;
  if (Array.isArray(raw)) {
    const parsedArray = raw.map(e => String(e).trim().toUpperCase()).filter(Boolean);
    if (parsedArray.length) return parsedArray;
  }

  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const parsedList = parsed.map(e => String(e).trim().toUpperCase()).filter(Boolean);
        if (parsedList.length) return parsedList;
      }
    } catch {
      const normalized = normalizarNomeEpoParaPill(raw);
      if (normalized) return [normalized];
    }
  }

  // Fallback 1: cadastro local de usuários EPO (quando sessão/API oscila)
  const loginNorm = String(user?.username || '').trim().toLowerCase();
  const localCadastro = getEpoUsuariosCadastradosStore()
    .find(item => String(item?.login || '').trim().toLowerCase() === loginNorm);
  if (localCadastro && Array.isArray(localCadastro.epos) && localCadastro.epos.length) {
    return localCadastro.epos.map(e => String(e).trim().toUpperCase()).filter(Boolean);
  }

  // Fallback 2: inferir pelo próprio nome/login do usuário (ex.: usuário ANTEC)
  const candidatos = [user?.username, user?.name, user?.email]
    .map(v => String(v || '').trim())
    .filter(Boolean);

  const inferidas = EPO_PILLS.filter((epo) => {
    const epoNorm = normalizeText(epo).replace(/[^a-z0-9]/g, '');
    return candidatos.some((candidate) => {
      const candNorm = normalizeText(candidate).replace(/[^a-z0-9]/g, '');
      return candNorm.includes(epoNorm) || epoNorm.includes(candNorm);
    });
  });

  if (inferidas.length) {
    return inferidas;
  }

  if (user?.role === 'viewer') {
    return [];
  }

  return null; // null = sem restrição (admin)
}

function aplicarRestricaoEpoAccess() {
  const permitidas = getEpoAccessDoUsuario();
  if (!permitidas) return; // sem restrição

  let primeiraPermitida = '';
  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    const epoName = String(btn.dataset.epo || '').trim().toUpperCase();
    const visivel = permitidas.includes(epoName);
    btn.style.display = visivel ? '' : 'none';
    if (visivel && !primeiraPermitida) {
      primeiraPermitida = epoName;
    }
  });

  if (permitidas.length && (!epoSelecionadaAtual || !permitidas.includes(epoSelecionadaAtual))) {
    if (primeiraPermitida) {
      selecionarEpo(primeiraPermitida);
    }
  }
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

function getEpoUsuariosCadastradosStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_EPO_USUARIOS_CADASTRADOS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEpoUsuariosCadastradosStore(lista = []) {
  localStorage.setItem(STORAGE_EPO_USUARIOS_CADASTRADOS_KEY, JSON.stringify(Array.isArray(lista) ? lista : []));
}

function registrarUsuarioEpoCadastrado({ nome = '', login = '', epos = [] } = {}) {
  const loginNorm = String(login || '').trim().toLowerCase();
  if (!loginNorm) return;

  const lista = getEpoUsuariosCadastradosStore();
  const idx = lista.findIndex(item => String(item?.login || '').trim().toLowerCase() === loginNorm);
  const payload = {
    nome: String(nome || '').trim(),
    login: String(login || '').trim(),
    epos: Array.isArray(epos) ? epos : [],
    updatedAt: new Date().toISOString()
  };

  if (idx >= 0) {
    lista[idx] = {
      ...lista[idx],
      ...payload,
      createdAt: lista[idx]?.createdAt || new Date().toISOString()
    };
  } else {
    lista.unshift({
      ...payload,
      createdAt: new Date().toISOString()
    });
  }

  saveEpoUsuariosCadastradosStore(lista);
}

function renderHistoricoUsuariosEpoCadastrados() {
  const lista = getEpoUsuariosCadastradosStore();
  if (!lista.length) {
    return '<p style="margin:8px 0 0;font-size:11px;color:#64748b;">Nenhum nome cadastrado ainda.</p>';
  }

  const itens = lista.slice(0, 30).map((item) => {
    const nome = escapeHtml(item?.nome || '-');
    const login = escapeHtml(item?.login || '-');
    const epos = Array.isArray(item?.epos) && item.epos.length
      ? escapeHtml(item.epos.join(', '))
      : '-';
    const data = formatDateTimeBr(item?.createdAt || item?.updatedAt);
    return `<li style="margin:0 0 6px;line-height:1.4;"><strong>${nome}</strong> (${login}) • EPO: ${epos} • ${escapeHtml(data)}</li>`;
  }).join('');

  return `
    <div style="margin-top:12px;border-top:1px solid #dbeafe;padding-top:10px;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#1e3a8a;">Nomes cadastrados</p>
      <ul style="margin:0;padding-left:18px;max-height:150px;overflow:auto;font-size:11px;color:#334155;">${itens}</ul>
    </div>
  `;
}

function atualizarHistoricoUsuariosEpoCadastradosNoForm() {
  const wrap = document.getElementById('epo-user-cadastrados-lista');
  if (!wrap) return;
  wrap.innerHTML = renderHistoricoUsuariosEpoCadastrados();
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
        return { codigo: item, tipo: 'gpon-ongoing', responsavel: '-', aceitoEm: null };
      }

      if (!item || typeof item !== 'object') return null;

      return {
        codigo: String(item.codigo || item.cod || item.COD_MDUGO || '').trim(),
        tipo: String(item.tipo || item.acao || 'gpon-ongoing').trim() || 'gpon-ongoing',
        responsavel: String(item.responsavel || item.user || '-').trim() || '-',
        aceitoEm: item.aceitoEm || item.createdAt || null
      };
    })
    .filter((item) => item && item.codigo);
}

function getAceitesDaEpo(nomeEpo) {
  const aceitesStore = getEpoAceitesStore();
  return normalizeListaAceitesEpo(aceitesStore?.[nomeEpo]);
}

function getAceitesMapDaEpo(nomeEpo, tipoAcao = 'gpon-ongoing') {
  const map = new Map();
  const lista = getAceitesDaEpo(nomeEpo);
  lista.forEach((entry) => {
    if (!entry || entry.tipo !== tipoAcao || !entry.codigo) return;
    map.set(String(entry.codigo), entry);
  });
  return map;
}

function salvarAceiteEpo(tipoAcao = 'gpon-ongoing', codigo = '') {
  if (!epoSelecionadaAtual || !codigo) return null;

  const aceitesStore = getEpoAceitesStore();
  const listaAtual = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);
  const responsavel = getNomeResponsavelAtual();
  const idxExistente = listaAtual.findIndex((entry) => String(entry.codigo) === String(codigo) && entry.tipo === tipoAcao);

  if (idxExistente === -1) {
    listaAtual.push({ codigo: String(codigo), tipo: tipoAcao, responsavel, aceitoEm: new Date().toISOString() });
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
    tipo: tipoAcao,
    codigo: String(codigo),
    at: Date.now()
  };

  return { responsavel };
}

function removerAceiteEpo(tipoAcao = 'gpon-ongoing', codigo = '') {
  if (!epoSelecionadaAtual || !codigo) return;

  const aceitesStore = getEpoAceitesStore();
  const listaAtual = normalizeListaAceitesEpo(aceitesStore?.[epoSelecionadaAtual]);
  aceitesStore[epoSelecionadaAtual] = listaAtual.filter((entry) => !(String(entry.codigo) === String(codigo) && entry.tipo === tipoAcao));
  saveEpoAceitesStore(aceitesStore);

  if (
    epoUltimoAceite
    && epoUltimoAceite.epo === epoSelecionadaAtual
    && epoUltimoAceite.tipo === tipoAcao
    && String(epoUltimoAceite.codigo) === String(codigo)
  ) {
    epoUltimoAceite = null;
  }
}

function _getCodigoAceiteDaLinhaEpo(item, index, tipoAcao = 'gpon-ongoing') {
  if (tipoAcao === 'projeto-f') {
    return getProjetoFCodigoGed(item, `LINHA-${Number(index) + 1}`);
  }

  return String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || `LINHA-${Number(index) + 1}`);
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

  const rows = lista.map((item, idx) => `
    <tr>
      <td>${escapeHtml(item.nome || '-')}</td>
      <td>${escapeHtml(item.rg || '-')}</td>
      <td>${escapeHtml(item.cpf || '-')}</td>
      <td>${escapeHtml(item.placa || '-')}</td>
      <td>${escapeHtml(item.modelo || '-')}</td>
      <td>${escapeHtml(formatDateTimeBr(item.createdAt))}</td>
      <td>
        <div class="epo-inline-actions epo-tecnico-actions">
          <button type="button" class="btn-secondary" onclick="editarTecnicoEpo(${idx})">Alterar</button>
          <button type="button" class="btn-secondary" onclick="excluirTecnicoEpo(${idx})">Excluir</button>
        </div>
      </td>
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
            <th>Ações</th>
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

  epoTecnicoEditIndex = -1;

  const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
  const isAdmin = getCurrentUser()?.role === 'admin';
  const cadastroUsuarioBtnHtml = isAdmin ? `
    <button type="button" class="btn-secondary" onclick="toggleCadastroUsuarioEpo()" style="margin-left:8px;">👤 CADASTRAR NOME</button>
    <div id="cadastro-usuario-epo-form" class="epo-form-shell" style="display:none;margin-top:12px;">
      <p style="font-size:12px;font-weight:700;color:#1d4ed8;margin:0 0 10px;">Cadastrar nome com acesso restrito a EPO(s) específica(s)</p>
      <div class="epo-form-grid">
        <input id="epo-user-nome" type="text" placeholder="NOME COMPLETO" />
        <input id="epo-user-login" type="text" placeholder="LOGIN (sem espaços)" />
      </div>
      <div style="margin:10px 0 4px;">
        <label style="font-size:12px;font-weight:700;color:#334155;">EPOs com acesso:</label>
        <div id="epo-user-pills" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
          ${EPO_PILLS.map(epo => `
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;cursor:pointer;background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:20px;padding:3px 10px;">
              <input type="checkbox" value="${epo}" ${epo === epoSelecionadaAtual ? 'checked' : ''} style="margin:0;" />
              ${escapeHtml(epo)}
            </label>`).join('')}
        </div>
      </div>
      <div class="epo-form-actions" style="margin-top:12px;">
        <button type="button" class="btn-primary" onclick="salvarCadastroUsuarioEpo()">CRIAR ACESSO</button>
        <button type="button" class="btn-secondary" onclick="toggleCadastroUsuarioEpo()">CANCELAR</button>
      </div>
      <div id="epo-user-resultado" style="margin-top:10px;font-size:12px;"></div>
      <div id="epo-user-cadastrados-lista">${renderHistoricoUsuariosEpoCadastrados()}</div>
    </div>
  ` : '';

  container.innerHTML = `
    <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • LISTA DE EQUIPES</p>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
      <button type="button" class="btn-primary" onclick="toggleCadastroTecnicoEpo()">CADASTRAR TÉCNICO</button>
      ${cadastroUsuarioBtnHtml}
    </div>

    <div id="cadastro-tecnico-form" class="epo-form-shell" style="display:none;">
      <div class="epo-form-grid">
        <input id="epo-tecnico-nome" type="text" placeholder="NOME DO TECNICO" />
        <input id="epo-tecnico-rg" type="text" placeholder="RG" />
        <input id="epo-tecnico-cpf" type="text" placeholder="CPF" />
        <input id="epo-tecnico-placa" type="text" placeholder="PLACA CARRO" />
        <input id="epo-tecnico-modelo" type="text" placeholder="MODELO CARRO" />
      </div>
      <div class="epo-form-actions">
        <button type="button" id="epo-tecnico-save-btn" class="btn-primary" onclick="salvarCadastroTecnicoEpo()">SALVAR CADASTRO</button>
        <button type="button" id="epo-tecnico-cancel-btn" class="btn-secondary" style="display:none;" onclick="cancelarEdicaoTecnicoEpo()">CANCELAR EDIÇÃO</button>
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

function toggleCadastroUsuarioEpo() {
  const form = document.getElementById('cadastro-usuario-epo-form');
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function salvarCadastroUsuarioEpo() {
  const nome = (document.getElementById('epo-user-nome')?.value || '').trim();
  const login = (document.getElementById('epo-user-login')?.value || '').trim().replace(/\s+/g, '');
  const checkboxes = document.querySelectorAll('#epo-user-pills input[type="checkbox"]:checked');
  const eposEscolhidas = Array.from(checkboxes).map(cb => cb.value);
  const resultEl = document.getElementById('epo-user-resultado');

  if (resultEl) resultEl.textContent = '';

  if (!nome || !login) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626;">⚠️ Preencha nome e login.</span>';
    return;
  }

  if (!eposEscolhidas.length) {
    if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626;">⚠️ Selecione ao menos uma EPO.</span>';
    return;
  }

  const senhaGerada = 'MDU@2026';

  const salvarUsuarioEpoLocal = () => {
    const users = getStoredUsers();
    if (users.find(u => String(u.username || '').toLowerCase() === login.toLowerCase())) {
      if (resultEl) resultEl.innerHTML = '<span style="color:#dc2626;">⚠️ Usuário já existe.</span>';
      return false;
    }

    users.push({
      username: login,
      password: senhaGerada,
      name: nome,
      email: `${login}@epo.local`,
      role: 'viewer',
      epo_access: eposEscolhidas,
      must_change_password: true,
      createdAt: new Date().toISOString(),
      approvedAt: new Date().toISOString()
    });
    saveStoredUsers(users);
    return true;
  };

  if (window.location.protocol.startsWith('http')) {
    try {
      const res = await fetch('/api/admin/create_epo_user', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nome, username: login, epo_access: eposEscolhidas, password: senhaGerada })
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const serverMsg = body.error || 'Não foi possível criar usuário no servidor.';
        if (resultEl) {
          resultEl.innerHTML = `<span style="color:#dc2626;">⚠️ ${escapeHtml(serverMsg)}<br>O acesso não foi criado para uso geral. Verifique conexão/API e tente novamente.</span>`;
        }
        return;
      }
    } catch {
      if (resultEl) {
        resultEl.innerHTML = '<span style="color:#dc2626;">⚠️ Falha de conexão com a API. O acesso não foi criado no servidor.</span>';
      }
      return;
    }
  } else {
    // Modo offline: salva localmente
    const okLocal = salvarUsuarioEpoLocal();
    if (!okLocal) return;
  }

  const avisoSync = window.location.protocol.startsWith('http')
    ? ''
    : '<br><span style="color:#b45309;">⚠️ Cadastro salvo apenas neste navegador (modo local/offline).</span>';

  if (resultEl) resultEl.innerHTML = `
    <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:10px 14px;font-size:12px;line-height:1.7;">
      <strong style="color:#166534;">✅ Acesso criado com sucesso!</strong><br>
      Login: <strong>${escapeHtml(login)}</strong><br>
      Senha padrão: <strong>${escapeHtml(senhaGerada)}</strong><br>
      EPOs: <strong>${eposEscolhidas.map(e => escapeHtml(e)).join(', ')}</strong><br>
      <span style="color:#64748b;">O usuário deverá trocar a senha no primeiro acesso.</span>
      ${avisoSync}
      <div style="margin-top:8px;">
        <button type="button" class="btn-secondary" onclick="copiarCredenciaisEpo('${escapeHtml(login)}','${escapeHtml(senhaGerada)}')">Copiar login e senha</button>
      </div>
    </div>
  `;

  registrarUsuarioEpoCadastrado({
    nome,
    login,
    epos: eposEscolhidas
  });
  atualizarHistoricoUsuariosEpoCadastradosNoForm();

  if (document.getElementById('epo-user-nome')) document.getElementById('epo-user-nome').value = '';
  if (document.getElementById('epo-user-login')) document.getElementById('epo-user-login').value = '';
}

async function copiarCredenciaisEpo(login, senha) {
  const texto = `Login: ${login}\nSenha padrão: ${senha}`;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      alert('✅ Credenciais copiadas para área de transferência.');
      return;
    }
  } catch {
    // segue fallback abaixo
  }

  const area = document.createElement('textarea');
  area.value = texto;
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  document.body.removeChild(area);
  alert('✅ Credenciais copiadas para área de transferência.');
}

function abrirSeletorPlanilhaTecnicosEpo() {
  const input = document.getElementById('epo-tecnicos-file');
  if (input) input.click();
}

function atualizarModoFormularioTecnicoEpo() {
  const saveBtn = document.getElementById('epo-tecnico-save-btn');
  const cancelBtn = document.getElementById('epo-tecnico-cancel-btn');

  if (saveBtn) {
    saveBtn.textContent = epoTecnicoEditIndex >= 0 ? 'SALVAR ALTERAÇÃO' : 'SALVAR CADASTRO';
  }

  if (cancelBtn) {
    cancelBtn.style.display = epoTecnicoEditIndex >= 0 ? 'inline-flex' : 'none';
  }
}

function limparFormularioTecnicoEpo() {
  const campos = [
    'epo-tecnico-nome',
    'epo-tecnico-rg',
    'epo-tecnico-cpf',
    'epo-tecnico-placa',
    'epo-tecnico-modelo'
  ];

  campos.forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

function editarTecnicoEpo(index) {
  if (!epoSelecionadaAtual) return;

  const idx = Number(index);
  const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
  const tecnico = tecnicos[idx];
  if (!tecnico) return;

  epoTecnicoEditIndex = idx;

  const form = document.getElementById('cadastro-tecnico-form');
  if (form) form.style.display = 'block';

  const nomeInput = document.getElementById('epo-tecnico-nome');
  const rgInput = document.getElementById('epo-tecnico-rg');
  const cpfInput = document.getElementById('epo-tecnico-cpf');
  const placaInput = document.getElementById('epo-tecnico-placa');
  const modeloInput = document.getElementById('epo-tecnico-modelo');

  if (nomeInput) nomeInput.value = tecnico.nome || '';
  if (rgInput) rgInput.value = tecnico.rg || '';
  if (cpfInput) cpfInput.value = tecnico.cpf || '';
  if (placaInput) placaInput.value = tecnico.placa || '';
  if (modeloInput) modeloInput.value = tecnico.modelo || '';

  atualizarModoFormularioTecnicoEpo();
}

function cancelarEdicaoTecnicoEpo() {
  epoTecnicoEditIndex = -1;
  limparFormularioTecnicoEpo();
  atualizarModoFormularioTecnicoEpo();
}

function excluirTecnicoEpo(index) {
  if (!epoSelecionadaAtual) return;

  const idx = Number(index);
  const tecnicos = getTecnicosDaEpo(epoSelecionadaAtual);
  const tecnico = tecnicos[idx];
  if (!tecnico) return;

  if (!confirm(`Deseja excluir o técnico ${tecnico.nome || 'selecionado'}?`)) {
    return;
  }

  tecnicos.splice(idx, 1);
  saveTecnicosDaEpo(epoSelecionadaAtual, tecnicos);
  executarAcaoEpo('equipes');

  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `🗑️ Técnico excluído em ${epoSelecionadaAtual}.`;
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
  const payload = { nome, rg, cpf, placa, modelo };

  if (epoTecnicoEditIndex >= 0 && tecnicos[epoTecnicoEditIndex]) {
    const registroAtual = tecnicos[epoTecnicoEditIndex];
    tecnicos[epoTecnicoEditIndex] = {
      ...registroAtual,
      ...payload,
      updatedAt: new Date().toISOString()
    };
  } else {
    tecnicos.push({ ...payload, createdAt: new Date().toISOString() });
  }

  saveTecnicosDaEpo(epoSelecionadaAtual, tecnicos);

  const estavaEditando = epoTecnicoEditIndex >= 0;
  epoTecnicoEditIndex = -1;

  executarAcaoEpo('equipes');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) {
    resultEl.textContent = estavaEditando
      ? `✅ Cadastro técnico atualizado com sucesso em ${epoSelecionadaAtual}.`
      : `✅ Técnico cadastrado com sucesso em ${epoSelecionadaAtual}.`;
  }
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

function isLikelyEpoOngoingRow(item) {
  if (!item || typeof item !== 'object') return false;

  const score = [
    getField(item, 'STATUS_GERAL', 'STATUS', 'status', 'Status Geral'),
    getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo', 'Motivo Geral'),
    getField(item, 'SOLICITANTE', 'solicitante'),
    getField(item, 'IDDEMANDA', 'ID DEMANDA', 'id'),
    getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo')
  ].filter((value) => String(value || '').trim() !== '').length;

  const projetoFHints = [
    getField(item, 'STATUS MDU', 'STATUS_MDU', 'status_mdu'),
    getField(item, 'STATUS LIBERAÇÃO', 'STATUS LIBERACAO', 'STATUS_LIBERACAO', 'status_liberacao'),
    getField(item, 'CODGED', 'codged', 'cod_ged')
  ].filter((value) => String(value || '').trim() !== '').length;

  return score >= 2 && score >= projetoFHints;
}

function isLikelyEpoProjetoFRow(item) {
  if (!item || typeof item !== 'object') return false;

  const score = [
    getField(item, 'STATUS MDU', 'STATUS_MDU', 'status_mdu'),
    getField(item, 'STATUS LIBERAÇÃO', 'STATUS LIBERACAO', 'STATUS_LIBERACAO', 'status_liberacao'),
    getField(item, 'CODGED', 'codged', 'cod_ged', 'CÓD. GED', 'COD GED'),
    getField(item, 'Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos'),
    getField(item, 'PARCEIRA', 'parceira')
  ].filter((value) => String(value || '').trim() !== '').length;

  const ongoingHints = [
    getField(item, 'STATUS_GERAL', 'STATUS', 'status', 'Status Geral'),
    getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo', 'Motivo Geral'),
    getField(item, 'SOLICITANTE', 'solicitante')
  ].filter((value) => String(value || '').trim() !== '').length;

  return score >= 2 && score >= ongoingHints;
}

function renderGponOngoingEpo(customRows = null) {
  const container = document.getElementById('epo-action-content');
  if (!container) return;

  const dadosOriginais = Array.isArray(customRows) ? customRows : getEpoRowsForEpo('gpon-ongoing', epoSelecionadaAtual);
  const dados = (Array.isArray(dadosOriginais) ? dadosOriginais : []).filter(isLikelyEpoOngoingRow);
  if (!dados.length) {
    container.innerHTML = `
      <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • GPON ONGOING (0)</p>
      <div class="epo-table-wrap">
        <table class="epo-table">
          <thead>
            <tr>
              <th>Código</th>
              <th>Endereço</th>
              <th>Número</th>
              <th>Bairro</th>
              <th>Cidade</th>
              <th>EPO</th>
              <th>Solicitante</th>
              <th>Status Geral</th>
              <th>Motivo Geral</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="10" style="text-align:center">Nenhum registro para esta EPO</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="epo-empty-state">Use o 📎 de GPON ONGOING para importar a planilha do BACKLOG.</p>
    `;
    return;
  }

  window.__epoGponRows = dados;
  const aceitesMap = getAceitesMapDaEpo(epoSelecionadaAtual, 'gpon-ongoing');

  const rows = dados.map((item, idx) => {
    const codigo = String(getField(item, 'COD-MDUGO', 'CODIGO', 'CÓDIGO', 'cod-mdugo', 'codmdugo') || `LINHA-${idx + 1}`);
    const enderecoBase = getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '-';
    const numero = getField(item, 'NUMERO', 'numero', 'num') || '-';
    const bairro = getField(item, 'BAIRRO', 'bairro') || '-';
    const cidade = getField(item, 'CIDADE', 'cidade') || '-';
    const epo = getField(item, 'EPO', 'epo', 'CLUSTER', 'cluster', 'PARCEIRA', 'parceira') || epoSelecionadaAtual || '-';
    const solicitante = getField(item, 'SOLICITANTE', 'solicitante') || '-';
    const status = getField(item, 'STATUS_GERAL', 'STATUS', 'status', 'Status Geral') || '-';
    const motivo = getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo', 'Motivo Geral') || '-';
    const aceite = aceitesMap.get(codigo);
    const isAceito = Boolean(aceite);
    const isAceitoRecente = Boolean(
      isAceito
      && epoUltimoAceite
      && epoUltimoAceite.epo === epoSelecionadaAtual
      && epoUltimoAceite.tipo === 'gpon-ongoing'
      && String(epoUltimoAceite.codigo) === codigo
      && (Date.now() - Number(epoUltimoAceite.at || 0) <= 15000)
    );
    const rowClass = [
      isAceito ? 'epo-row-aceita' : '',
      isAceitoRecente ? 'epo-row-aceita-recente' : ''
    ].filter(Boolean).join(' ');

    return `
      <tr class="${rowClass}">
        <td>${escapeHtml(codigo)}</td>
        <td>${escapeHtml(enderecoBase)}</td>
        <td>${escapeHtml(numero)}</td>
        <td>${escapeHtml(bairro)}</td>
        <td>${escapeHtml(cidade)}</td>
        <td>${escapeHtml(epo)}</td>
        <td>${escapeHtml(solicitante)}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(motivo)}</td>
        <td>
          <div class="epo-inline-actions">
            <button type="button" class="btn-secondary" onclick="visualizarNovoEntrante(${idx})">Visualizar</button>
            ${isAceito
              ? `<button type="button" class="epo-btn-aceito${isAceitoRecente ? ' pulse' : ''}" disabled>Aceito</button>`
              : `<button type="button" class="btn-primary" onclick="aceitarNovoEntrante(${idx})">Aceitar</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • GPON ONGOING (${dados.length})</p>
    <div class="epo-table-wrap">
      <table class="epo-table">
        <thead>
          <tr>
            <th>Código</th>
            <th>Endereço</th>
            <th>Número</th>
            <th>Bairro</th>
            <th>Cidade</th>
            <th>EPO</th>
            <th>Solicitante</th>
            <th>Status Geral</th>
            <th>Motivo Geral</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function getProjetoFCodigoGed(item, fallback = '') {
  const value = getField(
    item,
    'CÓD. GED', 'Cód. GED', 'COD. GED', 'COD GED', 'CODGED',
    'CÓD GED', 'COD_GED', 'cod_ged', 'CÓDIGO GED', 'CODIGO GED',
    'ID GED', 'ID_GED', 'GED', 'ged', 'COD-MDUGO', 'cod-mdugo', 'codmdugo'
  )
    || _getFieldByKeyHint(item, 'ged')
    || _getFieldByKeyHint(item, 'cod ged')
    || _getFieldByKeyHint(item, 'codigo ged')
    || _getFieldByKeyHint(item, 'id ged')
    || '';

  const normalized = String(value || '').trim();
  return normalized || String(fallback || '').trim() || '-';
}

function getProjetoFEndereco(item) {
  const endereco = String(getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '').trim();
  const numero = String(getField(item, 'NUMERO', 'NÚMERO', 'numero', 'num') || '').trim();
  if (!numero || numero === '-' || endereco.includes(`, ${numero}`)) return endereco || '-';
  return `${endereco}, ${numero}`;
}

function renderProjetoFEpo(customRows = null) {
  const container = document.getElementById('epo-action-content');
  if (!container) return;

  const dadosOriginais = Array.isArray(customRows) ? customRows : getEpoRowsForEpo('projeto-f', epoSelecionadaAtual);
  const dados = (Array.isArray(dadosOriginais) ? dadosOriginais : []).filter(isLikelyEpoProjetoFRow);
  if (!dados.length) {
    container.innerHTML = `
      <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • PROJETO F (0)</p>
      <div class="epo-table-wrap">
        <table class="epo-table">
          <thead>
            <tr>
              <th>Cidade</th>
              <th>Bloco</th>
              <th>Cód. GED</th>
              <th>Endereço</th>
              <th>Qtde Blocos</th>
              <th>Status MDU</th>
              <th>Status Liberação</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colspan="8" style="text-align:center">Nenhum registro para esta EPO</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="epo-empty-state">Use o 📎 de PROJETO F para importar a planilha de construção.</p>
    `;
    return;
  }

  window.__epoProjetoFRows = dados;
  const aceitesMap = getAceitesMapDaEpo(epoSelecionadaAtual, 'projeto-f');

  const rows = dados.map((item, idx) => {
    const cidade = String(getField(item, 'Cidade', 'CIDADE', 'cidade') || '-');
    const bloco = String(getField(item, 'Bloco', 'BLOCO', 'bloco') || '-');
    const codGed = getProjetoFCodigoGed(item, `LINHA-${idx + 1}`);
    const endereco = getProjetoFEndereco(item) || '-';
    const qtdeBlocos = String(getField(item, 'Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos') || '-');
    const statusMdu = String(getField(item, 'Status MDU', 'STATUS MDU', 'STATUS_MDU', 'status_mdu') || '-');
    const statusLiberacao = String(getField(item, 'Status Liberação', 'STATUS LIBERAÇÃO', 'STATUS LIBERACAO', 'STATUS_LIBERACAO', 'status_liberacao') || '-');
    const aceite = aceitesMap.get(codGed);
    const isAceito = Boolean(aceite);
    const isAceitoRecente = Boolean(
      isAceito
      && epoUltimoAceite
      && epoUltimoAceite.epo === epoSelecionadaAtual
      && epoUltimoAceite.tipo === 'projeto-f'
      && String(epoUltimoAceite.codigo) === codGed
      && (Date.now() - Number(epoUltimoAceite.at || 0) <= 15000)
    );
    const rowClass = [
      isAceito ? 'epo-row-aceita' : '',
      isAceitoRecente ? 'epo-row-aceita-recente' : ''
    ].filter(Boolean).join(' ');

    return `
      <tr class="${rowClass}">
        <td>${escapeHtml(cidade)}</td>
        <td>${escapeHtml(bloco)}</td>
        <td>${escapeHtml(codGed)}</td>
        <td>${escapeHtml(endereco)}</td>
        <td>${escapeHtml(qtdeBlocos)}</td>
        <td>${escapeHtml(statusMdu)}</td>
        <td>${escapeHtml(statusLiberacao)}</td>
        <td>
          <div class="epo-inline-actions">
            <button type="button" class="btn-secondary" onclick="visualizarProjetoFEpo(${idx})">Visualizar</button>
            ${isAceito
              ? `<button type="button" class="epo-btn-aceito${isAceitoRecente ? ' pulse' : ''}" disabled>Aceito</button>`
              : `<button type="button" class="btn-primary" onclick="aceitarProjetoFEpo(${idx})">Aceitar</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <p class="epo-section-title">${escapeHtml(epoSelecionadaAtual)} • PROJETO F (${dados.length})</p>
    <div class="epo-table-wrap">
      <table class="epo-table">
        <thead>
          <tr>
            <th>Cidade</th>
            <th>Bloco</th>
            <th>Cód. GED</th>
            <th>Endereço</th>
            <th>Qtde Blocos</th>
            <th>Status MDU</th>
            <th>Status Liberação</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderNovosEntrantesEpo(customRows = null) {
  renderGponOngoingEpo(customRows);
}

async function visualizarNovoEntrante(index) {
  const item = window.__epoGponRows?.[index];
  if (!item) return;

  const codigo = String(getField(item, 'COD-MDUGO', 'CODIGO', 'CÓDIGO', 'cod-mdugo', 'codmdugo') || `LINHA-${index + 1}`);
  const enderecoBase = getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '-';
  const numero = getField(item, 'NUMERO', 'numero', 'num') || '-';
  const enderecoCompleto = numero && numero !== '-' ? `${enderecoBase}, ${numero}` : enderecoBase || '-';
  const bairro = getField(item, 'BAIRRO', 'bairro') || '-';
  const cidade = getField(item, 'CIDADE', 'cidade') || '-';
  const tipoRede = getField(item, 'TIPO_REDE', 'tipo_rede', 'TIPO DE REDE', 'REDE') || '-';
  const contato = getField(item, 'CONTATO', 'contato', 'TELEFONE') || '-';
  const status = getField(item, 'STATUS_GERAL', 'STATUS', 'status', 'Status Geral') || '-';
  const motivo = getField(item, 'MOTIVO_GERAL', 'MOTIVO', 'motivo', 'Motivo Geral') || '-';
  const obsOriginal = getField(item, 'OBS', 'OBSERVACAO', 'observacao') || '-';
  const nodeAreaTecnica = getField(item, 'NODE&ÁREA TÉCNICA', 'NODE&AREA TECNICA', 'NODE_AREA_TECNICA', 'NODE', 'node') || '-';
  const dadosCliente = getField(item, 'DADOS_CLIENTE', 'DADOS CLIENTE', 'dados_cliente') || '-';
  const solicitante = getField(item, 'SOLICITANTE', 'solicitante') || '-';
  const epo = getField(item, 'EPO', 'epo', 'CLUSTER', 'cluster', 'PARCEIRA', 'parceira') || epoSelecionadaAtual || '-';

  const referencia = `${epoSelecionadaAtual || 'EPO'}::${codigo}`;
  currentPendenteCodigo = referencia;

  document.getElementById('modal-codigo').textContent = codigo;
  document.getElementById('modal-endereco').textContent = enderecoCompleto;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
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
    heroSubtitle: [cidade, bairro, epo].filter(v => v && v !== '-').join(' • ') || 'Visualização detalhada do entrante selecionado.',
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
        ${renderModalInfoCard('EPO', epo)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  await Promise.all([
    carregarObservacoesPendente(referencia),
    carregarAnexosPendente(referencia)
  ]);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const footer = document.querySelector('#modal-obs .modal-footer');
  if (footer) {
    syncEpoModalRetirarButton({
      tipoAcao: 'gpon-ongoing',
      codigo,
      index
    });
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

async function visualizarProjetoFEpo(index) {
  const item = window.__epoProjetoFRows?.[index];
  if (!item) return;

  const codigoGed = getProjetoFCodigoGed(item, `LINHA-${index + 1}`);
  const endereco = getProjetoFEndereco(item);
  const bairro = String(getField(item, 'Bairro', 'BAIRRO', 'bairro') || '-');
  const cidade = String(getField(item, 'Cidade', 'CIDADE', 'cidade') || '-');
  const statusMdu = String(getField(item, 'Status MDU', 'STATUS MDU', 'STATUS_MDU', 'status_mdu') || '-');
  const statusLiberacao = String(getField(item, 'Status Liberação', 'STATUS LIBERAÇÃO', 'STATUS LIBERACAO', 'STATUS_LIBERACAO', 'status_liberacao') || '-');
  const bloco = String(getField(item, 'Bloco', 'BLOCO', 'bloco') || '-');
  const qtdeBlocos = String(getField(item, 'Qtde Blocos', 'QTDE_BLOCOS', 'QTD_BLOCOS', 'qtd_blocos') || '-');
  const cliente = String(getField(item, 'Cliente', 'CLIENTE', 'cliente') || '-');
  const contato = String(getField(item, 'Contato', 'CONTATO', 'contato') || '-');
  const obsOriginal = String(getField(item, 'OBS', 'OBSERVACAO', 'observacao') || '-');

  const referencia = `${epoSelecionadaAtual || 'EPO'}::PROJETO_F::${codigoGed}`;
  currentPendenteCodigo = referencia;

  document.getElementById('modal-codigo').textContent = codigoGed;
  document.getElementById('modal-endereco').textContent = endereco;
  document.getElementById('modal-bairro').textContent = bairro;
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epoSelecionadaAtual || '-';
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusMdu);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(statusLiberacao);
  document.getElementById('modal-obs-original').textContent = obsOriginal;
  document.getElementById('modal-obs-adicional').value = '';

  applyModalContext({
    themeClass: 'empresarial-modal',
    title: 'Detalhes EPO • PROJETO F',
    kicker: 'Painel executivo por EPO',
    heroChip: 'PROJETO F',
    heroTitle: endereco || codigoGed,
    heroSubtitle: [cidade, bairro, epoSelecionadaAtual].filter(v => v && v !== '-').join(' • ') || 'Visualização detalhada do registro selecionado.',
    statusLabel: 'Status MDU',
    motivoLabel: 'Status Liberação',
    heroPills: [
      { label: 'CÓD. GED', value: codigoGed },
      { label: 'BLOCO', value: bloco },
      { label: 'QTDE BLOCOS', value: qtdeBlocos },
      { label: 'STATUS MDU', value: statusMdu, badge: true },
      { label: 'STATUS LIBERAÇÃO', value: statusLiberacao, badge: true }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const oldExtra = modalBody.querySelector('.modal-extra.modal-extra-grid');
    if (oldExtra) oldExtra.remove();
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('CLIENTE', cliente, { featured: true })}
        ${renderModalInfoCard('CONTATO', contato)}
        ${renderModalInfoCard('BLOCO', bloco)}
        ${renderModalInfoCard('QTDE BLOCOS', qtdeBlocos)}
      </div>
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  await Promise.all([
    carregarObservacoesPendente(referencia),
    carregarAnexosPendente(referencia)
  ]);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const footer = document.querySelector('#modal-obs .modal-footer');
  if (footer) {
    syncEpoModalRetirarButton({
      tipoAcao: 'projeto-f',
      codigo: codigoGed,
      index
    });
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
  const item = window.__epoGponRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = _getCodigoAceiteDaLinhaEpo(item, index, 'gpon-ongoing');
  const payload = salvarAceiteEpo('gpon-ongoing', codigo);
  const responsavel = payload?.responsavel || getNomeResponsavelAtual();

  executarAcaoEpo('gpon-ongoing');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `✅ Endereço ${codigo} aceito por ${responsavel}.`;

  await visualizarNovoEntrante(index);
}

async function retirarResponsavelNovoEntrante(index) {
  const item = window.__epoGponRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = _getCodigoAceiteDaLinhaEpo(item, index, 'gpon-ongoing');
  removerAceiteEpo('gpon-ongoing', codigo);

  executarAcaoEpo('gpon-ongoing');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `↩️ Responsável removido do endereço ${codigo}. O aceite foi liberado novamente.`;
}

async function aceitarProjetoFEpo(index) {
  const item = window.__epoProjetoFRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = _getCodigoAceiteDaLinhaEpo(item, index, 'projeto-f');
  const payload = salvarAceiteEpo('projeto-f', codigo);
  const responsavel = payload?.responsavel || getNomeResponsavelAtual();

  executarAcaoEpo('projeto-f');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `✅ Projeto F ${codigo} aceito por ${responsavel}.`;

  await visualizarProjetoFEpo(index);
}

function retirarAceiteProjetoFEpo(index) {
  const item = window.__epoProjetoFRows?.[index];
  if (!item || !epoSelecionadaAtual) return;

  const codigo = _getCodigoAceiteDaLinhaEpo(item, index, 'projeto-f');
  removerAceiteEpo('projeto-f', codigo);

  executarAcaoEpo('projeto-f');
  const resultEl = document.getElementById('epo-action-result');
  if (resultEl) resultEl.textContent = `↩️ Aceite removido do Projeto F ${codigo}.`;
}

function syncEpoModalRetirarButton({ tipoAcao = 'gpon-ongoing', codigo = '', index = -1 } = {}) {
  const footer = document.querySelector('#modal-obs .modal-footer');
  if (!footer) return;

  const oldBtn = document.getElementById('modal-retirar-responsavel');
  if (oldBtn) oldBtn.remove();

  if (!codigo || index < 0 || !epoSelecionadaAtual) return;

  const aceitesMap = getAceitesMapDaEpo(epoSelecionadaAtual, tipoAcao);
  const aceiteAtual = aceitesMap.get(String(codigo));
  if (!aceiteAtual) return;

  const btn = document.createElement('button');
  btn.id = 'modal-retirar-responsavel';
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.textContent = 'Retirar aceite';
  btn.onclick = async () => {
    if (tipoAcao === 'projeto-f') {
      retirarAceiteProjetoFEpo(index);
    } else {
      await retirarResponsavelNovoEntrante(index);
    }
    syncEpoModalRetirarButton({ tipoAcao, codigo, index });
  };

  const saveBtn = footer.querySelector('.btn-primary');
  if (saveBtn) {
    footer.insertBefore(btn, saveBtn);
  } else {
    footer.appendChild(btn);
  }
}

function selecionarEpo(nomeEpo) {
  epoSelecionadaAtual = String(nomeEpo || '').trim();

  const epoSection = document.getElementById('epo');
  const panel = document.getElementById('epo-action-panel');
  const importTools = document.getElementById('epo-import-tools');
  const resetButton = document.getElementById('epo-reset-selecao');
  const intro = document.getElementById('epo-selecao-intro');
  const pillGrid = document.querySelector('#epo .epo-pill-grid');
  const selectedNameEl = document.getElementById('epo-selected-name');
  const resultEl = document.getElementById('epo-action-result');

  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.epo === epoSelecionadaAtual);
  });
  atualizarCountPillsEpo();

  if (epoSection) epoSection.classList.remove('epo-selection-mode');
  if (pillGrid) pillGrid.classList.add('only-active');

  if (panel) panel.style.display = 'block';
  if (importTools) importTools.style.display = usuarioPodeImportar() ? 'flex' : 'none';
  if (resetButton) resetButton.style.display = 'inline-flex';
  if (intro) intro.style.display = 'none';
  if (selectedNameEl) atualizarResumoEpoSelecionada();
  if (resultEl) {
    resultEl.textContent = epoSelecionadaAtual
      ? `Selecione uma opção para ${epoSelecionadaAtual}.`
      : 'Selecione uma EPO para habilitar as opções.';
  }

  if (epoAcaoAtual) {
    executarAcaoEpo(epoAcaoAtual);
  } else {
    executarAcaoEpo('equipes');
  }
}

function resetarSelecaoEpo() {
  epoSelecionadaAtual = '';

  const epoSection = document.getElementById('epo');
  const panel = document.getElementById('epo-action-panel');
  const importTools = document.getElementById('epo-import-tools');
  const resetButton = document.getElementById('epo-reset-selecao');
  const intro = document.getElementById('epo-selecao-intro');
  const pillGrid = document.querySelector('#epo .epo-pill-grid');
  const selectedNameEl = document.getElementById('epo-selected-name');
  const resultEl = document.getElementById('epo-action-result');
  const actionContent = document.getElementById('epo-action-content');

  if (epoSection) epoSection.classList.add('epo-selection-mode');
  if (pillGrid) pillGrid.classList.remove('only-active');
  if (panel) panel.style.display = 'none';
  if (importTools) importTools.style.display = usuarioPodeImportar() ? 'flex' : 'none';
  if (resetButton) resetButton.style.display = 'none';
  if (intro) intro.style.display = '';
  if (selectedNameEl) atualizarResumoEpoSelecionada();
  if (resultEl) resultEl.textContent = 'Selecione uma EPO para habilitar as opções.';
  if (actionContent) actionContent.innerHTML = '';

  document.querySelectorAll('#epo .epo-pill[data-epo]').forEach(btn => {
    btn.classList.remove('active');
  });

  setEpoActionButtonActive('');
  atualizarCountPillsEpo();
}

function executarAcaoEpo(tipoAcao) {
  epoAcaoAtual = tipoAcao;
  setEpoActionButtonActive(tipoAcao);
  atualizarCountPillsEpo();

  const resultEl = document.getElementById('epo-action-result');
  if (!epoSelecionadaAtual) {
    if (resultEl) {
      resultEl.textContent = 'Selecione uma EPO antes de clicar nas opções.';
    }
    return;
  }

  if (tipoAcao === 'equipes') {
    renderListaEquipesEpo();
  } else if (tipoAcao === 'projeto-f') {
    renderProjetoFEpo();
  } else {
    renderGponOngoingEpo();
  }

  const labels = {
    'equipes': 'LISTA DE EQUIPES',
    'gpon-ongoing': 'GPON ONGOING',
    'projeto-f': 'PROJETO F'
  };
  const acao = labels[tipoAcao] || 'GPON ONGOING';

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

function getPendenteRowsByTab(tab = pendenteActiveTab) {
  return (dadosPorCategoria['pendente-autorizacao'] || []).filter(item => item.__pendenteTipo === tab);
}

function getPendenteCityOptions(tab = pendenteActiveTab) {
  return [...new Set(getPendenteRowsByTab(tab)
    .map(item => String(getField(item, 'CIDADE', 'cidade') || '').trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
}

function atualizarContadoresTabsPendente() {
  const filtroCidade = (document.getElementById('filtro-cidade-pendente')?.value || '').toLowerCase().trim();

  const filtrarPorCidade = (rows) => {
    if (!filtroCidade) return rows;
    return rows.filter(item => {
      const cidade = String(getField(item, 'CIDADE', 'cidade') || '').toLowerCase().trim();
      return cidade.includes(filtroCidade);
    });
  };

  const vistoriaCount = filtrarPorCidade(getPendenteRowsByTab('vistoria')).length;
  const backboneCount = filtrarPorCidade(getPendenteRowsByTab('backbone')).length;

  const btnVistoria = document.getElementById('tab-vistoria');
  const btnBackbone = document.getElementById('tab-backbone');
  const badgeVistoria = document.getElementById('tab-vistoria-badge');
  const badgeBackbone = document.getElementById('tab-backbone-badge');

  if (badgeVistoria) {
    badgeVistoria.textContent = String(vistoriaCount);
  } else if (btnVistoria) {
    btnVistoria.textContent = `PENDENTE VISTORIA (${vistoriaCount})`;
  }

  if (badgeBackbone) {
    badgeBackbone.textContent = String(backboneCount);
  } else if (btnBackbone) {
    btnBackbone.textContent = `PENDENTE BACKBONE (${backboneCount})`;
  }
}

function popularFiltroCidadePendente() {
  const input = document.getElementById('filtro-cidade-pendente');
  const sugestoes = document.getElementById('filtro-cidade-pendente-sugestoes');
  if (!input || !sugestoes) return;

  const valorAtual = input.value || '';
  const filtro = valorAtual.toLowerCase().trim();
  const cidadesFiltradas = getPendenteCityOptions()
    .filter(cidade => !filtro || cidade.toLowerCase().includes(filtro));
  const cidades = cidadesFiltradas.slice(0, 12);

  const headHtml = `
    <div class="filtro-cidade-pendente-head">
      <span class="filtro-cidade-pendente-icon" aria-hidden="true">📍</span>
      <span class="filtro-cidade-pendente-title">Cidades</span>
    </div>
  `;

  if (!cidades.length) {
    sugestoes.innerHTML = `${headHtml}<div class="filtro-cidade-pendente-vazio">Nenhuma cidade encontrada</div>`;
    sugestoes.classList.remove('hidden');
    input.value = valorAtual;
    return;
  }

  sugestoes.innerHTML = `${headHtml}<div class="filtro-cidade-pendente-list">${cidades.map(cidade => `
    <button type="button" class="filtro-cidade-pendente-opcao" onclick='selecionarCidadePendente(${JSON.stringify(cidade)})'>${escapeHtml(cidade)}</button>
  `).join('')}</div>`;

  sugestoes.classList.remove('hidden');
  input.value = valorAtual;
}

function mostrarSugestoesCidadePendente() {
  popularFiltroCidadePendente();
}

function ocultarSugestoesCidadePendente() {
  const sugestoes = document.getElementById('filtro-cidade-pendente-sugestoes');
  if (sugestoes) {
    sugestoes.classList.add('hidden');
  }
}

function selecionarCidadePendente(cidade) {
  const input = document.getElementById('filtro-cidade-pendente');
  if (input) {
    input.value = cidade || '';
  }
  ocultarSugestoesCidadePendente();
  renderPendenteAutorizacao();
}

function getPendenteRowsFiltrados() {
  const filtroCidade = (document.getElementById('filtro-cidade-pendente')?.value || '').toLowerCase().trim();
  const rows = getPendenteRowsByTab();

  if (!filtroCidade) {
    return rows;
  }

  return rows.filter(item => {
    const cidade = String(getField(item, 'CIDADE', 'cidade') || '').toLowerCase().trim();
    return cidade.includes(filtroCidade);
  });
}

function aplicarFiltrosPendenteAutorizacao() {
  popularFiltroCidadePendente();
  renderPendenteAutorizacao();
}

function limparFiltroCidadePendenteAutorizacao() {
  const input = document.getElementById('filtro-cidade-pendente');
  if (input) {
    input.value = '';
  }
  ocultarSugestoesCidadePendente();
  renderPendenteAutorizacao();
}

function exportarPendenteAutorizacao() {
  const dadosParaExportar = getPendenteRowsFiltrados();
  if (!dadosParaExportar.length) {
    alert('⚠️ Nenhum registro disponível para exportar no filtro atual.');
    return;
  }

  const csv = converterParaCSV(dadosParaExportar);
  const dataAtual = new Date().toISOString().slice(0, 10);
  baixarCSV(`pendente_autorizacao_${pendenteActiveTab}_${dataAtual}.csv`, csv);
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
  atualizarContadoresTabsPendente();
  popularFiltroCidadePendente();

  const dados = getPendenteRowsFiltrados();
  // Exibe todos os dados, sem truncar
  const tabelaId = pendenteActiveTab === 'vistoria' ? 'tabela-pendente-vistoria' : 'tabela-pendente-backbone';
  renderTabelaPendente(tabelaId, dados);
}

document.addEventListener('click', (event) => {
  const filtroWrap = document.querySelector('.filtro-item-cidade-pendente');
  if (!filtroWrap) return;

  if (!filtroWrap.contains(event.target)) {
    ocultarSugestoesCidadePendente();
  }
});

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
    const allow = useApi && Boolean(user) && user.role === 'admin';
    anexoInput.style.display = allow ? 'block' : 'none';
  }
  const anexoButton = document.getElementById('modal-anexo-button');
  if (anexoButton) {
    const allow = useApi && Boolean(user) && user.role === 'admin';
    anexoButton.style.display = allow ? 'inline-flex' : 'none';
  }
  if (helper) {
    helper.textContent = !useApi
      ? 'Recursos offline: anexos não estão disponíveis. Use o servidor para salvar anexos.'
      : user?.role === 'admin'
      ? 'Anexe arquivos para este endereço sempre que necessário.'
      : 'Acompanhamento não pode anexar arquivos. Apenas administrador pode anexar.';
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

  if (user?.role !== 'admin') {
    alert('⚠️ Apenas administrador pode anexar arquivos.');
    return;
  }

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
  const shouldPreserveManualImport = ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId)
    && Boolean(localSnapshot?.locked)
    && localItems.length;

  if (shouldPreserveManualImport) {
    applyDatasetToState(categoriaId, localItems);

    if (categoriaId === 'empresarial') {
      renderTabelaEmpresarial(`tabela-${categoriaId}`, localItems);
      popularFiltrosEmpresarial(localItems);
    } else if (categoriaId === 'sar-rede') {
      renderTabelaSarRede(`tabela-${categoriaId}`, localItems);
      popularFiltroStatusSarRede(localItems);
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

      applyDatasetToState(categoriaId, dados);
      if (['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId)) {
        persistirDadosCompartilhados(categoriaId, dados, {
          source: 'shared',
          locked: ['pendente-autorizacao', 'empresarial', 'mdu-ongoing', 'sar-rede'].includes(categoriaId),
        });
      }
      
      // Re-renderizar após carregar
      if (categoriaId === 'pendente-autorizacao') {
        setPendenteTab(pendenteActiveTab);
      } else if (categoriaId === 'empresarial') {
        renderTabelaEmpresarial(`tabela-${categoriaId}`, dados);
        popularFiltrosEmpresarial();
      } else if (categoriaId === 'sar-rede') {
        renderTabelaSarRede(`tabela-${categoriaId}`, dados);
        popularFiltroStatusSarRede();
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
    // Sempre priorizar cache local locked: true ao abrir SAR REDE
    if (categoriaId === 'sar-rede') {
      const localSar = getLocalDatasetCache()?.['sar-rede'];
      if (localSar?.locked && Array.isArray(localSar.items) && localSar.items.length) {
        applyDatasetToState('sar-rede', localSar.items);
        renderTabelaSarRede('tabela-sar-rede', localSar.items);
        popularFiltroStatusSarRede(localSar.items);
        atualizarContadores();
        return;
      }
    }
  if (!categoriaId) return;

  // Caso especial: Ongoing usa um parser diferente e layout de tabela próprio
  if (categoriaId === 'ongoing') {
    if ((!dadosCSVOngoing || dadosCSVOngoing.length === 0) && window.location.protocol.startsWith('http')) {
      carregarOngoingDatasetRemotamente('tabela-ongoing');
    }

    if ((!dadosCSVOngoing || dadosCSVOngoing.length === 0)) {
      const fallbackMdu = getPreferredDataset('mdu-ongoing');
      if (Array.isArray(fallbackMdu) && fallbackMdu.length) {
        const fallbackNormalizado = fallbackMdu.map((item) => normalizarLinhaOngoing(item));
        dadosCSVOngoing = fallbackNormalizado;
        dadosCSVOngoingOriginal = fallbackNormalizado;
        applyDatasetToState('ongoing', fallbackNormalizado);
      }
    }

    if ((!dadosCSVOngoing || dadosCSVOngoing.length === 0) && dadosPorCategoria['ongoing']) {
      dadosCSVOngoing = dadosPorCategoria['ongoing'];
      dadosCSVOngoingOriginal = dadosCSVOngoing;
    }
    renderTabelaOngoing(dadosCSVOngoing || []);
    atualizarContadores();
    return;
  }

  if (categoriaId === 'liberados') {
    atualizarLayoutLiberados();
    atualizarBotoesAbaLiberados();
    atualizarBadgesLiberados();

    const baseAtual = getPreferredDataset('liberados');
    if ((!baseAtual || baseAtual.length === 0) && window.location.protocol.startsWith('http')) {
      carregarLiberadosDatasetRemotamente();
    }

    if (!liberadosSubcardSelecionado) {
      const infoElInicial = document.getElementById('liberados-aba-info');
      if (infoElInicial) {
        infoElInicial.textContent = 'Selecione PROJETO F, GPON E HFC ou GREENFIELD para abrir anexo e tabela.';
      }
      atualizarContadores();
      return;
    }

    const baseLiberados = getPreferredDataset('liberados');
    let dadosAba = getDadosLiberadosDaAba(baseLiberados || [], liberadosAbaAtiva);

    // Fallback de compatibilidade para bases antigas derivadas de Projeto F.
    if ((!baseLiberados || !baseLiberados.length) && !dadosAba.length && liberadosAbaAtiva === 'projeto-f') {
      const baseProjetoF = getPreferredDataset('projeto-f');
      dadosAba = getDadosLiberadosProjetoF(baseProjetoF || []).map(item => ({ ...item, _aba_liberados: 'projeto-f' }));
    }

    const infoEl = document.getElementById('liberados-aba-info');
    if (infoEl) {
      const dadosFiltrados = getLiberadosRowsFiltrados(dadosAba);
      infoEl.textContent = `Aba ativa: ${getLiberadosAbaLabel(liberadosAbaAtiva)} • ${dadosFiltrados.length} registro(s)`;
      renderTabelaLiberados('tabela-liberados', dadosFiltrados);
      atualizarContadores();
      return;
    }

    renderTabelaLiberados('tabela-liberados', getLiberadosRowsFiltrados(dadosAba));
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
    } else if (categoriaId === 'sar-rede') {
      renderTabelaSarRede(tabelaId, dados || []);
      popularFiltroStatusSarRede(dados || []);
    } else if (categoriaId === 'mdu-ongoing') {
      if (!dados) {
        carregarDaBacklog('mdu-ongoing');
      } else {
        renderTabelaMduOngoing(tabelaId, dados);
      }
    } else if (categoriaId === 'projeto-f') {
      if ((!dados || dados.length === 0) && window.location.protocol.startsWith('http')) {
        carregarProjetoFDatasetRemotamente(tabelaId);
      }

      if (Array.isArray(dados) && dados.length) {
        garantirEpoProjetoFDerivado();
        atualizarCountPillsEpo();
      }

      renderTabelaProjetoF(tabelaId, dados || []);
    } else if (categoriaId === 'liberados') {
      const baseLiberados = getPreferredDataset('liberados');
      const dadosAba = getDadosLiberadosDaAba(baseLiberados || [], liberadosAbaAtiva);
      renderTabelaLiberados(tabelaId, dadosAba);
    } else {
      renderTabela(tabelaId, dados || [], false);
    }
  }

  // Atualizar contador na página inicial
  atualizarContadores();
}

function carregarOngoingDatasetRemotamente(tabelaId = 'tabela-ongoing') {
  if (ongoingDatasetLoadPromise) {
    return ongoingDatasetLoadPromise;
  }

  ongoingDatasetLoadPromise = (async () => {
    const preferred = getPreferredDataset('ongoing');
    if (Array.isArray(preferred) && preferred.length) {
      return preferred;
    }

    let rows = [];
    let meta = { source: 'shared', locked: true };

    try {
      const sharedResp = await fetch('/api/shared_datasets', { credentials: 'include' });
      if (sharedResp.ok) {
        const payload = await sharedResp.json().catch(() => ({}));
        const snapshot = payload?.datasets?.ongoing || {};
        const sharedItems = snapshot?.items;
        if (Array.isArray(sharedItems) && sharedItems.length) {
          rows = sharedItems;
          meta = {
            source: snapshot?.source || 'shared',
            updatedAt: snapshot?.updated_at || snapshot?.updatedAt || new Date().toISOString(),
            updatedBy: snapshot?.updated_by || snapshot?.updatedBy || '',
            locked: true,
          };
        } else {
          const mduSnapshot = payload?.datasets?.['mdu-ongoing'] || {};
          const mduItems = mduSnapshot?.items;
          if (Array.isArray(mduItems) && mduItems.length) {
            rows = mduItems;
            meta = {
              source: mduSnapshot?.source || 'fallback-mdu-ongoing',
              updatedAt: mduSnapshot?.updated_at || mduSnapshot?.updatedAt || new Date().toISOString(),
              updatedBy: mduSnapshot?.updated_by || mduSnapshot?.updatedBy || '',
              locked: true,
            };
          }
        }
      }
    } catch {
      // Sem bloqueio: mantem a tabela atual.
    }

    if (!rows.length) {
      const localMdu = getLocalDatasetCache()?.['mdu-ongoing']?.items;
      if (Array.isArray(localMdu) && localMdu.length) {
        rows = localMdu;
        meta = { source: 'fallback-local-mdu-ongoing', locked: true, updatedAt: new Date().toISOString() };
      }
    }

    if (!rows.length) {
      return [];
    }

    const rowsNormalizados = rows.map((item) => normalizarLinhaOngoing(item));

    applyDatasetToState('ongoing', rowsNormalizados);
    dadosCSVOngoing = rowsNormalizados;
    dadosCSVOngoingOriginal = rowsNormalizados;
    cacheDatasetLocally('ongoing', rowsNormalizados, meta);

    const tabela = document.getElementById(tabelaId);
    if (tabela) {
      renderTabelaOngoing(rowsNormalizados);
    }

    atualizarContadores();
    return rows;
  })().finally(() => {
    ongoingDatasetLoadPromise = null;
  });

  return ongoingDatasetLoadPromise;
}

function carregarLiberadosDatasetRemotamente() {
  if (liberadosDatasetLoadPromise) {
    return liberadosDatasetLoadPromise;
  }

  liberadosDatasetLoadPromise = (async () => {
    const preferred = getPreferredDataset('liberados');
    if (Array.isArray(preferred) && preferred.length) {
      return preferred;
    }

    let rows = [];
    let meta = { source: 'shared', locked: true };

    try {
      const sharedResp = await fetch('/api/shared_datasets', { credentials: 'include' });
      if (sharedResp.ok) {
        const payload = await sharedResp.json().catch(() => ({}));
        const snapshot = payload?.datasets?.['liberados'] || {};
        const sharedItems = snapshot?.items;
        if (Array.isArray(sharedItems) && sharedItems.length) {
          rows = sharedItems;
          meta = {
            source: snapshot?.source || 'shared',
            updatedAt: snapshot?.updated_at || snapshot?.updatedAt || new Date().toISOString(),
            updatedBy: snapshot?.updated_by || snapshot?.updatedBy || '',
            locked: true,
          };
        }
      }
    } catch {
      // Sem bloqueio: manter fallback local.
    }

    if (!rows.length) {
      const localRows = getLocalDatasetCache()?.['liberados']?.items;
      if (Array.isArray(localRows) && localRows.length) {
        rows = localRows;
        meta = { source: 'local-fallback', locked: true, updatedAt: new Date().toISOString() };
      }
    }

    if (!rows.length) {
      return [];
    }

    applyDatasetToState('liberados', rows);
    cacheDatasetLocally('liberados', rows, meta);

    if (document.querySelector('#liberados.secao.ativa')) {
      atualizarBadgesLiberados();
      const dadosAbaAtiva = getDadosLiberadosDaAba(rows, liberadosAbaAtiva);
      renderTabelaLiberados('tabela-liberados', dadosAbaAtiva);

      const infoEl = document.getElementById('liberados-aba-info');
      if (infoEl) {
        infoEl.textContent = `Aba ativa: ${getLiberadosAbaLabel(liberadosAbaAtiva)} • ${dadosAbaAtiva.length} registro(s)`;
      }

      atualizarContadores();
    }

    return rows;
  })().finally(() => {
    liberadosDatasetLoadPromise = null;
  });

  return liberadosDatasetLoadPromise;
}

function carregarProjetoFDatasetRemotamente(tabelaId = 'tabela-projeto-f') {
  if (projetoFDatasetLoadPromise) {
    return projetoFDatasetLoadPromise;
  }

  projetoFDatasetLoadPromise = (async () => {
    const preferred = getPreferredDataset('projeto-f');
    if (Array.isArray(preferred) && preferred.length) {
      return preferred;
    }

    let rows = [];
    let meta = { source: 'shared', locked: true };

    try {
      const sharedResp = await fetch('/api/shared_datasets', { credentials: 'include' });
      if (sharedResp.ok) {
        const sharedPayload = await sharedResp.json().catch(() => ({}));
        const snapshot = sharedPayload?.datasets?.['projeto-f'] || {};
        const sharedItems = snapshot?.items;
        if (Array.isArray(sharedItems) && sharedItems.length) {
          rows = sharedItems;
          meta = {
            source: snapshot?.source || 'shared',
            updatedAt: snapshot?.updated_at || snapshot?.updatedAt || new Date().toISOString(),
            updatedBy: snapshot?.updated_by || snapshot?.updatedBy || '',
            locked: true,
          };
        }
      }
    } catch {
      // Segue para fallback do endpoint especifico.
    }

    if (!rows.length) {
      try {
        const projetoResp = await fetch('/api/projeto_f_dataset', { credentials: 'include' });
        if (projetoResp.ok) {
          const projetoPayload = await projetoResp.json().catch(() => ({}));
          const projetoItems = projetoPayload?.items;
          if (Array.isArray(projetoItems) && projetoItems.length) {
            rows = projetoItems;
            meta = {
              source: projetoPayload?.source || 'api-projeto-f',
              updatedAt: new Date().toISOString(),
              updatedBy: getCurrentUser()?.username || '',
              locked: true,
            };
          }
        }
      } catch {
        // Sem bloqueio: mantem tabela atual.
      }
    }

    if (!rows.length) {
      return [];
    }

    applyDatasetToState('projeto-f', rows);
    cacheDatasetLocally('projeto-f', rows, meta);

    if (meta.source !== 'shared' && getCurrentUser()?.role === 'admin') {
      persistirDadosCompartilhados('projeto-f', rows, {
        source: meta.source,
        locked: true,
      });
    }

    const tabela = document.getElementById(tabelaId);
    if (tabela) {
      renderTabelaProjetoF(tabelaId, rows);
    }

    garantirEpoProjetoFDerivado({ persistShared: getCurrentUser()?.role === 'admin' });
    atualizarCountPillsEpo();
    atualizarContadores();
    return rows;
  })().finally(() => {
    projetoFDatasetLoadPromise = null;
  });

  return projetoFDatasetLoadPromise;
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
    if (categoriaId === 'epo' && epoSelecionadaAtual) {
      if (epoAcaoAtual === 'projeto-f') {
        renderProjetoFEpo();
      } else if (epoAcaoAtual === 'gpon-ongoing') {
        renderGponOngoingEpo();
      }
      const resultEl = document.getElementById('epo-action-result');
      if (resultEl) resultEl.textContent = `✅ Busca limpa. Exibindo todos os registros de ${epoSelecionadaAtual}.`;
      return;
    }

    alert('🔍 Digite um ID ou endereço para buscar');
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
  } else if (categoriaId === 'sar-rede') {
    resultado = todosDados.filter(item => {
      const idProjeto = String(getSarRedeIdProjeto(item) || '').toLowerCase();
      const cliente = String(getSarRedeCliente(item) || '').toLowerCase();
      const endereco = String(getField(item, "ENDEREÇO", "ENDERECO", "endereco") || '').toLowerCase();

      return idProjeto.includes(termoBusca) || cliente.includes(termoBusca) || endereco.includes(termoBusca);
    });
  } else if (categoriaId === 'liberados') {
    const dadosAba = getDadosLiberadosDaAba(getPreferredDataset('liberados') || [], liberadosAbaAtiva);
    resultado = dadosAba.filter(item => {
      const codImovel = String(getField(item, 'COD_IMOVEL', 'COD IMOVEL', 'COD_GED', 'CÓD. GED', 'ID Projeto', 'ID_PROJETO') || '').toLowerCase();
      const solicitante = String(getField(item, 'SOLICITANTE') || '').toLowerCase();
      const endereco = String(getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '').toLowerCase();
      return codImovel.includes(termoBusca) || solicitante.includes(termoBusca) || endereco.includes(termoBusca);
    });

    if (resultado.length === 0) {
      alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
      renderTabelaLiberados('tabela-liberados', dadosAba);
    } else {
      renderTabelaLiberados('tabela-liberados', resultado);
      alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
    }
    return;
  } else if (categoriaId === 'epo') {
    if (!epoSelecionadaAtual) {
      alert('⚠️ Selecione uma EPO antes de buscar.');
      return;
    }

    if (epoAcaoAtual === 'equipes') {
      alert('⚠️ A busca do EPO está disponível nas abas GPON ONGOING e PROJETO F.');
      return;
    }

    const actionKey = epoAcaoAtual === 'projeto-f' ? 'projeto-f' : 'gpon-ongoing';
    const baseRows = getEpoRowsForEpo(actionKey, epoSelecionadaAtual);

    if (actionKey === 'projeto-f') {
      resultado = baseRows.filter(item => {
        const codigoGed = getProjetoFCodigoGed(item).toLowerCase();
        const endereco = getProjetoFEndereco(item).toLowerCase();
        return codigoGed.includes(termoBusca) || endereco.includes(termoBusca);
      });

      if (resultado.length === 0) {
        alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
        renderProjetoFEpo();
      } else {
        renderProjetoFEpo(resultado);
        alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
      }
      return;
    }

    resultado = baseRows.filter(item => {
      const codigo = String(getField(item, 'COD-MDUGO', 'cod-mdugo', 'codmdugo') || '').toLowerCase();
      const endereco = String(getField(item, 'ENDEREÇO', 'ENDERECO', 'endereco') || '').toLowerCase();
      return codigo.includes(termoBusca) || endereco.includes(termoBusca);
    });

    if (resultado.length === 0) {
      alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
      renderGponOngoingEpo();
    } else {
      renderGponOngoingEpo(resultado);
      alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
    }
    return;
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

  if (categoriaId === 'empresarial') {
    if (resultado.length === 0) {
      alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
      renderTabelaEmpresarial('tabela-empresarial', todosDados);
    } else {
      renderTabelaEmpresarial('tabela-empresarial', resultado);
      alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
    }
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

  if (categoriaId === 'sar-rede') {
    if (resultado.length === 0) {
      alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
      renderTabelaSarRede('tabela-sar-rede', todosDados);
    } else {
      renderTabelaSarRede('tabela-sar-rede', resultado);
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
  const totalProjetoF = getPreferredDataset('projeto-f').length;
  const liberadosBase = getPreferredDataset('liberados');
  const totalLiberados = Array.isArray(liberadosBase) && liberadosBase.length
    ? liberadosBase.length
    : getDadosLiberadosProjetoF(getPreferredDataset('projeto-f')).length;
  const epoStoreGpon = getEpoStore('gpon-ongoing');
  const epoStoreProjetoF = getEpoStore('projeto-f');
  const totalEpo = [epoStoreGpon, epoStoreProjetoF].reduce((acc, store) => {
    return acc + Object.values(store || {}).reduce((sum, lista) => {
      return sum + (Array.isArray(lista) ? lista.length : 0);
    }, 0);
  }, 0);

  const contadores = {
    'pendente-autorizacao': (dadosPorCategoria['pendente-autorizacao'] || []).length,
    'ongoing': (dadosPorCategoria['ongoing'] || dadosCSVOngoing || []).length,
    'projeto-f': totalProjetoF,
    'liberados': totalLiberados,
    'empresarial': (dadosPorCategoria['empresarial'] || []).length,
    'sar-rede': (dadosPorCategoria['sar-rede'] || []).length,
    'mdu-ongoing': (dadosPorCategoria['mdu-ongoing'] || []).length,
    'epo': totalEpo,
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

function renderModalAllFields(item) {
  if (!item || typeof item !== 'object') return '';

  const keys = Object.keys(item);
  const hasOriginalForNormalized = new Set();

  keys.forEach(key => {
    const normalized = normalizeKey(key);
    if (normalized && key !== normalized) {
      hasOriginalForNormalized.add(normalized);
    }
  });

  const rows = keys
    .filter(key => {
      const normalized = normalizeKey(key);
      if (key === normalized && hasOriginalForNormalized.has(normalized)) {
        return false;
      }

      const value = item[key];
      return value !== undefined && value !== null && String(value).trim() !== '';
    })
    .map(key => `
      <tr>
        <td style="padding:6px 8px; border:1px solid #e2e8f0; font-weight:600; white-space:nowrap;">${escapeHtml(key)}</td>
        <td style="padding:6px 8px; border:1px solid #e2e8f0;">${escapeHtml(item[key])}</td>
      </tr>
    `)
    .join('');

  if (!rows) return '';

  return `
    <details class="modal-extra" style="margin-top:12px;">
      <summary style="cursor:pointer; font-weight:700; color:#1e3a8a;">Todos os campos da planilha</summary>
      <div style="margin-top:10px; max-height:260px; overflow:auto; border:1px solid #e2e8f0; border-radius:8px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>
  `;
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
  const item = dados.find(i => getField(i, "COD-MDUGO", "cod-mdugo", "codmdugo") === codigo);
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const enderecoCompleto = `${getField(item, "ENDEREÇO") || '-'} ${getField(item, "NUMERO") || ''}`.trim();
  const bairro = getField(item, "BAIRRO") || '-';
  const cidade = getField(item, "CIDADE") || '-';
  const epo = getField(item, "EPO", "cluster", "regional") || '-';
  const solicitante = getField(item, "SOLICITANTE", "solicitante") || '-';
  const statusGeral = getField(item, "STATUS_GERAL", "status_geral", "status") || '-';
  const motivoGeral = getField(item, "MOTIVO_GERAL", "motivo_geral", "motivo") || '-';
  const obsOriginal = getField(item, "OBS", "obs", "OBSERVACAO", "observacao", "STATUS OBS", "status obs", "status_obs") || '-';
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
      ${renderModalAllFields(item)}
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

function visualizarEmpresarialPorIndice(index) {
  const rows = Array.isArray(window.__empresarialRowsSnapshot) ? window.__empresarialRowsSnapshot : [];
  const item = rows[index];
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const codigo = getField(item, "COD-MDUGO", "cod-mdugo", "codmdugo") || '-';
  currentPendenteCodigo = codigo;

  const enderecoCompleto = `${getField(item, "ENDEREÇO", "ENDERECO", "endereco", "endereco_entrada") || '-'} ${getField(item, "NUMERO", "numero") || ''}`.trim();
  const bairro = getField(item, "BAIRRO", "bairro") || '-';
  const cidade = getField(item, "CIDADE", "cidade") || '-';
  const epo = getField(item, "EPO", "cluster", "regional") || '-';
  const solicitante = getField(item, "SOLICITANTE", "solicitante") || '-';
  const statusGeral = getField(item, "STATUS_GERAL", "status_geral", "status") || '-';
  const motivoGeral = getField(item, "MOTIVO_GERAL", "motivo_geral", "motivo") || '-';
  const obsOriginal = getField(item, "OBS", "obs", "OBSERVACAO", "observacao", "STATUS OBS", "status obs", "status_obs") || '-';
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
      ${renderModalAllFields(item)}
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

function visualizarSarRedePorIndice(index) {
  const rows = Array.isArray(window.__sarRedeRowsSnapshot) ? window.__sarRedeRowsSnapshot : [];
  const item = rows[index];
  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const idProjeto = getSarRedeIdProjeto(item) || '-';
  const ddd = getField(item, 'DDD', 'ddd') || _getFieldByKeyHint(item, 'ddd') || '-';
  const cidade = getField(item, 'Cidade', 'CIDADE', 'cidade') || _getFieldByKeyHint(item, 'cidade') || '-';
  const cliente = getSarRedeCliente(item) || '-';
  const projetado = getField(item, 'PROJETADO', 'projetado') || _getFieldByKeyHint(item, 'projetado') || '-';
  const ageGeral = getField(item, 'AGE GERAL', 'age geral', 'AGE_GERAL', 'age_geral', 'AGE', 'age') || _getFieldByKeyHint(item, 'age geral') || '-';
  const enviado = getField(item, 'ENVIADO', 'enviado') || _getFieldByKeyHint(item, 'enviado') || '-';
  const previsao = getField(item, 'PREVISÃO', 'PREVISAO', 'previsao', 'previsão') || _getFieldByKeyHint(item, 'previs') || '-';
  const statusProjetoReal = getSarRedeStatusProjetoReal(item) || '-';
  const epo = getField(item, 'EPO', 'epo') || _getFieldByKeyHint(item, 'epo') || '-';
  const site = getField(item, 'SITE', 'site') || _getFieldByKeyHint(item, 'site') || '-';
  const caboFo = getField(item, 'CABO FO', 'CABO_FO', 'cabo_fo', 'cabo fo') || _getFieldByKeyHint(item, 'cabo fo') || '-';
  const observacoesGerais = getField(item, 'Observações Gerais', 'Observacoes Gerais', 'OBSERVACOES GERAIS', 'obs_gerais', 'OBS')
    || _getFieldByKeyHint(item, 'observ')
    || '-';
  const blocos = getField(item, 'BLOCOS', 'blocos') || _getFieldByKeyHint(item, 'blocos') || '-';
  const hps = getField(item, 'HPS', 'hps') || _getFieldByKeyHint(item, 'hps') || '-';
  const area = getField(item, 'Área', 'Area', 'AREA', 'área') || _getFieldByKeyHint(item, 'area') || '-';

  currentPendenteCodigo = String(idProjeto || cliente || `sar-${index}`);

  document.getElementById('modal-codigo').textContent = idProjeto;
  document.getElementById('modal-endereco').textContent = cliente;
  document.getElementById('modal-bairro').textContent = '-';
  document.getElementById('modal-cidade').textContent = cidade;
  document.getElementById('modal-epo').textContent = epo;
  document.getElementById('modal-status').innerHTML = renderModalBadge(statusProjetoReal);
  document.getElementById('modal-motivo').innerHTML = renderModalBadge(previsao);
  document.getElementById('modal-obs-original').textContent = observacoesGerais;
  document.getElementById('modal-obs-adicional').value = '';

  applyModalContext({
    themeClass: 'mdu-ongoing-modal',
    title: 'Detalhes SAR REDE',
    kicker: 'Painel analítico do SAR Rede',
    heroChip: 'SAR REDE',
    heroTitle: cliente || idProjeto,
    heroSubtitle: [cidade, epo].filter(v => v && v !== '-').join(' • ') || 'Registro SAR selecionado',
    statusLabel: 'Status Projeto Real',
    motivoLabel: 'Previsão',
    heroPills: [
      { label: 'ID Projeto', value: idProjeto },
      { label: 'DDD', value: ddd },
      { label: 'Age Geral', value: ageGeral }
    ]
  });

  const modalBody = document.querySelector('#modal-obs .modal-body');
  if (modalBody) {
    const extraHtml = `
      <div class="modal-extra modal-extra-grid">
        ${renderModalInfoCard('EPO', epo, { featured: true })}
        ${renderModalInfoCard('SITE', site)}
        ${renderModalInfoCard('CABO FO', caboFo)}
        ${renderModalInfoCard('BLOCOS', blocos)}
        ${renderModalInfoCard('HPS', hps)}
        ${renderModalInfoCard('Área', area)}
        ${renderModalInfoCard('Projetado', projetado)}
        ${renderModalInfoCard('Enviado', enviado)}
      </div>
      ${renderModalAllFields(item)}
    `;
    const obsRow = document.getElementById('modal-obs-original')?.closest('.modal-row');
    if (obsRow) {
      obsRow.insertAdjacentHTML('beforebegin', extraHtml);
    }
  }

  carregarObservacoesPendente(currentPendenteCodigo);
  carregarAnexosPendente(currentPendenteCodigo);

  const modal = document.getElementById('modal-obs');
  if (modal) modal.classList.remove('hidden');

  const anexoInput = document.getElementById('modal-anexo');
  if (anexoInput) {
    anexoInput.value = '';
    anexoInput.onchange = (evt) => {
      const file = evt.target.files[0];
      if (file) {
        uploadAnexoPendente(currentPendenteCodigo, file);
      }
    };
  }
}

function visualizarMduOngoing(codigo) {
  const codigoNorm = String(codigo || '').trim();
  currentPendenteCodigo = codigoNorm;

  const snapshotRows = Array.isArray(window.__mduOngoingRowsSnapshot) ? window.__mduOngoingRowsSnapshot : [];
  const baseRows = snapshotRows.length ? snapshotRows : (dadosPorCategoria['mdu-ongoing'] || []);

  const item = baseRows.find((i) => {
    const valorCodigo = String(getField(i, "COD-MDUGO", "CÓDIGO", "CODIGO", "COD", "ID") || '').trim();
    return valorCodigo === codigoNorm;
  }) || (typeof codigo === 'number' ? baseRows[codigo] : null);

  if (!item) {
    alert('Registro não encontrado');
    return;
  }

  const codigoExibicao = getField(item, "COD-MDUGO", "CÓDIGO", "CODIGO", "COD", "ID") || codigoNorm || '-';
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
