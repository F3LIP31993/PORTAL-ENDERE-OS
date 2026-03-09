let dadosCSV = [];
let dddSelecionado = "todos"; // Armazena o DDD selecionado globalmente

const STORAGE_USERS_KEY = "portalUsers";
const STORAGE_CURRENT_USER_KEY = "portalCurrentUser";

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
  const username = localStorage.getItem(STORAGE_CURRENT_USER_KEY);
  if (!username) return null;
  const users = getStoredUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
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

function getPendingUsers() {
  return getStoredUsers().filter(u => u.role === "pending");
}

function updateNotificationBadge() {
  const badge = document.getElementById("notificationBadge");
  if (!badge) return;

  const count = getPendingUsers().length;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.classList.remove("hidden");
  } else {
    badge.textContent = "";
    badge.classList.add("hidden");
  }
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

function renderNotificationList() {
  const list = document.getElementById("notificationList");
  if (!list) return;

  const pendings = getPendingUsers();
  if (!pendings.length) {
    list.innerHTML = '<p class="notification-empty">Nenhuma solicitação pendente.</p>';
    return;
  }

  list.innerHTML = pendings.map(u => {
    const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : "-";
    return `
      <div class="notification-item">
        <p><strong>${u.name || u.username}</strong> <span style="opacity:.7">(${u.username})</span></p>
        <p class="notification-meta">${u.email || "sem e-mail"} • ${created}</p>
        <div class="notification-actions">
          <button class="approve" onclick="approveUser('${u.username}', 'admin')">Aprovar (Admin)</button>
          <button class="approve-alt" onclick="approveUser('${u.username}', 'viewer')">Aprovar (Acompanh.)</button>
          <button class="deny" onclick="denyUser('${u.username}')">Rejeitar</button>
        </div>
      </div>
    `;
  }).join("");
}

function approveUser(username, role) {
  const users = getStoredUsers();
  const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) return;

  users[idx].role = role;
  users[idx].approvedAt = new Date().toISOString();
  saveStoredUsers(users);

  updateNotificationBadge();
  renderNotificationList();
  alert(`✅ Usuário '${users[idx].username}' aprovado como ${role === "admin" ? "Administrador" : "Acompanhamento"}.`);
}

function denyUser(username) {
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
window.addEventListener("DOMContentLoaded", () => {
  const savedPhoto = localStorage.getItem("userPhoto");
  if (savedPhoto) {
    document.getElementById("profileImage").src = savedPhoto;
  }
  
  // Atualizar dados de usuário e notificações
  updateUserProfileInfo();
  updateNotificationBadge();
  
  // Inicializar filtros de DDD
  inicializarFiltrosDDD();
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

// Mostrar nome do arquivo selecionado
document.getElementById("arquivoCSV").addEventListener("change", function() {
  const fileName = this.files[0]?.name || "";
  const fileNameDisplay = document.getElementById("file-name");
  if (fileNameDisplay) {
    fileNameDisplay.textContent = fileName ? `📄 ${fileName}` : "";
  }
});

// IMPORTAR CSV
function importarCSV() {
  const input = document.getElementById("arquivoCSV");
  if (!input.files.length) return alert("Selecione o CSV");

  const reader = new FileReader();
  reader.onload = e => {
    const linhas = e.target.result.split(/\r?\n/);
    const cabecalho = linhas[0].split(";");

    dadosCSV = [];

    for (let i = 1; i < linhas.length; i++) {
      const col = linhas[i].split(";");
      if (col.length < cabecalho.length) continue;

      const item = {};
      cabecalho.forEach((c, j) => item[c.trim()] = col[j]?.trim());

      // Filtrar apenas status "4 - PENDENTE AUTORIZAÇÃO"
      if (item["STATUS_GERAL"] === "4 - PENDENTE AUTORIZAÇÃO") {
        dadosCSV.push(item);
      }
    }

    renderTabela("tabela-enderecos", dadosCSV);
    
    // Atualizar total na página inicial
    document.getElementById("totalRegistrosInicio").textContent = dadosCSV.length;
  };

  reader.readAsText(input.files[0], "ISO-8859-1");
}

// RENDER
function renderTabela(id, lista, atualizarRelatoriosFlag = true) {
  const tbody = document.getElementById(id);
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">Nenhum registro</td></tr>`;
    return;
  }

  lista.forEach(i => {
    const age = obterAge(i) || "—";
    tbody.innerHTML += `
      <tr>
        <td>${i["COD-MDUGO"]}</td>
        <td>${i["ENDEREÇO"]} ${i["NUMERO"]}</td>
        <td>${i["CIDADE"]}</td>
        <td>${i["STATUS_GERAL"]}</td>
        <td><strong>${age}</strong></td>
        <td>${i["MOTIVO_GERAL"]}</td>
      </tr>`;
  });

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
      const ddd = extrairDDD(item["CIDADE"]);
      return ddd.toString() === dddFiltro;
    });
  }

  // Atualizar total de registros no card do topo
  document.getElementById("totalRegistrosTop").textContent = dadosFiltrados.length;
  document.getElementById("totalEnderecos").textContent = dadosFiltrados.length;

  // Contar DDDs
  const dddCount = {};
  dadosFiltrados.forEach(item => {
    const ddd = extrairDDD(item["CIDADE"]);
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

  lista.forEach(i => {
    const age = obterAge(i) || "—";
    tbody.innerHTML += `
      <tr>
        <td>${i["COD-MDUGO"]}</td>
        <td>${i["ENDEREÇO"]} ${i["NUMERO"]}</td>
        <td>${i["CIDADE"]}</td>
        <td>${i["STATUS_GERAL"]}</td>
        <td><strong>${age}</strong></td>
        <td>${i["MOTIVO_GERAL"]}</td>
      </tr>`;
  });
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
  const res = dadosCSV.filter(i => i["COD-MDUGO"] === cod);
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
      const d = extrairDDD(item["CIDADE"]);
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
  const age = parseInt(item["AGE"]);
  return isNaN(age) ? 0 : age;
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
  document.querySelectorAll(".secao").forEach(s => s.classList.remove("ativa"));
  document.getElementById(id).classList.add("ativa");
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
function processarCSVOngoing(csv) {
  const linhas = csv.split(/\r?\n/);
  if (linhas.length < 2) return [];
  
  const cabecalho = linhas[0].split(";");
  const dados = [];
  
  // Encontrar índices dos campos principais
  const indiceIdDemanda = cabecalho.findIndex(c => 
    c.trim().toLowerCase().includes("iddemanda") || 
    c.trim().toLowerCase().includes("id demanda") ||
    c.trim().toLowerCase().includes("id_demanda")
  );
  const indiceFila = cabecalho.findIndex(c => c.trim().toLowerCase() === "fila");
  const indiceTipo = cabecalho.findIndex(c => c.trim().toLowerCase() === "tipo");
  const indiceEndereco = cabecalho.findIndex(c => c.trim().toLowerCase() === "endereco_unico");
  const indiceAging = cabecalho.findIndex(c => c.trim().toLowerCase().includes("aging"));
  const indiceSLA = cabecalho.findIndex(c => c.trim().toLowerCase().includes("sla tudo") || c.trim().toLowerCase().includes("sla_tudo"));
  const indiceStatus = cabecalho.findIndex(c => c.trim().toLowerCase() === "status_geral");
  const indiceMotivo = cabecalho.findIndex(c => c.trim().toLowerCase() === "motivo_geral");

  for (let i = 1; i < linhas.length; i++) {
    if (!linhas[i].trim()) continue;
    
    const col = linhas[i].split(";");
    if (col.length < cabecalho.length) continue;

    const item = {};
    cabecalho.forEach((c, j) => {
      item[c.trim()] = col[j]?.trim() || "";
    });
    
    // Garantir que os campos principais existem (mesmo que vazios)
    if (indiceIdDemanda !== -1) {
      item["iddemanda"] = col[indiceIdDemanda]?.trim() || "";
    }
    if (indiceFila !== -1) {
      item["fila"] = col[indiceFila]?.trim() || "";
    }
    if (indiceTipo !== -1) {
      item["tipo"] = col[indiceTipo]?.trim() || "";
    }
    if (indiceEndereco !== -1) {
      item["endereco_unico"] = col[indiceEndereco]?.trim() || "";
    }
    if (indiceAging !== -1) {
      item["Aging arredondado"] = col[indiceAging]?.trim() || "";
    }
    if (indiceSLA !== -1) {
      item["SLA TUDO"] = col[indiceSLA]?.trim() || "";
    }
    if (indiceStatus !== -1) {
      item["STATUS_GERAL"] = col[indiceStatus]?.trim() || "";
    }
    if (indiceMotivo !== -1) {
      item["MOTIVO_GERAL"] = col[indiceMotivo]?.trim() || "";
    }

    // Validar se tem os campos necessários
    if (item["iddemanda"] || item["STATUS_GERAL"]) {
      dados.push(item);
    }
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center">Nenhum dado</td></tr>';
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
        <td>${item["endereco_unico"] || "-"}</td>
        <td>${item["epo"] || "-"}</td>
        <td>${badgeClass ? `<span class="${badgeClass}">${agingNumero}</span>` : agingNumero}</td>
        <td>${item["SLA TUDO"] || "-"}</td>
        <td>${item["STATUS_GERAL"] || "-"}</td>
        <td>${item["MOTIVO_GERAL"] || "-"}</td>
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
    const slaTudo = (item["SLA TUDO"] || "").toLowerCase().trim();
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
function abrirDetalhesOngoing(indice) {
  const item = dadosTabelaExibida[indice]; // Usar dados atualmente exibidos
  if (!item) return;
  
  // Extrair apenas o número do Aging de forma robusta
  const agingRaw = item["Aging arredondado"] || "0";
  const match = agingRaw.toString().match(/\d+/);
  const agingNumero = match ? parseInt(match[0]) : 0;
  
  // Preencher os campos de detalhes
  document.getElementById("detalhe-iddemanda").textContent = item["iddemanda"] || "-";
  document.getElementById("detalhe-fila").textContent = item["fila"] || "-";
  document.getElementById("detalhe-tipo").textContent = item["tipo"] || "-";
  document.getElementById("detalhe-endereco").textContent = item["endereco_unico"] || "-";
  document.getElementById("detalhe-aging").textContent = agingNumero;
  document.getElementById("detalhe-sla").textContent = item["SLA TUDO"] || "-";
  document.getElementById("detalhe-status").textContent = item["STATUS_GERAL"] || "-";
  document.getElementById("detalhe-motivo").textContent = item["MOTIVO_GERAL"] || "-";
  document.getElementById("detalhe-obs").textContent = item["STATUS OBS"] || item["OBS"] || "Nenhuma observação disponível";
  
  // Mostrar seção de detalhes usando o sistema de navegação (classes .secao/.ativa)
  mostrarSecao('detalhes-ongoing');
  
  // Scroll para o topo
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
  window.location.href = "login.html";
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
  // Esconder todas as seções
  document.querySelectorAll(".secao").forEach(s => s.classList.remove("ativa"));
  
  // Mostrar a seção da categoria
  const secao = document.getElementById(categoriaId);
  if (secao) {
    secao.classList.add("ativa");
    
    // Carregar dados da categoria
    carregarDadosCategoria(categoriaId);
  }
}

// Voltar à página inicial
function voltarDoCategoria() {
  mostrarSecao('inicio');
  
  // Limpar buscas
  document.querySelectorAll('[id^="buscar-"]').forEach(input => {
    input.value = '';
  });
}

// Carregar dados da categoria
function carregarDadosCategoria(categoriaId) {
  // Dados de teste - você pode integrar com dados reais do CSV
  const dados = {
    'pendente-autorizacao': filtrarPorStatus('4 - PENDENTE AUTORIZAÇÃO'),
    'ongoing': filtrarPorStatus('ONGOING'),
    'novos-empreendimentos': filtrarPorStatus('NOVOS EMPREENDIMENTOS'),
    'empresarial': filtrarPorStatus('EMPRESARIAL'),
    'sar-rede': filtrarPorStatus('SAR REDE'),
    'mdu-ongoing': filtrarPorStatus('MDU ONGOING')
  };
  
  const tabelaId = `tabela-${categoriaId}`;
  const tabela = document.getElementById(tabelaId);
  
  if (tabela && dados[categoriaId]) {
    renderTabela(tabelaId, dados[categoriaId], false);
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
    const statusGeral = item["STATUS_GERAL"] || "";
    return statusGeral.includes(status) || statusGeral === status;
  });
}

// Buscar em categoria
function buscarEmCategoria(categoriaId) {
  const inputId = `buscar-${categoriaId}`;
  const inputElement = document.getElementById(inputId);
  const termoBusca = (inputElement?.value || "").toLowerCase().trim();
  
  if (!termoBusca) {
    alert('🔍 Digite um ID para buscar');
    return;
  }
  
  // Obter dados da categoria
  const dados = {
    'pendente-autorizacao': filtrarPorStatus('4 - PENDENTE AUTORIZAÇÃO'),
    'ongoing': filtrarPorStatus('ONGOING'),
    'novos-empreendimentos': filtrarPorStatus('NOVOS EMPREENDIMENTOS'),
    'empresarial': filtrarPorStatus('EMPRESARIAL'),
    'sar-rede': filtrarPorStatus('SAR REDE'),
    'mdu-ongoing': filtrarPorStatus('MDU ONGOING')
  };
  
  const dadosCategoria = dados[categoriaId] || [];
  
  // Buscar por código ou ID
  const resultado = dadosCategoria.filter(item => {
    const codigo = (item["COD-MDUGO"] || "").toLowerCase();
    const id = (item["ID"] || "").toLowerCase();
    const endereco = (item["ENDEREÇO"] || "").toLowerCase();
    
    return codigo.includes(termoBusca) || 
           id.includes(termoBusca) || 
           endereco.includes(termoBusca);
  });
  
  const tabelaId = `tabela-${categoriaId}`;
  
  if (resultado.length === 0) {
    alert('❌ Nenhum resultado encontrado para: ' + termoBusca);
    renderTabela(tabelaId, dadosCategoria, false);
  } else {
    renderTabela(tabelaId, resultado, false);
    alert(`✅ ${resultado.length} resultado(s) encontrado(s)`);
  }
}

// Atualizar contadores nas categorias
function atualizarContadores() {
  const contadores = {
    'pendente-autorizacao': filtrarPorStatus('4 - PENDENTE AUTORIZAÇÃO').length,
    'ongoing': filtrarPorStatus('ONGOING').length,
    'novos-empreendimentos': filtrarPorStatus('NOVOS EMPREENDIMENTOS').length,
    'empresarial': filtrarPorStatus('EMPRESARIAL').length,
    'sar-rede': filtrarPorStatus('SAR REDE').length,
    'mdu-ongoing': filtrarPorStatus('MDU ONGOING').length
  };
  
  for (const [categoria, count] of Object.entries(contadores)) {
    const elemento = document.getElementById(`count-${categoria}`);
    if (elemento) {
      elemento.textContent = count;
    }
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